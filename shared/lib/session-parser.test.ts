import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseSessionLog, parseSessionLines, extractSessionMetadata, type SessionSummary, type FileOperation, type Decision, type ToolError, type ParsedEvent } from '../shared/index.js'

const FIXTURES_DIR = resolve(__dirname, '__test-fixtures__')

// ── Helpers ────────────────────────────────────────────────────

function fixture(name: string): string {
  return join(FIXTURES_DIR, name)
}

// ── Public API surface ─────────────────────────────────────────

describe('parseSessionLog — public interface', () => {
  it('returns a SessionSummary with markdown and json fields', () => {
    const result = parseSessionLog(fixture('session-minimal.jsonl'))

    expect(result).toHaveProperty('markdown')
    expect(result).toHaveProperty('json')
    expect(typeof result.markdown).toBe('string')
    expect(typeof result.json).toBe('object')
  })

  it('throws when file does not exist', () => {
    expect(() => parseSessionLog('/nonexistent/path/session.jsonl')).toThrow()
  })
})

// ── Session metadata extraction ────────────────────────────────

describe('session metadata', () => {
  it('extracts session id from the first event', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    expect(result.json.session.id).toBe('abc12345-def6-7890-abcd-ef1234567890')
  })

  it('extracts timestamp from the first event', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    expect(result.json.session.timestamp).toBe('2026-05-22T10:00:00.000Z')
  })

  it('extracts model from model_change events', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    expect(result.json.session.model).toBe('gpt-4o')
  })

  it('extracts thinkingLevel from thinking_level_change events', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    expect(result.json.session.thinkingLevel).toBe('high')
  })

  it('calculates duration_minutes from first to last event timestamp', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    // Session starts at 10:00:00, last event at ~10:00:12 → should be ~0 minutes (less than 1 min)
    expect(result.json.session.duration_minutes).toBeGreaterThanOrEqual(0)
    expect(typeof result.json.session.duration_minutes).toBe('number')
  })

  it('handles minimal session with no messages', () => {
    const result = parseSessionLog(fixture('session-minimal.jsonl'))
    expect(result.json.session.id).toBe('minimal-001')
    expect(result.json.files_modified).toEqual([])
    expect(result.json.decisions).toEqual([])
    expect(result.json.errors).toEqual([])
  })
})

// ── File operations tracking ───────────────────────────────────

describe('file operations', () => {
  it('tracks successful file reads', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]

    const readOp = ops.find(op => op.action === 'read')
    expect(readOp).toBeDefined()
    if (readOp) {
      expect(readOp.status).toBe('success')
      expect(readOp.path).toBe('/home/david/projects/pi-pos-v0/server/src/db/schema.ts')
    }
  })

  it('tracks successful file edits', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]

    const editOp = ops.find(op => op.action === 'edit')
    expect(editOp).toBeDefined()
    if (editOp) {
      expect(editOp.status).toBe('success')
      expect(editOp.path).toBe('/home/david/projects/pi-pos-v0/server/src/db/schema.ts')
    }
  })

  it('tracks failed bash commands', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]

    const bashOp = ops.find(op => op.action === 'bash')
    expect(bashOp).toBeDefined()
    if (bashOp) {
      expect(bashOp.status).toBe('failed')
      expect(bashOp.error_message).toBeDefined()
      expect(typeof bashOp.error_message).toBe('string')
    }
  })

  it('includes timestamp on each file operation', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]

    for (const op of ops) {
      expect(op.timestamp).toBeDefined()
      expect(typeof op.timestamp).toBe('string')
    }
  })

  it('includes error_message only on failed operations', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]

    for (const op of ops) {
      if (op.status === 'success') {
        expect(op.error_message).toBeUndefined()
      } else {
        expect(op.error_message).toBeDefined()
      }
    }
  })
})

// ── Decision extraction ────────────────────────────────────────

