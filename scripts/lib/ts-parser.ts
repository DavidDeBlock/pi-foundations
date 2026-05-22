/**
 * scripts/lib/ts-parser.ts — TypeScript AST parser powered by ts-morph.
 *
 * Provides reliable extraction of exports, function signatures, JSDoc comments,
 * and script metadata from TypeScript source files. Uses the project's actual
 * TypeScript configuration for accurate parsing.
 */

import {
  Project,
  SourceFile,
  FunctionDeclaration,
  ClassDeclaration,
  VariableStatement,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration,
  SyntaxKind
} from 'ts-morph'

// ── Domain Model Types ────────────────────────────────────────────────

/** Represents a domain entity extracted from @entity JSDoc tags */
export interface DomainEntity {
  name: string;
  table?: string;
  description: string;
  fields: Array<{ name: string; type: string }>;
}

/** A relationship between two entities extracted from @relation JSDoc tags */
export interface DomainRelation {
  fromEntity: string;
  toEntity: string;
  fromField: string;
  direction: 'one-to-one' | 'one-to-many' | 'many-to-one';
  description?: string;
}

// ── Types ─────────────────────────────────────────────────────────────

/** Represents a parsed export from a TypeScript file */
export interface ParsedExport {
  name: string
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'other'
  parameters?: Array<{ name: string; type: string }>
  returnType?: string
  isAsync?: boolean
  jsDoc?: string
}

/** Script-level metadata extracted from JSDoc tags */
export interface ScriptMetadata {
  description?: string
  category?: string
  usage?: string
}

// ── Project Management ────────────────────────────────────────────────

const DEFAULT_PROJECT_ROOT = process.cwd()

/**
 * Create a ts-morph Project instance configured for the scripts directory.
 */
export function createProject(rootDir: string = DEFAULT_PROJECT_ROOT): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      strict: true,
      esModuleInterop: true,
      moduleResolution: 100 /* NodeNext */,
      target: 99 /* ES2022 */
    }
  })
}

/**
 * Load a TypeScript source file into the project.
 * @param project ts-morph Project instance
 * @param filePath Absolute path to the .ts file
 * @returns SourceFile or undefined if not found
 */
export function loadSourceFile(project: Project, filePath: string): SourceFile | undefined {
  // First try direct lookup
  const existing = project.getSourceFiles().find(sf => sf.getFilePath() === filePath)
  if (existing) return existing

  // Try adding the file path directly
  try {
    return project.addSourceFileAtPath(filePath)
  } catch {
    return undefined
  }
}

// ── Export Extraction ─────────────────────────────────────────────────

/**
 * Extract all exported symbols from a source file.
 * @param sourceFile Parsed TypeScript source file
 * @returns Array of parsed export objects
 */
export function extractExports(sourceFile: SourceFile): ParsedExport[] {
  const exportsList: ParsedExport[] = []
  const statements = sourceFile.getStatements()

  for (const stmt of statements) {
    // Check if the statement has an export modifier using duck typing
    const anyStmt = stmt as unknown as Record<string, unknown>
    let isExported = false

    if ('isExported' in anyStmt && typeof anyStmt.isExported === 'function') {
      isExported = (anyStmt.isExported as () => boolean)()
    }
    if (!isExported && 'getModifiers' in anyStmt && typeof anyStmt.getModifiers === 'function') {
      const modifiers = (stmt as unknown as { getModifiers: () => Array<{ getKind: () => number }> }).getModifiers()
      isExported = modifiers.some(m => m.getKind() === SyntaxKind.ExportKeyword)
    }

    if (!isExported) continue

    // Extract JSDoc from the statement (if it supports it)
    let jsDocComment: string | undefined
    if ('getJsDocs' in anyStmt && typeof anyStmt.getJsDocs === 'function') {
      const jsDocs = (stmt as unknown as { getJsDocs: () => Array<{ getCommentText: () => string }> }).getJsDocs()
      if (jsDocs.length > 0) {
        jsDocComment = jsDocs[0].getCommentText() || undefined
      }
    }

    // Type-narrowed processing using instanceof checks
    if (stmt instanceof FunctionDeclaration) {
      const funcName = stmt.getName() || 'anonymous'
      exportsList.push({
        name: funcName,
        kind: 'function',
        parameters: extractParameters(stmt),
        returnType: stmt.getReturnType().getText(),
        isAsync: stmt.isAsync(),
        jsDoc: jsDocComment
      })
    } else if (stmt instanceof ClassDeclaration) {
      exportsList.push({
        name: stmt.getName() || '',
        kind: 'class',
        jsDoc: jsDocComment
      })
    } else if (stmt instanceof VariableStatement) {
      const declarations = stmt.getDeclarations()
      for (const decl of declarations) {
        exportsList.push({
          name: decl.getName(),
          kind: 'const',
          jsDoc: (() => {
            // Try to get JSDoc from the variable declaration itself
            if ('getJsDocs' in anyStmt && typeof anyStmt.getJsDocs === 'function') {
              const jsDocs = (stmt as unknown as { getJsDocs: () => Array<{ getCommentText: () => string }> }).getJsDocs()
              return jsDocs.length > 0 ? (jsDocs[0].getCommentText() || undefined) : undefined
            }
            return undefined
          })()
        })
      }
    } else if (stmt instanceof InterfaceDeclaration) {
      exportsList.push({
        name: stmt.getName() || '',
        kind: 'interface',
        jsDoc: jsDocComment
      })
    } else if (stmt instanceof TypeAliasDeclaration) {
      exportsList.push({
        name: stmt.getName() || '',
        kind: 'type',
        returnType: stmt.getType().getText(),
        jsDoc: jsDocComment
      })
    } else if (stmt instanceof EnumDeclaration) {
      exportsList.push({
        name: stmt.getName() || '',
        kind: 'enum',
        jsDoc: jsDocComment
      })
    }
  }

  return exportsList
}

