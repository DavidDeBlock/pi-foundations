#!/usr/bin/env tsx
/**
 * scripts/synthesize/domain-model.ts — Domain model synthesizer.
 *
 * Parses domain schema files (e.g., Drizzle ORM) using standardized JSDoc tags
 * (`@entity`, `@relation`) to output a semantic graph of entities and their
 * relationships. Uses timestamp-based caching for performance.
 *
 * Usage:
 *   tsx scripts/synthesize/domain-model.ts [path]           # Markdown (default)
 *   tsx scripts/synthesize/domain-model.ts [path] --json    # Machine-readable JSON
 *   tsx scripts/synthesize/domain-model.ts --help            # Show usage info
 *
 * @category synthesis
 * @usage tsx scripts/synthesize/domain-model.ts [path] [--json]
 */

import {
  mkdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, basename, relative } from "node:path";
import { scanDirectory as _scanFiles } from "../lib/scanner.js";
import { markdownTable, toJson } from "../lib/format.js";
import {
  createProject,
  loadSourceFile,
  extractEntityTags,
  extractRelationTags,
} from "../lib/ts-parser.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Re-export domain model types from ts-parser for backward compatibility */
export type { DomainEntity, DomainRelation } from "../lib/ts-parser.js";

/** Complete domain model output */
export interface DomainModel {
  entities: DomainEntity[];
  relations: DomainRelation[];
  sourceFiles: string[];
}

// ── Configuration ─────────────────────────────────────────────────────

/** Scan options for domain model — skips common dirs, includes .ts only */
const DOMAIN_MODEL_SCAN_OPTIONS = {
  skipDirs: new Set([
    "node_modules",
    ".git",
    "dist",
    ".cache",
    "__snapshots__",
    "__test-fixtures__",
  ]),
  extensions: [".ts"],
  excludePatterns: [".d.ts", ".test.ts"],
  skipHidden: true,
};

/** Cache directory for timestamp-based invalidation */
const CACHE_DIR = resolve(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "domain-model.json");

// ── Domain Schema Parsing (ts-morph AST) ─────────────────────────────

/**
 * Parse a domain schema file and extract entities and relations.
 * Uses ts-morph AST via scripts/lib/ts-parser.js for reliable extraction.
 */
export function parseDomainSchema(filePath: string): {
  entities: DomainEntity[];
  relations: DomainRelation[];
} {
  const project = createProject();
  const sourceFile = loadSourceFile(project, filePath);

  if (!sourceFile) {
    throw new Error(`Could not load source file: ${filePath}`);
  }

  const entities = extractEntityTags(sourceFile);
  const relations = extractRelationTags(sourceFile);

  return { entities, relations };
}

// ── Directory Scanning ────────────────────────────────────────────────

/**
 * Recursively find all .ts files in a directory (using shared scanner).
 */
function findTsFiles(dirPath: string): string[] {
  return _scanFiles(dirPath, DOMAIN_MODEL_SCAN_OPTIONS);
}

/**
 * Scan a directory for domain schema files and build the complete model.
 */
