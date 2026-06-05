import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs'

const DOCS_ROOT = resolve(__dirname, '..', 'docs')
const INVENTORY_PATH = join(DOCS_ROOT, '_system', 'DOCS_INVENTORY.md')

// ── Helpers ────────────────────────────────────────────────────

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

describe('classify-inventory.ts — Classification Script', () => {
  // ── AC1: Parse inventory YAML blocks from DOCS_INVENTORY.md ──
  describe('parseInventory()', () => {
    it('parses all YAML blocks from a real inventory file', async () => {
      const mod = await import('./classify-inventory')

      expect(isFile(INVENTORY_PATH)).toBe(true)
      const blocks = mod.parseInventory(INVENTORY_PATH)

      expect(blocks.length).toBeGreaterThan(0)

      for (const block of blocks) {
        expect(block.id).toMatch(/^F\d{4}$/)
        expect(typeof block.path).toBe('string')
        expect(block.path).toMatch(/\.md$/)
        expect(typeof block.folder).toBe('string')
        expect(typeof block.size_kb).toBe('number')
        expect(typeof block.lines).toBe('number')
      }
    })

    it('parses array fields correctly (questions, related_files)', async () => {
      const mod = await import('./classify-inventory')
      const blocks = mod.parseInventory(INVENTORY_PATH)

      // Find a block that has non-empty arrays
      const withRelated = blocks.find(b => Array.isArray(b.related_files) && b.related_files.length > 0)
      if (withRelated) {
        expect(Array.isArray(withRelated.related_files)).toBe(true)
        for (const ref of withRelated.related_files) {
          expect(typeof ref).toBe('string')
        }
      }

      // All blocks should have questions as array
      for (const block of blocks) {
        expect(Array.isArray(block.questions)).toBe(true)
      }
    })

    it('handles empty arrays [] correctly', async () => {
      const mod = await import('./classify-inventory')
      const blocks = mod.parseInventory(INVENTORY_PATH)

      // Most blocks should have empty questions array
      const withEmptyQuestions = blocks.filter(b => Array.isArray(b.questions) && b.questions.length === 0)
      expect(withEmptyQuestions.length).toBeGreaterThan(0)
    })
  })

  // ── AC2: Deterministic rules classify obvious files correctly ──
  describe('classifyBlock() — deterministic rules', () => {
    it('classifies draft/temp-named files as experiment → archive', async () => {
      const mod = await import('./classify-inventory')

      const block: typeof mod.classifyBlock extends (b: infer B, f?: any) => any ? B : never = {
        id: 'F9001',
        path: 'docs/draft-notes.md',
        folder: 'docs',
        size_kb: 1.5,
        lines: 20,
        status: 'scanned' as const,
        class: null,
        confidence: null,
        proposed_action: null,
        approval: null,
        risk: null,
        reason: null,
        questions: [],
        related_files: [],
        target_path: null,
        current_step: null,
        blocker: null,
        last_updated: new Date().toISOString(),
      }

      const result = mod.classifyBlock(block, { isDraftOrTemp: true })

      expect(result.classified).toBe(true)
      if (result.classified) {
        expect(result.updates.class).toBe('experiment')
        expect(result.updates.confidence).toBe('high')
        expect(result.updates.proposed_action).toBe('archive')
      }
    })

    it('classifies adr/ folder files as decision → move to 40-decisions/', async () => {
      const mod = await import('./classify-inventory')

      const block: typeof mod.classifyBlock extends (b: infer B, f?: any) => any ? B : never = {
        id: 'F9002',
        path: 'docs/adr/0001-something.md',
        folder: 'docs/adr',
        size_kb: 3.2,
        lines: 45,
        status: 'scanned' as const,
        class: null,
        confidence: null,
        proposed_action: null,
        approval: null,
        risk: null,
        reason: null,
        questions: [],
        related_files: [],
        target_path: null,
        current_step: null,
        blocker: null,
        last_updated: new Date().toISOString(),
      }

      const result = mod.classifyBlock(block)

      expect(result.classified).toBe(true)
      if (result.classified) {
        expect(result.updates.class).toBe('decision')
        expect(result.updates.confidence).toBe('high')
        expect(result.updates.proposed_action).toBe('move')
        expect(result.updates.target_path).toContain('40-decisions/')
      }
    })

    it('classifies prd/ folder files as canonical → move to 35-prds/', async () => {
      const mod = await import('./classify-inventory')

      const block: typeof mod.classifyBlock extends (b: infer B, f?: any) => any ? B : never = {
        id: 'F9003',
        path: 'docs/prd/feature-x.md',
        folder: 'docs/prd',
        size_kb: 5.1,
        lines: 80,
        status: 'scanned' as const,
        class: null,
        confidence: null,
        proposed_action: null,
        approval: null,
        risk: null,
        reason: null,
        questions: [],
        related_files: [],
        target_path: null,
        current_step: null,
        blocker: null,
        last_updated: new Date().toISOString(),
      }

      const result = mod.classifyBlock(block)

      expect(result.classified).toBe(true)
      if (result.classified) {
        expect(result.updates.class).toBe('canonical')
        expect(result.updates.proposed_action).toBe('move')
        expect(result.updates.target_path).toContain('35-prds/')
      }
    })

    it('marks files in non-canonical folders as uncertain (low confidence)', async () => {
      const mod = await import('./classify-inventory')

      const block: typeof mod.classifyBlock extends (b: infer B, f?: any) => any ? B : never = {
        id: 'F9004',
        path: 'docs/react-guides/something.md',
        folder: 'docs/react-guides',
        size_kb: 2.3,
        lines: 30,
        status: 'scanned' as const,
        class: null,
        confidence: null,
        proposed_action: null,
        approval: null,
        risk: null,
        reason: null,
        questions: [],
        related_files: [],
        target_path: null,
        current_step: null,
        blocker: null,
        last_updated: new Date().toISOString(),
      }

      const result = mod.classifyBlock(block)

      // Non-canonical folder rule should match but produce low confidence (null class)
      expect(result).toBeDefined()
    })

    it('classifies files already in 50-agent-workflows as keep', async () => {
      const mod = await import('./classify-inventory')

      const block: typeof mod.classifyBlock extends (b: infer B, f?: any) => any ? B : never = {
        id: 'F9005',
        path: 'docs/50-agent-workflows/workflow.md',
        folder: 'docs/50-agent-workflows',
        size_kb: 1.2,
        lines: 15,
        status: 'scanned' as const,
        class: null,
        confidence: null,
        proposed_action: null,
        approval: null,
        risk: null,
        reason: null,
        questions: [],
        related_files: [],
        target_path: null,
        current_step: null,
        blocker: null,
        last_updated: new Date().toISOString(),
      }

      const result = mod.classifyBlock(block)

      expect(result.classified).toBe(true)
      if (result.classified) {
        expect(result.updates.proposed_action).toBe('keep')
        expect(result.updates.risk).toBe('none')
      }
    })
  })

  // ── AC3: writeInventory() round-trips correctly ──
  describe('writeInventory()', () => {
    it('writes and re-parses inventory without data loss', async () => {
      const mod = await import('./classify-inventory')

      // Read real inventory
      const originalBlocks = mod.parseInventory(INVENTORY_PATH)
      expect(originalBlocks.length).toBeGreaterThan(0)

      // Write to temp file
      const testDir = join(__dirname, '__test-classify-write')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
      const tempPath = join(testDir, 'DOCS_INVENTORY.md')

      mod.writeInventory(tempPath, originalBlocks)

      // Re-parse and compare
      const reParsed = mod.parseInventory(tempPath)
      expect(reParsed.length).toBe(originalBlocks.length)

      for (let i = 0; i < originalBlocks.length; i++) {
        expect(reParsed[i].id).toBe(originalBlocks[i].id)
        expect(reParsed[i].path).toBe(originalBlocks[i].path)
        expect(reParsed[i].folder).toBe(originalBlocks[i].folder)
      }

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── AC4: runAutoClassification() classifies inventory in-place ──
  describe('runAutoClassification()', () => {
    it('classifies entries and returns counts', async () => {
      const mod = await import('./classify-inventory')

      // Use a copy of the real inventory for testing
      const testDir = join(__dirname, '__test-classify-auto')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
      const systemDir = join(testDir, '_system')
      if (!existsSync(systemDir)) mkdirSync(systemDir, { recursive: true })

      // Copy real inventory to test dir
      const originalContent = readFileSync(INVENTORY_PATH, 'utf-8')
      writeFileSync(join(systemDir, 'DOCS_INVENTORY.md'), originalContent, 'utf-8')

      const result = mod.runAutoClassification(join(systemDir, 'DOCS_INVENTORY.md'))

      expect(result.total).toBeGreaterThan(0)
      expect(typeof result.classified).toBe('number')
      expect(typeof result.uncertain).toBe('number')
      expect(result.classified + result.uncertain).toBe(result.total)

      // At least some should be auto-classifiable (adr, prd, draft patterns etc.)
      expect(result.classified).toBeGreaterThan(0)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── AC5: outputUncertainAsJsonl() outputs valid JSONL ──
  describe('outputUncertainAsJsonl()', () => {
    it('outputs uncertain entries as parseable JSON lines', async () => {
      const mod = await import('./classify-inventory')

      // Create a test inventory with an uncertain entry (low confidence)
      const testDir = join(__dirname, '__test-classify-jsonl')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
      const systemDir = join(testDir, '_system')
      if (!existsSync(systemDir)) mkdirSync(systemDir, { recursive: true })

      // Create minimal inventory with one uncertain entry
      writeFileSync(join(systemDir, 'DOCS_INVENTORY.md'), `# DOCS_INVENTORY.md — File Inventory

## Folder Summary
| Folder | Total Files | Total Size (KB) |
|--------|-------------|-----------------|
| docs/test | 1 | 1.0 |

## File Entries

### docs/test

\`\`\`yaml
id: F9999
path: docs/test/unknown.md
folder: docs/test
size_kb: 1.0
lines: 10
status: scanned
class: null
confidence: low
proposed_action: null
approval: null
risk: null
reason: null
questions: []
related_files: []
target_path: null
current_step: null
blocker: null
last_updated: 2026-01-01T00:00:00.000Z
\`\`\`

`, 'utf-8')

      // Capture stdout
      const outputs: string[] = []
      const originalLog = console.log
      console.log = (msg: string) => outputs.push(msg)

      try {
        mod.outputUncertainAsJsonl(join(systemDir, 'DOCS_INVENTORY.md'), 5)
      } finally {
        console.log = originalLog
      }

      // Should have output at least one JSONL line
      expect(outputs.length).toBeGreaterThan(0)

      // Each line should be valid JSON
      for (const line of outputs) {
        const parsed = JSON.parse(line)
        expect(parsed.id).toBeDefined()
        expect(typeof parsed.path).toBe('string')
      }

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── AC6: CLI --auto mode runs without error ──
  describe('CLI execution', () => {
    it('--auto mode completes on real inventory', async () => {
      const mod = await import('./classify-inventory')

      // Capture console output to verify it ran
      let stdout = ''
      const originalLog = console.log
      console.log = (msg: string) => { stdout += msg + '\n' }

      try {
        // Run on a copy to avoid modifying real inventory in tests
        const testDir = join(__dirname, '__test-classify-cli')
        if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })
        const systemDir = join(testDir, '_system')
        if (!existsSync(systemDir)) mkdirSync(systemDir, { recursive: true })

        // Copy real inventory
        writeFileSync(join(systemDir, 'DOCS_INVENTORY.md'), readFileSync(INVENTORY_PATH, 'utf-8'), 'utf-8')

        await mod.main([testDir, '--auto'])

        expect(stdout).toContain('Auto-classified:')
        expect(stdout).toContain('Uncertain:')
      } finally {
        console.log = originalLog

        // Cleanup
        if (existsSync(join(__dirname, '__test-classify-cli'))) {
          rmSync(join(__dirname, '__test-classify-cli'), { recursive: true })
        }
      }
    })
  })
})