/** Map ts-morph SyntaxKind numbers to export kinds */
function getKindName(kind: number): ParsedExport['kind'] | 'other' {
  // SyntaxKind values from TypeScript compiler (verified against ts.SyntaxKind)
  const map: Record<number, ParsedExport['kind']> = {
    [SyntaxKind.TypeAliasDeclaration]: 'type',
    [SyntaxKind.InterfaceDeclaration]: 'interface',
    [SyntaxKind.EnumDeclaration]: 'enum'
  }
  return map[kind] ?? 'other'
}

// ── Helper Functions ──────────────────────────────────────────────────

/** Extract parameter list from a function declaration */
function extractParameters(func: FunctionDeclaration): Array<{ name: string; type: string }> {
  const params = func.getParameters()
  return params.map(param => ({
    name: param.getName(),
    type: param.getType().getText()
  }))
}

// ── Script Metadata Extraction ────────────────────────────────────────

/**
 * Extract script-level metadata from a source file's leading JSDoc comment.
 * Checks both statement-attached JSDoc and module-level leading comments
 * (handles shebangs + header comments correctly).
 */
export function extractScriptMetadata(sourceFile: SourceFile): ScriptMetadata | undefined {
  let rawJSDoc: string | undefined

  // Strategy 1: Check if first statement has attached JSDoc
  const statements = sourceFile.getStatements()
  if (statements.length > 0) {
    const anyStmt = statements[0] as unknown as Record<string, unknown>
    if ('getJsDocs' in anyStmt && typeof anyStmt.getJsDocs === 'function') {
      const jsDocs = (statements[0] as unknown as { getJsDocs: () => Array<{ getText: () => string }> }).getJsDocs()
      if (jsDocs.length > 0) {
        rawJSDoc = jsDocs[0].getText()
      }
    }
  }

  // Strategy 2: Check for module-level leading comment ranges (shebang + header)
  if (!rawJSDoc) {
    const comments = sourceFile.getLeadingCommentRanges() || []
    for (const comment of comments) {
      const text = comment.getText(sourceFile)
      // Match block comments that look like JSDoc
      if (/^\s*\/\*\*/.test(text)) {
        rawJSDoc = text
        break
      }
    }
  }

  // Strategy 3: Regex fallback for shebang-prefixed files (ts-morph drops leading comments after #!)
  if (!rawJSDoc) {
    const fullText = sourceFile.getFullText()
    const match = fullText.match(/^#!.*?\n([\s]*\/\*\*[\s\S]*?\*\/)/)
    if (match) {
      rawJSDoc = match[1]
    }
  }

  if (!rawJSDoc) return undefined
  // Strip /** ... */ wrapper and leading * on each line
  const cleaned = rawJSDoc
    .replace(/^\/\*\*[\s]*/, '')
    .replace(/[\s]*\*\/$/, '')
    .split('\n')
    .map((line: string) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')

  const metadata: ScriptMetadata = {}

  // Extract description (first paragraph before any @tag)
  const lines = cleaned.split('\n')
  let descLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^@/.test(trimmed)) break
    if (trimmed) {
      descLines.push(trimmed)
    }
  }
  if (descLines.length > 0) {
    metadata.description = descLines.join(' ')
  }

  // Extract @category tag
  const categoryMatch = cleaned.match(/@category\s+(\S+)/i)
  if (categoryMatch) {
    metadata.category = categoryMatch[1]
  }

  // Extract @usage tag
  const usageMatch = cleaned.match(/@usage\s+(.+)/i)
  if (usageMatch) {
    metadata.usage = usageMatch[1].trim()
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

// ── Domain Model Extraction (ts-morph AST) ───────────────────────────

/**
 * Extract @entity tags from a source file using ts-morph AST.
 *
 * Iterates over exported const declarations, reads their attached JSDoc,
 * and extracts entities defined with `@entity EntityName - Description`.
 *
 * For each entity it also extracts:
 *   - table name from the pgTable('tableName', ...) call
 *   - field names/types by navigating into the object literal argument
 */
export function extractEntityTags(sourceFile: SourceFile): DomainEntity[] {
  const entities: DomainEntity[] = []
  const statements = sourceFile.getStatements()

  for (const stmt of statements) {
    // Only process exported const declarations
    if (!(stmt instanceof VariableStatement)) continue

    const anyStmt = stmt as unknown as Record<string, unknown>
    let isExported = false

    if ('isExported' in anyStmt && typeof anyStmt.isExported === 'function') {
      isExported = (anyStmt.isExported as () => boolean)()
    }
    if (!isExported && 'getModifiers' in anyStmt) {
      const modifiers = (
        stmt as unknown as {
          getModifiers: () => Array<{ getKind: () => number }>
        }
      ).getModifiers()
      isExported = modifiers.some(
        m => m.getKind() === SyntaxKind.ExportKeyword
      )
    }
    if (!isExported) continue

    // Get JSDoc comment from the declaration
    let jsDocText: string | undefined
    if ('getJsDocs' in anyStmt && typeof anyStmt.getJsDocs === 'function') {
      const jsDocs = (
        stmt as unknown as {
          getJsDocs: () => Array<{ getInnerText: () => string }>
        }
      ).getJsDocs()
      if (jsDocs.length > 0) {
        jsDocText = jsDocs[0].getInnerText()
      }
    }

    if (!jsDocText || !/@entity\s+\w+/i.test(jsDocText)) continue

    // Extract entity name and description from @entity tag
    const entityMatch = jsDocText.match(
      /@entity\s+(\w+)(?:\s*[-–]\s*(.+))?/i
    )
    if (!entityMatch) continue

    const entityName = entityMatch[1]
    const description = (entityMatch[2] || '').trim() || `${entityName} entity`

    // Extract table name from pgTable('tableName', ...) call in the source text
    const stmtText = stmt.getText()
    const tableMatch = stmtText.match(/pgTable\s*\(\s*['"]([^'"]+)['"]/)
    const tableName = tableMatch ? tableMatch[1] : undefined

    // Extract field names by navigating into the object literal argument of pgTable
    const fields: Array<{ name: string; type: string }> = []
    const declarations = stmt.getDeclarations()
    for (const decl of declarations) {
      const initializer = decl.getInitializer()
      if (
        initializer &&
        initializer.isKind(SyntaxKind.CallExpression)
      ) {
        const callExpr = initializer as import('ts-morph').CallExpression
        const args = callExpr.getArguments()
        // Second argument is the object literal with field definitions
        if (args.length >= 2) {
          const secondArg = args[1]
          if (
            secondArg.isKind(SyntaxKind.ObjectLiteralExpression)
          ) {
            const objLit = secondArg as import('ts-morph').ObjectLiteralExpression
            const properties = objLit.getProperties()
            for (const prop of properties) {
              if (prop.isKind(SyntaxKind.PropertyAssignment)) {
                const propAssign =
                  prop as import('ts-morph').PropertyAssignment
                const propName = propAssign.getNameNode().getText()
                // Skip known Drizzle column type helpers
                if (
                  [
                    'uuid',
                    'varchar',
                    'text',
                    'integer',
                    'decimal',
                    'timestamp',
                    'boolean',
                    'date',
                  ].includes(propName)
                ) {
                  continue
                }
                // Get the type from the call expression (e.g., varchar, text, etc.)
                // Handle nested calls like `varchar('key').primaryKey()` or
                // `varchar('email').unique().notNull()` by walking left through
                // PropertyAccessExpressions to find the base CallExpression,
                // then extract its identifier.
                const propInit = propAssign.getInitializer()
                let fieldType = 'unknown'
                if (propInit) {
                  // Walk left through chained method calls until we reach a node that is NOT
                  // a PropertyAccessExpression. This handles arbitrary nesting like:
                  //   varchar('key').primaryKey()           → base: varchar('key')
                  //   varchar('email').unique().notNull()   → base: varchar('email', ...)
                  let current: import('ts-morph').Node | null = propInit
                  while (current) {
                    if (current.isKind(SyntaxKind.CallExpression)) {
                      const callExpr =
                        current as import('ts-morph').CallExpression
                      const expr = callExpr.getExpression()
                      if (
                        expr.isKind(SyntaxKind.PropertyAccessExpression)
                      ) {
                        // Walk left through the PAE chain to find what's before it
                        let paeCurrent: import('ts-morph').Node | null = expr
                        while (
                          paeCurrent &&
                          paeCurrent.isKind(SyntaxKind.PropertyAccessExpression)
                        ) {
                          const pae = paeCurrent as import('ts-morph').PropertyAccessExpression
                          paeCurrent = pae.getExpression()
                        }
                        current = paeCurrent
                      } else if (expr.isKind(SyntaxKind.Identifier)) {
                        // Base case: identifier → this is the type function name
                        fieldType = expr.getText()
                        break
                      } else {
                        // Unexpected structure, stop
                        break
                      }
                    } else if (
                      current.isKind(SyntaxKind.PropertyAccessExpression)
                    ) {
                      // Walk left through chained method calls
                      const pae =
                        current as import('ts-morph').PropertyAccessExpression
                      current = pae.getExpression()
                    } else if (current.isKind(SyntaxKind.Identifier)) {
                      fieldType = current.getText()
                      break
                    } else {
                      // Unexpected structure, stop
                      break
                    }
                  }
                }
                fields.push({ name: propName, type: fieldType })
              }
            }
          }
        }
      }
    }

    entities.push({
      name: entityName,
      table: tableName,
      description,
      fields,
    })
  }

  return entities
}

/**
 * Extract @relation tags from a source file using ts-morph AST.
 *
 * Iterates over exported const declarations, reads their attached JSDoc,
 * and extracts relationships defined with `@relation` tags.
 *
 * Supported formats:
 *   - @relation Entity.field -> TargetEntity (cardinality)
 *   - @relation SourceEntity.sourceField -> TargetEntity.targetField (cardinality)
 */
export function extractRelationTags(sourceFile: SourceFile): DomainRelation[] {
  const relations: DomainRelation[] = []
  const statements = sourceFile.getStatements()

  for (const stmt of statements) {
    // Only process exported const declarations
    if (!(stmt instanceof VariableStatement)) continue

    const anyStmt = stmt as unknown as Record<string, unknown>
    let isExported = false

    if ('isExported' in anyStmt && typeof anyStmt.isExported === 'function') {
      isExported = (anyStmt.isExported as () => boolean)()
    }
    if (!isExported && 'getModifiers' in anyStmt) {
      const modifiers = (
        stmt as unknown as {
          getModifiers: () => Array<{ getKind: () => number }>
        }
      ).getModifiers()
      isExported = modifiers.some(
        m => m.getKind() === SyntaxKind.ExportKeyword
      )
    }
    if (!isExported) continue

    // Get JSDoc comment from the declaration
    let jsDocText: string | undefined
    if ('getJsDocs' in anyStmt && typeof anyStmt.getJsDocs === 'function') {
      const jsDocs = (
        stmt as unknown as {
          getJsDocs: () => Array<{ getInnerText: () => string }>
        }
      ).getJsDocs()
      if (jsDocs.length > 0) {
        jsDocText = jsDocs[0].getInnerText()
      }
    }

    if (!jsDocText) continue

    // Extract all @relation tags from the JSDoc
    const relationPattern =
      /@relation\s+(\w+)\.?(\w*)\s*->\s*(\w+)(?:\.(\w+))?\s*\(([^)]+)\)/g
    let match: RegExpExecArray | null

    while ((match = relationPattern.exec(jsDocText)) !== null) {
      const fromEntity = match[1]
      const fromField = match[2] || ''
      const toEntity = match[3]
      // match[4] is optional target field (ignored for output)
      const cardinality = match[5].trim()

      relations.push({
        fromEntity,
        toEntity,
        fromField,
        direction: parseCardinality(cardinality),
        description: `Links ${fromEntity} to ${toEntity}`,
      })
    }
  }

  return relations
}

/** Parse cardinality string into a relation type */
function parseCardinality(
  cardinality: string
): DomainRelation['direction'] {
  const lower = cardinality.toLowerCase()
  if (lower.includes('one-to-many') || lower.includes('1-n'))
    return 'one-to-many'
  if (lower.includes('many-to-one') || lower.includes('n-1'))
    return 'many-to-one'
  if (lower.includes('one-to-one') || lower.includes('1-1'))
    return 'one-to-one'
  // Default: infer from context — most common is one-to-many
  return 'one-to-many'
}
