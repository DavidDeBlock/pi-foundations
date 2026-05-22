#!/usr/bin/env tsx
/**
 * scripts/scan-inventory.ts — Phase 1: Scan docs/ and produce DOCS_INVENTORY.md.
 *
 * Recursively scans a docs directory, collects file metadata (size, lines, preview),
 * preserves existing YAML classification blocks from previous runs,
 * and writes a structured inventory file.
 *
 * Usage:
 *   npx tsx scripts/scan-inventory.ts [docs-root]           # Scan docs/ (default)
 *   npx tsx scripts/scan-inventory.ts /path/to/docs        # Scan specific directory
 *
 * @category maintenance
 * @usage npx tsx scripts/scan-inventory.ts [docs-root]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { resolve, join, basename, relative } from 'path'

// ── Types ──────────────────────────────────────────────────────

export interface FileEntry {
  path: string          // relative to project root (e.g., "docs/03-features/README.md")
  size_kb: number
  lines: number
  preview: string[]     // first 5 lines
  flags?: {
    largeFile?: boolean
    isDraftOrTemp?: boolean
    isDuplicateBasename?: boolean
  }
}

export type ClassificationStatus = 'scanned' | 'classified' | 'approved' | 'migrated'

export interface InventoryBlock {
  id: string
  path: string
  folder: string
  size_kb: number
  lines: number
  status: ClassificationStatus
  class: string | null
  confidence: string | null
  proposed_action: string | null
  approval: string | null
  risk: string | null
  reason: string | null
  questions: string[]
  related_files: string[]
  target_path: string | null
  current_step: string | null
  blocker: string | null
  last_updated: string
}

// Fields that survive a re-scan (classification state)
const PRESERVED_FIELDS = [
  'status',
  'class',
  'confidence',
  'proposed_action',
  'approval',
  'risk',
  'reason',
  'questions',
  'related_files',
  'target_path',
  'current_step',
  'blocker',
] as const

export type PreservedFields = Pick<InventoryBlock, typeof PRESERVED_FIELDS[number]>

export interface InventoryResult {
  blocks: Record<string, InventoryBlock>
  summaryTable: string
}

// ── Core Functions ─────────────────────────────────────────────

/**
 * Parse YAML blocks from an existing DOCS_INVENTORY.md file.
 * Returns a map keyed by `path` so we can preserve classification state across scans.
 */
