import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import { existsSync, statSync, mkdirSync, writeFileSync, rmSync } from 'fs'

const DOCS_ROOT = resolve(__dirname, '..', 'docs')

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

// ── Cycle 1: Section header extraction with line numbers ───────

describe('parse-doc-file.ts — Deep Analysis Script', () => {
  describe('Section header extraction', () => {
    it('extracts markdown headings with line numbers from a real doc file', async () => {
      const mod = await import('./parse-doc-file')

      // Use a known multi-section doc
      const testFile = join(DOCS_ROOT, '_system', 'DOCS_RULES.md')
      expect(isFile(testFile)).toBe(true)

      const result = mod.parseDocFile(testFile)

      expect(result.sections.length).toBeGreaterThan(0)

      for (const section of result.sections) {
        expect(section.heading).toBeDefined()
        expect(typeof section.level).toBe('number')
        expect(section.lineNumber).toBeGreaterThan(0)
      }

      // Headings should be in document order by line number
      const lineNumbers = result.sections.map(s => s.lineNumber)
      for (let i = 1; i < lineNumbers.length; i++) {
        expect(lineNumbers[i]).toBeGreaterThanOrEqual(lineNumbers[i - 1])
      }
    })

    it('distinguishes heading levels (h1, h2, h3)', async () => {
      const mod = await import('./parse-doc-file')

      // Create a test file with known heading structure
      const testDir = join(__dirname, '__test-parse-docs')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      const testFile = join(testDir, 'structure-test.md')
      writeFileSync(testFile, `# Top Level

Some content here.

## Second Level

More content.

### Third Level

Even more content.

## Another Second Level

Final section.
`)

      const result = mod.parseDocFile(testFile)

      expect(result.sections.length).toBe(4)
      expect(result.sections[0]).toMatchObject({ heading: 'Top Level', level: 1 })
      expect(result.sections[1]).toMatchObject({ heading: 'Second Level', level: 2 })
      expect(result.sections[2]).toMatchObject({ heading: 'Third Level', level: 3 })
      expect(result.sections[3]).toMatchObject({ heading: 'Another Second Level', level: 2 })

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── Cycle 2: Content summary per section (sampling) ────────────

  describe('Content summary per section', () => {
    it('generates a content summary from first N lines of each section', async () => {
      const mod = await import('./parse-doc-file')

      const testDir = join(__dirname, '__test-parse-summary')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      // Create a file with known content per section
      writeFileSync(join(testDir, 'summary-test.md'), `# Section One
Line A of section one.
Line B of section one.
Line C of section one.

## Section Two
Line X of section two.
Line Y of section two.

### Section Three
Line 1 here.
Line 2 here.
Line 3 here.
Line 4 here.
Line 5 here.
Line 6 here.
`)

      const result = mod.parseDocFile(join(testDir, 'summary-test.md'))

      expect(result.sections.length).toBe(3)

      // Each section should have a summary
      for (const section of result.sections) {
        expect(section.summary).toBeDefined()
        expect(typeof section.summary).toBe('string')
        expect(section.summary.length).toBeGreaterThan(0)
      }

      // Section One summary should contain its content lines
      const secOne = result.sections.find(s => s.heading === 'Section One')
      expect(secOne?.summary).toContain('Line A of section one')
      expect(secOne?.summary).toContain('Line B of section one')

      // Section Two summary should contain its content lines
      const secTwo = result.sections.find(s => s.heading === 'Section Two')
      expect(secTwo?.summary).toContain('Line X of section two')

      // Section Three has more lines than sampling limit — should be truncated
      const secThree = result.sections.find(s => s.heading === 'Section Three')
      expect(secThree?.summary).toBeDefined()
      if (secThree?.summary) {
        // Should not contain all 6 lines if sampling is capped at ~5
        const summaryLines = secThree.summary.split('\n').filter(l => l.trim())
        expect(summaryLines.length).toBeLessThanOrEqual(5)
      }

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── Cycle 3: Cross-reference detection ────────────────────────

  describe('Cross-reference detection', () => {
    it('finds markdown link references to other docs paths', async () => {
      const mod = await import('./parse-doc-file')

      const testDir = join(__dirname, '__test-parse-xref')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      writeFileSync(join(testDir, 'xref-test.md'), `# Main Doc

See [the guide](docs/03-features/guide.md) for details.
Also check [README](./README.md).

## References

Related to [ADR-01](../adr/001-decision.md) and [Issue #5](https://github.com/example/repo/issues/5).
`)

      const result = mod.parseDocFile(join(testDir, 'xref-test.md'))

      expect(result.crossReferences).toBeDefined()
      expect(Array.isArray(result.crossReferences)).toBe(true)

      // Should find local file references (not external URLs)
      const localRefs = result.crossReferences.filter(r => !r.target.startsWith('http'))
      expect(localRefs.length).toBeGreaterThanOrEqual(2)

      // Check specific refs found
      const targets = result.crossReferences.map(r => r.target)
      expect(targets.some(t => t.includes('guide.md'))).toBe(true)
      expect(targets.some(t => t.includes('README.md'))).toBe(true)
      expect(targets.some(t => t.includes('001-decision.md'))).toBe(true)

      // External URL should also be detected but marked as external
      const extRefs = result.crossReferences.filter(r => r.isExternal)
      expect(extRefs.length).toBeGreaterThanOrEqual(1)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── Cycle 4: Edge cases — binary, empty, large files ────────────

  describe('Edge case handling', () => {
    it('detects and handles binary files gracefully', async () => {
      const mod = await import('./parse-doc-file')

      const testDir = join(__dirname, '__test-parse-binary')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      // Write a "binary" file with null bytes
      const binaryFile = join(testDir, 'binary.dat.md')
      writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x00, 0x00]))

      const result = mod.parseDocFile(binaryFile)

      expect(result.fileType).toBe('binary')
      // Should not crash; sections should be empty or minimal
      expect(Array.isArray(result.sections)).toBe(true)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })

    it('handles empty files', async () => {
      const mod = await import('./parse-doc-file')

      const testDir = join(__dirname, '__test-parse-empty')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      writeFileSync(join(testDir, 'empty.md'), '')

      const result = mod.parseDocFile(join(testDir, 'empty.md'))

      expect(result.fileType).toBe('markdown')
      expect(result.sections.length).toBe(0)
      expect(result.wordCount).toBe(0)
      expect(result.crossReferences.length).toBe(0)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })

    it('handles large files with sampling (caps processing)', async () => {
      const mod = await import('./parse-doc-file')

      const testDir = join(__dirname, '__test-parse-large')
      if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true })

      // Generate a large file (>50KB) with many sections
      let content = '# Large File\n'
      for (let i = 0; i < 2000; i++) {
        content += `## Section ${i}\n`
        content += `Line of content for section ${i}. This is some text to pad the file.\n`
        content += `Another line in section ${i} with more words.\n`
        content += `\n`
      }

      const largeFile = join(testDir, 'large.md')
      writeFileSync(largeFile, content)

      // Verify it's actually large
      const stat = statSync(largeFile)
      expect(stat.size / 1024).toBeGreaterThan(50) // >50KB

      const result = mod.parseDocFile(largeFile)

      // Should still produce valid output
      expect(result.fileType).toBe('markdown')
      expect(Array.isArray(result.sections)).toBe(true)
      expect(result.sections.length).toBeGreaterThan(0)

      // Large file flag should be set
      expect(result.flags?.largeFile).toBe(true)

      // Word count should be estimated (not exact for large files)
      expect(typeof result.wordCount).toBe('number')
      expect(result.wordCount).toBeGreaterThan(0)

      // Cleanup
      rmSync(testDir, { recursive: true })
    })
  })

  // ── Cycle 5: CLI entry point + structured output ────────────────

  describe('CLI execution', () => {
    it('accepts a file path argument and outputs structured JSON to stdout', async () => {
      const mod = await import('./parse-doc-file')

      // Use a real doc with known structure
      const testFile = join(DOCS_ROOT, '_system', 'DOCS_RULES.md')
      expect(isFile(testFile)).toBe(true)

      // Capture stdout via process.stdout.write spy (runner uses writeOutput)
      let capturedOutput = ''
      const originalWrite = process.stdout.write.bind(process.stdout)
      ;(process.stdout.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
        capturedOutput += chunk
        return true
      }

      try {
        await mod.main([testFile])
      } finally {
        // Restore process.stdout.write
        ;(process.stdout.write as unknown as Function) = originalWrite
      }

      // Should output valid JSON
      const parsed = JSON.parse(capturedOutput)

      // Verify structure matches DocAnalysis
      expect(parsed.filePath).toBe(testFile)
      expect(['markdown', 'binary']).toContain(parsed.fileType)
      expect(typeof parsed.wordCount).toBe('number')
      expect(Array.isArray(parsed.sections)).toBe(true)
      expect(Array.isArray(parsed.crossReferences)).toBe(true)

      // Sections should have required fields
      if (parsed.sections.length > 0) {
        const firstSection = parsed.sections[0]
        expect(firstSection.heading).toBeDefined()
        expect(typeof firstSection.level).toBe('number')
        expect(typeof firstSection.lineNumber).toBe('number')
        expect(typeof firstSection.summary).toBe('string')
      }
    })

    it('exits with error when no file path provided', async () => {
      const mod = await import('./parse-doc-file')

      await expect(mod.main([])).rejects.toThrow()
    })
  })
})
