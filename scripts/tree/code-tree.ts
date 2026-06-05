#!/usr/bin/env tsx
/**
 * scripts/tree/code-tree.ts — Categorized file tree scanner.
 *
 * Scans a directory and outputs a Unicode-indented tree with files categorized
 * by type (Source, Generated/Dist, Config, Docs). Supports --json for machine
 * consumption and --help for usage information.
 *
 * Usage:
 *   tsx scripts/tree/code-tree.ts [path]           # Human-readable tree (default)
 *   tsx scripts/tree/code-tree.ts [path] --json    # Machine-readable JSON output
 *   tsx scripts/tree/code-tree.ts --help            # Show usage information
 *
 * @category discovery
 * @usage tsx scripts/tree/code-tree.ts [path] [--json]
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve, join, extname, basename } from 'node:path'
import { scanDirectory as _scanFiles } from '../lib/scanner.js'
import { fileURLToPath } from 'node:url'
import { toJson } from '../lib/format.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ── Types ─────────────────────────────────────────────────────────────

/** Category assigned to a file or directory */
export type FileCategory = 'source' | 'generated' | 'config' | 'docs' | 'other'

/** A single categorized entry in the tree */
interface TreeEntry {
  name: string
  category: FileCategory
}

/** Nested tree node — either a file (with category) or directory (with children) */
type TreeNode = Record<string, TreeNode | TreeEntry>

// ── Configuration ─────────────────────────────────────────────────────

/** Scan options for code tree — all file types, keeps .pi */
const CODE_TREE_SCAN_OPTIONS = {
  skipDirs: new Set([
    'node_modules',
    '.git',
    'dist',
    '.cache',
    '__test__',
    '__test-fixtures__',
    '__snapshots__',
  ]),
  extensions: [], // empty = accept all files
  excludePatterns: [],
  skipHidden: true,
}

/** Extensions that classify a file as source code */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs'])

/** Extensions or patterns that classify a file as generated/dist output */
const GENERATED_PATTERNS = [
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.map',       // sourcemaps
  '.lock',      // lockfiles are generated
]

/** Extensions that classify a file as configuration */
const CONFIG_EXTS = new Set([
  '.json', '.yaml', '.yml', '.toml',
  '.env', '.envrc', '.nvmrc', '.node-version',
])

/** Config file name patterns (basename match) */
const CONFIG_NAMES = new Set([
  'tsconfig.json', 'jsconfig.json', 'package.json', 'pnpm-lock.yaml',
  'bun.lockb', 'yarn.lock', 'package-lock.json', '.gitignore', '.env',
  '.env.local', '.env.development', '.env.test', '.env.production',
])

/** Extensions that classify a file as documentation */
const DOCS_EXTS = new Set(['.md', '.txt', '.rst'])

// ── Category Rules ────────────────────────────────────────────────────

/** Determine the category of a single file based on extension and name */
export function categorizeFile(filename: string): FileCategory {
  const ext = extname(filename)
  const base = basename(filename).toLowerCase()

  // Check generated patterns first (e.g., .d.ts before .ts)
  for (const pattern of GENERATED_PATTERNS) {
    if (ext === pattern || filename.endsWith(pattern)) return 'generated'
  }

  // Source code extensions
  if (SOURCE_EXTS.has(ext)) return 'source'

  // Config by extension
  if (CONFIG_EXTS.has(ext)) return 'config'

  // Config by name pattern
  if (CONFIG_NAMES.has(base)) return 'config'

  // Documentation
  if (DOCS_EXTS.has(ext)) return 'docs'

  // Default to other
  return 'other'
}

/** Determine the category of a directory */
export function categorizeDir(dirname: string): FileCategory {
  const base = dirname.toLowerCase()

  // Generated directories
  if (base === 'node_modules' || base === '.git') return 'generated'
  if (base.startsWith('.pi')) return 'config'

  // Docs directories
  if (base === 'docs') return 'docs'

  // Default to other
  return 'other'
}

/** Category display icon */
const CATEGORY_ICONS: Record<FileCategory, string> = {
  source: '🟦',
  generated: '⬛',
  config: '📄',
  docs: '📘',
  other: '🔧',
}