export function loadExistingInventory(inventoryPath: string): Map<string, PreservedFields> {
  const result = new Map<string, PreservedFields>()

  let content: string
  try {
    content = readFileSync(inventoryPath, 'utf-8')
  } catch {
    return result // no existing inventory — start fresh
  }

  // Extract all ```yaml ... ``` blocks
  const yamlRegex = /```yaml\n([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = yamlRegex.exec(content)) !== null) {
    const blockText = match[1]
    const parsed: Partial<InventoryBlock> = {}

    for (const line of blockText.split('\n')) {
      const colonIdx = line.indexOf(': ')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const rawValue = line.slice(colonIdx + 2).trim()

      // Parse value based on type
      let value: unknown = rawValue
      if (rawValue === '[]') {
        value = []
      } else if (rawValue === 'null') {
        value = null
      }

      parsed[key as keyof InventoryBlock] = value as never
    }

    if (parsed.path) {
      const preserved: Partial<PreservedFields> = {}
      for (const field of PRESERVED_FIELDS) {
        preserved[field] = parsed[field as keyof typeof parsed]
      }
      result.set(parsed.path, preserved as PreservedFields)
    }
  }

  return result
}

/**
 * Recursively scan a directory for .md files, excluding specified subdirectories.
 */
export function scanFiles(rootDir: string, excludeDirs: string[] = []): FileEntry[] {
  const entries: FileEntry[] = []
  rootDir = resolve(rootDir)
  // Project root is parent of docs/
  const projectRoot = resolve(join(rootDir, '..'))

  function walk(dir: string) {
    const items = readdirSync(dir, { withFileTypes: true })

    for (const item of items) {
      // Skip excluded directories
      if (excludeDirs.includes(item.name)) continue

      const fullPath = join(dir, item.name)

      if (item.isDirectory()) {
        walk(fullPath)
      } else if (item.isFile() && item.name.endsWith('.md')) {
        entries.push(collectMetadata(fullPath, projectRoot))
      }
    }
  }

  walk(rootDir)
  return entries
}

/**
 * Collect metadata for a single file: path, size_kb, lines, first 5 lines preview.
 */
export function collectMetadata(filePath: string, projectRoot?: string): FileEntry {
  const stat = statSync(filePath)
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

  // Read only first 5 lines for preview (sampling strategy for large files)
  const preview = lines.slice(0, 5)

  // Use relative path from project root if provided
  const relPath = projectRoot ? relative(projectRoot, filePath) : filePath

  return {
    path: relPath,
    size_kb: Math.round((stat.size / 1024) * 100) / 100,
    lines: lines.length,
    preview,
  }
}

/**
 * Apply heuristic flags to entries in-place.
 */
export function applyHeuristics(entries: FileEntry[], largeThresholdKB: number = 50): void {
  // ── Large file flag ──
  for (const entry of entries) {
    if (!entry.flags) entry.flags = {}
    entry.flags.largeFile = entry.size_kb > largeThresholdKB
  }

  // ── Temp/draft name pattern ──
  const tempDraftPattern = /^(draft|temp|tmp|scratch|wip|todo)/i
  for (const entry of entries) {
    if (!entry.flags) entry.flags = {}
    const nameWithoutExt = basename(entry.path, '.md')
    entry.flags.isDraftOrTemp = tempDraftPattern.test(nameWithoutExt)
  }

  // ── Duplicate basename detection ──
  const basenameCount = new Map<string, number>()
  for (const entry of entries) {
    const name = basename(entry.path)
    basenameCount.set(name, (basenameCount.get(name) ?? 0) + 1)
  }

  for (const entry of entries) {
    if (!entry.flags) entry.flags = {}
    const name = basename(entry.path)
    entry.flags.isDuplicateBasename = (basenameCount.get(name) ?? 0) > 1
  }
}

/**
 * Generate inventory: assign stable IDs, create YAML blocks grouped by folder, summary table.
 * Preserves classification state from previous scan when paths still exist.
 */
export function generateInventory(
  entries: FileEntry[],
  largeThresholdKB: number = 50,
  previousClassifications?: Map<string, PreservedFields>,
): InventoryResult {
  applyHeuristics(entries, largeThresholdKB)

  const blocks: Record<string, InventoryBlock> = {}
  const now = new Date().toISOString()

  // Group by folder for summary
  const folderStats = new Map<string, { count: number; totalSizeKb: number }>()

  let idCounter = 1

  // Sort entries by path for stable ordering
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))

  for (const entry of sorted) {
    const id = `F${String(idCounter).padStart(4, '0')}`
    idCounter++

    // Extract folder from relative path (e.g., "docs/issues/foo.md" → "docs/issues")
    const folderParts = entry.path.split('/')
    const folder = folderParts.length > 1 ? folderParts.slice(0, -1).join('/') : '(root)'

    // Preserve classification state from previous scan if path still exists
    const prev = previousClassifications?.get(entry.path)

    blocks[id] = {
      id,
      path: entry.path,
      folder,
      size_kb: entry.size_kb,
      lines: entry.lines,
      status: prev?.status ?? 'scanned',
      class: prev?.class ?? null,
      confidence: prev?.confidence ?? null,
      proposed_action: prev?.proposed_action ?? null,
      approval: prev?.approval ?? null,
      risk: prev?.risk ?? null,
      reason: prev?.reason ?? null,
      questions: prev?.questions ?? [],
      related_files: prev?.related_files ?? [],
      target_path: prev?.target_path ?? null,
      current_step: prev?.current_step ?? null,
      blocker: prev?.blocker ?? null,
      last_updated: now,
    }

    // Accumulate folder stats
    const existing = folderStats.get(folder) ?? { count: 0, totalSizeKb: 0 }
    folderStats.set(folder, {
      count: existing.count + 1,
      totalSizeKb: Math.round((existing.totalSizeKb + entry.size_kb) * 100) / 100,
    })
  }

  // Generate summary table
  const sortedFolders = [...folderStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  let summaryTable = '| Folder | Total Files | Total Size (KB) |\n'
  summaryTable += '|--------|-------------|-----------------|\n'
  for (const [folder, stats] of sortedFolders) {
    summaryTable += `| ${folder} | ${stats.count} | ${stats.totalSizeKb} |\n`
  }

  return { blocks, summaryTable }
}

/**
 * Format inventory result as markdown content.
 */
function formatInventoryMarkdown(result: InventoryResult): string {
  let output = '# DOCS_INVENTORY.md — File Inventory\n\n'
  output += '**Purpose:** Central state file containing YAML blocks per file with stable IDs. Source of truth for all reorganization state.\n'
  output += '**Updated By:** Phase 1 scan script, then agent during classification\n'
  output += `**Last Scan:** ${new Date().toISOString()}\n\n`
  output += '---\n\n'

  // Folder summary table
  output += '## Folder Summary\n\n'
  output += result.summaryTable + '\n'

  // File entries grouped by folder
  output += '## File Entries\n\n'

  const blocks = Object.values(result.blocks)
  const folders = new Map<string, InventoryBlock[]>()

  for (const block of blocks) {
    if (!folders.has(block.folder)) folders.set(block.folder, [])
    folders.get(block.folder)!.push(block)
  }

  // Sort folder names and output groups
  const sortedFolders = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  for (const [folder, entries] of sortedFolders) {
    output += `### ${folder}\n\n`

    for (const entry of entries) {
      output += '```yaml\n'
      output += `id: ${entry.id}\n`
      output += `path: ${entry.path}\n`
      output += `folder: ${entry.folder}\n`
      output += `size_kb: ${entry.size_kb}\n`
      output += `lines: ${entry.lines}\n`
      output += `status: ${entry.status}\n`
      output += `class: ${entry.class ?? 'null'}\n`
      output += `confidence: ${entry.confidence ?? 'null'}\n`
      output += `proposed_action: ${entry.proposed_action ?? 'null'}\n`
      output += `approval: ${entry.approval ?? 'null'}\n`
      output += `risk: ${entry.risk ?? 'null'}\n`
      output += `reason: ${entry.reason ?? 'null'}\n`
      output += `questions: []\n`
      output += `related_files: []\n`
      output += `target_path: ${entry.target_path ?? 'null'}\n`
      output += `current_step: ${entry.current_step ?? 'null'}\n`
      output += `blocker: ${entry.blocker ?? 'null'}\n`
      output += `last_updated: ${entry.last_updated}\n`
      output += '```\n\n'
    }
  }

  return output
}

