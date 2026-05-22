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

// ── Output Generator ───────────────────────────────────────────

/**
 * Generate output for cleanup-empty-dirs.
 * Returns cleanup summary as string. Accepts custom flags via args object.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false,
  dryRun = false
): string {
  if (help) {
    return `Usage: npx tsx scripts/cleanup-empty-dirs.ts [docs-root] [--dry-run]

Phase 5: Remove empty directories after migration.

Scans docs/ for empty directories (excluding _system/) and removes them safely.
Supports dry-run mode to preview what would be deleted.

Arguments:
  docs-root     Path to docs directory (default: ./docs)

Options:
  --dry-run     Preview only — don't remove anything
  --json        Output as JSON (not supported for this script)
  --help        Show this help message

Output:
  Prints cleanup summary to stdout.`
  }

  const docsDir = resolve(targetPath || 'docs')
  const absDocsDir = docsDir
  
  // Find all empty dirs (returns absolute paths)
  const emptyDirs = findEmptyDirs(absDocsDir)
  
  // Convert to relative for display
  const relPaths = emptyDirs.map(d => d.replace(absDocsDir + '/', ''))
  
  const lines: string[] = [
    `🔍 Scanning for empty directories in: ${absDocsDir}`,
    '',
  ]
  
  if (dryRun) {
    lines.push('📋 DRY RUN MODE — no directories will be removed')
    lines.push('')
  }
  
  lines.push(`📊 Found ${emptyDirs.length} empty directory/directories:`)
  lines.push('')
  
  if (emptyDirs.length === 0) {
    return lines.join('\n') + '\n✅ No empty directories found — nothing to clean up.\n'
  }
  
  for (const p of relPaths) {
    lines.push(`   📁 ${p}`)
  }
  
  lines.push('')
  
  if (!dryRun && emptyDirs.length > 0) {
    // Remove directories (findEmptyDirs already returns absolute paths)
    const results = removeTree(emptyDirs)
    
    const removed = results.filter(r => r.action === 'removed').length
    const skipped = results.filter(r => r.action === 'skipped').length
    const errors = results.filter(r => r.action === 'error').length
    
    lines.push('═══ CLEANUP SUMMARY ═══')
    lines.push('')
    lines.push(`📊 Results:`)
    lines.push(`   ✅ Removed: ${removed}`)
    if (skipped > 0) lines.push(`   ⏭️  Skipped: ${skipped}`)
    if (errors > 0) lines.push(`   ❌ Errors: ${errors}`)
    lines.push('')
    
    // Show removed directories
    const removedResults = results.filter(r => r.action === 'removed')
    if (removedResults.length > 0 && removedResults.length <= 30) {
      lines.push('── Removed ──────────────────────────────────────')
      lines.push('')
      for (const r of removedResults) {
        const relPath = r.path.replace(resolve(process.cwd() + '/') + '/', '')
        lines.push(`   ✅ ${relPath}`)
      }
    }
    
    // Show errors
    const errorResults = results.filter(r => r.action === 'error')
    if (errorResults.length > 0) {
      lines.push('')
      lines.push('❌ Errors:')
      for (const r of errorResults) {
        const relPath = r.path.replace(resolve(process.cwd() + '/') + '/', '')
        lines.push(`   ❌ ${relPath}: ${r.message}`)
      }
    }
    
    lines.push('')
  } else if (dryRun) {
    lines.push('💡 To remove these directories, run without --dry-run:')
    lines.push('')
    lines.push(`   npx tsx scripts/cleanup-empty-dirs.ts docs`)
    lines.push('')
  }
  
  return lines.join('\n') + '\n'
}

// ── CLI Entry Point ────────────────────────────────────────────
import { runScriptWithCustomFlags } from '../_lib/script-runner.js'

runScriptWithCustomFlags(
  (args) => {
    const dryRun = args.rawArgs.includes('--dry-run')
    return generateOutput(args.targetPath, false, args.help, dryRun)
  },
  'cleanup-empty-dirs.ts',
  { defaultPath: 'docs' }
)