export function scanDirectory(dirPath: string): DomainModel {
  const tsFiles = findTsFiles(dirPath);
  let allEntities: DomainEntity[] = [];
  let allRelations: DomainRelation[] = [];
  const sourceFiles: string[] = [];

  for (const file of tsFiles) {
    try {
      const result = parseDomainSchema(file);
      if (result.entities.length > 0 || result.relations.length > 0) {
        allEntities.push(...result.entities);
        allRelations.push(...result.relations);
        sourceFiles.push(file);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  return { entities: allEntities, relations: allRelations, sourceFiles };
}

// ── Caching ───────────────────────────────────────────────────────────

/**
 * Compute a cache key based on file timestamps.
 */
function computeCacheKey(files: string[]): string {
  const entries = files.map((f) => {
    try {
      const stat = statSync(f);
      return `${f}:${stat.mtimeMs}`;
    } catch {
      return `${f}:missing`;
    }
  });
  return JSON.stringify(entries.sort());
}

/**
 * Get the cache file path for a specific directory.
 */
function getCacheFilePath(dirPath: string): string {
  const dirHash = Buffer.from(dirPath).toString("base64url").slice(0, 16);
  return join(CACHE_DIR, `domain-model-${dirHash}.json`);
}

/**
 * Try to load cached domain model for a specific directory.
 */
function getCachedModelForDir(dirPath: string): DomainModel | null {
  try {
    const cacheFile = getCacheFilePath(dirPath);
    if (!existsSync(cacheFile)) return null;

    const cacheData = JSON.parse(readFileSync(cacheFile, "utf-8")) as {
      key: string;
      model: DomainModel;
    };

    // Re-scan files to check timestamps
    const allFiles = findTsFiles(dirPath);
    const schemaFiles = allFiles.filter((f) => {
      try {
        const project = createProject();
        const sf = loadSourceFile(project, f);
        if (!sf) return false;
        const entities = extractEntityTags(sf);
        return entities.length > 0;
      } catch {
        return false;
      }
    });

    if (schemaFiles.length === 0) return null;

    const currentKey = computeCacheKey(schemaFiles);
    if (currentKey !== cacheData.key) return null; // Cache is stale

    return cacheData.model;
  } catch {
    return null;
  }
}

/**
 * Save domain model to cache for a specific directory.
 */
function saveCachedModelForDir(dirPath: string, model: DomainModel): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    const allFiles = findTsFiles(dirPath);
    const schemaFiles = allFiles.filter((f) => {
      try {
        const project = createProject();
        const sf = loadSourceFile(project, f);
        if (!sf) return false;
        const entities = extractEntityTags(sf);
        return entities.length > 0;
      } catch {
        return false;
      }
    });

    const cacheFile = getCacheFilePath(dirPath);
    const key = computeCacheKey(schemaFiles);
    writeFileSync(cacheFile, JSON.stringify({ key, model }, null, 2));
  } catch {
    // Cache failure is non-fatal
  }
}

// ── Output Generation ─────────────────────────────────────────────────

/**
 * Generate a compact Markdown table of the domain model.
 * Designed to fit within ~50 lines for agent context consumption.
 */
export function generateMarkdownTable(model: DomainModel): string {
  let output = "# Domain Model\n\n";

  if (model.entities.length === 0) {
    output += "> No entities found. Add `@entity` tags to your schema files.\n";
    return output.trim() + "\n";
  }

  // Summary line
  const relationCount = model.relations.length;
  output += `**${model.entities.length} entity(ies)** — ${relationCount} relationship(s)\n\n`;

  // Entity table: Name | Table | Fields | Description
  const headers = ["Entity", "Table", "Fields", "Description"];
  const rows: string[][] = [];

  for (const entity of model.entities) {
    const fieldList =
      entity.fields.length > 0
        ? entity.fields.map((f) => `${f.name} (${f.type})`).join(", ")
        : "(no fields)";

    rows.push([
      `**${entity.name}**`,
      `\`${entity.table || "-"}\``,
      fieldList,
      entity.description,
    ]);
  }

  output += markdownTable(headers, rows) + "\n";

  // Relations section (only if there are relations)
  if (model.relations.length > 0) {
    output += "## Relationships\n\n";
    const relHeaders = ["From", "Field", "→ To", "Cardinality"];
    const relRows: string[][] = [];

    for (const rel of model.relations) {
      relRows.push([
        `**${rel.fromEntity}**`,
        `\`${rel.fromField}\``,
        `**${rel.toEntity}**`,
        rel.direction.replace(/-/g, " "),
      ]);
    }

    output += markdownTable(relHeaders, relRows) + "\n";
  }

  // Source files (compact)
  if (model.sourceFiles.length > 0) {
    const relPaths = model.sourceFiles.map((f) => relative(process.cwd(), f));
    output += `\n*Source: ${relPaths.join(", ")}*\n`;
  }

  return output.trim() + "\n";
}

/**
 * Generate JSON output of the domain model.
 */
export function generateJsonOutput(model: DomainModel): string {
  const data = {
    entityCount: model.entities.length,
    relationCount: model.relations.length,
    entities: model.entities.map((e) => ({
      name: e.name,
      table: e.table || null,
      description: e.description,
      fields: e.fields,
    })),
    relations: model.relations.map((r) => ({
      fromEntity: r.fromEntity,
      toEntity: r.toEntity,
      fromField: r.fromField,
      direction: r.direction,
      description: r.description,
    })),
  };

  return toJson(data);
}

/**
 * Generate help text.
 */
export function generateHelp(): string {
  return `Usage: tsx scripts/synthesize/domain-model.ts [path] [--json|--help]

Domain model synthesizer. Parses domain schema files using @entity and @relation
JSDoc tags to output a semantic graph of entities and relationships.

Arguments:
  path          Directory to scan (defaults to current directory)

Options:
  --json        Output machine-readable JSON with full metadata
  --help        Show this help message

Output Formats:
  Default       Markdown table (Entity | Table | Fields | Description) + Relationships section
  --json        Detailed JSON array with entities, fields, and relations

JSDoc Tags:
  @entity EntityName - Optional description
    Defines a domain entity. The name is extracted from the tag.

  @relation SourceEntity.field -> TargetEntity.id (cardinality)
    Defines a relationship between two entities.
    Cardinality options: one-to-many, many-to-one, one-to-one

Examples:
  tsx scripts/synthesize/domain-model.ts                    # Scan current directory
  tsx scripts/synthesize/domain-model.ts ./src/schema       # Scan specific directory
  tsx scripts/synthesize/domain-model.ts --json             # JSON output`;
}

// ── Main Output Generator ─────────────────────────────────────────────

/**
 * Generate the full output for a given directory.
 * Uses caching when available to avoid re-parsing unchanged files.
 */
export function generateOutput(
  targetPath: string,
  json = false,
  help = false,
): string {
  if (help) {
    return generateHelp();
  }

  const resolvedPath = resolve(targetPath || ".");

  // Check if path exists and is a directory
  if (!existsSync(resolvedPath)) {
    return `Error: Directory not found at '${resolvedPath}'.\n`;
  }

  if (!statSync(resolvedPath).isDirectory()) {
    return `Error: '${resolvedPath}' is not a directory.\n`;
  }

  // Try cache first (scoped to this directory)
  const cached = getCachedModelForDir(resolvedPath);
  let model: DomainModel;

  if (cached) {
    model = cached;
  } else {
    model = scanDirectory(resolvedPath);
    saveCachedModelForDir(resolvedPath, model);
  }

  if (json) {
    return generateJsonOutput(model);
  }

  return generateMarkdownTable(model);
}

// ── CLI Entry Point ───────────────────────────────────────────────────
import { runScriptIfDirect } from '../lib/script-runner.js'

runScriptIfDirect(
  (targetPath: string, json = false, help = false) => {
    return generateOutput(targetPath, json, help)
  },
  'domain-model.ts',
  { defaultPath: '.' }
)
