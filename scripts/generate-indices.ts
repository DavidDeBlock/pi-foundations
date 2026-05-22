#!/usr/bin/env -S node --loader ts-node/esm
/**
 * scripts/generate-indices.ts — Auto-generate `_index.md` files for every docs subfolder.
 *
 * Scans the directory structure, extracts file titles (first H1/H2), and writes a table of contents
 * per folder. Uses hardcoded folder descriptions from the canonical docs structure.
 *
 * Usage:
 *   npx tsx scripts/generate-indices.ts    # Auto-generate all _index.md files in docs/
 *
 * @category maintenance
 * @usage npx tsx scripts/generate-indices.ts
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const DOCS_DIR = join(PROJECT_ROOT, 'docs')

// Auto-discover: find every immediate subdirectory of docs/ containing .md files
function discoverFolders(): string[] {
  const entries = readdirSync(DOCS_DIR)
    .filter(name => {
      const fullPath = join(DOCS_DIR, name)
      return existsSync(fullPath) && readdirSync(fullPath).some(f => f.endsWith('.md') && f !== '_index.md')
    })
    .sort()
  console.log(`📂 Found ${entries.length} folders with markdown content\n`)
  return entries
}

// Folder descriptions — add custom ones per folder; others get a generic fallback.
const FOLDER_DESCRIPTIONS: Record<string, string> = {
  '00-current': 'Quick setup guides, onboarding steps, and current state references.',
  '10-domain': 'Business domain language, glossary, data models, and POS concepts.',
  '20-architecture': 'Technical system design, stack details, API contracts, and coding standards.',
  '25-system-specs': 'Meta-workflows, system rules, and operational specifications.',
  '30-vertical-flows': 'End-to-end feature flows that span multiple layers (types → DB → API → UI).',
  '31-planning-notes': 'Fluid planning notes, rough ideas, brainstorming, and pre-issue drafts.',
  '35-prds': 'Product requirements documents for active or planned features.',
  '40-decisions': 'Architectural Decision Records (ADRs) and accepted permanent choices.',
  '_system': 'State and maintenance files: inventory, rules, questions, progress tracking, reorganization design.',
  'agents': 'Agent-specific domain rules, triage labels, issue tracking workflows, and context definitions.',
  '50-agent-workflows': 'AI agent loops, implementation processes, review steps, and context loading strategies.',
  '90-archive': 'Historical reference only. Not canonical. Preserve original structure where possible.'
}

function describeFolder(folder: string): string {
  return FOLDER_DESCRIPTIONS[folder] ?? `Documentation folder — ${folder}.`
}

function extractFirstHeading(content: string): string {
  const lines = content.split('\n').slice(0, 20) // Check first 20 lines
  for (const line of lines) {
    if (/^(#{1,3})\s+(.+)/.test(line)) {
      return line.replace(/^#{1,3}\s+/, '').trim()
    }
  }
  return 'Untitled'
}

function generateIndex(folder: string): void {
  const folderPath = join(DOCS_DIR, folder)
  
  if (!existsSync(folderPath)) {
    console.log(`⚠️  Skipping ${folder}: directory does not exist.`)
    return
  }

  const files = readdirSync(folderPath).filter(f => f.endsWith('.md') && f !== '_index.md')
  
  // Sort alphabetically for consistency
  files.sort()

  let indexContent = `# ${folder} Index\n\n` +
    `${describeFolder(folder)}\n\n` +
    `## Files\n\n` +
    `| File | Title |\n|------|-------|\n`

  for (const file of files) {
    const filePath = join(folderPath, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const title = extractFirstHeading(content)
      indexContent += `| \`${file}\` | ${title} |\n`
    } catch (err) {
      console.log(`⚠️  Error reading ${filePath}: ${(err as Error).message}`)
      indexContent += `| \`${file}\` | [Error reading] |\n`
    }
  }

  const indexPath = join(folderPath, '_index.md')
  writeFileSync(indexPath, indexContent.trim() + '\n', 'utf-8')
  console.log(`✅ Generated: ${indexPath} (${files.length} files indexed)`)
}

// ── Output Generator ───────────────────────────────────────────

/**
 * Generate output for generate-indices.
 * Returns index generation summary as string.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false
): string {
  if (help) {
    return `Usage: npx tsx scripts/generate-indices.ts

Auto-generate _index.md files for every docs subfolder.

Scans the directory structure, extracts file titles (first H1/H2), and writes a table of contents
per folder. Uses hardcoded folder descriptions from the canonical docs structure.

Options:
  --json        Output as JSON (not supported for this script)
  --help        Show this help message

Output:
  Writes _index.md files to each docs subfolder.
  Prints generation summary to stdout.`
  }

  // Main execution
  const FOLDERS = discoverFolders()

  for (const folder of FOLDERS) {
    generateIndex(folder)
  }

  return `\n✨ Index generation complete. (${FOLDERS.length} folders indexed).`
}

// ── CLI Entry Point ────────────────────────────────────────────
import { runScriptIfDirect } from './lib/script-runner.js'

runScriptIfDirect(
  generateOutput,
  'generate-indices.ts',
  { defaultPath: '.' }
)
