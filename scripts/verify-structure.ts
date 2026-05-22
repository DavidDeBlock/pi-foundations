#!/usr/bin/env tsx
/**
 * scripts/verify-structure.ts — Verify docs/ folder structure against canonical rules.
 *
 * Checks that all folders exist with correct numbering (00-current through 90-archive),
 * identifies orphaned files at root level, detects non-canonical folders,
 * and generates a DOCS_INDEX.md in _system/. Outputs pass/fail status.
 *
 * Usage:
 *   npx tsx scripts/verify-structure.ts [docs-root]           # Verify docs/ (default)
 *   npx tsx scripts/verify-structure.ts /path/to/docs        # Specific directory
 *
 * @category validation
 * @usage npx tsx scripts/verify-structure.ts [docs-root]
 */

import { readdirSync, statSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'

// ── Types ──────────────────────────────────────────────────────

export interface FolderEntry {
  name: string
  fileCount: number
}

export interface ScanResult {
  folders: FolderEntry[]
  rootFiles: string[]    // .md files directly in docs/ root (not in subfolder)
}

export interface OrphanResult {
  orphanRootFiles: string[]     // .md files at docs/ root level
  orphanFolders: { name: string; fileCount: number }[]  // non-canonical folders with .md files
}

export interface Violation {
  folder: string
  rule: string
  message: string
}

export interface ValidationResult {
  scan: ScanResult
  orphaned: OrphanResult
  emptyFolders: FolderEntry[]
  violations: Violation[]
  indexContent: string
  passed: boolean
}

// ── Canonical folder names from DOCS_RULES.md ──────────────────
const CANONICAL_FOLDERS = [
  '00-current',
  '10-domain',
  '20-architecture',
  '30-flows',
  '40-decisions',
  '50-agent-workflows',
  '90-archive',
]

// Living state folders — current truth, no old plans allowed
const LIVING_STATE_FOLDERS = [
  '00-current',
  '10-domain',
  '20-architecture',
  '30-flows',
  '40-decisions',
  '50-agent-workflows',
]

// Patterns that indicate old plan/scratch content in living state folders
const OLD_PLAN_PATTERNS = [
  /^plan/i,
  /^fix[-_]/i,
  /^todo/i,
  /^draft/i,
  /^wip/i,
  /-plan\./i,
  /-fix\./i,
]

const EXCLUDED_DIRS = ['_system']

// ── Core Functions ─────────────────────────────────────────────

/**
 * Scan docs/ directory structure: collect folders with file counts,
 * and list root-level .md files. Excludes _system/.
 */
export function scanDocsStructure(docsRoot: string): ScanResult {
  docsRoot = resolve(docsRoot)
  const folders: FolderEntry[] = []
  const rootFiles: string[] = []

  const items = readdirSync(docsRoot, { withFileTypes: true })

  for (const item of items) {
    // Skip excluded directories
    if (EXCLUDED_DIRS.includes(item.name)) continue

    const fullPath = join(docsRoot, item.name)

    if (item.isDirectory()) {
      const mdFiles = readdirSync(fullPath).filter(
        f => statSync(join(fullPath, f)).isFile() && f.endsWith('.md')
      )
      folders.push({ name: item.name, fileCount: mdFiles.length })
    } else if (item.isFile() && item.name.endsWith('.md')) {
      rootFiles.push(item.name)
    }
  }

  return { folders, rootFiles }
}

/**
 * Find folders with zero .md files (empty canonical or non-canonical folders).
 */
export function findEmptyFolders(scanResult: ScanResult): FolderEntry[] {
  return scanResult.folders.filter(f => f.fileCount === 0)
}

/**
 * Verify folder constraints from DOCS_RULES.md:
 * - 00-current/ has max 3-5 files
 * - No old plan/scratch files in living state folders (00-current through 50-agent-workflows)
 */
export function verifyFolderConstraints(scanResult: ScanResult, docsRoot: string): Violation[] {
  const violations: Violation[] = []
  docsRoot = resolve(docsRoot)

  for (const folder of scanResult.folders) {
    // Rule: 00-current/ max 5 files
    if (folder.name === '00-current' && folder.fileCount > 5) {
      violations.push({
        folder: folder.name,
        rule: 'max-files',
        message: `00-current/ has ${folder.fileCount} files (max 3-5 allowed). Remove old plans or deep implementation notes.`,
      })
    }

    // Rule: No old plan-like files in living state folders
    if (LIVING_STATE_FOLDERS.includes(folder.name)) {
      const folderPath = join(docsRoot, folder.name)
      try {
        const files = readdirSync(folderPath).filter(
          f => statSync(join(folderPath, f)).isFile() && f.endsWith('.md')
        )

        for (const file of files) {
          if (OLD_PLAN_PATTERNS.some(pattern => pattern.test(file))) {
            violations.push({
              folder: folder.name,
              rule: 'no-old-plans',
              message: `"${file}" looks like an old plan/scratch file in living state folder ${folder.name}/. Move to 90-archive/.`,
            })
          }
        }
      } catch {
        // Folder may not exist or be unreadable — skip
      }
    }
  }

  return violations
}

/**
 * Detect orphaned files: root-level .md files and non-canonical folders.
 * Canonical folders are the numbered ones from DOCS_RULES.md (00-current through 90-archive).
 */
export function detectOrphanedFiles(scanResult: ScanResult, docsRoot: string): OrphanResult {
  const orphanFolders: { name: string; fileCount: number }[] = []

  for (const folder of scanResult.folders) {
    if (!CANONICAL_FOLDERS.includes(folder.name)) {
      // Only report folders that actually have .md files
      if (folder.fileCount > 0) {
        orphanFolders.push({ name: folder.name, fileCount: folder.fileCount })
      }
    }
  }

  return {
    orphanRootFiles: scanResult.rootFiles,
    orphanFolders,
  }
}

/**
 * Generate DOCS_INDEX.md from current structure.
 * Includes folder summary table with file counts and status indicators.
 */
export function generateDocsIndex(scanResult: ScanResult, docsRoot: string): string {
  const now = new Date().toISOString()
  let output = '# DOCS_INDEX.md — Documentation Structure Index\n\n'
  output += `**Generated:** ${now}\n`
  output += `**Source:** Auto-generated by verify-structure.ts\n\n`
  output += '---\n\n'

  // ── System folder note ──
  output += '> **Note:** `_system/` is excluded from content scan (holds state files: DOCS_RULES.md, DOCS_INVENTORY.md, work-sessions/).\n>\n'

  // ── Folder Summary Table ──
  output += '## Folder Summary\n\n'
  output += '| Status | Folder | Files | Type |\n'
  output += '|--------|--------|-------|------|\n'

  const emptyFolders = findEmptyFolders(scanResult)
  const violations = verifyFolderConstraints(scanResult, docsRoot)
  const orphaned = detectOrphanedFiles(scanResult, docsRoot)

  // Sort folders: canonical first (by number), then non-canonical
  const sortedFolders = [...scanResult.folders].sort((a, b) => {
    const aIdx = CANONICAL_FOLDERS.indexOf(a.name)
    const bIdx = CANONICAL_FOLDERS.indexOf(b.name)
    if (aIdx === -1 && bIdx === -1) return a.name.localeCompare(b.name)
    if (aIdx === -1) return 1
    if (bIdx === -1) return -1
    return aIdx - bIdx
  })

  for (const folder of sortedFolders) {
    const isEmpty = emptyFolders.some(f => f.name === folder.name)
    const hasViolation = violations.some(v => v.folder === folder.name)
    const isOrphan = orphaned.orphanFolders.some(f => f.name === folder.name)

    let status: string
    if (hasViolation) {
      status = '❌'
    } else if (isEmpty || isOrphan) {
      status = '⚠️'
    } else {
      status = '✅'
    }

    const type = CANONICAL_FOLDERS.includes(folder.name)
      ? folder.name === '90-archive' ? 'archive'
        : LIVING_STATE_FOLDERS.includes(folder.name) ? 'canonical'
        : 'canonical'
      : 'orphan'

    output += `| ${status} | \`${folder.name}/\` | ${folder.fileCount} | ${type} |\n`
  }

  // ── Root-level files ──
  if (scanResult.rootFiles.length > 0) {
    output += '\n## Root-Level Files ⚠️\n\n'
    output += 'These `.md` files are at `docs/` root and not in any numbered folder:\n\n'
    for (const file of scanResult.rootFiles.sort()) {
      output += `- \`${file}\`\n`
    }
  }

  // ── Violations section ──
  if (violations.length > 0) {
    output += '\n## Violations ❌\n\n'
    for (const v of violations) {
      output += `- **${v.folder}/** [${v.rule}]: ${v.message}\n`
    }
  }

  // ── Empty folders section ──
  if (emptyFolders.length > 0) {
    output += '\n## Empty Folders ⚠️\n\n'
    for (const f of emptyFolders) {
      output += `- \`${f.name}/\` (${f.fileCount} files)\n`
    }
  }

  // ── Orphaned folders section ──
  if (orphaned.orphanFolders.length > 0) {
    output += '\n## Non-Canonical Folders ⚠️\n\n'
    output += 'These folders exist but are not part of the canonical structure:\n\n'
    for (const f of orphaned.orphanFolders) {
      output += `- \`${f.name}/\` (${f.fileCount} files)\n`
    }
  }

  return output
}

/**
 * Run full validation: scan, detect orphans, find empty folders,
 * verify constraints, and generate index.
 */
export function runValidation(docsRoot: string): ValidationResult {
  docsRoot = resolve(docsRoot)

  const scan = scanDocsStructure(docsRoot)
  const orphaned = detectOrphanedFiles(scan, docsRoot)
  const emptyFolders = findEmptyFolders(scan)
  const violations = verifyFolderConstraints(scan, docsRoot)
  const indexContent = generateDocsIndex(scan, docsRoot)

  return {
    scan,
    orphaned,
    emptyFolders,
    violations,
    indexContent,
    passed: violations.length === 0,
  }
}

// ── Output Generator ───────────────────────────────────────────

/**
 * Generate output for verify-structure.
 * Writes DOCS_INDEX.md and returns console summary as string.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false
): string {
  if (help) {
    return `Usage: npx tsx scripts/verify-structure.ts [docs-root]

Verify docs/ folder structure against canonical rules.

Checks that all folders exist with correct numbering (00-current through 90-archive),
identifies orphaned files at root level, detects non-canonical folders,
and generates a DOCS_INDEX.md in _system/. Outputs pass/fail status.

Arguments:
  docs-root     Path to docs directory (default: ./docs)

Options:
  --json        Output as JSON (not supported for this script — always writes file)
  --help        Show this help message

Output:
  Writes DOCS_INDEX.md to <docs-root>/_system/
  Prints validation summary to stdout.`
  }

  const docsDir = resolve(targetPath || 'docs')

  const result = runValidation(docsDir)

  // ── Summary ──
  const totalFolders = result.scan.folders.length
  const totalRootFiles = result.scan.rootFiles.length
  const orphanFolderCount = result.orphaned.orphanFolders.length
  const emptyCount = result.emptyFolders.length
  const violationCount = result.violations.length

  // ── Write DOCS_INDEX.md ──
  const indexPath = join(docsDir, '_system', 'DOCS_INDEX.md')
  writeFileSync(indexPath, result.indexContent, 'utf-8')

  // Build summary lines
  const lines: string[] = [
    `🔍 Verifying structure at: ${docsDir}`,
    '',
    `📁 Folders scanned: ${totalFolders}`,
    `📄 Root-level .md files: ${totalRootFiles}`,
    `⚠️  Orphan folders (non-canonical): ${orphanFolderCount}`,
    `⚠️  Empty folders: ${emptyCount}`,
    `❌ Violations: ${violationCount}`,
    '',
    `📝 Generated: ${indexPath}`,
  ]

  // ── Violations detail ──
  if (result.violations.length > 0) {
    lines.push('── Violations ─────────────────────────────────────')
    for (const v of result.violations) {
      lines.push(`  ❌ [${v.rule}] ${v.folder}/: ${v.message}`)
    }
    lines.push('')
  }

  // ── Orphaned files detail ──
  if (result.orphaned.orphanRootFiles.length > 0) {
    lines.push('── Orphan Root Files ─────────────────────────────')
    for (const f of result.orphaned.orphanRootFiles.sort()) {
      lines.push(`  ⚠️  ${f}`)
    }
    lines.push('')
  }

  if (result.orphaned.orphanFolders.length > 0) {
    lines.push('── Orphan Folders ────────────────────────────────')
    for (const f of result.orphaned.orphanFolders.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ⚠️  ${f.name}/ (${f.fileCount} files)`)
    }
    lines.push('')
  }

  if (result.emptyFolders.length > 0) {
    lines.push('── Empty Folders ─────────────────────────────────')
    for (const f of result.emptyFolders.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  ⚠️  ${f.name}/`)
    }
    lines.push('')
  }

  // ── Final status ──
  if (result.passed) {
    lines.push('\n✅ Structure validation PASSED — no violations found.')
  } else {
    lines.push(`\n❌ Structure validation FAILED — ${violationCount} violation(s) found.`)
  }

  return lines.join('\n') + '\n'
}

// ── CLI Entry Point ───────────────────────────────────────────
import { runScriptIfDirect, parseArgs, writeOutput } from './lib/script-runner.js'

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
  'verify-structure.ts',
  { defaultPath: 'docs' }
)
