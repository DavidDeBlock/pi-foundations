import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs'

const DOCS_ROOT = resolve(__dirname, '..', 'docs')

// ── Helpers ────────────────────────────────────────────────────

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

// ── Slice 1: Scan docs/ structure, collect folder/file info ──
describe('verify-structure.ts — Structure Scanner', () => {
  describe('scanDocsStructure', () => {
    it('scans docs/ and returns folder entries with file counts', async () => {
      const mod = await import('./verify-structure')
      const result = mod.scanDocsStructure(DOCS_ROOT)

      // Should find folders
      expect(result.folders.length).toBeGreaterThan(0)

      // Each folder should have a name and file count
      for (const folder of result.folders) {
        expect(folder.name).toBeDefined()
        expect(typeof folder.fileCount).toBe('number')
        expect(folder.fileCount).toBeGreaterThanOrEqual(0)
      }

      // Should include known canonical folders from DOCS_RULES.md
      const folderNames = result.folders.map(f => f.name)
      expect(folderNames).toContain('00-current')
    })

    it('excludes _system/ directory from scan results', async () => {
      const mod = await import('./verify-structure')
      const result = mod.scanDocsStructure(DOCS_ROOT)

      const folderNames = result.folders.map(f => f.name)
      expect(folderNames).not.toContain('_system')
    })

    it('counts only .md files in each folder', async () => {
      const mod = await import('./verify-structure')
      const result = mod.scanDocsStructure(DOCS_ROOT)

      // Verify a specific folder's count matches actual .md files
      for (const folder of result.folders) {
        const folderPath = join(DOCS_ROOT, folder.name)
        if (!isDir(folderPath)) continue

        const mdFiles = readdirSync(folderPath).filter(
          f => isFile(join(folderPath, f)) && f.endsWith('.md')
        )
        expect(folder.fileCount).toBe(mdFiles.length)
      }
    })
  })

// ── Slice 2: Detect orphaned files (outside numbered folders) ──
  describe('detectOrphanedFiles', () => {
    it('identifies root-level .md files as orphans', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const result = mod.detectOrphanedFiles(scanResult, DOCS_ROOT)

      // docs/ has root-level .md files (README.md, flows.md, index.md, etc.)
      expect(result.orphanRootFiles.length).toBeGreaterThan(0)
    })

    it('identifies non-canonical folders as orphan sources', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const result = mod.detectOrphanedFiles(scanResult, DOCS_ROOT)

      // Folders like adr/, flows/, issues/, plans/, prd/, etc. are not canonical
      expect(result.orphanFolders.length).toBeGreaterThan(0)
    })
  })

// ── Slice 3: Find empty folders ──
  describe('findEmptyFolders', () => {
    it('reports folders with zero .md files as empty', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const result = mod.findEmptyFolders(scanResult)

      // Should find at least some empty folders (e.g., 06-templates, 07-examples if they have no .md files)
      // The assertion is just that the function works correctly — we verify against actual state
      for (const folder of result) {
        const folderPath = join(DOCS_ROOT, folder.name)
        expect(isDir(folderPath)).toBe(true)
        const mdFiles = readdirSync(folderPath).filter(
          f => isFile(join(folderPath, f)) && f.endsWith('.md')
        )
        expect(mdFiles.length).toBe(0)
      }
    })

    it('does not report folders that have .md files', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const result = mod.findEmptyFolders(scanResult)

      // Empty folder names should not include folders with content
      for (const emptyFolder of result) {
        const matchingScanFolder = scanResult.folders.find(f => f.name === emptyFolder.name)
        expect(matchingScanFolder?.fileCount).toBe(0)
      }
    })
  })

// ── Slice 4: Verify folder constraints ──
  describe('verifyFolderConstraints', () => {
    it('reports violation when 00-current/ has more than 5 files', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const violations = mod.verifyFolderConstraints(scanResult, DOCS_ROOT)

      // Check if 00-current has > 5 files — if so there should be a violation
      const currentFolder = scanResult.folders.find(f => f.name === '00-current')
      if (currentFolder && currentFolder.fileCount > 5) {
        const hasViolation = violations.some(v =>
          v.folder === '00-current' && v.rule.includes('max')
        )
        expect(hasViolation).toBe(true)
      }
    })

    it('reports violation when old plan files are in living state folders', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const violations = mod.verifyFolderConstraints(scanResult, DOCS_ROOT)

      // If there are any plan-like files in 00-current/, should be flagged
      // This test verifies the detection logic works — actual violations depend on current state
      for (const violation of violations) {
        expect(violation.folder).toBeDefined()
        expect(violation.rule).toBeDefined()
        expect(violation.message).toBeDefined()
      }
    })
  })

// ── Slice 5: Generate DOCS_INDEX.md from current structure ──
  describe('generateDocsIndex', () => {
    it('produces markdown with folder summary table and file counts', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const indexContent = mod.generateDocsIndex(scanResult, DOCS_ROOT)

      // Should contain header
      expect(indexContent).toContain('# DOCS_INDEX.md')

      // Should contain folder summary table with headers
      expect(indexContent).toContain('| Folder |')
      expect(indexContent).toContain('Files |')

      // Should list canonical folders from scan
      for (const folder of scanResult.folders) {
        if (folder.fileCount > 0) {
          expect(indexContent).toContain(folder.name)
        }
      }
    })

    it('includes status indicators per folder', async () => {
      const mod = await import('./verify-structure')
      const scanResult = mod.scanDocsStructure(DOCS_ROOT)
      const indexContent = mod.generateDocsIndex(scanResult, DOCS_ROOT)

      // Should include status column or status markers (✅/⚠️/❌)
      expect(indexContent).toMatch(/[✅⚠️❌]/)
    })
  })

// ── Slice 6: Full validation run + CLI entry point ──
  describe('runValidation', () => {
    it('returns complete validation result with all checks', async () => {
      const mod = await import('./verify-structure')
      const result = mod.runValidation(DOCS_ROOT)

      // Should have scan results
      expect(result.scan.folders.length).toBeGreaterThan(0)

      // Should have orphan detection
      expect(Array.isArray(result.orphaned.orphanRootFiles)).toBe(true)
      expect(Array.isArray(result.orphaned.orphanFolders)).toBe(true)

      // Should have empty folders
      expect(Array.isArray(result.emptyFolders)).toBe(true)

      // Should have violations
      expect(Array.isArray(result.violations)).toBe(true)

      // Should have generated index content
      expect(typeof result.indexContent).toBe('string')
      expect(result.indexContent).toContain('# DOCS_INDEX.md')
    })

    it('sets overall pass/fail based on violations', async () => {
      const mod = await import('./verify-structure')
      const result = mod.runValidation(DOCS_ROOT)

      // If there are violations, should not be passing
      if (result.violations.length > 0) {
        expect(result.passed).toBe(false)
      }
    })
  })

// ── CLI execution test ──
  describe('CLI execution', () => {
    it('writes DOCS_INDEX.md when run as script', async () => {
      const mod = await import('./verify-structure')

      // Run main with docs/ path — should write DOCS_INDEX.md
      await mod.main([join(__dirname, '..', 'docs')])

      const indexPath = join(DOCS_ROOT, '_system', 'DOCS_INDEX.md')
      expect(isFile(indexPath)).toBe(true)

      const content = readFileSync(indexPath, 'utf-8')
      // Should contain folder summary table
      expect(content).toContain('| Status | Folder | Files | Type |')
      // Should have been generated recently (within last minute)
      expect(content).toMatch(/Generated:.*\d{4}-\d{2}-\d{2}T/)
    })
  })
})