// ── Output Generator ───────────────────────────────────────────

/**
 * Generate output for scan-inventory.
 * Writes DOCS_INVENTORY.md and returns console summary as string.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false
): string {
  if (help) {
    return `Usage: npx tsx scripts/scan-inventory.ts [docs-root]

Phase 1: Scan docs/ and produce DOCS_INVENTORY.md.

Recursively scans a docs directory, collects file metadata (size, lines, preview),
preserves existing YAML classification blocks from previous runs,
and writes a structured inventory file.

Arguments:
  docs-root     Path to docs directory (default: ./docs)

Options:
  --json        Output as JSON (not supported for this script — always writes file)
  --help        Show this help message

Output:
  Writes DOCS_INVENTORY.md to <docs-root>/_system/
  Prints summary to stdout.`
  }

  const docsDir = resolve(targetPath || 'docs')
  const inventoryPath = join(docsDir, '_system', 'DOCS_INVENTORY.md')

  // Load existing classifications to preserve across re-scans
  const previousClassifications = loadExistingInventory(inventoryPath)

  // Scan excluding _system/ (the system dir holds state files, not content to classify)
  const entries = scanFiles(docsDir, ['_system'])

  // Generate inventory with stable IDs and YAML blocks
  const result = generateInventory(entries, 50, previousClassifications)

  // Write output
  writeFileSync(inventoryPath, formatInventoryMarkdown(result), 'utf-8')

  // Build summary
  let preserved = 0, fresh = 0
  for (const block of Object.values(result.blocks)) {
    if (block.class !== null || block.status !== 'scanned') {
      preserved++
    } else {
      fresh++
    }
  }
  const folders = new Set(Object.values(result.blocks).map(b => b.folder))

  // Return summary as string
  return [
    `📋 Scanning inventory from: ${docsDir}`,
    previousClassifications.size > 0 ? `♻️  Loaded ${previousClassifications.size} existing classification(s)` : '',
    `📄 Found ${entries.length} .md files`,
    `🏷️ Assigned IDs: F${Object.keys(result.blocks).length > 0 ? Object.keys(result.blocks)[0].slice(1) : '—'} to F${Object.keys(result.blocks).length > 0 ? Object.keys(result.blocks)[Object.keys(result.blocks).length - 1].slice(1) : '—'}`,
    `✅ Wrote inventory to: ${inventoryPath}`,
    `📊 Preserved: ${preserved} classification(s), Fresh: ${fresh}`,
    `📁 Folders found: ${folders.size} (${[...folders].join(', ')})`,
  ].filter(Boolean).join('\n') + '\n'
}

// ── CLI Entry Point ────────────────────────────────────────────
import { runScriptIfDirect, parseArgs, writeOutput } from '../_lib/script-runner.js'

/** Main entry point for CLI execution (used by tests and direct execution) */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args, { defaultPath: 'docs' })

  if (parsed.help) {
    writeOutput(generateOutput(parsed.targetPath, false, true))
    return
  }

  try {
    const output = generateOutput(parsed.targetPath, parsed.json)
    writeOutput(output)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}

runScriptIfDirect(
  generateOutput,
  'scan-inventory.ts',
  { defaultPath: 'docs' }
)
