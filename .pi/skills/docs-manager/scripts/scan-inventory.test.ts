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

// ── Import the module under test (will create next) ────────────
// We import lazily so the module can be created in GREEN step

describe('scan-inventory.ts — Inventory Script', () => {
  // ── AC1: Recursive scan excludes _system/ and collects .md files ──
  describe('Recursive file scanning', () => {
    it('finds all .md files in docs/ excluding _system/', async () => {
      const mod = await import('./scan-inventory')
      const entries = mod.scanFiles(DOCS_ROOT, ['_system'])

      // Should find real files
      expect(entries.length).toBeGreaterThan(0)

      // All paths should be .md files
      for (const entry of entries) {
        expect(entry.path).toMatch(/\.md$/)
        expect(isFile(resolve(__dirname, '..', entry.path))).toBe(true)
      }

      // None should be from _system/
      for (const entry of entries) {
        expect(entry.path).not.toMatch(/_system\//)
        expect(entry.path).not.toMatch(/_system\\/)
      }
    })

    it('excludes multiple directories when specified', async () => {
      const mod = await import('./scan-inventory')
      const entries = mod.scanFiles(DOCS_ROOT, ['_system', '06-templates'])

      for (const entry of entries) {
        expect(entry.path).not.toMatch(/_system\//)
        expect(entry.path).not.toMatch(/06-templates\//)
      }
    })
  })

  // ── AC2: Metadata collection — path, size_kb, lines, first 5 lines ──
  describe('Metadata collection', () => {
    it('collects correct metadata for a known file', async () => {
      const mod = await import('./scan-inventory')

      // Use a real file we know exists
      const testFile = join(DOCS_ROOT, 'README.md')
      expect(isFile(testFile)).toBe(true)

      const meta = mod.collectMetadata(testFile)

      expect(meta.path).toBeDefined()
      expect(typeof meta.size_kb).toBe('number')
      expect(meta.size_kb).toBeGreaterThan(0)
      expect(typeof meta.lines).toBe('number')
      expect(meta.lines).toBeGreaterThan(0)
      expect(Array.isArray(meta.preview)).toBe(true)
      expect(meta.preview.length).toBeLessThanOrEqual(5)

      // Verify preview matches actual first lines
      const content = readFileSync(testFile, 'utf-8')
      const actualLines = content.split('\n')
      for (let i = 0; i < meta.preview.length; i++) {
        expect(meta.preview[i]).toBe(actualLines[i])
      }
    })

    it('limits preview to first 5 lines even on long files', async () => {
      const mod = await import('./scan-inventory')

      // Find a file with more than 5 lines
      const testFile = join(DOCS_ROOT, '_system', 'DOCS_RULES.md')
      expect(isFile(testFile)).toBe(true)

      const meta = mod.collectMetadata(testFile)
      expect(meta.lines).toBeGreaterThan(5)
      expect(meta.preview.length).toBeLessThanOrEqual(5)
    })
  })

  // ── AC3: Heuristic flags — large file, temp/draft, duplicate basename ──
  describe('Heuristic flags', () => {
    it('flags files larger than threshold as largeFile', async () => {
      const mod = await import('./scan-inventory')

      // Create a test scenario with entries
      const entries: typeof mod.scanFiles extends (dir: string, dirs?: string[]) => infer R ? R : never[] = []

      // Use actual scan but with 0KB threshold to force largeFile flag on everything
      const scanned = mod.scanFiles(DOCS_ROOT, ['_system'])
      mod.applyHeuristics(scanned, 0)

      // All should be flagged as large when threshold is 0
      for (const entry of scanned) {
        expect(entry.flags?.largeFile).toBe(true)
      }
    })

    it('flags files with temp/draft name patterns', async () => {
      const mod = await import('./scan-inventory')

      // Create a temp directory with draft-named files for testing
      const testDir = join(__dirname, '__test-draft-files')
      if (!isDir(testDir)) mkdirSync(testDir, { recursive: true })

      writeFileSync(join(testDir, 'draft-notes.md'), '# Draft\nsome content here\nmore lines\nand more\nline 5\nline 6')
      writeFileSync(join(testDir, 'temp-work.md'), '# Temp\ncontent\nlines\nhere\nfive\nsix')
      writeFileSync(join(testDir, 'normal-doc.md'), '# Normal\nclean\ndocument\nno\ntemp\npattern')

      const scanned = mod.scanFiles(testDir, [])
      mod.applyHeuristics(scanned, 50)

      const draftEntry = scanned.find(e => e.path.includes('draft-notes'))
      const tempEntry = scanned.find(e => e.path.includes('temp-work'))
      const normalEntry = scanned.find(e => e.path.includes('normal-doc'))

      expect(draftEntry?.flags?.isDraftOrTemp).toBe(true)
      expect(tempEntry?.flags?.isDraftOrTemp).toBe(true)
      expect(normalEntry?.flags?.isDraftOrTemp).toBe(false)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })

    it('detects duplicate basenames across folders', async () => {
      const mod = await import('./scan-inventory')

      // docs/ has README.md at root and in subfolders (03-features, 04-operations, etc.)
      const scanned = mod.scanFiles(DOCS_ROOT, ['_system'])
      mod.applyHeuristics(scanned, 50)

      // Check if any README.md duplicates are flagged
      const readmeEntries = scanned.filter(e => e.path.endsWith('README.md'))
      if (readmeEntries.length > 1) {
        const hasDuplicateFlag = readmeEntries.some(e => e.flags?.isDuplicateBasename)
        expect(hasDuplicateFlag).toBe(true)
      }
    })
  })

  // ── AC4: Stable sequential IDs (F0001, F0002...) ──
  describe('Stable ID assignment', () => {
    it('assigns sequential F-prefixed IDs', async () => {
      const mod = await import('./scan-inventory')
      const scanned = mod.scanFiles(DOCS_ROOT, ['_system'])

      // After heuristics, generate output which assigns IDs
      const result = mod.generateInventory(scanned, 50)

      const ids = Object.keys(result.blocks)
      expect(ids.length).toBeGreaterThan(0)

      for (const id of ids) {
        expect(id).toMatch(/^F\d{4}$/)
      }

      // IDs should be sequential
      const sortedIds = [...ids].sort()
      for (let i = 1; i < sortedIds.length; i++) {
        const prevNum = parseInt(sortedIds[i - 1].slice(1))
        const currNum = parseInt(sortedIds[i].slice(1))
        expect(currNum).toBe(prevNum + 1)
      }
    })
  })

  // ── AC5: YAML block output — all required fields present ──
  describe('YAML block output', () => {
    it('includes all required fields in each entry', async () => {
      const mod = await import('./scan-inventory')
      const scanned = mod.scanFiles(DOCS_ROOT, ['_system'])
      const result = mod.generateInventory(scanned, 50)

      const ids = Object.keys(result.blocks)
      expect(ids.length).toBeGreaterThan(0)

      for (const id of ids) {
        const block = result.blocks[id]
        // Required fields from schema
        expect(block.id).toBeDefined()
        expect(block.path).toMatch(/\.md$/)
        expect(block.folder).toBeDefined()
        expect(typeof block.size_kb).toBe('number')
        expect(typeof block.lines).toBe('number')
        expect(block.status).toBe('scanned')
        expect(block.class).toBe(null)
        expect(block.confidence).toBe(null)
        expect(block.proposed_action).toBe(null)
        expect(block.approval).toBe(null)
        expect(block.risk).toBe(null)
        expect(block.reason).toBe(null)
        expect(Array.isArray(block.questions)).toBe(true)
        expect(Array.isArray(block.related_files)).toBe(true)
        expect(block.target_path).toBe(null)
        expect(block.current_step).toBe(null)
        expect(block.blocker).toBe(null)
        expect(block.last_updated).toMatch(/\d{4}-\d{2}-\d{2}T/)
      }
    })

    it('groups files by folder in output', async () => {
      const mod = await import('./scan-inventory')
      const scanned = mod.scanFiles(DOCS_ROOT, ['_system'])
      const result = mod.generateInventory(scanned, 50)

      // Check that summary table has folder entries
      expect(result.summaryTable).toContain('| Folder |')
      expect(result.summaryTable).toContain('Total')
    })
  })

  // ── AC6: Large file sampling — only reads first 5 lines ──
  describe('Large file handling', () => {
    it('does not read full content of files (preview limited to 5 lines)', async () => {
      const mod = await import('./scan-inventory')

      // Use a large-ish file
      const testFile = join(DOCS_ROOT, '_system', 'DOCS_RULES.md')
      expect(isFile(testFile)).toBe(true)

      const meta = mod.collectMetadata(testFile)

      // File should have many lines but preview capped at 5
      expect(meta.lines).toBeGreaterThan(10)
      expect(meta.preview.length).toBeLessThanOrEqual(5)
    })
  })

  // ── AC7: CLI runnable via npx tsx scripts/scan-inventory.ts docs/ ──
  describe('CLI execution', () => {
    it('writes output to DOCS_INVENTORY.md when run as script', async () => {
      const mod = await import('./scan-inventory')

      // The main() function should be callable and write the file
      const inventoryPath = join(DOCS_ROOT, '_system', 'DOCS_INVENTORY.md')
      expect(isFile(inventoryPath)).toBe(true)

      // Capture content before
      const beforeContent = readFileSync(inventoryPath, 'utf-8')

      // Run main with docs/ path
      await mod.main([join(__dirname, '..', 'docs')])

      // File should be updated (or at least still exist and have entries now)
      expect(isFile(inventoryPath)).toBe(true)
      const afterContent = readFileSync(inventoryPath, 'utf-8')

      // Should contain file entries with F-prefixed IDs
      expect(afterContent).toMatch(/id:\s*F\d{4}/)
      // Should contain folder summary table
      expect(afterContent).toContain('| Folder |')
    })
  })
})
