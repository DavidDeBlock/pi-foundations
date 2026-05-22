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
  readdirSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join, basename, relative } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────

/** Represents a parsed entity with its fields and business description */
export interface DomainEntity {
  name: string;
  table?: string;
  description: string;
  fields: Array<{ name: string; type: string }>;
}

/** A relationship between two entities */
export interface DomainRelation {
  fromEntity: string;
  toEntity: string;
  fromField: string;
  direction: "one-to-one" | "one-to-many" | "many-to-one";
  description?: string;
}

/** Complete domain model output */
export interface DomainModel {
  entities: DomainEntity[];
  relations: DomainRelation[];
  sourceFiles: string[];
}

// ── Configuration ─────────────────────────────────────────────────────

/** Directories to skip during scanning */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".cache",
  "__snapshots__",
  "__test-fixtures__",
]);

/** Cache directory for timestamp-based invalidation */
const CACHE_DIR = resolve(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "domain-model.json");

// ── JSDoc Parsing ─────────────────────────────────────────────────────

/**
 * Extract @entity tag from a JSDoc comment.
 * Format: @entity EntityName - Optional description
 */
function parseEntityTag(
  jsDoc: string,
): { name: string; description: string } | undefined {
  const match = jsDoc.match(/@entity\s+(\w+)(?:\s*[-–]\s*(.+))?/);
  if (!match) return undefined;

  return {
    name: match[1],
    description: (match[2] || "").trim(),
  };
}

/**
 * Extract @relation tags from a JSDoc comment.
 * Format: @relation EntityName.field -> TargetEntity (cardinality)
 *         or: @relation SourceEntity.sourceField -> TargetEntity.targetField (cardinality)
 */
function parseRelationTags(jsDoc: string): DomainRelation[] {
  const relations: DomainRelation[] = [];

  // Pattern 1: Entity.field -> TargetEntity.field (full form)
  const fullPattern =
    /@relation\s+(\w+)\.(\w+)\s*->\s*(\w+)\.(\w+)\s*\(([^)]+)\)/g;
  let match;

  while ((match = fullPattern.exec(jsDoc)) !== null) {
    const [, fromEntity, fromField, toEntity] = match;
    relations.push({
      fromEntity,
      toEntity,
      fromField,
      direction: parseCardinality(match[5].trim()),
      description: `Links ${fromEntity} to ${toEntity}`,
    });
  }

  // Pattern 2: Entity.field -> TargetEntity (target field implied)
  const shortPattern = /@relation\s+(\w+)\.(\w+)\s*->\s*(\w+)\s*\(([^)]+)\)/g;
  while ((match = shortPattern.exec(jsDoc)) !== null) {
    // Skip if already matched by full pattern (check for dot after arrow target)
    const [, fromEntity, fromField, toEntity] = match;
    relations.push({
      fromEntity,
      toEntity,
      fromField,
      direction: parseCardinality(match[4].trim()),
      description: `Links ${fromEntity} to ${toEntity}`,
    });
  }

  return relations;
}

/** Parse cardinality string into a relation type */
function parseCardinality(cardinality: string): DomainRelation["direction"] {
  const lower = cardinality.toLowerCase();
  if (lower.includes("one-to-many") || lower.includes("1-n"))
    return "one-to-many";
  if (lower.includes("many-to-one") || lower.includes("n-1"))
    return "many-to-one";
  if (lower.includes("one-to-one") || lower.includes("1-1"))
    return "one-to-one";
  // Default: infer from context — most common is one-to-many
  return "one-to-many";
}

// ── AST Parsing (lightweight, no ts-morph dependency) ────────────────

/**
 * Parse a domain schema file and extract entities and relations.
 * Uses regex-based JSDoc parsing for speed — sufficient for @entity/@relation tags.
 */
export function parseDomainSchema(filePath: string): {
  entities: DomainEntity[];
  relations: DomainRelation[];
} {
  const content = readFileSync(filePath, "utf-8");
  const entities: DomainEntity[] = [];
  const relations: DomainRelation[] = [];

  // Extract all JSDoc blocks with their associated code
  const jsDocPattern = /\/\*\*([\s\S]*?)\*\//g;
  let match;

  while ((match = jsDocPattern.exec(content)) !== null) {
    const jsDoc = match[1];
    const entityTag = parseEntityTag(jsDoc);

    if (!entityTag) continue;

    // Extract table name from pgTable('table_name', ...) pattern
    const tableMatch = content
      .slice(match.index)
      .match(/pgTable\s*\(\s*['"]([^'"]+)['"]/);
    const tableName = tableMatch ? tableMatch[1] : undefined;

    // Extract field names and types from the table definition.
    // Only capture top-level column definitions (indented at body level), not nested params.
    const fields: Array<{ name: string; type: string }> = [];

    // Find the pgTable body (between { and })
    const braceStart = content.indexOf("{", match.index);
    if (braceStart === -1) continue;

    let depth = 0;
    let inBraces = false;
    let bodyStart = -1;
    let bodyEnd = -1;

    for (let i = braceStart; i < content.length; i++) {
      const ch = content[i];
      if (ch === "{") {
        depth++;
        inBraces = true;
        if (bodyStart === -1) bodyStart = i + 1;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && inBraces) {
          bodyEnd = i;
          break;
        }
      }
    }

    if (bodyStart !== -1 && bodyEnd !== -1) {
      const body = content.slice(bodyStart, bodyEnd);
      // Match top-level field definitions: name followed by colon and type call
      // Pattern: optional whitespace + identifier + colon + identifier (the Drizzle function)
      const fieldRegex = /^\s+(\w+)\s*:\s*(\w+)\(/gm;
      let fieldMatch;

      while ((fieldMatch = fieldRegex.exec(body)) !== null) {
        const fieldName = fieldMatch[1];
        // Skip known Drizzle column types and keywords
        if (
          [
            "uuid",
            "varchar",
            "text",
            "integer",
            "decimal",
            "timestamp",
            "boolean",
            "date",
          ].includes(fieldName)
        )
          continue;
        fields.push({ name: fieldName, type: fieldMatch[2] });
      }
    }

    entities.push({
      name: entityTag.name,
      table: tableName,
      description: entityTag.description || `${entityTag.name} entity`,
      fields,
    });

    // Parse relations from this JSDoc block
    const fileRelations = parseRelationTags(jsDoc);
    relations.push(...fileRelations);
  }

  return { entities, relations };
}

// ── Directory Scanning ────────────────────────────────────────────────

/**
 * Recursively find all .ts files in a directory.
 */
function findTsFiles(dirPath: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dirPath);

    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...findTsFiles(fullPath));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read — return empty
  }

  return files;
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
        const content = readFileSync(f, "utf-8");
        return /@entity/.test(content);
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
        const content = readFileSync(f, "utf-8");
        return /@entity/.test(content);
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

// ── Markdown Table Helper (inline to avoid dependency) ────────────────

/** Generate a Markdown table from headers and rows */
function markdownTable(headers: string[], rows: string[][]): string {
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

/** Serialize data to JSON string */
function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
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
// Only run when executed directly (not imported as a module by tests)
const SCRIPT_NAME = "domain-model.ts";
const isDirectExecution =
  process.argv[1] && basename(process.argv[1]) === SCRIPT_NAME;

if (isDirectExecution) {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(generateHelp());
    process.exit(0);
  }

  let jsonMode = false;
  let targetPath: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      jsonMode = true;
    } else if (!arg.startsWith("-")) {
      if (!targetPath) targetPath = arg;
    }
  }

  console.log(generateOutput(targetPath ?? ".", jsonMode));
}