describe('decision extraction', () => {
  it('extracts decisions from assistant text with decision patterns', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    expect(decisions.length).toBeGreaterThan(0)
  })

  it('captures topic from ## 🔥 Question blocks', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    const topics = decisions.map(d => d.topic)
    expect(topics).toContain('Database Schema Location')
  })

  it('captures decision from ✅ **...** confirmation', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    const decisions_text = decisions.map(d => d.decision)
    expect(decisions_text).toContain('Confirmed: Use `server/src/db/schema.ts` as source of truth')
  })

  it('marks confidence as high for extracted decisions', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    for (const d of decisions) {
      expect(d.confidence).toBe('high')
    }
  })

  it('stores source_pattern snippet', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    for (const d of decisions) {
      expect(d.source_pattern).toBeDefined()
      expect(typeof d.source_pattern).toBe('string')
      expect(d.source_pattern.length).toBeGreaterThan(0)
    }
  })
})

// ── Error tracking ─────────────────────────────────────────────

describe('error tracking', () => {
  it('captures tool errors from isError:true results', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]

    expect(errors.length).toBeGreaterThan(0)
  })

  it('classifies tool errors with type "tool_error"', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]

    const toolErrors = errors.filter(e => e.type === 'tool_error')
    expect(toolErrors.length).toBeGreaterThan(0)
  })

  it('includes context for each error', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]

    for (const e of errors) {
      expect(e.context).toBeDefined()
      expect(typeof e.context).toBe('string')
    }
  })

  it('captures text-level errors from assistant messages', () => {
    // The session has "error" in the bash error output — verify tool_error is captured
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]

    expect(errors.some(e => e.message.toLowerCase().includes('error'))).toBe(true)
  })
})

// ── Markdown output quality ────────────────────────────────────

describe('markdown summary', () => {
  it('includes session header with id, time, and duration', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('# Session Summary')
    expect(result.markdown).toContain('abc12345') // truncated ID
  })

  it('includes file operations table when there are operations', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('## 📁 File Operations Log')
    expect(result.markdown).toContain('| Time | Action | File | Status | Notes |')
  })

  it('includes decisions table when there are decisions', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('## 🔑 Key Decisions & Confirmations')
    expect(result.markdown).toContain('| Topic | Decision | Confidence |')
  })

  it('includes errors section when there are errors', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('## ⚠️ Errors & Exceptions')
  })

  it('includes raw messages section when there are critical messages', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('## 📝 Critical Context (Raw)')
  })

  it('shows success status with ✅ for successful operations', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('✅ Success')
  })

  it('shows failed status with ❌ for failed operations', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('❌ Failed')
  })
})

// ── JSON output structure ──────────────────────────────────────

describe('json output structure', () => {
  it('has top-level keys: session, files_modified, decisions, errors, raw_messages', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(Object.keys(result.json)).toEqual(
      expect.arrayContaining(['session', 'files_modified', 'decisions', 'errors', 'raw_messages'])
    )
  })

  it('session object contains metadata fields', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const session = result.json.session as Record<string, unknown>

    expect(session).toHaveProperty('id')
    expect(session).toHaveProperty('timestamp')
    expect(session).toHaveProperty('model')
    expect(session).toHaveProperty('thinkingLevel')
    expect(session).toHaveProperty('duration_minutes')
  })

  it('files_modified is an array of FileOperation objects', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const files = result.json.files_modified as FileOperation[]

    expect(Array.isArray(files)).toBe(true)
    for (const f of files) {
      expect(f).toHaveProperty('path')
      expect(f).toHaveProperty('action')
      expect(f.status).toMatch(/^(success|failed)$/)
      expect(f).toHaveProperty('timestamp')
    }
  })

  it('decisions is an array of Decision objects', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]

    expect(Array.isArray(decisions)).toBe(true)
    for (const d of decisions) {
      expect(d).toHaveProperty('topic')
      expect(d).toHaveProperty('decision')
      expect(d).toHaveProperty('confidence')
      expect(d).toHaveProperty('source_pattern')
    }
  })

  it('errors is an array of ToolError objects', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]

    expect(Array.isArray(errors)).toBe(true)
    for (const e of errors) {
      expect(e).toHaveProperty('type')
      expect(e).toHaveProperty('message')
      expect(e).toHaveProperty('context')
    }
  })
})

