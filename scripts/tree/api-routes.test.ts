import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import fs from 'node:fs'

const FIXTURE_DIR = resolve(__dirname, '..', '__test__', 'api-routes')

// ── Helper to create temp TS files for testing ───────────────────────

async function writeFixture(name: string, content: string): Promise<string> {
  const filePath = join(FIXTURE_DIR, name)
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

async function cleanupFixture(name: string): Promise<void> {
  const filePath = join(FIXTURE_DIR, name)
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath)
  }
}

describe('api-routes — extractRoutes', () => {
  it('extracts GET routes from Hono app definitions', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/health', (c) => c.json({ ok: true }))
export { app }`

    const fixturePath = await writeFixture('test-get-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('GET')
      expect(routes[0].path).toBe('/health')
      expect(routes[0].handler).toBeDefined()
    } finally {
      await cleanupFixture('test-get-routes.ts')
    }
  })

  it('extracts POST routes', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.post('/sales', createSaleHandler)
export { app }`

    const fixturePath = await writeFixture('test-post-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('POST')
      expect(routes[0].path).toBe('/sales')
    } finally {
      await cleanupFixture('test-post-routes.ts')
    }
  })

  it('extracts PATCH routes', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.patch('/sales/:id/status', updateSaleStatusHandler)
export { app }`

    const fixturePath = await writeFixture('test-patch-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('PATCH')
      expect(routes[0].path).toBe('/sales/:id/status')
    } finally {
      await cleanupFixture('test-patch-routes.ts')
    }
  })

  it('extracts DELETE routes', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.delete('/sales/:id', deleteSaleHandler)
export { app }`

    const fixturePath = await writeFixture('test-delete-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('DELETE')
      expect(routes[0].path).toBe('/sales/:id')
    } finally {
      await cleanupFixture('test-delete-routes.ts')
    }
  })

  it('extracts multiple routes from one file', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/sales', listSales)
app.post('/sales', createSale)
app.patch('/sales/:id/status', updateStatus)
app.delete('/sales/:id', deleteSale)
export { app }`

    const fixturePath = await writeFixture('test-multi-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(4)
      expect(routes.map(r => r.method)).toEqual(['GET', 'POST', 'PATCH', 'DELETE'])
      expect(routes[0].path).toBe('/sales')
      expect(routes[1].path).toBe('/sales')
    } finally {
      await cleanupFixture('test-multi-routes.ts')
    }
  })

  it('extracts routes from nested routers', async () => {
    const content = `import { Hono } from 'hono'
const api = new Hono()
const products = new Hono()
api.get('/status', statusHandler)
products.get('/', listProducts)
products.post('/', createProduct)
export { api, products }`

    const fixturePath = await writeFixture('test-nested.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(3)
      expect(routes.map(r => r.path)).toContain('/status')
      expect(routes.map(r => r.path)).toContain('/')
    } finally {
      await cleanupFixture('test-nested.ts')
    }
  })

  it('extracts routes with middleware (ignores extra args)', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/dashboard', authMiddleware, dashboardHandler)
export { app }`

    const fixturePath = await writeFixture('test-middleware.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(1)
      expect(routes[0].method).toBe('GET')
      expect(routes[0].path).toBe('/dashboard')
    } finally {
      await cleanupFixture('test-middleware.ts')
    }
  })

  it('returns empty array for files with no routes', async () => {
    const content = `export function calculateTotal(items: Array<{ price: number; qty: number }>): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
}`

    const fixturePath = await writeFixture('test-no-routes.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes.length).toBe(0)
    } finally {
      await cleanupFixture('test-no-routes.ts')
    }
  })

  it('handles files that do not exist', async () => {
    const mod = await import('./api-routes.js')
    const routes = mod.extractRoutes('/nonexistent/file.ts')

    expect(routes.length).toBe(0)
  })

  it('extracts handler names from function references', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/sales', listSales)
app.post('/sales', createSale)
export { app }`

    const fixturePath = await writeFixture('test-handler-names.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes[0].handler).toBe('listSales')
      expect(routes[1].handler).toBe('createSale')
    } finally {
      await cleanupFixture('test-handler-names.ts')
    }
  })

  it('extracts handler names from inline arrow functions', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/health', (c) => c.json({ ok: true }))
export { app }`

    const fixturePath = await writeFixture('test-inline-handler.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)

      expect(routes[0].handler).toBeDefined()
      // Inline arrow functions should have a placeholder handler name
      expect(routes[0].handler).toContain('anonymous')
    } finally {
      await cleanupFixture('test-inline-handler.ts')
    }
  })
})

