#!/usr/bin/env tsx
/**
 * migrate-docs.ts — Phase 4: Migrate files from current locations to target structure.
 *
 * Reads DOCS_INVENTORY.md, validates each entry with proposed_action = move/archive/merge-into,
 * then performs the moves on disk while updating paths in inventory and logging to archive log.
 *
 * Usage: npx tsx scripts/migrate-docs.ts [docs-root] [--dry-run] [--batch-size=N]
 */

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs'
import { resolve, join, dirname, relative } from 'path'

// ── Types ──────────────────────────────────────────────────────

interface InventoryEntry {
  id: string
  path: string        // current path on disk (relative to docs/)
  folder: string
  class: string
  proposed_action: string
  target_path: string | null
  reason: string
  approval: string | null
}

type MigrationStatus = 'pending' | 'moved' | 'skipped' | 'error'

interface MigrationResult {
  entryId: string
  sourcePath: string   // full path on disk
  targetPath: string   // full path on disk
  status: MigrationStatus
  message: string
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Extract all YAML blocks from DOCS_INVENTORY.md and return parsed entries.
 */
function extractInventoryEntries(inventoryPath: string): InventoryEntry[] {
  const content = readFileSync(inventoryPath, 'utf-8')

  // Match YAML blocks between ```yaml and ```
  const yamlBlocks = content.match(/```yaml\s*\n([\s\S]*?)\n```/g) || []

  const entries: InventoryEntry[] = []

  for (const block of yamlBlocks) {
    const idMatch = block.match(/^id:\s*(F\d+)/m)
    const pathMatch = block.match(/^path:\s*["']?([^"'\n]+)["']?\n/m)
    const folderMatch = block.match(/^folder:\s*["']?([^"'\n]+)["']?\n/m)
    const classMatch = block.match(/^class:\s*(.+)$/m)
    const actionMatch = block.match(/^proposed_action:\s*(.+)$/m)
    const targetMatch = block.match(/^target_path:\s*([^\n]+)/m)
    const reasonMatch = block.match(/^reason:\s*["']?([^"'\n]+)["']?\n/m)
    const approvalMatch = block.match(/^approval:\s*(null|[a-z]+)/m)

    if (!idMatch || !pathMatch || !actionMatch) continue

    entries.push({
      id: idMatch[1],
      path: pathMatch[1].trim(),
      folder: folderMatch ? folderMatch[1].trim() : '',
      class: classMatch?.[1]?.trim() ?? 'unknown',
      proposed_action: actionMatch[1].trim(),
      target_path: targetMatch ? (targetMatch[1].trim() === 'null' ? null : targetMatch[1].trim()) : null,
      reason: reasonMatch?.[1]?.trim() ?? '',
      approval: approvalMatch?.[1] === 'null' ? null : approvalMatch?.[1],
    })
  }

  return entries
}

/**
 * Ensure a directory exists (create parent dirs if needed).
 */
function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

/**
 * Validate and normalize a target path.
 */
function validateTargetPath(targetPath: string | null, docsDir: string): { valid: boolean; normalized?: string; error?: string } {
  if (!targetPath || targetPath === 'null') {
    return { valid: false, error: 'No target_path specified' }
  }

  // Normalize: ensure it starts with "docs/"
  let normalized = targetPath.startsWith('docs/') ? targetPath : join('docs', targetPath)
  
  const fullPath = resolve(join(docsDir, relative(normalized, '')))
    // Actually paths are like "docs/20-architecture/conventions.md" so we strip docs/ and resolve from docsDir
    .replace(resolve(docsDir), docsDir)

  return { valid: true, normalized }
}

/**
 * Check if a file exists at the expected location.
 */
function fileExistsAtPath(fullPath: string): boolean {
  try {
    const stat = statSync(fullPath)
    return stat.isFile()
  } catch {
    return false
  }
}

// ── Main Logic ─────────────────────────────────────────────────

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let docsDir = 'docs'
  let dryRun = false
  let batchSize = 5

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true
    else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10) || 5
      i++
    } else if (!args[i].startsWith('-')) {
      docsDir = resolve(args[i])
    }
  }

  console.log(`🔍 Migrating documentation at: ${docsDir}\n`)
  if (dryRun) console.log('📋 DRY RUN MODE — no files will be moved\n')

  // ── Step 1: Load inventory ──
  const inventoryPath = join(docsDir, '_system', 'DOCS_INVENTORY.md')
  let entries: InventoryEntry[]
  try {
    entries = extractInventoryEntries(inventoryPath)
    console.log(`📋 Loaded ${entries.length} entries from DOCS_INVENTORY.md\n`)
  } catch (err: any) {
    console.error(`❌ Failed to read inventory: ${err.message}`)
    process.exit(1)
  }

  // ── Step 2: Filter entries that need migration ──
  const migratable = entries.filter(e => 
    ['move', 'archive', 'merge-into'].includes(e.proposed_action) && 
    e.target_path !== null
  )

  console.log(`📦 ${migratable.length} entries require migration\n`)

  if (migratable.length === 0) {
    console.log('✅ No migrations needed — all entries are already in place or marked keep.\n')
    process.exit(0)
  }

  // ── Step 3: Process migrations ──
  const results: MigrationResult[] = []
  let errors = 0

  for (const entry of migratable) {
    console.log(`── ${entry.id}: ${entry.proposed_action} ─────────────`)
    
    // Validate target path
    const validation = validateTargetPath(entry.target_path, docsDir)
    if (!validation.valid) {
      console.log(`  ❌ Skipped: ${validation.error}`)
      results.push({
        entryId: entry.id,
        sourcePath: join(docsDir, relative(entry.path, '')),
        targetPath: '',
        status: 'skipped',
        message: validation.error || 'Invalid target path',
      })
      errors++
      continue
    }

    const normalizedTarget = validation.normalized!
    
    // Determine source and target full paths
    // entry.path is already like 'docs/01-onboarding/conventions.md'
    const sourceFull = resolve(join(process.cwd(), entry.path))

    // Normalize source path for display (keep as-is from inventory)
    const normalizedSource = entry.path

    const targetFull = resolve(join(process.cwd(), normalizedTarget))

    console.log(`  Source: ${normalizedSource}`)
    console.log(`  Target: ${normalizedTarget}`)

    // Check if file is already at target location (source == target)
    const normalizedFullSource = resolve(join(process.cwd(), normalizedSource))
    const normalizedFullTarget = resolve(join(process.cwd(), normalizedTarget))
    
    if (normalizedFullSource === normalizedFullTarget) {
      console.log(`  ⏭️  Already at correct location — skipping`)
      results.push({
        entryId: entry.id,
        sourcePath: normalizedSource,
        targetPath: normalizedTarget,
        status: 'skipped',
        message: `Already in place (source = target)`,
      })
      continue
    }

    // Check if source exists
    if (!fileExistsAtPath(sourceFull)) {
      // File might have been moved already — check if it's at the target location
      if (fileExistsAtPath(targetFull)) {
        console.log(`  ℹ️  Already at target location — will fix inventory path`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'moved',  // Mark as moved so Step 4 updates the inventory
          message: 'Already migrated (file found at target)',
        })
      } else {
        console.log(`  ❌ Source file not found — skipping`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'error',
          message: `Source not found at ${normalizedSource}`,
        })
        errors++
      }
      continue
    }

    // Check if target already exists (conflict)
    if (fileExistsAtPath(targetFull)) {
      // If source also still exists — real conflict, abort
      if (fileExistsAtPath(sourceFull)) {
        console.log(`  ❌ Target file already exists AND source still present — conflict`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'error',
          message: `Conflict: both ${normalizedSource} and ${normalizedTarget} exist`,
        })
        errors++
      } else {
        // Source already moved (from previous attempt where inventory wasn't updated)
        console.log(`  ⏭️  Already at target location — will fix inventory path`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'moved',  // Mark as moved so Step 4 updates the inventory
          message: `Already migrated (target exists, source not found at original location)`,
        })
      }
      continue
    }

    // Perform the move (or dry-run)
    if (!dryRun) {
      try {
        const { execSync } = await import('child_process')
        const targetDir = dirname(targetFull)
        
        // Create target directory if needed
        ensureDir(targetDir)
        
        // Move file
        execSync(`mv "${sourceFull}" "${targetFull}"`, { stdio: 'pipe' })
        
        console.log(`  ✅ Moved successfully`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'moved',
          message: `Moved from ${normalizedSource} to ${normalizedTarget}`,
        })
      } catch (err: any) {
        console.log(`  ❌ Move failed: ${err.message}`)
        results.push({
          entryId: entry.id,
          sourcePath: normalizedSource,
          targetPath: normalizedTarget,
          status: 'error',
          message: `Move error: ${err.message}`,
        })
        errors++
      }
    } else {
      console.log(`  📋 [DRY-RUN] Would move from ${normalizedSource} to ${normalizedTarget}`)
      results.push({
        entryId: entry.id,
        sourcePath: normalizedSource,
        targetPath: normalizedTarget,
        status: 'moved',
        message: `[DRY-RUN] Would move`,
      })
    }

    console.log()
  }

  // ── Step 4: Update inventory with new paths ──
  if (!dryRun && results.some(r => r.status === 'moved')) {
    console.log('📝 Updating DOCS_INVENTORY.md with new paths...\n')
    
    let updatedContent = readFileSync(inventoryPath, 'utf-8')
    const updates: Array<{ id: string; oldPath: string; newPath: string }> = []

    for (const result of results) {
      if (result.status !== 'moved' || !result.targetPath) continue
      
      // Match the full YAML block for this entry ID
      const blockRegex = new RegExp('(```yaml\\nid: ' + result.entryId + '\\n)([\\s\\S]*?)(\\n```)', 'm')
      const match = updatedContent.match(blockRegex)
      
      if (!match) continue
      
      const blockContent = match[2]
      const oldPathMatch = blockContent.match(/^path:\s*["']?([^"'\n]+)["']?/m)
      const oldPath = oldPathMatch?.[1] || ''
      
      if (oldPath === result.targetPath) continue
      
      console.log(`  Updating ${result.entryId}: ${oldPath} → ${result.targetPath}`)
      
      // Replace path line in block content
      let updatedBlock = blockContent.replace(
        /^path:\s*["']?([^"'\n]+)["']?\n/m,
        `path: ${result.targetPath}\n`
      )
      
      // Update folder field too
      const targetDir = dirname(result.targetPath)
      updatedBlock = updatedBlock.replace(
        /^folder:\s*["']?([^"'\n]+)["']?\n/m,
        (match, currentFolder) => {
          if (currentFolder !== targetDir) {
            return `folder: ${targetDir}\n`
          }
          return match
        }
      )
      
      // Replace the entire block in content
      updatedContent = updatedContent.replace(match[0], `${match[1]}${updatedBlock}${match[3]}`)
      updates.push({ id: result.entryId, oldPath, newPath: result.targetPath })
    }

    writeFileSync(inventoryPath, updatedContent, 'utf-8')
    
    console.log(`✅ Updated ${updates.length} entries in inventory\n`)
  } else {
    console.log('ℹ️  No updates needed for inventory.\n')
  }

  // ── Step 5: Write archive log ──
  if (!dryRun && results.some(r => r.status === 'moved')) {
    const archiveLogPath = join(docsDir, '_system', 'DOCS_ARCHIVE_LOG.md')
    let archiveContent = readFileSync(archiveLogPath, 'utf-8')
    
    // Add entries to the Actions Log section
    const timestamp = new Date().toISOString()
    for (const result of results) {
      if (result.status === 'moved' && result.sourcePath && result.targetPath) {
        archiveContent += `\n| ${timestamp} | move | ${result.sourcePath} | ${result.targetPath} | Migrated during Phase 4 | migrate-docs.ts |\n`
      }
    }

    // Update summary counts
    const movedCount = results.filter(r => r.status === 'moved').length
    
    archiveContent = archiveContent.replace(
      /(\| move \|)(\d+)(\|)/,
      (_, prefix: string, current: number, suffix: string) => {
        return `${prefix}${parseInt(current) + movedCount}${suffix}`
      }
    )

    writeFileSync(archiveLogPath, archiveContent, 'utf-8')
    console.log(`📝 Updated DOCS_ARCHIVE_LOG.md with ${movedCount} new entries\n`)
  }

  // ── Step 6: Summary Report ──
  console.log('═══ MIGRATION SUMMARY ═══\n')

  const moved = results.filter(r => r.status === 'moved').length
  const skipped = results.filter(r => r.status === 'skipped').length
  const failed = results.filter(r => r.status === 'error').length

  console.log(`📊 Results:`)
  console.log(`   ✅ Moved: ${moved}`)
  console.log(`   ⏭️  Skipped: ${skipped}`)
  console.log(`   ❌ Failed: ${failed}\n`)

  if (results.length > 0) {
    console.log('── Details ──────────────────────────────────────\n')
    
    const movedResults = results.filter(r => r.status === 'moved' || r.status === 'error')
    
    for (const result of movedResults.slice(0, 20)) { // Limit output
      const icon = result.status === 'moved' ? '✅' : '❌'
      console.log(`   ${icon} ${result.entryId}: ${result.message}`)
    }
    
    if (movedResults.length > 20) {
      console.log(`   ... and ${movedResults.length - 20} more`)
    }

    const skippedResults = results.filter(r => r.status === 'skipped')
    if (skippedResults.length > 0) {
      console.log('\n⏭️  Skipped entries:')
      for (const result of skippedResults.slice(0, 10)) {
        console.log(`   ⏭️  ${result.entryId}: ${result.message}`)
      }
      if (skippedResults.length > 10) {
        console.log(`   ... and ${skippedResults.length - 10} more`)
      }
    }

    const failedResults = results.filter(r => r.status === 'error')
    if (failedResults.length > 0) {
      console.log('\n❌ Failed entries:')
      for (const result of failedResults.slice(0, 10)) {
        console.log(`   ❌ ${result.entryId}: ${result.message}`)
      }
      if (failedResults.length > 10) {
        console.log(`   ... and ${failedResults.length - 10} more`)
      }
    }

    console.log()
  }

  // ── Exit code ──
  const hasErrors = failed > 0
  process.exit(hasErrors ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(2)
})
