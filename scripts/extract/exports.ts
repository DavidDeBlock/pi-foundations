#!/usr/bin/env tsx
/**
 * scripts/extract/exports.ts — TypeScript export extractor.
 *
 * Parses a TypeScript file and outputs its public API: exported functions,
 * classes, types, interfaces, enums, and constants with their signatures
 * and JSDoc comments. Outputs a Markdown table by default or detailed JSON
 * via --json flag.
 *
 * Usage:
 *   tsx scripts/extract/exports.ts <path>                    # Markdown table (default)
 *   tsx scripts/extract/exports.ts <path> --json             # Detailed JSON output
 *   tsx scripts/extract/exports.ts <path> --help             # Show usage information
 *
 * @category analysis
 * @usage tsx scripts/extract/exports.ts <path> [--json]
 */

import { statSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { createProject, loadSourceFile, extractExports, ParsedExport } from '../../_lib/ts-parser.js'
import { markdownTable, toJson } from '../../_lib/format.js'

// ── Types ─────────────────────────────────────────────────────────────

/** Export kind with display icon */
type ExportKind = 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'other'

/** Display metadata for each export kind */
interface KindMeta {
  icon: string
  label: string
}

// ── Configuration ─────────────────────────────────────────────────────

/** Export kind display metadata */
const KIND_META: Record<ExportKind, KindMeta> = {
  function: { icon: '⚡', label: 'Function' },
  class: { icon: '🏗️', label: 'Class' },
  const: { icon: '📦', label: 'Const' },
  type: { icon: '🔤', label: 'Type' },
  interface: { icon: '📋', label: 'Interface' },
  enum: { icon: '🏷️', label: 'Enum' },
  other: { icon: '📄', label: 'Other' },
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Format a parameter list for display.
 * @param params Array of { name, type } objects
 * @returns Formatted string like "(a: number, b: string)" or empty string
 */
export function formatParameters(params?: Array<{ name: string; type: string }>): string {
  if (!params || params.length === 0) return ''

  const formatted = params.map(p => `${p.name}: ${p.type}`).join(', ')
  return `(${formatted})`
}

/**
 * Build a compact signature string for display in the Markdown table.
 * Includes async marker, parameters, and return type.
 */
export function buildSignature(exp: ParsedExport): string {
  const prefix = exp.isAsync ? 'async ' : ''
  const params = formatParameters(exp.parameters)

  if (exp.kind === 'class') {
    return `${prefix}${exp.name}`
  }

  if (exp.kind === 'const' || exp.kind === 'interface' || exp.kind === 'enum') {
    return `${exp.name}`
  }

  // For functions, types, interfaces, enums — include signature details
  const retType = exp.returnType ? `: ${exp.returnType}` : ''
  return `${prefix}${exp.name}${params}${retType}`
}

/**
 * Truncate a JSDoc comment to a single line for compact display.
 * Strips leading/trailing whitespace and truncates at ~80 chars.
 */
export function truncateJSDoc(jsDoc?: string): string {
  if (!jsDoc) return ''
  // Collapse multi-line into single paragraph, strip leading/trailing whitespace
  const cleaned = jsDoc.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  // Truncate to reasonable length for table display
  return cleaned.length > 100 ? cleaned.slice(0, 97) + '...' : cleaned
}

/**
 * Parse a TypeScript file and extract all exported symbols.
 * @param filePath Absolute path to the .ts file
 * @returns Array of parsed export objects with enriched signatures
 */
export function parseExports(filePath: string): ParsedExport[] {
  const project = createProject()

  try {
    const sourceFile = loadSourceFile(project, filePath)
    if (!sourceFile) {
      return []
    }

    return extractExports(sourceFile)
  } finally {
    // ts-morph v25 doesn't require explicit disposal
  }
}

/**
 * Generate a Markdown table output of exports.
 */
export function generateMarkdownTable(exports: ParsedExport[], filePath: string): string {
  const fileName = filePath.split('/').pop() || filePath

  let output = `# Exports: ${fileName}\n\n`

  if (exports.length === 0) {
    output += '> No exports found in this file.\n'
    return output.trim() + '\n'
  }

  // Group by kind for better readability
  const grouped: Record<string, ParsedExport[]> = {}
  for (const exp of exports) {
    if (!grouped[exp.kind]) grouped[exp.kind] = []
    grouped[exp.kind].push(exp)
  }

  let totalLines = 0

  // Add a summary line
  const kindCounts: Record<string, number> = {}
  for (const exp of exports) {
    kindCounts[exp.kind] = (kindCounts[exp.kind] || 0) + 1
  }
  output += `**${exports.length} export(s)** — ${Object.entries(kindCounts).map(([k, v]) => `${v}x ${KIND_META[k as ExportKind]?.label ?? k}`).join(', ')}\n\n`

  // Build table rows grouped by kind
  for (const [kind, items] of Object.entries(grouped)) {
    const meta = KIND_META[kind as ExportKind] || KIND_META.other
    output += `## ${meta.icon} ${meta.label}\n\n`

    const headers = ['Name', 'Signature', 'JSDoc']
    const rows: string[][] = []

    for (const exp of items) {
      const sig = buildSignature(exp)
      const jsDoc = truncateJSDoc(exp.jsDoc)
      rows.push([exp.name, `\`${sig}\``, jsDoc])
      totalLines++
    }

    output += markdownTable(headers, rows) + '\n'
  }

  return output.trim() + '\n'
}

/**
 * Generate detailed JSON output of exports.
 */
export function generateJsonOutput(exports: ParsedExport[], filePath: string): string {
  const data = {
    file: filePath.split('/').pop(),
    path: filePath,
    exportCount: exports.length,
    exports: exports.map(exp => ({
      name: exp.name,
      kind: exp.kind,
      signature: buildSignature(exp),
      parameters: exp.parameters || [],
      returnType: exp.returnType || undefined,
      isAsync: exp.isAsync || false,
      jsDoc: exp.jsDoc || undefined,
    })),
  }

  return toJson(data)
}

/**
 * Generate help text.
 */
export function generateHelp(): string {
  return `Usage: tsx scripts/extract/exports.ts <path> [options]

TypeScript export extractor. Parses a TypeScript file and outputs its public API
with signatures, JSDoc comments, and type information.

Arguments:
  path          Path to the .ts file to analyze

Options:
  --json        Output detailed JSON (includes parameters, return types, async flag)
  --help        Show this help message

Output Formats:
  Default       Markdown table grouped by export kind (Name | Signature | JSDoc)
  --json        Detailed JSON with full parameter lists and metadata

Examples:
  tsx scripts/extract/exports.ts src/services/sale.ts
  tsx scripts/extract/exports.ts src/types/index.ts --json
  tsx scripts/extract/exports.ts _lib/ts-parser.ts`
}

/**
 * Generate the full output for a given file.
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

  // Check if file exists and is a file
  try {
    const stats = statSync(resolvedPath)
    if (!stats.isFile()) {
      return `Error: '${resolvedPath}' is not a file.\n`
    }
  } catch {
    return `Error: File not found at '${resolvedPath}'.\n`
  }

  const exports = parseExports(resolvedPath)

  if (json) {
    return generateJsonOutput(exports, resolvedPath)
  }

  return generateMarkdownTable(exports, resolvedPath)
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../../_lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    if (help) {
      return generateHelp()
    }
    if (!targetPath || targetPath === '.') {
      console.error('Error: Please provide a TypeScript file path.')
      process.exit(1)
    }
    return generateOutput(targetPath, json, help)
  },
  'exports.ts',
  { exitCodeOnError: 1 }
)