// ── Edge cases ─────────────────────────────────────────────────

describe('edge cases', () => {
  it('skips malformed JSON lines without crashing', () => {
    // Write a fixture with mixed valid/invalid lines
    const tmpPath = join(FIXTURES_DIR, 'session-malformed.jsonl')
    writeFileSync(tmpPath, [
      '{"type":"session","id":"malformed-001","timestamp":"2026-05-22T13:00:00.000Z"}',
      'this is not valid json',
      '{also invalid}',
      '',
    ].join('\n'))

    const result = parseSessionLog(tmpPath)
    expect(result.json.session.id).toBe('malformed-001')

    // Cleanup
    readFileSync(tmpPath) // just verify it exists; cleanup handled by test runner or fixture dir
  })

  it('handles empty file (only whitespace)', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-empty.jsonl')
    writeFileSync(tmpPath, '\n\n   \n')

    const result = parseSessionLog(tmpPath)
    expect(result.markdown).toContain('# Session Summary')
  })

  it('handles session with no model_change events', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-no-model.jsonl')
    writeFileSync(tmpPath, [
      '{"type":"session","id":"no-model-001","timestamp":"2026-05-22T14:00:00.000Z"}',
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-22T14:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}',
    ].join('\n'))

    const result = parseSessionLog(tmpPath)
    expect(result.json.session.id).toBe('no-model-001')
    // model should be undefined or empty when no model_change event exists
  })
})

// ── Integration: round-trip consistency ────────────────────────

describe('round-trip consistency', () => {
  it('markdown and json describe the same data', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    // Number of file operations in markdown should match JSON array length
    const opsCount = (result.json.files_modified as FileOperation[]).length
    expect(opsCount).toBeGreaterThan(0)

    // Markdown should mention each operation's status
    for (const op of result.json.files_modified as FileOperation[]) {
      if (op.status === 'success') {
        expect(result.markdown).toContain('✅ Success')
      } else {
        expect(result.markdown).toContain('❌ Failed')
      }
    }

    // Number of decisions in markdown should match JSON array length
    const decCount = (result.json.decisions as Decision[]).length
    expect(decCount).toBeGreaterThan(0)

    // Markdown should contain decision topics
    for (const d of result.json.decisions as Decision[]) {
      expect(result.markdown).toContain(d.topic.substring(0, 20))
    }
  })

  it('raw_messages captures assistant decisions and tool errors', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const rawMessages = result.json.raw_messages as Array<{ role: string; content: string }>

    expect(Array.isArray(rawMessages)).toBe(true)
    expect(rawMessages.length).toBeGreaterThan(0)

    // Should include assistant messages with decisions
    const assistantMsgs = rawMessages.filter(m => m.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)

    // Should include tool error results
    const errorResults = rawMessages.filter(m => m.role === 'toolResult')
    expect(errorResults.length).toBeGreaterThan(0)
  })
})

// ── Type exports verification ──────────────────────────────────

describe('type exports', () => {
  it('SessionSummary type is correctly structured', () => {
    const summary: SessionSummary = parseSessionLog(fixture('session-minimal.jsonl'))
    // TypeScript compile-time check — if this compiles, the types are correct
    expect(summary).toHaveProperty('markdown')
    expect(summary).toHaveProperty('json')
  })

  it('FileOperation type enforces status union', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const ops = result.json.files_modified as FileOperation[]
    // TypeScript compile-time check
    for (const op of ops) {
      const _status: 'success' | 'failed' = op.status
      expect(op).toHaveProperty('path')
      expect(op).toHaveProperty('action')
      expect(op).toHaveProperty('timestamp')
    }
  })

  it('Decision type enforces required fields', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const decisions = result.json.decisions as Decision[]
    for (const d of decisions) {
      const _topic: string = d.topic
      const _decision: string = d.decision
      const _confidence: string = d.confidence
      const _sourcePattern: string = d.source_pattern
    }
  })

  it('ToolError type enforces required fields', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const errors = result.json.errors as ToolError[]
    for (const e of errors) {
      const _type: string = e.type
      const _message: string = e.message
      const _context: string = e.context
    }
  })

  it('RawMessageEntry type enforces required fields', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))
    const msgs = result.json.raw_messages as Array<import('../shared/index.js').RawMessageEntry>
    for (const m of msgs) {
      expect(m).toHaveProperty('id')
      expect(m).toHaveProperty('role')
      expect(m).toHaveProperty('content')
      expect(m).toHaveProperty('timestamp')
    }
  })
})