describe('api-routes — scanDirectory', () => {
  it('scans all .ts files in a directory for routes', async () => {
    const mod = await import('./api-routes.js')
    const results = mod.scanDirectory(FIXTURE_DIR)

    // Should find routes from the fixture files we created
    expect(results.length).toBeGreaterThan(0)

    // All methods should be valid HTTP verbs
    for (const route of results) {
      expect(['GET', 'POST', 'PATCH', 'DELETE']).toContain(route.method)
    }
  })

  it('returns empty array when directory has no .ts files with routes', async () => {
    // Create a temp dir with only non-ts files
    const tmpDir = join(FIXTURE_DIR, '__temp-empty')
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(join(tmpDir, 'readme.md'), '# No routes here')

    try {
      const mod = await import('./api-routes.js')
      const results = mod.scanDirectory(tmpDir)
      expect(results.length).toBe(0)
    } finally {
      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('skips node_modules and hidden directories', async () => {
    const mod = await import('./api-routes.js')
    const results = mod.scanDirectory(FIXTURE_DIR)

    // Should not contain any routes from node_modules or .pi dirs
    for (const route of results) {
      expect(route.file).not.toContain('node_modules')
      expect(route.file).not.toMatch(/\/\.[a-z]/)
    }
  })
})

describe('api-routes — generateMarkdownTable', () => {
  it('generates a Markdown table with Method, Path, Handler columns', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/health', healthCheck)
app.post('/sales', createSale)
export { app }`

    const fixturePath = await writeFixture('test-table.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)
      const output = mod.generateMarkdownTable(routes, FIXTURE_DIR)

      expect(output).toContain('| Method | Path | Handler |')
      expect(output).toContain('GET')
      expect(output).toContain('/health')
      expect(output).toContain('POST')
      expect(output).toContain('/sales')
    } finally {
      await cleanupFixture('test-table.ts')
    }
  })

  it('includes file path in output header', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/test', handler)
export { app }`

    const fixturePath = await writeFixture('test-header.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)
      const output = mod.generateMarkdownTable(routes, FIXTURE_DIR)

      expect(output).toContain('# API Routes')
    } finally {
      await cleanupFixture('test-header.ts')
    }
  })

  it('handles empty route list gracefully', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateMarkdownTable([], FIXTURE_DIR)

    expect(output).toContain('# API Routes')
    expect(output).toContain('> No routes found.')
  })
})

describe('api-routes — generateJsonOutput', () => {
  it('generates JSON with route details', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.get('/health', healthCheck)
export { app }`

    const fixturePath = await writeFixture('test-json.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)
      const output = mod.generateJsonOutput(routes, FIXTURE_DIR)

      const parsed = JSON.parse(output)
      expect(parsed.routes).toBeDefined()
      expect(parsed.routeCount).toBe(1)
      expect(parsed.routes[0].method).toBe('GET')
      expect(parsed.routes[0].path).toBe('/health')
    } finally {
      await cleanupFixture('test-json.ts')
    }
  })

  it('includes file path in JSON output', async () => {
    const content = `import { Hono } from 'hono'
const app = new Hono()
app.post('/sales', createSale)
export { app }`

    const fixturePath = await writeFixture('test-json-file.ts', content)

    try {
      const mod = await import('./api-routes.js')
      const routes = mod.extractRoutes(fixturePath)
      const output = mod.generateJsonOutput(routes, FIXTURE_DIR)

      const parsed = JSON.parse(output)
      expect(parsed.routes[0].file).toContain('test-json-file.ts')
    } finally {
      await cleanupFixture('test-json-file.ts')
    }
  })
})

describe('api-routes — generateHelp', () => {
  it('returns help text with usage information', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateHelp()

    expect(output).toContain('Usage: tsx scripts/tree/api-routes.ts [path]')
    expect(output).toContain('--json')
    expect(output).toContain('--help')
  })
})

describe('api-routes — generateOutput', () => {
  it('returns Markdown table by default', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateOutput(FIXTURE_DIR, false)

    expect(output).toContain('# API Routes')
    expect(output).toContain('| Method | Path | Handler |')
  })

  it('returns JSON with --json flag', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateOutput(FIXTURE_DIR, true)

    const parsed = JSON.parse(output)
    expect(parsed.routes).toBeDefined()
    expect(Array.isArray(parsed.routes)).toBe(true)
  })

  it('returns help with --help flag', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateOutput('.', false, true)

    expect(output).toContain('Usage:')
  })

  it('handles non-existent directory gracefully', async () => {
    const mod = await import('./api-routes.js')
    const output = mod.generateOutput('/nonexistent/path', false)

    expect(output).toContain('Error: Directory not found')
  })
})
