#!/usr/bin/env tsx
/**
 * scripts/verify-inventory-drift.ts — Compare DOCS_INVENTORY.md paths against actual filesystem.
 *
 * Reads all YAML blocks from DOCS_INVENTORY.md, extracts the `path:` field for each entry,
 * and checks if that file actually exists on disk (relative to docs/ root).
 * Also discovers .md files on disk not covered by any inventory entry.
 *
 * Usage:
 *   npx tsx scripts/verify-inventory-drift.ts [docs-root]    # Check drift
 *
 * @category validation
 * @usage npx tsx scripts/verify-inventory-drift.ts [docs-root]
 */

import { readdirSync, readFileSync } from 'fs'
import { resolve, relative, join } from 'path'

// ── Types ──────────────────────────────────────────────────────

interface InventoryEntry {
  id: string
  path: string        // path relative to docs/ root (e.g. "docs/01-onboarding/conventions.md")
  folder: string
}

type DriftResult = 'ok' | 'missing' | 'moved' | 'wrong-folder'

interface DriftReport {
  entryId: string
  expectedPath: string   // full path on disk
  actualPath?: string    // where file actually is (if moved)
  status: DriftResult
  message: string
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Extract all YAML blocks from DOCS_INVENTORY.md and return their id + path.
 * Uses simple regex since the format is consistent (YAML blocks per file).
 */
function extractInventoryPaths(inventoryPath: string): InventoryEntry[] {
  const content = readFileSync(inventoryPath, 'utf-8')

  // Match YAML blocks between ```yaml and ```
  const yamlBlocks = content.match(/```yaml\s*\n([\s\S]*?)\n```/g) || []

  const entries: InventoryEntry[] = []

  for (const block of yamlBlocks) {
    const idMatch = block.match(/^id:\s*(F\d+)/m)
    const pathMatch = block.match(/^path:\s*["']?([^"'\n]+)["']?\n/m)
    const folderMatch = block.match(/^folder:\s*["']?([^"'\n]+)["']?\n/m)

    if (idMatch && pathMatch) {
      entries.push({
        id: idMatch[1],
        path: pathMatch[1].trim(),
        folder: folderMatch ? folderMatch[1].trim() : '',
      })
    }
  }

  return entries
}

/**
 * Scan all .md files under docs/ (excluding _system/), returning paths relative to project root.
 */
function scanDiskFiles(docsRoot: string): string[] {
  const EXCLUDED_DIRS = new Set(['_system', '.git'])
  const mdFiles: string[] = []

  function walk(dir: string) {
    try {
      const items = readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        if (EXCLUDED_DIRS.has(item.name)) continue
        const fullPath = join(dir, item.name)
        if (item.isDirectory()) {
          walk(fullPath)
        } else if (item.isFile() && item.name.endsWith('.md')) {
          mdFiles.push(relative(process.cwd(), fullPath))
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  walk(docsRoot)
  return mdFiles.sort()
}

// ── Main Logic ─────────────────────────────────────────────────

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const docsDir = args[0] ? resolve(args[0]) : resolve('docs')
  const inventoryPath = join(docsDir, '_system', 'DOCS_INVENTORY.md')

  console.log(`🔍 Checking inventory drift at: ${docsDir}\n`)

  // ── Step 1: Extract inventory paths ──
  let entries: InventoryEntry[]
  try {
    entries = extractInventoryPaths(inventoryPath)
    console.log(`📋 Loaded ${entries.length} entries from DOCS_INVENTORY.md\n`)
  } catch (err: any) {
    console.error(`❌ Failed to read inventory: ${err.message}`)
    process.exit(1)
  }

  // ── Step 2: Scan actual files on disk ──
  const diskFiles = new Set(scanDiskFiles(docsDir))
  console.log(`📁 Found ${diskFiles.size} .md files on disk (excluding _system/)\n`)

  // ── Step 3: Compare ──
  const reports: DriftReport[] = []

  for (const entry of entries) {
    const fullPath = join(docsDir, relative(entry.path, '')) 
      // Actually, paths in inventory are like "docs/01-onboarding/conventions.md"
      // so we need to strip the "docs/" prefix and resolve from docsRoot
    const relPath = entry.path.replace(/^docs\//, '')
    const expectedFull = join(docsDir, relPath)

    if (!diskFiles.has(entry.path)) {
      // File not found at expected path — check if it was moved
      let actualPath: string | undefined
      const basename = entry.path.split('/').pop()!
      
      // Search for the same filename in other folders
      for (const diskFile of diskFiles) {
        if (diskFile.endsWith('/' + basename)) {
          actualPath = diskFile
          break
        }
      }

      reports.push({
        entryId: entry.id,
        expectedPath: expectedFull,
        actualPath,
        status: 'missing',
        message: actualPath 
          ? `File moved from ${relPath} → ${actualPath.replace(docsDir + '/', '')}`
          : `File not found at ${relPath}`,
      })
    } else {
      // File exists — check if folder matches inventory's folder field
      const fileFolder = entry.path.split('/').slice(0, -1).join('/') || 'docs/'
      if (entry.folder && fileFolder !== entry.folder) {
        reports.push({
          entryId: entry.id,
          expectedPath: expectedFull,
          status: 'wrong-folder',
          message: `Inventory says folder="${entry.folder}" but path is "${fileFolder}"`,
        })
      }
    }
  }

  // ── Step 4: Find orphaned files (on disk but not in inventory) ──
  const inventoryPaths = new Set(entries.map(e => e.path))
  const orphans: string[] = []
  
  for (const diskFile of diskFiles) {
    if (!inventoryPaths.has(diskFile)) {
      orphans.push(diskFile)
    }
  }

  // ── Step 5: Report ──
  console.log('═══ DRIFT REPORT ═══\n')

  const missingCount = reports.filter(r => r.status === 'missing').length
  const folderMismatchCount = reports.filter(r => r.status === 'wrong-folder').length
  const okCount = entries.length - missingCount - folderMismatchCount

  console.log(`📊 Summary:`)
  console.log(`   ✅ OK: ${okCount} (${(okCount / entries.length * 100).toFixed(0)}%)`)
  console.log(`   ❌ Missing/moved: ${missingCount}`)
  console.log(`   ⚠️  Folder mismatch: ${folderMismatchCount}`)
  console.log(`   📄 Orphaned on disk (not in inventory): ${orphans.length}\n`)

  if (reports.length > 0) {
    console.log('── Details ──────────────────────────────────────\n')
    
    const missingReports = reports.filter(r => r.status === 'missing')
    const folderMismatchReports = reports.filter(r => r.status === 'wrong-folder')

    if (missingReports.length > 0) {
      console.log('❌ Missing or moved files:')
      for (const r of missingReports.slice(0, 20)) { // Limit output
        console.log(`   ${r.entryId}: ${r.message}`)
      }
      if (missingReports.length > 20) {
        console.log(`   ... and ${missingReports.length - 20} more`)
      }
      console.log()
    }

    if (folderMismatchReports.length > 0) {
      console.log('⚠️  Folder mismatches:')
      for (const r of folderMismatchReports) {
        console.log(`   ${r.entryId}: ${r.message}`)
      }
      console.log()
    }

    if (orphans.length > 0) {
      console.log('📄 Orphaned files (on disk, not in inventory):')
      for (const o of orphans.slice(0, 20)) {
        console.log(`   ${o}`)
      }
      if (orphans.length > 20) {
        console.log(`   ... and ${orphans.length - 20} more`)
      }
      console.log()
    }
  }

  // ── Exit code ──
  const hasIssues = missingCount + folderMismatchCount + orphans.length > 0
  process.exit(hasIssues ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(2)
})
