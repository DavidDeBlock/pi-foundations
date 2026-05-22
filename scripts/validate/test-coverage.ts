#!/usr/bin/env tsx
/**
 * scripts/validate/test-coverage.ts — Test coverage scanner.
 *
 * Scans a directory for TypeScript files and checks if corresponding test files
 * exist (e.g., `foo.ts` -> `foo.test.ts` or in `__tests__/`).
 * Outputs a compact table showing which files have tests and which don't.
 *
 * Usage:
 *   tsx scripts/validate/test-coverage.ts [path]           # Markdown (default)
 *   tsx scripts/validate/test-coverage.ts [path] --json    # Machine-readable JSON
 *   tsx scripts/validate/test-coverage.ts --help            # Show usage info
 *
 * @category validation
 * @usage tsx scripts/validate/test-coverage.ts [path] [--json]
 */

import {
  statSync,
  existsSync,
  readFileSync
} from "node:fs";
import { resolve, join, relative, dirname, basename } from "node:path";
import { scanDirectory as _scanFiles } from "../../_lib/scanner.js";
import { markdownTable, toJson } from "../../_lib/format.js";

// ── Types ─────────────────────────────────────────────────────────────

interface CoverageEntry {
  file: string;
  hasTest: boolean;
  testPath?: string;
}

/** Complete coverage report */
export interface TestCoverageReport {
  totalFiles: number;
  testedCount: number;
  untestedCount: number;
  coveragePercent: number;
  entries: CoverageEntry[];
}

// ── Configuration ─────────────────────────────────────────────────────

/** Scan options for test coverage — includes .ts/.tsx, excludes tests */
const TEST_COVERAGE_SCAN_OPTIONS = {
  skipDirs: new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    "__test__",
    "__snapshots__",
  ]),
  extensions: [".ts", ".tsx"],
  excludePatterns: [
    ".d.ts",
    ".test.ts",
    ".test.tsx",
    ".spec.ts",
    ".spec.tsx",
  ],
  skipHidden: true,
};

// ── Core Functions ────────────────────────────────────────────────────

/** Recursively find all .ts/.tsx source files (excluding tests) */
function findSourceFiles(dirPath: string): string[] {
  return _scanFiles(dirPath, TEST_COVERAGE_SCAN_OPTIONS);
}

/** Check if a corresponding test file exists */
function findTestFile(sourcePath: string): { found: boolean; path?: string } {
  const fileName = basename(sourcePath);
  const dirName = dirname(sourcePath);
  const baseName = fileName.replace(/\.(tsx?)$/, "");

  // Pattern 1: foo.test.tsx in same directory
  for (const pattern of TEST_PATTERNS) {
    const testPath = join(dirName, `${baseName}${pattern}`);
    try {
      if (statSync(testPath).isFile()) {
        return { found: true, path: testPath };
      }
    } catch {
      // File doesn't exist
    }
  }

  // Pattern 2: foo.ts in __tests__/ directory (e.g., components/__tests__/DetailCardGrid.test.tsx)
  const testsDir = join(dirName, "__tests__");
  try {
    if (existsSync(testsDir) && statSync(testsDir).isDirectory()) {
      const entries = readdirSync(testsDir);
      for (const entry of entries) {
        // Match: DetailCardGrid.test.tsx
        if (entry === `${baseName}.test.tsx`) return { found: true, path: join(testsDir, entry) };
        // Match: DetailCardGrid.spec.tsx
        if (entry === `${baseName}.spec.tsx`) return { found: true, path: join(testsDir, entry) };
      }
    }
  } catch {
    // __tests__ dir doesn't exist — not a failure
  }

  return { found: false };
}

/** Scan directory and generate coverage report */
export function scanCoverage(dirPath: string): TestCoverageReport {
  const sourceFiles = findSourceFiles(dirPath);
  let testedCount = 0;
  const entries: CoverageEntry[] = [];

  for (const file of sourceFiles) {
    const testInfo = findTestFile(file);
    if (testInfo.found) testedCount++;

    entries.push({
      file: relative(process.cwd(), file),
      hasTest: testInfo.found,
      testPath: testInfo.path ? relative(process.cwd(), testInfo.path) : undefined,
    });
  }

  return {
    totalFiles: sourceFiles.length,
    testedCount,
    untestedCount: sourceFiles.length - testedCount,
    coveragePercent:
      sourceFiles.length > 0
        ? Math.round((testedCount / sourceFiles.length) * 100)
        : 0,
    entries,
  };
}

/** Generate Markdown table output */
export function generateMarkdownTable(report: TestCoverageReport): string {
  let output = "# Test Coverage\n\n";
  output += `**${report.coveragePercent}% coverage** (${report.testedCount}/${report.totalFiles} files)\n\n`;

  if (report.entries.length === 0) {
    output += "> No TypeScript source files found.\n";
    return output.trim() + "\n";
  }

  const headers = ["File", "Status"];
  const rows: string[][] = [];

  for (const entry of report.entries) {
    if (entry.hasTest) {
      rows.push([`\`${entry.file}\``, `✅ ${entry.testPath}`]);
    } else {
      rows.push([`\`${entry.file}\``, "❌ No test"]);
    }
  }

  output += markdownTable(headers, rows) + "\n";
  return output.trim() + "\n";
}

/** Generate JSON output */
export function generateJsonOutput(report: TestCoverageReport): string {
  const data = {
    coveragePercent: report.coveragePercent,
    totalFiles: report.totalFiles,
    testedCount: report.testedCount,
    untestedCount: report.untestedCount,
    entries: report.entries,
  };

  return toJson(data);
}

/** Generate help text */
export function generateHelp(): string {
  return `Usage: tsx scripts/validate/test-coverage.ts [path] [--json|--help]

Test coverage scanner. Checks which TypeScript files have corresponding test files.

Arguments:
  path          Directory to scan (defaults to current directory)

Options:
  --json        Output machine-readable JSON with full metadata
  --help        Show this help message

Output Formats:
  Default       Markdown table (File | Status) + coverage percentage summary
  --json        Detailed JSON with file paths and test locations

Examples:
  tsx scripts/validate/test-coverage.ts                       # Scan current directory
  tsx scripts/validate/test-coverage.ts ./server/src          # Scan specific directory
  tsx scripts/validate/test-coverage.ts --json                # JSON output`;
}

// ── Main Output Generator ─────────────────────────────────────────────

export function generateOutput(targetPath: string, json = false, help = false): string {
  if (help) return generateHelp();

  const resolvedPath = resolve(targetPath || ".");

  if (!existsSync(resolvedPath)) {
    return `Error: Directory not found at '${resolvedPath}'.\n`;
  }

  if (!statSync(resolvedPath).isDirectory()) {
    return `Error: '${resolvedPath}' is not a directory.\n`;
  }

  const report = scanCoverage(resolvedPath);

  if (json) return generateJsonOutput(report);
  return generateMarkdownTable(report);
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../../_lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    return generateOutput(targetPath, json, help)
  },
  'test-coverage.ts',
  { defaultPath: '.' }
)
