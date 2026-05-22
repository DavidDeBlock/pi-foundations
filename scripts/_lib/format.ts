/**
 * scripts/_lib/format.ts — Shared formatting utilities for all scripts.
 *
 * Provides `markdownTable()` and `toJson()` used by every script in the
 * synthesize/ and validate/ directories.  Keeping these here avoids copy-
 * paste duplication while staying dependency-free (no external libs).
 */

// ── Markdown Table ────────────────────────────────────────────────────────

/** Generate a Markdown table from headers and rows */
export function markdownTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return "";

  const escape = (cell: string): string => cell.replace(/\|/g, "\\|");

  let result = `| ${headers.map(escape).join(" | ")} |\n`;

  const colWidths = headers.map((_, i) => {
    let maxLen = headers[i].length;
    for (const row of rows) {
      if (row[i]) maxLen = Math.max(maxLen, row[i].length);
    }
    return maxLen;
  });

  const separator = `|${colWidths.map((w) => "-".repeat(Math.max(w, 3) + 2)).join("|")}|\n`;
  result += separator;

  for (const row of rows) {
    const cells = headers.map((_, i) => escape(row[i] ?? ""));
    result += `| ${cells.join(" | ")} |\n`;
  }

  return result;
}

// ── JSON Serialization ───────────────────────────────────────────────────

/** Serialize data to a pretty-printed JSON string */
export function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}
