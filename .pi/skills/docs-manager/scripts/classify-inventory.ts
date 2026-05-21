import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'

// Import shared modules
import { parseDocFile } from './parse-doc-file'

// ── Types (aligned with scan-inventory.ts) ─────────────────────

export interface InventoryBlock {
  id: string
  path: string
  folder: string
  size_kb: number
  lines: number
  status: 'scanned' | 'classified' | 'approved' | 'migrated'
  class: 'canonical' | 'stale' | 'duplicate' | 'archive' | 'experiment' | 'decision' | null
  confidence: 'high' | 'medium' | 'low' | null
  proposed_action: 'keep' | 'move' | 'archive' | 'delete' | 'merge-into' | 'rewrite' | null
  approval: 'auto' | 'approved' | 'rejected' | null
  risk: 'none' | 'low' | 'high' | null
  reason: string | null
  questions: string[]
  related_files: string[]
  target_path: string | null
  current_step: string | null
  blocker: string | null
  last_updated: string
}

export interface ClassificationResult {
  classified: InventoryBlock[]    // auto-classified with high confidence
  uncertain: UncertainEntry[]     // needs agent review
}

export interface UncertainEntry extends InventoryBlock {
  docAnalysis?: ReturnType<typeof parseDocFile>
  suggestedClasses: string[]      // which classes are plausible
  ruleMatches: string[]           // rules that matched (may conflict)
}

// ── Canonical folder map from DOCS_RULES.md ────────────────────

const CANONICAL_FOLDERS = [
  '00-current',
  '10-domain',
  '20-architecture',
  '30-flows',
  '35-prds',
  '40-decisions',
  '50-agent-workflows',
  '90-archive',
]

// ── Deterministic classification rules ─────────────────────────
// Each rule: matches a condition → produces class + action + targetFolder (optional)
// Rules are evaluated in order; first match wins.