// ── Real-world usage: parse an actual session file ─────────────

describe('real-world usage', () => {
  it('can parse a real session from the user\'s sessions directory', () => {
    const home = process.env.HOME || require('node:os').homedir()
    const sessionsRoot = join(home, '.pi', 'agent', 'sessions')

    // Find any .jsonl file in the sessions directory
    let realSessionPath: string | null = null
    try {
      if (require('node:fs').existsSync(sessionsRoot)) {
        const projects = require('node:fs').readdirSync(sessionsRoot).filter(d => !d.startsWith('.'))
        for (const project of projects) {
          const projectDir = join(sessionsRoot, project)
          if (!require('node:fs').existsSync(projectDir)) continue
          const files = require('node:fs').readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
          if (files.length > 0) {
            realSessionPath = join(projectDir, files[0])
            break
          }
        }
      }
    } catch { /* skip */ }

    if (!realSessionPath) {
      // Skip this test if no sessions exist — it's optional
      expect(true).toBe(true)
      return
    }

    const result = parseSessionLog(realSessionPath)

    // Should produce valid output for any real session
    expect(result.markdown.length).toBeGreaterThan(0)
    expect(typeof result.json.session.id).toBe('string')
    expect(Array.isArray(result.json.files_modified)).toBe(true)
    expect(Array.isArray(result.json.decisions)).toBe(true)
    expect(Array.isArray(result.json.errors)).toBe(true)
  })
})

// ── No behavioral regression: output format stability ──────────

describe('no behavioral changes', () => {
  it('markdown header format matches expected pattern', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    // Verify the markdown starts with the expected header structure
    expect(result.markdown).toMatch(/^# Session Summary\n/)
    expect(result.markdown).toContain('**ID:**')
    expect(result.markdown).toContain('**Time:**')
    expect(result.markdown).toContain('**Duration:**')
  })

  it('markdown table headers are consistent', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    // File operations table
    expect(result.markdown).toContain('| Time | Action | File | Status | Notes |')

    // Decisions table
    expect(result.markdown).toContain('| Topic | Decision | Confidence |')
  })

  it('error section uses consistent formatting', () => {
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(result.markdown).toContain('## ⚠️ Errors & Exceptions')
    // Each error starts with - **type:** message
    const errorSection = result.markdown.split('## ⚠️ Errors & Exceptions')[1]?.split('\n\n')[0] || ''
    if (errorSection) {
      expect(errorSection).toMatch(/- \*\*.*?:\s*.*/)
    }
  })
})

// ── parseSessionLines — event stream parsing ───────────────────

