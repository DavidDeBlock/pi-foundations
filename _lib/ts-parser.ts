/**
 * _lib/ts-parser.ts — TypeScript AST parser powered by ts-morph.
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