interface ClassificationRule {
  name: string
  test: (block: InventoryBlock, flags?: Record<string, boolean>) => boolean
  classify: (block: InventoryBlock) => Omit<Partial<InventoryBlock>, 'id' | 'path' | 'folder' | 'size_kb' | 'lines'>
}

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  // ── Flag-based rules (highest confidence — obvious cases) ──

  {
    name: 'draft-or-temp-name',
    test: (_, flags) => !!flags?.isDraftOrTemp,
    classify: () => ({
      status: 'classified' as const,
      class: 'experiment',
      confidence: 'high' as const,
      proposed_action: 'archive',
      risk: 'low' as const,
      reason: 'Filename matches draft/temp/tmp/scratch/wip/todo pattern — experiment or scratch content per DOCS_RULES.md',
    }),
  },

  {
    name: 'empty-or-near-empty-file',
    test: (block) => block.lines < 3 && block.size_kb < 0.1,
    classify: () => ({
      status: 'classified' as const,
      class: 'stale',
      confidence: 'high' as const,
      proposed_action: 'archive',
      risk: 'low' as const,
      reason: 'File is near-empty (<3 lines, <100 bytes) — likely scratch or abandoned per DOCS_RULES.md',
    }),
  },

  // ── Folder-based rules (high confidence for structural folders) ──

  {
    name: 'adr-folder',
    test: (block) => /\/adr(\/|$)/i.test(block.folder),
    classify: (block) => ({
      status: 'classified' as const,
      class: 'decision',
      confidence: 'high' as const,
      proposed_action: 'move',
      risk: 'low' as const,
      target_path: resolveTargetPath(block.path, '40-decisions'),
      reason: 'File is in an adr/ folder — ADRs belong in 40-decisions/ per DOCS_RULES.md',
    }),
  },

  {
    name: 'patterns-folder-in-architecture',
    test: (block) => /\/20-architecture\/patterns/i.test(block.folder) || /\/02-architecture\/patterns/i.test(block.folder),
    classify: (block) => ({
      status: 'classified' as const,
      class: 'canonical',
      confidence: 'high' as const,
      proposed_action: 'move',
      risk: 'low' as const,
      target_path: resolveTargetPath(block.path, '20-architecture/patterns'),
      reason: 'Architecture pattern file — belongs in 20-architecture/patterns/ per DOCS_RULES.md',
    }),
  },

  {
    name: 'prd-folder-active',
    test: (block) => /\/(prd|prds)(\/|$)/i.test(block.folder),
    classify: (block) => ({
      status: 'classified' as const,
      class: 'canonical',
      confidence: 'high' as const,
      proposed_action: 'move',
      risk: 'low' as const,
      target_path: resolveTargetPath(block.path, '35-prds'),
      reason: 'PRD file — belongs in 35-prds/ per DOCS_RULES.md folder map',
    }),
  },

  {
    name: 'contracts-folder',
    test: (block) => /\/contracts(\/|$)/i.test(block.folder),
    classify: (block) => ({
      status: 'classified' as const,
      class: 'canonical',
      confidence: 'high' as const,
      proposed_action: 'move',
      risk: 'low' as const,
      target_path: resolveTargetPath(block.path, '20-architecture'),
      reason: 'API contract file — belongs in 20-architecture/ per DOCS_RULES.md (technical system design)',
    }),
  },

  {
    name: 'agent-workflows-folder',
    test: (block) => /\/50-agent-workflows/i.test(block.folder),
    classify: () => ({
      status: 'classified' as const,
      class: 'canonical',
      confidence: 'high' as const,
      proposed_action: 'keep',
      risk: 'none' as const,
      reason: 'Already in correct canonical folder (50-agent-workflows/) per DOCS_RULES.md',
    }),
  },

  {
    name: 'archive-folder',
    test: (block) => /\/90-archive/i.test(block.folder),
    classify: () => ({
      status: 'classified' as const,
      class: 'archive',
      confidence: 'high' as const,
      proposed_action: 'keep',
      risk: 'none' as const,
      reason: 'Already in archive folder (90-archive/) per DOCS_RULES.md',
    }),
  },

  // ── Filename-based rules (medium confidence — may need review) ──

  {
    name: 'plan-file-name',
    test: (_, flags, path) => /^plan/i.test(basename(path || '', '.md')) || /-plan\.md$/i.test(path || ''),
    classify: () => ({
      status: 'classified' as const,
      class: 'stale',
      confidence: 'medium' as const,
      proposed_action: 'archive',
      risk: 'low' as const,
      reason: 'Filename matches plan pattern — likely old planning content per DOCS_RULES.md no-old-plans rule',
    }),
  },

  {
    name: 'fix-or-todo-file-name',
    test: (_, flags, path) => /^(fix[-_]|todo)/i.test(basename(path || '', '.md')),
    classify: () => ({
      status: 'classified' as const,
      class: 'stale',
      confidence: 'medium' as const,
      proposed_action: 'archive',
      risk: 'low' as const,
      reason: 'Filename matches fix/todo pattern — task-level content, not living documentation per DOCS_RULES.md',
    }),
  },

  // ── Root docs/ folder files (uncertain — need content analysis) ──

  {
    name: 'root-docs-file',
    test: (block) => block.folder === 'docs' || block.folder === '(root)',
    classify: () => ({
      status: 'classified' as const,
      class: null,
      confidence: 'low' as const,
      proposed_action: null,
      risk: null,
      reason: 'File is at docs/ root — needs content analysis to determine placement per DOCS_RULES.md',
    }),
  },

  // ── Non-canonical folder files (uncertain) ──

  {
    name: 'non-canonical-folder',
    test: (block) => !CANONICAL_FOLDERS.some(cf => block.folder.includes(cf)),
    classify: () => ({
      status: 'classified' as const,
      class: null,
      confidence: 'low' as const,
      proposed_action: null,
      risk: null,
      reason: 'File is in non-canonical folder — needs classification against target structure per DOCS_RULES.md',
    }),
  },
]

// ── Core Functions ─────────────────────────────────────────────

/**
 * Parse YAML blocks from DOCS_INVENTORY.md into typed InventoryBlock array.
 * Handles the markdown format: ```yaml ... ``` blocks under folder headings.
 */
