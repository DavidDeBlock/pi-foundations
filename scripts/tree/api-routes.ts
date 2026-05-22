#!/usr/bin/env tsx
/**
 * scripts/tree/api-routes.ts — Hono API route scanner.
 *
 * Scans TypeScript files for Hono-style route definitions (`.get()`, `.post()`,
 * `.patch()`, `.delete()` calls) and outputs a consolidated Markdown table of
 * all HTTP endpoints with method, path, and handler name.
 *
 * Usage:
 *   tsx scripts/tree/api-routes.ts [path]           # Markdown table (default)
 *   tsx scripts/tree/api-routes.ts [path] --json    # Machine-readable JSON output
 *   tsx scripts/tree/api-routes.ts --help            # Show usage information
 *
 * @category discovery
 * @usage tsx scripts/tree/api-routes.ts [path] [--json]
 */

import { statSync, existsSync } from 'node:fs'
import { resolve, join, basename, relative } from 'node:path'
import { scanDirectory as _scanFiles } from '../lib/scanner.js'
import { Node, Project, CallExpression, SyntaxKind } from 'ts-morph'
import { createProject, loadSourceFile } from '../lib/ts-parser.js'
import { markdownTable, toJson } from '../lib/format.js'

// ── Types ─────────────────────────────────────────────────────────────

/** A single discovered route with method, path, and handler info */
export interface RouteInfo {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  handler: string
  file: string
}

// ── Configuration ─────────────────────────────────────────────────────

/** HTTP methods recognized by Hono route definitions */
const ROUTE_METHODS = new Set(['get', 'post', 'patch', 'delete'])

/** Scan options for API routes — skips common dirs, includes .ts only */
const API_ROUTES_SCAN_OPTIONS = {
  skipDirs: new Set([
    'node_modules',
    '.git',
    'dist',
    '.cache',
    '__snapshots__',
  ]),
  extensions: ['.ts'],
  excludePatterns: ['.d.ts', '.test.ts'],
  skipHidden: true,
}

// ── AST Parsing ───────────────────────────────────────────────────────

/**
 * Extract the string literal value from a node (if it's a string or simple template).
 */
function getStringLiteral(node: Node): string | undefined {
  if (node.isKind(SyntaxKind.StringLiteral)) {
    return node.getText().slice(1, -1) // Remove surrounding quotes
  }

  // Handle template literals with no interpolations
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    const text = node.getText()
    return text.slice(1, -1)
  }

  return undefined
}

/**
 * Extract the handler name from a node.
 * Handles: function references, arrow functions, inline calls.
 */
function extractHandlerName(node: Node): string {
  if (node.isKind(SyntaxKind.Identifier)) {
    return node.getText()
  }

  // Arrow function or inline call — use a placeholder
  const text = node.getText().trim()
  const preview = text.length > 40 ? text.slice(0, 37) + '...' : text
  return `anonymous(${preview})`
}

/**
 * Parse a single TypeScript file and extract all Hono route definitions.
 * Looks for patterns like: app.get('/path', handler), router.post('/path', fn)
 */
export function extractRoutes(filePath: string): RouteInfo[] {
  const project = createProject()
  const results: RouteInfo[] = []

  try {
    const sourceFile = loadSourceFile(project, filePath)
    if (!sourceFile) return results

    // Find all call expressions in the file
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)

    for (const call of calls) {
      // Check if this is a method call on an object (e.g., app.get(...))
      // In ts-morph v25, CallExpression has getExpression() which returns the part before ()
      const expr = call.getExpression()

      // For property access expressions like `app.get`, extract the method name
      let methodName: string | undefined
      if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
        methodName = expr.getName().toLowerCase()
      }

      if (!methodName) continue

      // Only process known route methods
      if (!ROUTE_METHODS.has(methodName)) continue

      // Get the arguments: path (arg 0), handler (arg 1+)
      const args = call.getArguments()
      if (args.length < 2) continue

      const pathNode = args[0] as Node
      const path = getStringLiteral(pathNode)
      if (!path) continue

      // Handler is the second argument (may have middleware in between)
      const handlerNode = args[1] as Node
      const handler = extractHandlerName(handlerNode)

      results.push({
        method: methodName.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path,
        handler,
        file: filePath
      })
    }
  } finally {
    // ts-morph v25 doesn't require explicit disposal
  }

  return results
}

// ── Directory Scanning ────────────────────────────────────────────────

/**
 * Recursively find all .ts files in a directory (using shared scanner).
 */
