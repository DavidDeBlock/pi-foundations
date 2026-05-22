/**
 * _lib/scanner.ts — Configurable directory scanner.
 *
 * Replaces N independent inline scanners with one deep module. Each caller
 * passes its SKIP_DIRS, extension filters, and exclusion patterns via an
 * options object. One implementation replaces shallow copies.
 *
 * Usage:
 *   import { scanDirectory, DEFAULT_SCAN_OPTIONS } from './_lib/scanner.js'
 *   const files = scanDirectory(dirPath, { ...DEFAULT_SCAN_OPTIONS })
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────

/** Options controlling how `scanDirectory` walks a directory tree. */
export interface ScanOptions {
  /** Directories to skip entirely during scanning (e.g., node_modules, .git). */
  skipDirs?: Set<string>;

  /** File extensions to include (e.g., new Set(['.ts', '.tsx'])). Defaults to ['.ts']. */
  extensions?: string[];

  /** Patterns that exclude files even if they match the extension filter.
   *  Each pattern is matched against the basename via `endsWith`.
   *  Default: ['.d.ts', '.test.ts'] — excludes type declarations and test files. */
  excludePatterns?: string[];

  /** Whether to skip hidden entries (names starting with '.'). Default: true. */
  skipHidden?: boolean;
}

/** Default scan options used by most scripts in this project. */
export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  skipDirs: new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    "__test__",
    "__test-fixtures__",
    "__snapshots__",
  ]),
  extensions: [".ts"],
  excludePatterns: [".d.ts", ".test.ts"],
  skipHidden: true,
};

// ── Core Scanner ────────────────────────────────────────────────────────

/**
 * Recursively find all matching files in a directory tree.
 *
 * @param dirPath - Absolute path to the root directory to scan.
 * @param options   - Configuration controlling which files are included.
 * @returns Sorted array of absolute file paths.
 */
export function scanDirectory(
  dirPath: string,
  options: ScanOptions = DEFAULT_SCAN_OPTIONS
): string[] {
  const {
    skipDirs = new Set(),
    extensions = [".ts"],
    excludePatterns = [".d.ts", ".test.ts"],
    skipHidden = true,
  } = options;

  const files: string[] = [];

  try {
    const entries = readdirSync(dirPath);

    for (const entry of entries.sort()) {
      // Skip hidden entries
      if (skipHidden && entry.startsWith(".")) continue;

      // Skip excluded directories
      if (skipDirs.has(entry)) continue;

      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...scanDirectory(fullPath, options));
      } else if (_matchesFile(entry, extensions, excludePatterns)) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — return empty
  }

  return files;
}

/** Check whether a filename matches the extension and exclusion filters. */
function _matchesFile(
  name: string,
  extensions: string[],
  excludePatterns: string[]
): boolean {
  // If no extensions specified, accept all files (used by code-tree)
  if (extensions.length === 0) {
    // Still apply exclusion patterns
    for (const pattern of excludePatterns) {
      if (name.endsWith(pattern)) return false;
    }
    return true;
  }

  // Must match at least one allowed extension
  if (!extensions.some((ext) => name.endsWith(ext))) return false;

  // Must not match any exclusion pattern
  for (const pattern of excludePatterns) {
    if (name.endsWith(pattern)) return false;
  }

  return true;
}
