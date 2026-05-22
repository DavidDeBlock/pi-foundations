import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import fs from 'node:fs'

const TEST_DIR = resolve(__dirname, '..', '_lib', '__test-fixtures__')



// ── Helper to create temp TS files for testing ───────────────────────

async function writeFixture(name: string, content: string): Promise<string> {
  const filePath = join(TEST_DIR, name)
  fs.mkdirSync(TEST_DIR, { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

async function cleanupFixture(name: string): Promise<void> {
  const filePath = join(TEST_DIR, name)
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath)
  }
}

describe('ts-parser — Project and file loading', () => {
  it('creates a project instance from the scripts directory', async () => {
    const mod = await import('./ts-parser.js')
    const project = mod.createProject()

    expect(project).toBeDefined()
    expect(typeof project.getSourceFiles).toBe('function')
    project
  })

  it('loads a TypeScript source file and returns it', async () => {
    const fixturePath = await writeFixture('test-load.ts', `export function hello(): string { return "hi" }`)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      expect(sourceFile).toBeDefined()
      expect(sourceFile.getFilePath()).toBe(fixturePath)
      project
    } finally {
      await cleanupFixture('test-load.ts')
    }
  })

  it('returns undefined for non-existent files', async () => {
    const mod = await import('./ts-parser.js')
    const project = mod.createProject()
    const result = mod.loadSourceFile(project, '/nonexistent/file.ts')

    expect(result).toBeUndefined()
    project
  })
})

describe('ts-parser — Export extraction', () => {
  it('extracts named function exports with signatures', async () => {
    const content = `
/** Add two numbers */
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(x: number, y: number): number {
  return x * y
}
`
    const fixturePath = await writeFixture('test-exports.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('add')
      expect(exports[0].kind).toBe('function')
      expect(exports[1].name).toBe('multiply')
      project
    } finally {
      await cleanupFixture('test-exports.ts')
    }
  })

  it('extracts class exports', async () => {
    const content = `
export class SaleService {
  create(data: CreateSaleInput): Sale { return {} as Sale }
}
`
    const fixturePath = await writeFixture('test-class.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('SaleService')
      expect(exports[0].kind).toBe('class')
      project
    } finally {
      await cleanupFixture('test-class.ts')
    }
  })

  it('extracts constant exports', async () => {
    const content = `
export const MAX_RETRIES = 3
export const API_URL = "https://api.example.com"
`
    const fixturePath = await writeFixture('test-const.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(2)
      // Both should be 'const' kind
      for (const exp of exports) {
        expect(exp.kind).toBe('const')
      }
      project
    } finally {
      await cleanupFixture('test-const.ts')
    }
  })

  it('extracts JSDoc comments when available', async () => {
    const content = `
/** Process a sale transaction */
export function processSale(id: string): Sale { return {} as Sale }
`
    const fixturePath = await writeFixture('test-jsdoc.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(1)
      expect(exports[0].jsDoc).toBeDefined()
      expect(exports[0].jsDoc).toContain('Process a sale transaction')
      project
    } finally {
      await cleanupFixture('test-jsdoc.ts')
    }
  })

  it('handles files with no exports', async () => {
    const content = `
function internalHelper(): void {}
const privateVar = 42
`
    const fixturePath = await writeFixture('test-no-exports.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(0)
      project
    } finally {
      await cleanupFixture('test-no-exports.ts')
    }
  })
})

describe('ts-parser — Function signature extraction', () => {
  it('extracts parameter types and return type from functions', async () => {
    const content = `export function createSale(customerId: string, parts: Part[]): Sale`
    const fixturePath = await writeFixture('test-signature.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(1)
      expect(exports[0].parameters).toBeDefined()
      // Should contain parameter info
      const paramStr = JSON.stringify(exports[0].parameters)
      expect(paramStr).toContain('customerId')
      project
    } finally {
      await cleanupFixture('test-signature.ts')
    }
  })

  it('handles async functions', async () => {
    const content = `export async function fetchSale(id: string): Promise<Sale>`
    const fixturePath = await writeFixture('test-async.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(1)
      expect(exports[0].isAsync).toBe(true)
      project
    } finally {
      await cleanupFixture('test-async.ts')
    }
  })
})

