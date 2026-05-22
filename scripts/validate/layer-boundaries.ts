#!/usr/bin/env tsx
/**
 * scripts/validate/layer-boundaries.ts — Layer boundary validator.
 *
 * Scans TypeScript files for cross-layer import violations based on directory structure.
 * Enforces rules like: routes -> services -> repositories (no direct route->repo imports).
 * Outputs a compact table of violations found.
 *
 * Usage:
 *   tsx scripts/validate/layer-boundaries.ts [path]           # Markdown (default)
 *   tsx scripts/validate/layer-boundaries.ts [path] --json    # Machine-readable JSON
 *   tsx scripts/validate/layer-boundaries.ts --help            # Show usage info
 *
 * @category validation
 * @usage tsx scripts/validate/layer-boundaries.ts [path] [--json]
 */

import {
  statSync,
  existsSync,
  readFileSync
} from "node:fs";
import { resolve, join, relative, basename, dirname } from "node:path";
import { scanDirectory as _scanFiles } from "../lib/scanner.js";
import { markdownTable, toJson } from "../lib/format.js";

// ── Types ─────────────────────────────────────────────────────────────

/** A single layer boundary violation */
export interface LayerViolation {
  file: string;
  line?: number;
  importPath: string;
  reason: string; // e.g., "Route importing directly from repository"
}

/** Complete validation report */
export interface LayerValidationReport {
  totalFiles: number;
  violations: LayerViolation[];
  status: "clean" | "violations";
}

// ── Configuration ─────────────────────────────────────────────────────

/** Scan options for layer boundaries — skips common dirs, includes .ts only */
const LAYER_BOUNDARIES_SCAN_OPTIONS = {
  skipDirs: new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    "__test__",
    "__snapshots__",
  ]),
  extensions: [".ts"],
  excludePatterns: [".d.ts", ".test.ts"],
  skipHidden: true,
};

/** Layer boundary rules — defines allowed import paths per layer */
const LAYER_RULES: Record<string, string[]> = {
  // Routes can only import from services and shared types
  routes: ["services", "shared", "types"],
  // Services can import from repositories, shared types, and other services (carefully)
  services: ["repositories", "shared", "types"],
  // Repositories should only touch db schema and shared types
  repositories: ["db", "shared", "types"],
};

// ── Core Functions ────────────────────────────────────────────────────

/** Recursively find all .ts source files (using shared scanner) */
function findTsFiles(dirPath: string): string[] {
  return _scanFiles(dirPath, LAYER_BOUNDARIES_SCAN_OPTIONS);
}

/** Determine which layer a file belongs to based on its directory */
function getLayer(filePath: string): string | undefined {
  for (const layer of Object.keys(LAYER_RULES)) {
    if (filePath.includes(`/${layer}/`)) {
      return layer;
    }
  }
  return undefined;
}

/** Check if an import path violates the layer rules */
function checkImportViolation(fileLayer: string, importPath: string): LayerViolation | null {
  const allowedLayers = LAYER_RULES[fileLayer];
  if (!allowedLayers) return null; // No rules defined for this layer

  for (const layer of allowedLayers) {
    if (importPath.includes(`/${layer}/`)) {
      return null; // Import is allowed
    }
  }

  // Determine the actual target layer from the import path
  const matchedLayer = Object.keys(LAYER_RULES).find((l) => importPath.includes(`/${l}/`));
  if (matchedLayer && matchedLayer !== fileLayer) {
    return {
      file: relative(process.cwd(), fileLayer === "routes" ? findRouteForImport(fileLayer, importPath) : ""),
      line: undefined, // Could enhance with line number parsing
      importPath,
      reason: `${fileLayer} importing from ${matchedLayer}`,
    };
  }

  return null;
}

/** Helper to find the route file that likely owns this violation (for reporting) */
function findRouteForImport(layerDir: string, _importPath: string): string {
  // Simplified — in a real implementation we'd map imports back to source files
  return layerDir;
}

/** Extract import paths from a TypeScript file */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Match: import ... from 'path' or import('path')
    const match = line.match(/['"](\.[^'"]+)['"]/);
    if (match && !match[1].endsWith(".css") && !match[1].endsWith(".json")) {
      imports.push(match[1]);
    }
  }

  return imports;
}

/** Scan directory and validate layer boundaries */
export function scanLayerBoundaries(dirPath: string): LayerValidationReport {
  const tsFiles = findTsFiles(dirPath);
  let violations: LayerViolation[] = [];

  for (const file of tsFiles) {
    const content = readFileSync(file, "utf-8");
    const fileLayer = getLayer(file);

    if (!fileLayer) continue; // Skip files not in a defined layer

    const imports = extractImports(content);
    for (const importPath of imports) {
      const violation = checkImportViolation(fileLayer, importPath);
      if (violation) violations.push(violation);
    }
  }

  return {
    totalFiles: tsFiles.length,
    violations,
    status: violations.length === 0 ? "clean" : "violations",
  };
}

/** Generate Markdown table output */
export function generateMarkdownTable(report: LayerValidationReport): string {
  let output = "# Layer Boundaries\n\n";

  if (report.status === "clean") {
    output += "> ✅ No layer boundary violations found.\n";
    return output.trim() + "\n";
  }

  const headers = ["File", "Import", "Violation"];
  const rows: string[][] = [];

  for (const v of report.violations) {
    rows.push([`\`${v.file}\``, `\`${v.importPath}\``, v.reason]);
  }

  output += markdownTable(headers, rows) + "\n";
  return output.trim() + "\n";
}

/** Generate JSON output */
export function generateJsonOutput(report: LayerValidationReport): string {
  const data = {
    status: report.status,
    totalFiles: report.totalFiles,
    violationCount: report.violations.length,
    violations: report.violations.map((v) => ({
      file: v.file,
      importPath: v.importPath,
      reason: v.reason,
    })),
  };

  return toJson(data);
}

/** Generate help text */
export function generateHelp(): string {
  return `Usage: tsx scripts/validate/layer-boundaries.ts [path] [--json|--help]

Layer boundary validator. Checks for cross-layer import violations based on directory structure.

Arguments:
  path          Directory to scan (defaults to current directory)

Options:
  --json        Output machine-readable JSON with full metadata
  --help        Show this help message

Output Formats:
  Default       Markdown table (File | Import | Violation) + status summary
  --json        Detailed JSON array of violations

Layer Rules:
  routes    → services, shared, types
  services  → repositories, shared, types
  repositories → db, shared, types

Examples:
  tsx scripts/validate/layer-boundaries.ts                       # Scan current directory
  tsx scripts/validate/layer-boundaries.ts ./server/src          # Scan backend layers
  tsx scripts/validate/layer-boundaries.ts --json                # JSON output`;
}

/** Generate a Markdown table from headers and rows */
export function generateOutput(targetPath: string, json = false, help = false): string {
  if (help) return generateHelp();

  const resolvedPath = resolve(targetPath || ".");

  if (!existsSync(resolvedPath)) {
    return `Error: Directory not found at '${resolvedPath}'.\n`;
  }

  if (!statSync(resolvedPath).isDirectory()) {
    return `Error: '${resolvedPath}' is not a directory.\n`;
  }

  const report = scanLayerBoundaries(resolvedPath);

  if (json) return generateJsonOutput(report);
  return generateMarkdownTable(report);
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    return generateOutput(targetPath, json, help)
  },
  'layer-boundaries.ts',
  { defaultPath: '.' }
)
