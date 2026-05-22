import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { scanDirectory, DEFAULT_SCAN_OPTIONS } from './scanner.js'

// ── Helpers ────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'))
}

function writeFile(dir: string, relPath: string, content = ''): void {
  const fullPath = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('scanDirectory', () => {
  it('returns sorted absolute paths for .ts files by default', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'b.ts')
      writeFile(dir, 'c.ts')

      const result = scanDirectory(dir)

      expect(result).toHaveLength(3)
      // Should be sorted alphabetically by full path
      expect(result[0]).toContain('a.ts')
      expect(result[1]).toContain('b.ts')
      expect(result[2]).toContain('c.ts')
    } finally {
      cleanup(dir)
    }
  })

  it('excludes .d.ts files by default', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'a.d.ts')
      writeFile(dir, 'b.ts')

      const result = scanDirectory(dir)

      expect(result).toHaveLength(2)
      expect(result.every(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('excludes .test.ts files by default', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'a.test.ts')
      writeFile(dir, 'b.ts')

      const result = scanDirectory(dir)

      expect(result).toHaveLength(2)
      expect(result.every(f => !f.endsWith('.test.ts'))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('skips hidden directories and files by default', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, '.hidden.ts')
      writeFile(dir, 'sub/b.ts')
      writeFile(dir, 'sub/.secret.ts')

      const result = scanDirectory(dir)

      expect(result).toHaveLength(2)
      expect(result.every(f => !path.basename(f).startsWith('.'))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('skips configured skipDirs', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'node_modules/b.ts')
      writeFile(dir, '.git/c.ts')
      writeFile(dir, 'src/d.ts')

      const result = scanDirectory(dir, DEFAULT_SCAN_OPTIONS)

      expect(result).toHaveLength(2) // a.ts and src/d.ts
    } finally {
      cleanup(dir)
    }
  })

  it('respects custom extensions', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'b.tsx')
      writeFile(dir, 'c.js')
      writeFile(dir, 'd.txt')

      const result = scanDirectory(dir, {
        skipDirs: new Set(),
        extensions: ['.ts', '.tsx'],
        excludePatterns: [],
        skipHidden: false,
      })

      expect(result).toHaveLength(2) // a.ts and b.tsx
    } finally {
      cleanup(dir)
    }
  })

  it('accepts all files when extensions is empty (code-tree use case)', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'b.json')
      writeFile(dir, 'c.md')
      writeFile(dir, 'd.js')

      const result = scanDirectory(dir, {
        skipDirs: new Set(),
        extensions: [], // empty = accept all
        excludePatterns: [],
        skipHidden: false,
      })

      expect(result).toHaveLength(4)
    } finally {
      cleanup(dir)
    }
  })

  it('applies custom excludePatterns', () => {
    const dir = createTempDir()
    try {
      writeFile(dir, 'a.ts')
      writeFile(dir, 'b.spec.ts')
      writeFile(dir, 'c.test.tsx')
      writeFile(dir, 'd.tsx')

      const result = scanDirectory(dir, {
        skipDirs: new Set(),
        extensions: ['.ts', '.tsx'],
        excludePatterns: ['.spec.ts', '.test.tsx'],
        skipHidden: false,
      })

      expect(result).toHaveLength(2) // a.ts and d.tsx
    } finally {
      cleanup(dir)
    }
  })

  it('handles non-existent directory gracefully', () => {
    const result = scanDirectory('/nonexistent/path/that/does/not/exist')
    expect(result).toEqual([])
  })

  it('returns empty array for empty directory', () => {
    const dir = createTempDir()
    try {
      const result = scanDirectory(dir)
      expect(result).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('DEFAULT_SCAN_OPTIONS has expected defaults', () => {
    expect(DEFAULT_SCAN_OPTIONS.skipDirs).toBeInstanceOf(Set)
    expect(DEFAULT_SCAN_OPTIONS.extensions).toEqual(['.ts'])
    expect(DEFAULT_SCAN_OPTIONS.excludePatterns).toContain('.d.ts')
    expect(DEFAULT_SCAN_OPTIONS.excludePatterns).toContain('.test.ts')
    expect(DEFAULT_SCAN_OPTIONS.skipHidden).toBe(true)
  })

  it('preserves sorted order matching readdirSync().sort()', () => {
    const dir = createTempDir()
    try {
      // Create files in non-alphabetical order to verify sorting
      writeFile(dir, 'z.ts')
      writeFile(dir, 'a.ts')
      writeFile(dir, 'm.ts')
      writeFile(dir, 'b.ts')

      const result = scanDirectory(dir)

      // Results should be sorted by full path (which equals basename sort for flat dir)
      expect(result.map(f => path.basename(f))).toEqual(['a.ts', 'b.ts', 'm.ts', 'z.ts'])
    } finally {
      cleanup(dir)
    }
  })
})