describe('ts-parser — Script metadata extraction', () => {
  it('extracts JSDoc-based script metadata (description, category)', async () => {
    const content = `
/**
 * Code Tree — Display directory structure with file categories.
 * @category discovery
 * @usage tsx scripts/tree/code-tree.ts [path] --json
 */
export function codeTree(): void {}
`
    const fixturePath = await writeFixture('test-script-meta.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const metadata = mod.extractScriptMetadata(sourceFile)

      expect(metadata).toBeDefined()
      expect(metadata!.description).toContain('Display directory structure')
      expect(metadata!.category).toBe('discovery')
      project
    } finally {
      await cleanupFixture('test-script-meta.ts')
    }
  })

  it('handles scripts without metadata tags', async () => {
    const content = `/** Simple script */ export function simple(): void {}`
    const fixturePath = await writeFixture('test-no-tags.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const metadata = mod.extractScriptMetadata(sourceFile)

      expect(metadata).toBeDefined()
      expect(metadata!.category).toBeUndefined()
      project
    } finally {
      await cleanupFixture('test-no-tags.ts')
    }
  })
})

describe('ts-parser — Type, interface, and enum extraction', () => {
  it('extracts type alias exports via SyntaxKind fallback', async () => {
    const content = `
export type SaleStatus = 'pending' | 'completed' | 'cancelled'
export type CustomerRole = 'admin' | 'user'
`
    const fixturePath = await writeFixture('test-types.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('SaleStatus')
      expect(exports[0].kind).toBe('type')
      expect(exports[1].name).toBe('CustomerRole')
      expect(exports[1].kind).toBe('type')
      project
    } finally {
      await cleanupFixture('test-types.ts')
    }
  })

  it('extracts interface exports via SyntaxKind fallback', async () => {
    const content = `
export interface Sale {
  id: string
  total: number
}
export interface LineItem {
  productId: string
  quantity: number
}
`
    const fixturePath = await writeFixture('test-interfaces.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('Sale')
      expect(exports[0].kind).toBe('interface')
      expect(exports[1].name).toBe('LineItem')
      expect(exports[1].kind).toBe('interface')
      project
    } finally {
      await cleanupFixture('test-interfaces.ts')
    }
  })

  it('extracts enum exports via SyntaxKind fallback', async () => {
    const content = `
export enum OrderStatus {
  Pending = 'pending',
  Shipped = 'shipped',
  Delivered = 'delivered'
}
`
    const fixturePath = await writeFixture('test-enums.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('OrderStatus')
      expect(exports[0].kind).toBe('enum')
      project
    } finally {
      await cleanupFixture('test-enums.ts')
    }
  })

  it('handles mixed export types in a single file', async () => {
    const content = `
export interface Product { id: string; name: string }
export type PriceRange = [number, number]
export enum Category { Electronics, Clothing, Food }
export function getProduct(id: string): Product { return {} as Product }
export class ProductService {}
export const DEFAULT_CATEGORY = 'Electronics'
`
    const fixturePath = await writeFixture('test-mixed.ts', content)

    try {
      const mod = await import('./ts-parser.js')
      const project = mod.createProject()
      const sourceFile = mod.loadSourceFile(project, fixturePath)

      const exports = mod.extractExports(sourceFile)

      expect(exports.length).toBe(6)
      // Check each kind is correctly identified
      const kinds = exports.map(e => e.kind)
      expect(kinds).toContain('interface')
      expect(kinds).toContain('type')
      expect(kinds).toContain('enum')
      expect(kinds).toContain('function')
      expect(kinds).toContain('class')
      expect(kinds).toContain('const')
      project
    } finally {
      await cleanupFixture('test-mixed.ts')
    }
  })
})