function findTsFiles(dirPath: string): string[] {
  return _scanFiles(dirPath, API_ROUTES_SCAN_OPTIONS)
}

/**
 * Scan a directory for all Hono routes across TypeScript files.
 */
export function scanDirectory(dirPath: string): RouteInfo[] {
  const tsFiles = findTsFiles(dirPath)
  const allRoutes: RouteInfo[] = []

  for (const file of tsFiles) {
    const routes = extractRoutes(file)
    if (routes.length > 0) {
      allRoutes.push(...routes)
    }
  }

  // Sort by method then path for deterministic output
  return allRoutes.sort((a, b) => {
    const methodOrder = { GET: 0, POST: 1, PATCH: 2, DELETE: 3 }
    const methodDiff = methodOrder[a.method] - methodOrder[b.method]
    if (methodDiff !== 0) return methodDiff
    return a.path.localeCompare(b.path)
  })
}

// ── Output Generation ─────────────────────────────────────────────────

/**
 * Generate a Markdown table of routes.
 */
export function generateMarkdownTable(routes: RouteInfo[], basePath: string): string {
  let output = '# API Routes\n\n'

  if (routes.length === 0) {
    output += '> No routes found.\n'
    return output.trim() + '\n'
  }

  // Group by file for better readability
  const groupedByFile: Record<string, RouteInfo[]> = {}
  for (const route of routes) {
    const relPath = relative(basePath, route.file) || basename(route.file)
    if (!groupedByFile[relPath]) groupedByFile[relPath] = []
    groupedByFile[relPath].push(route)
  }

  let totalLines = 0

  for (const [file, fileRoutes] of Object.entries(groupedByFile)) {
    output += `## \`${file}\`\n\n`

    const headers = ['Method', 'Path', 'Handler']
    const rows: string[][] = []

    for (const route of fileRoutes) {
      rows.push([route.method, `\`${route.path}\``, route.handler])
      totalLines++
    }

    output += markdownTable(headers, rows) + '\n'
  }

  // Summary line
  const methods: Record<string, number> = {}
  for (const r of routes) {
    methods[r.method] = (methods[r.method] || 0) + 1
  }
  const methodSummary = Object.entries(methods).map(([m, c]) => `${c}x ${m}`).join(', ')

  output += `**${routes.length} route(s)** — ${methodSummary}\n`

  return output.trim() + '\n'
}

/**
 * Generate JSON output of routes.
 */
export function generateJsonOutput(routes: RouteInfo[], basePath: string): string {
  const data = {
    routeCount: routes.length,
    routes: routes.map(r => ({
      method: r.method,
      path: r.path,
      handler: r.handler,
      file: relative(basePath, r.file) || basename(r.file)
    }))
  }

  return toJson(data)
}

/**
 * Generate help text.
 */
export function generateHelp(): string {
  return `Usage: tsx scripts/tree/api-routes.ts [path] [--json|--help]

Hono API route scanner. Scans TypeScript files for Hono-style route definitions
and outputs a consolidated table of all HTTP endpoints.

Arguments:
  path          Directory to scan (defaults to current directory)

Options:
  --json        Output machine-readable JSON with full metadata
  --help        Show this help message

Output Formats:
  Default       Markdown table grouped by file (Method | Path | Handler)
  --json        Detailed JSON array with method, path, handler, and file paths

Recognized Patterns:
  app.get('/path', handler)     → GET /path
  router.post('/path', fn)      → POST /path
  app.patch('/path/:id', fn)    → PATCH /path/:id
  app.delete('/path', fn)       → DELETE /path

Examples:
  tsx scripts/tree/api-routes.ts                    # Scan current directory
  tsx scripts/tree/api-routes.ts ./server/src       # Scan specific directory
  tsx scripts/tree/api-routes.ts --json             # JSON output`
}

/**
 * Generate the full output for a given directory.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false
): string {
  if (help) {
    return generateHelp()
  }

  const resolvedPath = resolve(targetPath)

  // Check if path exists and is a directory
  if (!existsSync(resolvedPath)) {
    return `Error: Directory not found at '${resolvedPath}'.\n`
  }

  if (!statSync(resolvedPath).isDirectory()) {
    return `Error: '${resolvedPath}' is not a directory.\n`
  }

  const routes = scanDirectory(resolvedPath)

  if (json) {
    return generateJsonOutput(routes, resolvedPath)
  }

  return generateMarkdownTable(routes, resolvedPath)
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    return generateOutput(targetPath, json, help)
  },
  'api-routes.ts',
  { defaultPath: '.' }
)
