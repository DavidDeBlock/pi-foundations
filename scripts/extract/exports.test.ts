import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import fs from 'node:fs'

const TEST_DIR = resolve(__dirname, '..', '__test__')

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

describe('exports — parseExports', () => {
  it('extracts named function exports with signatures and JSDoc', async () => {
    const content = `
/** Add two numbers together */
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(x: number, y: number): number {
  return x * y
}
`
    const fixturePath = await writeFixture('test-exports-func.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('add')
      expect(exports[0].kind).toBe('function')
      expect(exports[0].jsDoc).toContain('Add two numbers together')
      expect(exports[0].parameters?.length).toBe(2)
      expect(exports[0].returnType).toBe('number')

      expect(exports[1].name).toBe('multiply')
      expect(exports[1].kind).toBe('function')
    } finally {
      await cleanupFixture('test-exports-func.ts')
    }
  })

  it('extracts class exports', async () => {
    const content = `
export class SaleService {
  create(data: CreateSaleInput): Sale { return {} as Sale }
}
`
    const fixturePath = await writeFixture('test-exports-class.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('SaleService')
      expect(exports[0].kind).toBe('class')
    } finally {
      await cleanupFixture('test-exports-class.ts')
    }
  })

  it('extracts constant exports', async () => {
    const content = `
export const MAX_RETRIES = 3
export const API_URL = "https://api.example.com"
`
    const fixturePath = await writeFixture('test-exports-const.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(2)
      for (const exp of exports) {
        expect(exp.kind).toBe('const')
      }
    } finally {
      await cleanupFixture('test-exports-const.ts')
    }
  })

  it('extracts type alias exports', async () => {
    const content = `
export type SaleStatus = 'pending' | 'completed' | 'cancelled'
export type CustomerRole = 'admin' | 'user'
`
    const fixturePath = await writeFixture('test-exports-type.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('SaleStatus')
      expect(exports[0].kind).toBe('type')
      expect(exports[1].name).toBe('CustomerRole')
    } finally {
      await cleanupFixture('test-exports-type.ts')
    }
  })

  it('extracts interface exports', async () => {
    const content = `
export interface Sale {
  id: string
  total: number
}
`
    const fixturePath = await writeFixture('test-exports-interface.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('Sale')
      expect(exports[0].kind).toBe('interface')
    } finally {
      await cleanupFixture('test-exports-interface.ts')
    }
  })

  it('extracts enum exports', async () => {
    const content = `
export enum OrderStatus {
  Pending = 'pending',
  Shipped = 'shipped'
}
`
    const fixturePath = await writeFixture('test-exports-enum.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('OrderStatus')
      expect(exports[0].kind).toBe('enum')
    } finally {
      await cleanupFixture('test-exports-enum.ts')
    }
  })

  it('handles async functions', async () => {
    const content = `export async function fetchSale(id: string): Promise<Sale>`
    const fixturePath = await writeFixture('test-exports-async.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].isAsync).toBe(true)
    } finally {
      await cleanupFixture('test-exports-async.ts')
    }
  })

  it('handles generic types', async () => {
    const content = `export interface Repository<T extends { id: string }> { findById(id: string): T | undefined }`
    const fixturePath = await writeFixture('test-exports-generic.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].name).toBe('Repository')
      expect(exports[0].kind).toBe('interface')
    } finally {
      await cleanupFixture('test-exports-generic.ts')
    }
  })

  it('handles decorated classes', async () => {
    const content = `export function Injectable<T>(target: new (...args: any[]) => T) { return target }\n@Injectable()\nexport class SaleRepository {}`
    const fixturePath = await writeFixture('test-exports-decorator.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(2)
      expect(exports[0].name).toBe('Injectable')
      expect(exports[1].name).toBe('SaleRepository')
    } finally {
      await cleanupFixture('test-exports-decorator.ts')
    }
  })

  it('handles files with no exports', async () => {
    const content = `function internalHelper(): void {}\nconst privateVar = 42`
    const fixturePath = await writeFixture('test-no-exports.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(0)
    } finally {
      await cleanupFixture('test-no-exports.ts')
    }
  })

  it('handles mixed export types in a single file', async () => {
    const content = `
export interface Product { id: string; name: string }
export type PriceRange = [number, number]
export enum Category { Electronics, Clothing }
export function getProduct(id: string): Product { return {} as Product }
export class ProductService {}
export const DEFAULT_CATEGORY = 'Electronics'
`
    const fixturePath = await writeFixture('test-mixed.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(6)
      const kinds = exports.map(e => e.kind)
      expect(kinds).toContain('interface')
      expect(kinds).toContain('type')
      expect(kinds).toContain('enum')
      expect(kinds).toContain('function')
      expect(kinds).toContain('class')
      expect(kinds).toContain('const')
    } finally {
      await cleanupFixture('test-mixed.ts')
    }
  })

  it('handles multi-line JSDoc comments', async () => {
    const content = `
/**
 * Process a sale transaction.
 * This is a multi-line description that should be collapsed.
 * @param id The sale identifier
 * @returns The processed sale
 */
export function processSale(id: string): Sale { return {} as Sale }
`
    const fixturePath = await writeFixture('test-multiline-jsdoc.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)

      expect(exports.length).toBe(1)
      expect(exports[0].jsDoc).toBeDefined()
      expect(exports[0].jsDoc).toContain('Process a sale transaction')
    } finally {
      await cleanupFixture('test-multiline-jsdoc.ts')
    }
  })
})

