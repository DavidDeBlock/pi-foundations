#!/usr/bin/env tsx
/**
 * scripts/synthesize/api-surface.ts — API contract synthesizer.
 *
 * Combines route definitions (method, path) with type information to produce
 * a full API surface map. Scans route files and attempts to infer request/response
 * types from handler signatures or JSDoc comments.
 *
 * Usage:
 *   tsx scripts/synthesize/api-surface.ts [path]           # Markdown (default)
 *   tsx scripts/synthesize/api-surface.ts [path] --json    # Machine-readable JSON
 *   tsx scripts/synthesize/api-surface.ts --help            # Show usage info
 *
 * @category synthesis
 * @usage tsx scripts/synthesize/api-surface.ts [path] [--json]
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

interface ApiEndpoint {
  method: string;
  path: string;
  handler?: string;
  inputType?: string;
  outputType?: string;
}

/** Complete API surface map */
export interface ApiSurfaceMap {
  endpoints: ApiEndpoint[];
  sourceFiles: string[];
}

// ── Configuration ─────────────────────────────────────────────────────

/** Scan options for API surface — skips common dirs, includes .ts only */
const API_SURFACE_SCAN_OPTIONS = {
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

// ── Core Functions ────────────────────────────────────────────────────

/** Recursively find all .ts files in a directory (using shared scanner) */
function findTsFiles(dirPath: string): string[] {
  return _scanFiles(dirPath, API_SURFACE_SCAN_OPTIONS);
}

/** Extract Hono route patterns from file content */
function extractRoutes(content: string, filePath: string): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match Hono route patterns: .get('/path', ...), .post('/path', ...)
    const match = line.match(/\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/i);

    if (match) {
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        handler: extractHandlerSignature(lines, i),
      });
    }
  }

  return endpoints;
}

/** Extract handler signature from the route definition */
function extractHandlerSignature(lines: string[], routeLineIndex: number): string | undefined {
  // Look for the next few lines after the route declaration to find type references
  const searchLines = lines.slice(routeLineIndex, routeLineIndex + 10).join(" ");

  // Try to find zValidator or similar type inference patterns
  const validatorMatch = searchLines.match(/zValidator\s*\(\s*['"](\w+)['"]/);
  if (validatorMatch) {
    return `Input: ${validatorMatch[1]}`;
  }

  // Look for type annotations in the handler function
  const funcMatch = searchLines.match(/\(c\)\s*=>\s*(?:async\s+)?\{?/);
  if (funcMatch) {
    return "Handler defined inline";
  }

  return undefined;
}

/** Scan directory and build API surface map */
export function scanApiSurface(dirPath: string): ApiSurfaceMap {
  const tsFiles = findTsFiles(dirPath);
  let allEndpoints: ApiEndpoint[] = [];
  const sourceFiles: string[] = [];

  for (const file of tsFiles) {
    try {
      const content = readFileSync(file, "utf-8");
      // Only process route files (usually contain .get/.post patterns or are named 'routes')
      if (content.includes(".get(") || content.includes(".post(") || basename(file).includes("route")) {
        const endpoints = extractRoutes(content, file);
        if (endpoints.length > 0) {
          allEndpoints.push(...endpoints);
          sourceFiles.push(file);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return { endpoints: allEndpoints, sourceFiles };
}

/** Generate Markdown table output */
export function generateMarkdownTable(map: ApiSurfaceMap): string {
  let output = "# API Surface\n\n";

  if (map.endpoints.length === 0) {
    output += "> No routes found in scanned files.\n";
    return output.trim() + "\n";
  }

  const headers = ["Method", "Path", "Handler"];
  const rows: string[][] = [];

  for (const ep of map.endpoints) {
    rows.push([ep.method, `\`${ep.path}\``, ep.handler || "-"]);
  }

  output += markdownTable(headers, rows) + "\n";

  if (map.sourceFiles.length > 0) {
    const relPaths = map.sourceFiles.map((f) => relative(process.cwd(), f));
    output += `\n*Source: ${relPaths.join(", ")}*\n`;
  }

  return output.trim() + "\n";
}

/** Generate JSON output */
export function generateJsonOutput(map: ApiSurfaceMap): string {
  const data = {
    endpointCount: map.endpoints.length,
    endpoints: map.endpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      handler: ep.handler || null,
    })),
    sourceFiles: map.sourceFiles.map((f) => relative(process.cwd(), f)),
  };

  return toJson(data);
}

/** Generate help text */
export function generateHelp(): string {
  return `Usage: tsx scripts/synthesize/api-surface.ts [path] [--json|--help]

API contract synthesizer. Scans route files and extracts all HTTP endpoints with their paths, methods, and handler signatures.

Arguments:
  path          Directory to scan (defaults to current directory)

Options:
  --json        Output machine-readable JSON with full metadata
  --help        Show this help message

Output Formats:
  Default       Markdown table (Method | Path | Handler) + source file list
  --json        Detailed JSON array of endpoints and sources

Examples:
  tsx scripts/synthesize/api-surface.ts                       # Scan current directory
  tsx scripts/synthesize/api-surface.ts ./server/src          # Scan backend routes
  tsx scripts/synthesize/api-surface.ts --json                # JSON output`;
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

  const map = scanApiSurface(resolvedPath);

  if (json) return generateJsonOutput(map);
  return generateMarkdownTable(map);
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../../_lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    return generateOutput(targetPath, json, help)
  },
  'api-surface.ts',
  { defaultPath: '.' }
)