/** Category display name */
const CATEGORY_NAMES: Record<FileCategory, string> = {
  source: 'Source',
  generated: 'Generated',
  config: 'Config',
  docs: 'Docs',
  other: 'Other',
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Recursively build a categorized tree from a directory.
 * @param dirPath Absolute path to the directory to scan
 * @param maxDepth Maximum depth relative to root (0 = files only, 1 = one level deep)
 * @returns Nested tree structure with category annotations
 */
export function buildTree(
  dirPath: string,
  currentDepth = 0,
  maxDepth = 3
): TreeNode {
  const entries = readdirSync(dirPath).sort()
  const tree: TreeNode = {}

  for (const name of entries) {
    // Skip hidden files/dirs except .pi (project config)
    if (name.startsWith('.') && name !== '.pi') continue

    const fullPath = join(dirPath, name)
    const stat = statSync(fullPath)

    // Skip directories in CODE_TREE_SCAN_OPTIONS.skipDirs
    if (stat.isDirectory() && CODE_TREE_SCAN_OPTIONS.skipDirs!.has(name)) continue

    if (stat.isDirectory()) {
      // Only recurse if we haven't hit max depth
      if (currentDepth < maxDepth) {
        tree[name] = buildTree(fullPath, currentDepth + 1, maxDepth)
      } else {
        // At max depth — show as a placeholder with count
        const childCount = readdirSync(fullPath).filter(
          c => !c.startsWith('.') && !CODE_TREE_SCAN_OPTIONS.skipDirs!.has(c)
        ).length
        tree[name] = { name: `${name}/ (${childCount} items)`, category: categorizeDir(name), _truncated: true } as unknown as TreeNode | TreeEntry
      }
    } else {
      tree[name] = { category: categorizeFile(name), name }
    }
  }

  return tree
}

/**
 * Render a categorized tree to human-readable Unicode output.
 * @param tree Nested tree structure
 * @param rootName Display name for the root directory
 * @returns Formatted tree string with category markers
 */
export function renderCategorizedTree(
  tree: TreeNode,
  rootName: string,
  maxFiles = 60
): { output: string; totalFiles: number } {
  const lines: string[] = []
  let fileCount = 0

  // Root entry (no connector — it's the top-level)
  const rootCat = categorizeDir(rootName)
  lines.push(`${CATEGORY_ICONS[rootCat]} ${rootName}/`)

  function renderNode(
    name: string,
    value: TreeNode | TreeEntry,
    prefix: string,
    isLast: boolean
  ): void {
    const connector = isLast ? '└── ' : '├── '

    if ('category' in value && !('children' in value)) {
      // Leaf file entry — check cap
      if (fileCount >= maxFiles) return

      const catIcon = CATEGORY_ICONS[value.category]
      lines.push(`${prefix}${connector}${catIcon} ${name}`)
      fileCount++
    } else {
      // Directory node — print the directory line first, then recurse
      const dirCat = categorizeDir(name)
      const dirIcon = CATEGORY_ICONS[dirCat]

      // Check if this is a truncated placeholder
      const entryValue = value as Record<string, unknown>
      const isTruncated = '_truncated' in entryValue && (entryValue._truncated as boolean)
      const displayName = isTruncated ? `${name}/` : name + '/'

      lines.push(`${prefix}${connector}${dirIcon} ${displayName}`)

      if (!isTruncated) {
        const childEntries = Object.entries(value as TreeNode).sort(
          ([a], [b]) => a.localeCompare(b)
        )

        for (let i = 0; i < childEntries.length; i++) {
          const [childName, childValue] = childEntries[i]
          const isLastChild = i === childEntries.length - 1
          // Add indentation for children — connector will be added by recursive call
          const newPrefix = prefix + '    '

          renderNode(childName, childValue, newPrefix, isLastChild)
        }
      }
    }
  }

  // Render root children
  const rootEntries = Object.entries(tree).sort(([a], [b]) => a.localeCompare(b))
  for (let i = 0; i < rootEntries.length; i++) {
    const [name, value] = rootEntries[i]
    renderNode(name, value, '', i === rootEntries.length - 1)
  }

  return { output: lines.join('\n') + '\n', totalFiles: fileCount }
}

/**
 * Flatten the tree into a list of categorized entries for JSON output.
 * @param tree Nested tree structure
 * @param basePath Base path prefix (for relative paths in output)
 * @returns Array of { path, category } objects
 */
export function flattenTree(
  tree: TreeNode,
  basePath: string = ''
): Array<{ path: string; category: FileCategory }> {
  const results: Array<{ path: string; category: FileCategory }> = []

  for (const [name, value] of Object.entries(tree).sort()) {
    const fullPath = join(basePath, name)

    if ('category' in value && !('children' in value)) {
      // Leaf file
      results.push({ path: fullPath, category: value.category })
    } else {
      // Directory — recurse
      results.push(...flattenTree(value as TreeNode, fullPath))
    }
  }

  return results
}

/**
 * Generate a summary section showing counts per category.
 */
export function generateSummary(entries: Array<{ path: string; category: FileCategory }>): string {
  const counts: Record<FileCategory, number> = { source: 0, generated: 0, config: 0, docs: 0, other: 0 }

  for (const entry of entries) {
    counts[entry.category]++
  }

  let summary = '\n---\n'
  summary += '**Category Summary:**\n\n'
  for (const [cat, count] of Object.entries(counts)) {
    if (count > 0) {
      const icon = CATEGORY_ICONS[cat as FileCategory]
      summary += `${icon} **${CATEGORY_NAMES[cat as FileCategory]}**: ${count}\n`
    }
  }

  return summary.trim() + '\n'
}

/**
 * Generate the full output for a given directory.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false,
  depth = 3,
  maxFiles = 60
): string {
  if (help) {
    return `Usage: tsx scripts/tree/code-tree.ts [path] [--json|--help]

Categorized file tree scanner. Scans a directory and outputs a Unicode-indented
tree with files categorized by type using color-coded markers.

Arguments:
  path          Directory to scan (defaults to project root)

Options:
  --json        Output raw JSON with paths and categories
  --help        Show this help message
  --depth N     Max directory depth (default: 2, keeps output <500 tokens)
  --max-files N Limit displayed files (default: 25, keeps output <500 tokens)

Categories:
  🟦 Source     TypeScript, JavaScript, etc.
  ⬛ Generated  Compiled output, lockfiles, node_modules
  📄 Config     Configuration files (JSON, YAML, env)
  📘 Docs       Documentation files (Markdown, text)
  🔧 Other      Everything else

Examples:
  tsx scripts/tree/code-tree.ts                    # Scan project root
  tsx scripts/tree/code-tree.ts ./scripts          # Scan specific directory
  tsx scripts/tree/code-tree.ts --json             # JSON output`
  }

  const resolvedPath = resolve(targetPath)

  if (!statSync(resolvedPath).isDirectory()) {
    return `Error: '${resolvedPath}' is not a directory.\n`
  }

  // Build the categorized tree with depth limit
  const tree = buildTree(resolvedPath, 0, depth)
  const rootName = basename(resolvedPath)

  if (json) {
    const entries = flattenTree(tree, resolvedPath)
    return toJson(entries, true)
  }

  // Human-readable output with file cap
  const { output: treeOutput, totalFiles } = renderCategorizedTree(tree, rootName, maxFiles)

  let result = `# File Tree: ${rootName}\n\n`
  result += treeOutput

  // Only show summary if we hit the file cap (indicates truncation)
  const fullEntries = flattenTree(tree, resolvedPath)
  if (totalFiles < fullEntries.length) {
    result += `> Showing ${totalFiles} of ${fullEntries.length} files (--depth=${depth}, --max-files=${maxFiles})\n\n`
  }

  // Show summary for displayed files only
  const displayedEntries = fullEntries.slice(0, maxFiles)
  result += generateSummary(displayedEntries)

  return result.trim() + '\n'
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    // code-tree.ts has extra params (--depth, --max-files)
    const args = process.argv.slice(2)
    let depth = 2
    let maxFiles = 25

    for (const arg of args) {
      if (arg === '--depth' && args[args.indexOf(arg) + 1]) {
        depth = parseInt(args[args.indexOf(arg) + 1], 10) || 3
      } else if (arg === '--max-files' && args[args.indexOf(arg) + 1]) {
        maxFiles = parseInt(args[args.indexOf(arg) + 1], 10) || 60
      }
    }

    return generateOutput(targetPath, json, help, depth, maxFiles)
  },
  'code-tree.ts',
  { defaultPath: process.cwd() }
)