export function parseInventory(filePath: string): InventoryBlock[] {
  const content = readFileSync(resolve(filePath), 'utf-8')
  const blocks: InventoryBlock[] = []

  // Split on yaml code fences
  const yamlBlocks = content.split('```yaml')

  for (const raw of yamlBlocks) {
    const endIdx = raw.indexOf('```')
    if (endIdx === -1) continue

    const yamlText = raw.slice(0, endIdx).trim()
    if (!yamlText) continue

    // Parse key: value lines into object
    const block: Partial<InventoryBlock> = {}

    for (const line of yamlText.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const key = line.slice(0, colonIdx).trim()
      let value = line.slice(colonIdx + 1).trim()

      // Handle array values: [] or [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim()
        value = inner ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : []
      }

      // Handle null values
      if (value === 'null') value = null

      // Handle numeric values
      if (key === 'size_kb' || key === 'lines') {
        value = value !== null ? Number(value) : null
      }

      block[key] = value
    }

    // Only add if it has an id field (valid inventory entry)
    if (block.id && typeof block.id === 'string' && block.id.startsWith('F')) {
      blocks.push(block as InventoryBlock)
    }
  }

  return blocks
}

/**
 * Write updated InventoryBlock array back to DOCS_INVENTORY.md.
 * Rebuilds the entire file from scratch with updated values.
 */
export function writeInventory(filePath: string, blocks: InventoryBlock[]): void {
  const resolved = resolve(filePath)

  // Group by folder for output structure
  const folders = new Map<string, InventoryBlock[]>()
  for (const block of blocks) {
    if (!folders.has(block.folder)) folders.set(block.folder, [])
    folders.get(block.folder)!.push(block)
  }

  // Build summary table
  let summaryTable = '| Folder | Total Files | Total Size (KB) |\n'
  summaryTable += '|--------|-------------|-----------------|\n'

  const sortedFolders = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [folder, entries] of sortedFolders) {
    const totalSize = Math.round(entries.reduce((sum, e) => sum + e.size_kb, 0) * 100) / 100
    summaryTable += `| ${folder} | ${entries.length} | ${totalSize} |\n`
  }

  // Build file content
  let output = '# DOCS_INVENTORY.md — File Inventory\n\n'
  output += '**Purpose:** Central state file containing YAML blocks per file with stable IDs. Source of truth for all reorganization state.\n'
  output += '**Updated By:** Phase 1 scan script, then classify-inventory.ts during classification\n'
  output += `**Last Scan:** ${new Date().toISOString()}\n\n`
  output += '---\n\n'

  // Folder summary table
  output += '## Folder Summary\n\n'
  output += summaryTable + '\n'

  // File entries grouped by folder
  output += '## File Entries\n\n'

  for (const [folder, entries] of sortedFolders) {
    output += `### ${folder}\n\n`

    for (const entry of entries) {
      output += '```yaml\n'
      output += formatYamlBlock(entry) + '\n'
      output += '```\n\n'
    }
  }

  writeFileSync(resolved, output, 'utf-8')
}

/**
 * Format a single InventoryBlock as YAML text.
 */
function formatYamlBlock(block: InventoryBlock): string {
  const lines: string[] = []

  const fields: (keyof InventoryBlock)[] = [
    'id', 'path', 'folder', 'size_kb', 'lines', 'status', 'class', 'confidence',
    'proposed_action', 'approval', 'risk', 'reason', 'questions', 'related_files',
    'target_path', 'current_step', 'blocker', 'last_updated',
  ]

  for (const field of fields) {
    const value = block[field]
    lines.push(`${field}: ${formatYamlValue(value, field)}`)
  }

  return lines.join('\n')
}

/**
 * Format a value for YAML output. Handles null, arrays, strings, numbers.
 */
function formatYamlValue(value: unknown, field?: string): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  // Arrays: [] or [item1, item2]
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(item => typeof item === 'string' && item.includes(' ') ? `"${item}"` : String(item))
    return `[${items.join(', ')}]`
  }

  // Strings: quote if contains special characters or spaces in certain fields
  if (typeof value === 'string') {
    if ((field === 'reason' || field === 'blocker') && (value.includes(':') || value.includes('\n'))) {
      return `"${value.replace(/"/g, '\\"')}"`
    }
    return value
  }

  return String(value)
}

/**
 * Resolve target path: take the basename of source and place it in target folder.
 */
function resolveTargetPath(sourcePath: string, targetFolder: string): string {
  const name = basename(sourcePath)
  // Extract docs/ prefix from source if present
  const docsPrefix = sourcePath.startsWith('docs/') ? 'docs/' : ''
  return `${docsPrefix}${targetFolder}/${name}`
}

