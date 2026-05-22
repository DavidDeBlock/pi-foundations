/**
 * scripts/lib/format.ts — Shared formatting utilities for all scripts.
 *
 * Provides deterministic, compact output formats:
 * - Markdown tables for flat data (routes, exports)
 * - Unicode trees for hierarchical data (directory structures)
 * - JSON for machine consumption (--json flag)
 */

// ── Markdown Tables ───────────────────────────────────────────────────

/**
 * Generate a Markdown table from headers and rows.
 * @param headers Column header names
 * @param rows Array of row arrays (one per column)
 * @returns Formatted Markdown table string
 */
export function markdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return ''

  // Escape pipe characters in cells to prevent table breakage
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|')

  // Header row
  let result = `| ${headers.map(escape).join(' | ')} |\n`

  // Separator row — calculate column widths for alignment
  const colWidths = headers.map((_, i) => {
    let maxLen = headers[i].length
    for (const row of rows) {
      if (row[i]) maxLen = Math.max(maxLen, row[i].length)
    }
    return maxLen
  })

  const separator = `|${colWidths.map(w => '-'.repeat(Math.max(w, 3) + 2)).join('|')}|\n`
  result += separator

  // Data rows
  for (const row of rows) {
    const cells = headers.map((_, i) => escape(row[i] ?? ''))
    result += `| ${cells.join(' | ')} |\n`
  }

  return result
}

// ── Unicode Trees ─────────────────────────────────────────────────────

/**
 * Generate an indented Unicode tree from a nested object.
 * @param data Nested object representing directory/file hierarchy
 * @returns Formatted Unicode tree string
 */
export function unicodeTree(data: Record<string, unknown>): string {
  const entries = Object.entries(data)
  if (entries.length === 0) return ''

  const lines: string[] = []

  function renderNode(name: string, children: Record<string, unknown>, prefix: string): void {
    const childEntries = Object.entries(children)

    // Always show directory marker for objects (even empty ones)
    lines.push(`${prefix}${name}/`)

    const newPrefix = prefix + '  '

    for (let i = 0; i < childEntries.length; i++) {
      const [childName, childValue] = childEntries[i]
      const isLastChild = i === childEntries.length - 1
      const connector = isLastChild ? '└── ' : '├── '

      if (typeof childValue === 'object' && childValue !== null) {
        renderNode(childName, childValue as Record<string, unknown>, newPrefix + connector)
      } else {
        lines.push(`${newPrefix}${connector}${childName}`)
      }
    }
  }

  // Root entries
  for (let i = 0; i < entries.length; i++) {
    const [name, value] = entries[i]
    const isLast = i === entries.length - 1

    if (typeof value === 'object' && value !== null) {
      renderNode(name, value as Record<string, unknown>, '')
    } else {
      lines.push(`${isLast ? '└── ' : '├── '}${name}`)
    }
  }

  return lines.join('\n') + '\n'
}

// ── JSON Output ───────────────────────────────────────────────────────

/**
 * Serialize data to a JSON string.
 * @param data Value to serialize
 * @param compact If true, produce single-line output; otherwise pretty-print (2-space indent)
 * @returns JSON string representation
 */
export function toJson(data: unknown, compact = false): string {
  return JSON.stringify(data, null, compact ? undefined : 2) + '\n'
}
