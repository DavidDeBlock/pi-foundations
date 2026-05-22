#!/usr/bin/env tsx
/**
 * scripts/index.ts — Dynamic script catalog entry point.
 *
 * Scans the scripts directory for TypeScript files, extracts JSDoc metadata
 * (description, category, usage), and prints a formatted catalog of available tools.
 *
 * Usage:
 *   tsx scripts/                    # Print human-readable catalog
 *   tsx scripts/ --list             # Same as above (explicit)
 *   tsx scripts/ --json             # Machine-readable JSON output
 *   tsx scripts/ --help             # Show usage information
 *
 * @category utility
 * @usage tsx scripts/ [--list|--json|--help]
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve, join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProject, loadSourceFile, extractExports, extractScriptMetadata } from '../_lib/ts-parser.js'
import { markdownTable, toJson } from '../_lib/format.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Types ─────────────────────────────────────────────────────────────

interface ScriptEntry {
  name: string
  description: string
  category: string | undefined
  usage: string | undefined
  filePath: string
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Recursively find all TypeScript script files in a directory.
 */
function findScriptFiles(dir: string): string[] {
  const SKIP_DIRS = new Set(['node_modules', '.git', '__test__', '__test-fixtures__', '__snapshots__', 'dist'])
  let results: string[] = []

  try {
    const items = readdirSync(dir)
    for (const item of items) {
      if (SKIP_DIRS.has(item)) continue
      const fullPath = join(dir, item)
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        results = results.concat(findScriptFiles(fullPath))
      } else if (extname(item) === '.ts' && !item.endsWith('.test.ts') && !item.startsWith('.')) {
        results.push(fullPath)
      }
    }
  } catch {
    // Ignore permission errors or missing dirs
  }

  return results
}

/**
 * Scan the scripts directory and extract metadata from all TypeScript files.
 */
export function scanScripts(scriptsDir: string): ScriptEntry[] {
  const entries: ScriptEntry[] = []
  const project = createProject()

  try {
    const files = findScriptFiles(scriptsDir)

    for (const fullPath of files) {
      const sourceFile = loadSourceFile(project, fullPath)
      if (!sourceFile) continue

      const metadata = extractScriptMetadata(sourceFile)
      const exportsList = extractExports(sourceFile)

      entries.push({
        name: basename(fullPath),
        description: metadata?.description || 'No description available',
        category: metadata?.category || 'utility',
        usage: metadata?.usage,
        filePath: fullPath
      })
    }
  } finally {
    // ts-morph v25 doesn't require explicit disposal
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Generate a formatted catalog output.
 */
export function generateCatalogOutput(
  scriptsDir: string,
  json = false,
  help = false
): string {
  if (help) {
    return `Usage: tsx scripts/ [options]

Options:
  --list      Display the script catalog (default)
  --json      Output as machine-readable JSON
  --help      Show this help message

The script catalog scans all TypeScript files in the scripts directory,
extracts JSDoc metadata (description, category, usage), and presents
a dynamic list of available tools.

Each script should include:
  /**
   * Brief description of what the script does.
   * @category discovery|analysis|maintenance
   * @usage tsx scripts/name.ts [args] --json
   */`
  }

  const entries = scanScripts(scriptsDir)

  if (json) {
    return toJson(entries, true)
  }

  // Group by category
  const grouped: Record<string, ScriptEntry[]> = {}
  for (const entry of entries) {
    const cat = entry.category || 'uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(entry)
  }

  // Build output
  let output = '# Script Catalog\n\n'
  output += `Found ${entries.length} scripts across ${Object.keys(grouped).length} categories.\n\n`

  for (const [category, scripts] of Object.entries(grouped).sort()) {
    output += `## ${category}\n\n`

    const headers = ['Script', 'Description']
    const rows = scripts.map(s => [s.name, s.description])

    // Add usage line if available
    for (const script of scripts) {
      if (script.usage) {
        output += `> Usage: \`${script.usage}\`\n\n`
      }
    }

    output += markdownTable(headers, rows) + '\n'
  }

  return output.trim() + '\n'
}

// ── CLI Entry Point ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const scriptsDir = join(PROJECT_ROOT, 'scripts')

if (args.includes('--help')) {
  console.log(generateCatalogOutput(scriptsDir, false, true))
} else if (args.includes('--json')) {
  const output = generateCatalogOutput(scriptsDir, true)
  process.stdout.write(output)
} else {
  // Default: --list behavior
  const output = generateCatalogOutput(scriptsDir, false)
  console.log(output)
}