/**
 * Apply deterministic classification rules to a single block.
 * Returns the classification result or null if no rule matched with confidence.
 */
export function classifyBlock(
  block: InventoryBlock,
  flags?: Record<string, boolean>,
): { classified: true; updates: Partial<InventoryBlock> } | { classified: false; suggestedClasses: string[]; ruleMatches: string[] } {
  const matches: string[] = []

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test(block, flags, block.path)) {
      matches.push(rule.name)
      const updates = rule.classify(block)

      // If the rule produced a definitive classification (class set and confidence high/medium), use it
      if (updates.class && (updates.confidence === 'high' || updates.confidence === 'medium')) {
        return { classified: true, updates }
      }

      // Rule matched but couldn't decide — collect suggestions
    }
  }

  // No definitive rule matched — mark as uncertain
  const suggested = deriveSuggestedClasses(block, matches)

  return { classified: false, suggestedClasses: suggested, ruleMatches: matches }
}

/**
 * Derive suggested classification classes from block metadata and rule matches.
 */
function deriveSuggestedClasses(block: InventoryBlock, ruleMatches: string[]): string[] {
  const suggestions = new Set<string>()

  // Based on folder patterns
  if (/\/(adr|decisions)/i.test(block.folder)) suggestions.add('decision')
  if (/\/(prd|prds)/i.test(block.folder)) suggestions.add('canonical')
  if (/\/patterns/i.test(block.folder)) suggestions.add('canonical')

  // Based on filename patterns
  const name = basename(block.path, '.md').toLowerCase()
  if (name.startsWith('readme')) suggestions.add('canonical')
  if (name.startsWith('plan') || name.includes('-plan')) suggestions.add('stale')
  if (/^(fix|todo)/.test(name)) suggestions.add('stale')

  // Root files or non-canonical folders could be anything
  if (!suggestions.size) {
    suggestions.add('canonical')
    suggestions.add('archive')
    suggestions.add('experiment')
  }

  return [...suggestions]
}

/**
 * Run auto-classification on all blocks. Applies deterministic rules, writes back results.
 * Returns count of classified vs uncertain entries.
 */
export function runAutoClassification(
  inventoryPath: string,
  docsRoot?: string,
): { total: number; classified: number; uncertain: number } {
  const blocks = parseInventory(inventoryPath)
  let classifiedCount = 0
  let uncertainCount = 0

  // Load heuristic flags from scan-inventory if available (re-derive them)
  const flagMap = deriveFlags(blocks, docsRoot || resolve(dirname(inventoryPath), '..'))

  for (const block of blocks) {
    const result = classifyBlock(block, flagMap.get(block.path))

    if (result.classified) {
      Object.assign(block, result.updates)
      block.last_updated = new Date().toISOString()
      classifiedCount++
    } else {
      // Only set low if not already classified by a prior agent run.
      // This preserves agent work across re-runs while still catching new files (confidence: null).
      if (!block.confidence || block.confidence === 'low') {
        block.status = 'classified' as const
        block.confidence = 'low' as const
        block.reason = `Uncertain — needs agent review. Suggested classes: ${result.suggestedClasses.join(', ')}`
        block.last_updated = new Date().toISOString()
        uncertainCount++
      }
    }
  }

  // Write updated inventory back
  writeInventory(inventoryPath, blocks)

  return { total: blocks.length, classified: classifiedCount, uncertain: uncertainCount }
}

/**
 * Derive heuristic flags for all blocks by re-scanning file metadata.
 */
function deriveFlags(blocks: InventoryBlock[], projectRoot?: string): Map<string, Record<string, boolean>> {
  const flagMap = new Map<string, Record<string, boolean>>()
  const tempDraftPattern = /^(draft|temp|tmp|scratch|wip|todo)/i

  // Duplicate basename detection
  const basenameCount = new Map<string, number>()
  for (const block of blocks) {
    const name = basename(block.path)
    basenameCount.set(name, (basenameCount.get(name) ?? 0) + 1)
  }

  for (const block of blocks) {
    const flags: Record<string, boolean> = {}
    const nameWithoutExt = basename(block.path, '.md')

    flags.largeFile = block.size_kb > 50
    flags.isDraftOrTemp = tempDraftPattern.test(nameWithoutExt)
    flags.isDuplicateBasename = (basenameCount.get(basename(block.path)) ?? 0) > 1

    flagMap.set(block.path, flags)
  }

  return flagMap
}