describe('exports — buildSignature', () => {
  it('builds function signature with parameters and return type', async () => {
    const content = `export function add(a: number, b: number): number`
    const fixturePath = await writeFixture('test-sig-func.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const sig = mod.buildSignature(exports[0])

      expect(sig).toBe('add(a: number, b: number): number')
    } finally {
      await cleanupFixture('test-sig-func.ts')
    }
  })

  it('builds async function signature', async () => {
    const content = `export async function fetchSale(id: string): Promise<Sale>`
    const fixturePath = await writeFixture('test-sig-async.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const sig = mod.buildSignature(exports[0])

      expect(sig).toBe('async fetchSale(id: string): Promise<Sale>')
    } finally {
      await cleanupFixture('test-sig-async.ts')
    }
  })

  it('builds class signature without parameters', async () => {
    const content = `export class SaleService {}`
    const fixturePath = await writeFixture('test-sig-class.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const sig = mod.buildSignature(exports[0])

      expect(sig).toBe('SaleService')
    } finally {
      await cleanupFixture('test-sig-class.ts')
    }
  })

  it('builds const signature without type', async () => {
    const content = `export const MAX_RETRIES = 3`
    const fixturePath = await writeFixture('test-sig-const.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const sig = mod.buildSignature(exports[0])

      expect(sig).toBe('MAX_RETRIES')
    } finally {
      await cleanupFixture('test-sig-const.ts')
    }
  })
})

describe('exports — generateMarkdownTable', () => {
  it('generates a formatted Markdown table grouped by kind', async () => {
    const content = `
/** Add numbers */
export function add(a: number, b: number): number {}
export class SaleService {}
`
    const fixturePath = await writeFixture('test-table.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const output = mod.generateMarkdownTable(exports, 'test.ts')

      expect(output).toContain('# Exports: test.ts')
      expect(output).toContain('export(s)')
      expect(output).toContain('## ⚡ Function')
      expect(output).toContain('## 🏗️ Class')
      expect(output).toContain('| Name | Signature | JSDoc |')
    } finally {
      await cleanupFixture('test-table.ts')
    }
  })

  it('handles empty exports gracefully', async () => {
    const content = `function internal(): void {}`
    const fixturePath = await writeFixture('test-empty-table.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const output = mod.generateMarkdownTable(exports, 'empty.ts')

      expect(output).toContain('No exports found in this file.')
    } finally {
      await cleanupFixture('test-empty-table.ts')
    }
  })
})

describe('exports — generateJsonOutput', () => {
  it('generates detailed JSON with full metadata', async () => {
    const content = `/** Add numbers */ export function add(a: number, b: number): number {}`
    const fixturePath = await writeFixture('test-json.ts', content)

    try {
      const mod = await import('./exports.js')
      const exports = mod.parseExports(fixturePath)
      const output = mod.generateJsonOutput(exports, '/path/to/test.ts')

      const parsed = JSON.parse(output)

      expect(parsed.file).toBe('test.ts')
      expect(parsed.path).toBe('/path/to/test.ts')
      expect(parsed.exportCount).toBe(1)
      expect(parsed.exports[0].name).toBe('add')
      expect(parsed.exports[0].kind).toBe('function')
      expect(parsed.exports[0].parameters).toEqual([
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' }
      ])
      expect(parsed.exports[0].returnType).toBe('number')
      expect(parsed.exports[0].jsDoc).toContain('Add numbers')
    } finally {
      await cleanupFixture('test-json.ts')
    }
  })
})

describe('exports — CLI integration', () => {
  it('generates help text with --help flag', async () => {
    const mod = await import('./exports.js')
    const output = mod.generateHelp()

    expect(output).toContain('Usage: tsx scripts/extract/exports.ts <path> [options]')
    expect(output).toContain('--json')
    expect(output).toContain('--help')
  })

  it('returns error for non-existent file', async () => {
    const mod = await import('./exports.js')
    const output = mod.generateOutput('/nonexistent/file.ts', false, false)

    expect(output).toContain('Error: File not found')
  })

  it('returns Markdown table by default', async () => {
    const content = `export function hello(): string {}`
    const fixturePath = await writeFixture('test-cli-default.ts', content)

    try {
      const mod = await import('./exports.js')
      const output = mod.generateOutput(fixturePath, false, false)

      expect(output).toContain('# Exports:')
      expect(output).toContain('| Name | Signature | JSDoc |')
    } finally {
      await cleanupFixture('test-cli-default.ts')
    }
  })

  it('returns JSON with --json flag', async () => {
    const content = `export function hello(): string {}`
    const fixturePath = await writeFixture('test-cli-json.ts', content)

    try {
      const mod = await import('./exports.js')
      const output = mod.generateOutput(fixturePath, true, false)

      const parsed = JSON.parse(output)
      expect(parsed.exports).toBeDefined()
      expect(parsed.exportCount).toBe(1)
    } finally {
      await cleanupFixture('test-cli-json.ts')
    }
  })
})
