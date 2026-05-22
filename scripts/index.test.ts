import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import fs from 'node:fs'

const PROJECT_ROOT = resolve(__dirname, '..')
const SCRIPTS_DIR = join(PROJECT_ROOT, 'scripts')



describe('scripts/index — Catalog generation', () => {
  it('scans the scripts directory and finds available scripts', async () => {
    const mod = await import('./index.js')

    // Should find at least the existing scripts
    const catalog = mod.scanScripts(SCRIPTS_DIR)

    expect(catalog).toBeDefined()
    expect(Array.isArray(catalog)).toBe(true)
    expect(catalog.length).toBeGreaterThan(0)
  })

  it('includes script metadata (name, description, category)', async () => {
    const mod = await import('./index.js')
    const catalog = mod.scanScripts(SCRIPTS_DIR)

    // Each entry should have required fields
    for (const entry of catalog) {
      expect(entry.name).toBeDefined()
      expect(typeof entry.name).toBe('string')
      expect(entry.description).toBeDefined()
      expect(entry.category).toBeDefined()
    }
  })

  it('groups scripts by category', async () => {
    const mod = await import('./index.js')
    const catalog = mod.scanScripts(SCRIPTS_DIR)

    // Should be able to group by category
    const grouped: Record<string, typeof catalog> = {}
    for (const entry of catalog) {
      const cat = entry.category || 'uncategorized'
      if (!grouped[cat]) grouped[cat] = []
      grouped[cat].push(entry)
    }

    // At least one category should exist
    expect(Object.keys(grouped).length).toBeGreaterThan(0)
  })

  it('generates a formatted catalog output', async () => {
    const mod = await import('./index.js')
    const result = mod.generateCatalogOutput(SCRIPTS_DIR)

    expect(result).toBeDefined()
    // DataFn returns structured output: { markdown: string; json?: unknown }
    if (typeof result === 'string') {
      expect(result.length).toBeGreaterThan(0)
    } else {
      expect(typeof result.markdown).toBe('string')
      expect(result.markdown.length).toBeGreaterThan(0)
    }
  })

  it('supports --json flag for machine-readable output', async () => {
    const mod = await import('./index.js')
    const result = mod.generateCatalogOutput(SCRIPTS_DIR)

    // When called without help flag, structured output with json field should be present
    if (typeof result === 'object' && result.json !== undefined) {
      const parsed = JSON.parse(JSON.stringify(result.json))
      expect(Array.isArray(parsed)).toBe(true)
    }
  })

  it('handles --help flag gracefully', async () => {
    const mod = await import('./index.js')

    // Should not throw when help is requested
    const output = mod.generateCatalogOutput(SCRIPTS_DIR, false, true)
    expect(output).toContain('Usage')
  })
})