/**
 * Output uncertain entries as JSONL to stdout for agent batch review.
 * Each line includes the block data plus doc analysis if available.
 */
export function outputUncertainAsJsonl(
  inventoryPath: string,
  batchSize: number = 5,
): UncertainEntry[] {
  const blocks = parseInventory(inventoryPath)

  // Find entries that are uncertain (low confidence or null class)
  const uncertain = blocks.filter(b => b.confidence === 'low' || b.class === null)

  // Take only the requested batch size
  const batch = uncertain.slice(0, batchSize)

  const result: UncertainEntry[] = []

  for (const block of batch) {
    const entry: UncertainEntry = { ...block, suggestedClasses: [], ruleMatches: [] }

    // Try to parse the doc file for content analysis
    try {
      const docsRoot = resolve(dirname(inventoryPath), '..')
      const fullPath = join(docsRoot, block.path)
      const analysis = parseDocFile(fullPath)
      entry.docAnalysis = analysis
    } catch {
      // File may not exist or be unreadable — skip doc analysis
    }

    // Derive suggested classes and rule matches
    const flagMap = deriveFlags([block])
    const result2 = classifyBlock(block, flagMap.get(block.path))
    if (!result2.classified) {
      entry.suggestedClasses = result2.suggestedClasses
      entry.ruleMatches = result2.ruleMatches
    }

    // Output as JSONL line to stdout
    console.log(JSON.stringify(entry))
    result.push(entry)
  }

  return result
}

// ── CLI Entry Point ────────────────────────────────────────────

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const docsDir = args[0] ? resolve(args[0]) : resolve('docs')
  const inventoryPath = join(docsDir, '_system', 'DOCS_INVENTORY.md')

  // Parse flags
  const autoMode = args.includes('--auto')
  const uncertainMode = args.includes('--uncertain')
  const batchSizeMatch = args.find(a => a.startsWith('--batch-size='))
  const batchSize = batchSizeMatch ? parseInt(batchSizeMatch.split('=')[1], 10) : 5

  if (!autoMode && !uncertainMode) {
    console.log('Usage:')
    console.log('  npx tsx scripts/classify-inventory.ts docs --auto              # auto-classify obvious files')
    console.log('  npx tsx scripts/classify-inventory.ts docs --uncertain         # output uncertain entries as JSONL')
    console.log('  npx tsx scripts/classify-inventory.ts docs --uncertain --batch-size=5')
    process.exit(1)
  }

  if (!existsSync(inventoryPath)) {
    throw new Error(`Inventory file not found: ${inventoryPath}\nRun scan-inventory.ts first.`)
  }

  // ── Auto mode ──
  if (autoMode) {
    console.log(`🏷️  Running auto-classification on: ${inventoryPath}`)

    const result = runAutoClassification(inventoryPath, resolve(docsDir))

    console.log(`\n📊 Results:`)
    console.log(`   Total entries:     ${result.total}`)
    console.log(`   Auto-classified:   ${result.classified} (high/medium confidence rules matched)`)
    console.log(`   Uncertain:         ${result.uncertain} (needs agent review — low confidence or no rule match)`)

    if (result.uncertain > 0) {
      console.log(`\n💡 Next step: Run with --uncertain to review the ${result.uncertain} uncertain entries in batches.`)
    } else {
      console.log('\n✅ All entries classified — no uncertain entries remaining.')
    }

    return
  }

  // ── Uncertain mode (JSONL output) ──
  if (uncertainMode) {
    console.error(`🔍 Outputting ${batchSize} uncertain entries as JSONL...`)
    const entries = outputUncertainAsJsonl(inventoryPath, batchSize)
    console.error(`\n📝 Output ${entries.length} entry/entries to stdout.`)

    if (entries.length === 0) {
      console.error('✅ No uncertain entries remaining — classification complete.')
    } else {
      console.error('\n💡 Agent: Review these entries, update their YAML blocks in DOCS_INVENTORY.md with class/reason/action.')
    }
  }
}

// Run if executed directly via tsx
if (import.meta.url.includes('classify-inventory') && process.argv[1]?.endsWith('classify-inventory.ts')) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