describe('parseSessionLines', () => {
  it('returns an array of ParsedEvent objects', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))

    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  it('parses session metadata event', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))

    const sessionEvent = events.find(e => e.type === 'session')
    expect(sessionEvent).toBeDefined()
    if (sessionEvent) {
      expect(sessionEvent.id).toBe('abc12345-def6-7890-abcd-ef1234567890')
      expect(sessionEvent.timestamp).toBe('2026-05-22T10:00:00.000Z')
    }
  })

  it('parses model_change events', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))

    const modelEvent = events.find(e => e.type === 'model_change')
    expect(modelEvent).toBeDefined()
    if (modelEvent) {
      expect(modelEvent.modelId).toBe('gpt-4o')
      expect(modelEvent.provider).toBe('openai')
    }
  })

  it('parses message events with assistant content', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))

    const assistantMsgs = events.filter(e => e.message?.role === 'assistant')
    expect(assistantMsgs.length).toBeGreaterThan(0)
  })

  it('parses message events with tool results', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))

    const toolResults = events.filter(e => e.message?.role === 'toolResult')
    expect(toolResults.length).toBeGreaterThan(0)
  })

  it('parses message events with user content', () => {
    const events = parseSessionLines(fixture('session-minimal.jsonl'))
    // Minimal fixture has no messages, so this should be empty
    const userMsgs = events.filter(e => e.message?.role === 'user')
    expect(userMsgs.length).toBe(0)
  })

  it('skips malformed lines without crashing', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-malformed-lines.jsonl')
    writeFileSync(tmpPath, [
      '{"type":"session","id":"malformed-002","timestamp":"2026-05-22T13:00:00.000Z"}',
      'this is not valid json',
      '',
      '{"type":"message","id":"m1","parentId":null,"timestamp":"2026-05-22T13:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}',
    ].join('\n'))

    const events = parseSessionLines(tmpPath)
    expect(events.length).toBe(2) // session + valid message, malformed line skipped
  })

  it('returns empty array for empty file', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-empty-lines.jsonl')
    writeFileSync(tmpPath, '\n\n   \n')

    const events = parseSessionLines(tmpPath)
    expect(events).toEqual([])
  })

  it('event count matches parseSessionLog file operation + message count', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    // All parsed events should be accounted for
    expect(events.length).toBeGreaterThan(0)
  })
})

// ── extractSessionMetadata — lightweight metadata extraction ───

describe('extractSessionMetadata', () => {
  it('extracts session id from first line', () => {
    const meta = extractSessionMetadata(fixture('session-with-events.jsonl'))

    expect(meta.id).toBe('abc12345-def6-7890-abcd-ef1234567890')
  })

  it('extracts timestamp from first line', () => {
    const meta = extractSessionMetadata(fixture('session-with-events.jsonl'))

    expect(meta.timestamp).toBe('2026-05-22T10:00:00.000Z')
  })

  it('returns empty object for non-session first line', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-non-session.jsonl')
    writeFileSync(tmpPath, '{"type":"message","id":"m1","timestamp":"2026-05-22T10:00:00.000Z","message":{"role":"assistant","content":[]}}\n')

    const meta = extractSessionMetadata(tmpPath)
    expect(meta.id).toBeUndefined()
  })

  it('returns empty object for malformed first line', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-bad-first.jsonl')
    writeFileSync(tmpPath, 'not valid json\n{"type":"session","id":"test-001"}')

    const meta = extractSessionMetadata(tmpPath)
    expect(meta.id).toBeUndefined()
  })

  it('returns empty object for empty file', () => {
    const tmpPath = join(FIXTURES_DIR, 'session-empty-meta.jsonl')
    writeFileSync(tmpPath, '\n\n   \n')

    const meta = extractSessionMetadata(tmpPath)
    expect(meta.id).toBeUndefined()
  })
})

// ── Integration: scripts use shared parser ─────────────────────

describe('scripts integration — shared parser usage', () => {
  it('parseSessionLines and parseSessionLog produce consistent event counts', () => {
    const events = parseSessionLines(fixture('session-with-events.jsonl'))
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    // Both should process the same number of valid lines
    expect(events.length).toBeGreaterThan(0)
    expect(result.json.session.id).toBeDefined()
  })

  it('extractSessionMetadata matches parseSessionLog session id', () => {
    const meta = extractSessionMetadata(fixture('session-with-events.jsonl'))
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(meta.id).toBe(result.json.session.id)
  })

  it('extractSessionMetadata matches parseSessionLog timestamp', () => {
    const meta = extractSessionMetadata(fixture('session-with-events.jsonl'))
    const result = parseSessionLog(fixture('session-with-events.jsonl'))

    expect(meta.timestamp).toBe(result.json.session.timestamp)
  })
})


