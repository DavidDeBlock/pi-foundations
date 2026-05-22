import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'

const DOCS_ROOT = resolve(__dirname, '..', 'docs')
const SYSTEM_DIR = join(DOCS_ROOT, '_system')

function fileExists(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function dirExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory()
}

function readFileContent(path: string): string {
  return readFileSync(path, 'utf-8')
}

describe('Docs Foundation — Issue docs-reorg-01', () => {
  // ── AC2: Target folders created ──────────────────────────────
  describe('Target folder structure', () => {
    const targetFolders = [
      '00-current',
      '10-domain',
      '20-architecture',
      '30-vertical-flows',
      '40-decisions',
      '50-agent-workflows',
      '90-archive',
    ]

    for (const folder of targetFolders) {
      it(`docs/${folder}/ directory exists`, () => {
        expect(dirExists(join(DOCS_ROOT, folder))).toBe(true)
      })
    }
  })

  // ── AC3: work-sessions directory created ─────────────────────
  describe('Work sessions directory', () => {
    it('docs/_system/work-sessions/ directory exists', () => {
      expect(dirExists(join(SYSTEM_DIR, 'work-sessions'))).toBe(true)
    })
  })

  // ── AC1: DOCS_RULES.md written with required sections ───────
  describe('DOCS_RULES.md', () => {
    const rulesPath = join(SYSTEM_DIR, 'DOCS_RULES.md')

    it('file exists and is non-empty', () => {
      expect(fileExists(rulesPath)).toBe(true)
      const content = readFileContent(rulesPath)
      expect(content.length).toBeGreaterThan(100)
    })

    it('contains classification categories section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/classification.*categories/i)
      // Verify all 6 categories are mentioned
      const categories = ['canonical', 'stale', 'duplicate', 'archive', 'experiment', 'decision']
      for (const cat of categories) {
        expect(content.toLowerCase()).toContain(cat)
      }
    })

    it('contains action types section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/action.*types/i)
      const actions = ['keep', 'move', 'archive', 'delete', 'merge-into', 'rewrite']
      for (const action of actions) {
        expect(content.toLowerCase()).toContain(action)
      }
    })

    it('contains escalation thresholds section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/escalat/i)
    })

    it('contains execution rules section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/execution.*rules|rules.*execution/i)
    })

    it('contains target structure section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/target.*(structure|folders)/i)
    })

    it('contains naming conventions section', () => {
      const content = readFileContent(rulesPath)
      expect(content).toMatch(/naming.*conventions/i)
    })

    it('states human-owned / agent-read-only ownership', () => {
      const content = readFileContent(rulesPath)
      expect(content.toLowerCase()).toContain('human')
      expect(content.toLowerCase()).toContain('agent')
    })

    it('contains content ownership rules per folder', () => {
      const content = readFileContent(rulesPath)
      // Should reference the numbered folders with their purposes
      expect(content).toMatch(/00-current|10-domain|20-architecture/)
    })
  })

  // ── AC4: State files initialized with proper headers ────────
  describe('State files', () => {
    it('DOCS_INVENTORY.md exists with header and YAML schema example', () => {
      const path = join(SYSTEM_DIR, 'DOCS_INVENTORY.md')
      expect(fileExists(path)).toBe(true)
      const content = readFileContent(path)
      // Should have a header/title
      expect(content).toMatch(/^#\s+/m)
      // Should contain YAML block schema example
      expect(content).toMatch(/id:\s*F\d+/i)
    })

    it('DOCS_QUESTIONS.md exists with header', () => {
      const path = join(SYSTEM_DIR, 'DOCS_QUESTIONS.md')
      expect(fileExists(path)).toBe(true)
      const content = readFileContent(path)
      // Should have a header/title
      expect(content).toMatch(/^#\s+/m)
    })

    it('DOCS_ARCHIVE_LOG.md exists with header', () => {
      const path = join(SYSTEM_DIR, 'DOCS_ARCHIVE_LOG.md')
      expect(fileExists(path)).toBe(true)
      const content = readFileContent(path)
      // Should have a header/title
      expect(content).toMatch(/^#\s+/m)
    })
  })

  // ── AC5: DOCS_PROGRESS.md updated for Phase 0 complete ──────
  describe('DOCS_PROGRESS.md', () => {
    const progressPath = join(SYSTEM_DIR, 'DOCS_PROGRESS.md')

    it('file exists and is non-empty', () => {
      expect(fileExists(progressPath)).toBe(true)
      const content = readFileContent(progressPath)
      expect(content.length).toBeGreaterThan(50)
    })

    it('indicates Phase 0 (foundation) complete', () => {
      const content = readFileContent(progressPath)
      expect(content.toLowerCase()).toMatch(/phase\s*0|foundation/)
      expect(content.toLowerCase()).toContain('complete')
    })

    it('lists pipeline phases', () => {
      const content = readFileContent(progressPath)
      // Should reference the 5 pipeline phases
      expect(content).toMatch(/inventory/i)
      expect(content).toMatch(/classify|propose/i)
      expect(content).toMatch(/review/i)
      expect(content).toMatch(/migrate|execute/i)
      expect(content).toMatch(/verify/i)
    })
  })

  // ── AC6: DOCS_INDEX.md contains folder-level map ────────────
  describe('DOCS_INDEX.md', () => {
    const indexPath = join(SYSTEM_DIR, 'DOCS_INDEX.md')

    it('file exists and is non-empty', () => {
      expect(fileExists(indexPath)).toBe(true)
      const content = readFileContent(indexPath)
      expect(content.length).toBeGreaterThan(50)
    })

    it('contains folder-level map of target structure', () => {
      const content = readFileContent(indexPath)
      // Should list the numbered folders
      expect(content).toMatch(/00-current/)
      expect(content).toMatch(/10-domain/)
      expect(content).toMatch(/20-architecture/)
      expect(content).toMatch(/30-vertical-flows/)
      expect(content).toMatch(/40-decisions/)
      expect(content).toMatch(/50-agent-workflows/)
      expect(content).toMatch(/90-archive/)
    })

    it('contains _system folder reference', () => {
      const content = readFileContent(indexPath)
      expect(content).toMatch(/_system/)
    })
  })
})
