// tag-normalizer.ts — issue #008
//
// Pure normalization for tag names. The dashboard's tags are stored in
// a single `tags` table with a UNIQUE constraint on `name`; the value
// stored there MUST be the output of `normalize()`. This module owns
// the contract: lowercased, trimmed, whitespace-padded, special chars
// collapsed to single hyphens, no leading/trailing hyphens, no empties.
//
// Why a deep module:
//   - The PRD module map calls this one of the 5 deep modules with
//     100% unit-test coverage. It has zero side effects, so it's
//     trivial to test exhaustively.
//   - All callers go through `normalize()` before insert. If we ever
//     change the canonical form (e.g. allow `+` in tags), this is the
//     ONE place to update — and the tests will catch regressions.
//
// NOT responsible for:
//   - DB queries (tags.ts handles storage)
//   - UI rendering (activity-feed.ts renders the chips)

/**
 * Normalize a single tag name to its canonical form.
 *
 * Rules (applied in order):
 *   1. Trim leading/trailing whitespace.
 *   2. Lowercase (locale-independent; we don't want Turkish "İ" → "i"
 *      to differ from "I" → "i" surprises).
 *   3. Collapse runs of non-letter, non-digit characters into a single
 *      hyphen. Letters and digits include Unicode `\p{L}` and `\p{N}`
 *      so "café" and "数据" round-trip unchanged.
 *   4. Strip leading/trailing hyphens.
 *   5. Return `""` if nothing remains (e.g. user typed only punctuation).
 *
 * Examples:
 *   normalize("Postgres")            // "postgres"
 *   normalize("  PostgreSQL  ")       // "postgresql"
 *   normalize("Database & SQL")      // "database-sql"
 *   normalize("C++")                 // "c"
 *   normalize("---")                 // ""
 *   normalize("café")                // "café"
 *   normalize("数据存储")             // "数据存储"
 */
export function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Normalize a list of tag names AND dedupe case-insensitively, returning
 * the first canonical form of each unique tag in input order.
 *
 * The case-insensitivity is enforced by `normalize()` already lowercasing;
 * after normalization, "Postgres" and "postgres" both become "postgres"
 * and the dedupe is just a `Set` lookup. We use `Set` to preserve the
 * "first occurrence wins" semantic, so `["Postgres", "POSTGRES", "postgres"]`
 * returns `["postgres"]` (not multiple).
 *
 * Empty results (from normalize() returning "") are filtered out so the
 * caller doesn't accidentally insert a blank tag.
 *
 * Used by:
 *   - `tags.ts attachTags()` — when the UI sends a list of tag names
 *     typed by the user.
 *   - `tags.ts replaceTags()` — same.
 *
 * Example:
 *   normalizeAll(["Postgres", "Postgres", "  database "])
 *   // → ["postgres", "database"]
 */
export function normalizeAll(raws: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of raws) {
    const canonical = normalize(raw)
    if (canonical === '') continue
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push(canonical)
  }
  return out
}