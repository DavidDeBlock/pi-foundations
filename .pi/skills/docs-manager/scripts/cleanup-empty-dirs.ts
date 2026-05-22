#!/usr/bin/env tsx
/**
 * scripts/cleanup-empty-dirs.ts — Phase 5: Remove empty directories after migration.
 *
 * Scans docs/ for empty directories (excluding _system/) and removes them safely.
 * Supports dry-run mode to preview what would be deleted.
 *
 * Usage:
 *   npx tsx scripts/cleanup-empty-dirs.ts [docs-root]              # Remove empty dirs
 *   npx tsx scripts/cleanup-empty-dirs.ts docs --dry-run           # Preview only
 *
 * @category maintenance
 * @usage npx tsx scripts/cleanup-empty-dirs.ts [docs-root] [--dry-run]
 */

import { readdirSync, statSync, rmdirSync } from 'fs'
import { resolve, join } from 'path'

interface CleanupResult {
  path: string
  action: 'removed' | 'skipped' | 'error'
  message?: string
}

/**
 * Find all empty directories recursively (excluding _system/).
 */
function findEmptyDirs(docsDir: string): string[] {
  const result: string[] = []
  
  function scan(dirPath: string): void {
    try {
      const entries = readdirSync(dirPath)
      
      for (const entry of entries) {
        if (entry === '_system') continue // Never remove _system
        
        const fullPath = join(dirPath, entry)
        const stat = statSync(fullPath)
        
        if (stat.isDirectory()) {
          scan(fullPath) // Recurse first (bottom-up)
          
          // Check if now empty after recursion
          try {
            const remaining = readdirSync(fullPath)
            if (remaining.length === 0) {
              result.push(join(docsDir, relativeToDocs(fullPath)))
            }
          } catch {
            // Directory no longer exists (race condition or permission issue)
          }
        }
      }
    } catch (err: any) {
      console.error(`  ⚠️  Cannot scan ${dirPath}: ${err.message}`)
    }
  }
  
  function relativeToDocs(fullPath: string): string {
    return fullPath.replace(resolve(docsDir) + '/', '')
  }
  
  scan(resolve(docsDir))
  return result.sort()
}

/**
 * Remove a directory tree (removes from deepest level first).
 */
function removeTree(dirsToRemove: string[]): CleanupResult[] {
  const results: CleanupResult[] = []
  
  // Sort by depth (deepest first) to handle nested empty dirs
  const sorted = [...dirsToRemove].sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    return depthB - depthA // Descending
  })
  
  for (const dirPath of sorted) {
    try {
      rmdirSync(dirPath)
      results.push({ path: dirPath, action: 'removed' })
    } catch (err: any) {
      if (err.code === 'ENOTEMPTY') {
        // Directory became non-empty after scan — skip
        results.push({ path: dirPath, action: 'skipped', message: 'No longer empty' })
      } else {
        results.push({ path: dirPath, action: 'error', message: err.message })
      }
    }
  }
  
  return results
}

// ── Main ────────────────────────────────────────────────────────

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let docsDir = 'docs'
  let dryRun = false
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true
    else if (!args[i].startsWith('-')) {
      docsDir = resolve(args[i])
    }
  }
  
  // Always work with absolute paths internally
  const absDocsDir = resolve(docsDir)
  const cwd = process.cwd()
  
  console.log(`🔍 Scanning for empty directories in: ${absDocsDir}\n`)
  if (dryRun) console.log('📋 DRY RUN MODE — no directories will be removed\n')
  
  // Find all empty dirs (returns absolute paths)
  const emptyDirs = findEmptyDirs(absDocsDir)
  
  // Convert to relative for display
  const relPaths = emptyDirs.map(d => d.replace(absDocsDir + '/', ''))
  
  console.log(`📊 Found ${emptyDirs.length} empty directory/directories:\n`)
  
  if (emptyDirs.length === 0) {
    console.log('✅ No empty directories found — nothing to clean up.\n')
    return
  }
  
  for (const p of relPaths) {
    console.log(`   📁 ${p}`)
  }
  
  console.log()
  
  if (!dryRun && emptyDirs.length > 0) {
    // Remove directories (findEmptyDirs already returns absolute paths)
    const results = removeTree(emptyDirs)
    
    const removed = results.filter(r => r.action === 'removed').length
    const skipped = results.filter(r => r.action === 'skipped').length
    const errors = results.filter(r => r.action === 'error').length
    
    console.log('═══ CLEANUP SUMMARY ═══\n')
    console.log(`📊 Results:`)
    console.log(`   ✅ Removed: ${removed}`)
    if (skipped > 0) console.log(`   ⏭️  Skipped: ${skipped}`)
    if (errors > 0) console.log(`   ❌ Errors: ${errors}\n`)
    
    // Show removed directories
    const removedResults = results.filter(r => r.action === 'removed')
    if (removedResults.length > 0 && removedResults.length <= 30) {
      console.log('── Removed ──────────────────────────────────────\n')
      for (const r of removedResults) {
        const relPath = r.path.replace(resolve(process.cwd() + '/') + '/', '')
        console.log(`   ✅ ${relPath}`)
      }
    }
    
    // Show errors
    const errorResults = results.filter(r => r.action === 'error')
    if (errorResults.length > 0) {
      console.log('\n❌ Errors:')
      for (const r of errorResults) {
        const relPath = r.path.replace(resolve(process.cwd() + '/') + '/', '')
        console.log(`   ❌ ${relPath}: ${r.message}`)
      }
    }
    
    console.log()
  } else if (dryRun) {
    console.log('💡 To remove these directories, run without --dry-run:\n')
    console.log(`   npx tsx scripts/cleanup-empty-dirs.ts docs\n`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(2)
})
