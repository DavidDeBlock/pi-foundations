import { describe, it, expect } from 'vitest'
import { markdownTable, unicodeTree, toJson } from './format.js'

describe('format — Markdown table generation', () => {
  it('generates a simple markdown table with header and rows', () => {
    const headers = ['Name', 'Status']
    const rows = [
      ['script-a.ts', 'ready'],
      ['script-b.ts', 'draft']
    ]

    const result = markdownTable(headers, rows)

    expect(result).toContain('| Name | Status |')
    // Separator row uses column-width-based alignment
    expect(result).toContain('| Name | Status |')
    expect(result.split('\n')[1]).toMatch(/^\|.*-+.*\|$/)
    expect(result).toContain('| script-a.ts | ready |')
    expect(result).toContain('| script-b.ts | draft |')
  })

  it('handles empty rows array', () => {
    const headers = ['Col A']
    const result = markdownTable(headers, [])

    expect(result).toBe('| Col A |\n|-------|\n')
  })

  it('escapes pipe characters in cell content', () => {
    const headers = ['Description']
    const rows = [['value | with pipes']]

    const result = markdownTable(headers, rows)

    expect(result).toContain('\\|')
  })

  it('handles multi-word values correctly', () => {
    const headers = ['Script', 'Purpose']
    const rows = [
      ['exports.ts', 'List file exports with signatures']
    ]

    const result = markdownTable(headers, rows)

    expect(result).toContain('| exports.ts | List file exports with signatures |')
  })
})

describe('format — Unicode tree generation', () => {
  it('generates a simple indented tree from nested objects', () => {
    const data: Record<string, unknown> = {
      'src': {
        'components': {},
        'lib': {}
      },
      'scripts': {} // flat file at root level
    }

    const result = unicodeTree(data)

    expect(result).toContain('src')
    expect(result).toContain('├── components')
    expect(result).toContain('└── lib')
    // scripts is a sibling of src, not nested under it
    expect(result).toContain('scripts')
  })

  it('handles flat objects (no nesting)', () => {
    const data = { 'a': {}, 'b': {} }
    const result = unicodeTree(data)

    // Flat root-level entries have no tree connectors; empty objects show as directories
    expect(result).toContain('a/')
    expect(result).toContain('b/')
  })

  it('handles deep nesting with proper indentation', () => {
    const data: Record<string, unknown> = {
      'a': {
        'b': {
          'c': {}
        }
      }
    }

    const result = unicodeTree(data)

    expect(result).toContain('a')
    // b should be indented under a
    const lines = result.split('\n')
    const bLine = lines.find(l => l.includes('b'))!
    const cLine = lines.find(l => l.includes('c'))!
    expect(cLine.length).toBeGreaterThan(bLine.length)
  })

  it('handles empty object', () => {
    const result = unicodeTree({})
    expect(result.trim()).toBe('')
  })
})

describe('format — JSON output', () => {
  it('serializes data to pretty-printed JSON string', () => {
    const data = { name: 'test', value: 42 }
    const result = toJson(data)

    expect(result).toContain('"name": "test"')
    expect(result).toContain('"value": 42')
  })

  it('produces compact JSON when flag is set', () => {
    const data = { a: 1, b: 2 }
    const result = toJson(data, true)

    // Compact should be one line of JSON + trailing newline
    expect(result.split('\n').length).toBe(2) // content + empty from trailing \n
    expect(result.trim()).toBe('{"a":1,"b":2}')
  })

  it('handles arrays', () => {
    const data = [1, 'two', { three: true }]
    const result = toJson(data)

    expect(result).toContain('[')
    expect(result).toContain('"three": true')
  })

  it('handles null values', () => {
    const data = { key: null }
    const result = toJson(data)

    expect(result).toContain('"key": null')
  })
})
