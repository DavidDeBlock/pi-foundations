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

import { resolve, join, dirname, basename } from 'node:path'
import { scanDirectory as _scanFiles } from './lib/scanner.js'
import { fileURLToPath } from 'node:url'
import { createProject, loadSourceFile, extractExports, extractScriptMetadata } from './lib/ts-parser.js'
import { markdownTable } from './lib/format.js'
import { runCli } from './lib/cli-runner.js'

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
 * Recursively find all TypeScript script files in a directory (using shared scanner).
 */
function findScriptFiles(dir: string): string[] {
  const SCRIPT_SCAN_OPTIONS = {
    skipDirs: new Set(['node_modules', '.git', '__test__', '__test-fixtures__', '__snapshots__', 'dist']),
    extensions: ['.ts'],
    excludePatterns: ['.d.ts', '.test.ts'],
    skipHidden: true,
  }
  return _scanFiles(dir, SCRIPT_SCAN_OPTIONS)
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
 * Returns structured data with both markdown and json fields for flexible routing.
 */
export function generateCatalogOutput(
  scriptsDir: string,
  _json = false,
  help = false
): { markdown: string; json?: unknown } | string {
  if (help) {
    return '# Script Catalog\n\nScans the scripts directory for TypeScript files, extracts JSDoc metadata\n(description, category, usage), and prints a formatted catalog of available tools.\n\nUsage:\n  tsx scripts/ [--json|--help]\n'
  }

  const entries = scanScripts(scriptsDir)

  // Group by category for markdown output
  const grouped: Record<string, ScriptEntry[]> = {}
  for (const entry of entries) {
    const cat = entry.category || 'uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(entry)
  }

  // Build markdown output
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

  // Always return structured data with both fields — runner routes to correct format
  return { markdown: output.trim() + '\n', json: entries }
}

// ── CLI Entry Point ───────────────────────────────────────────

const scriptsDir = join(PROJECT_ROOT, 'scripts')

runCli(
  (dirPath: string) => {
    const fullScriptsDir = join(dirPath, 'scripts')
    return generateCatalogOutput(fullScriptsDir)
  },
  'index.ts',
  { helpText: `Usage: tsx scripts/ [options]

Options:
  --json      Output as machine-readable JSON
  --help      Show this help message

The script catalog scans all TypeScript files in the scripts directory,
extracts JSDoc metadata (description, category, usage), and presents
a dynamic list of available tools.` }
)
