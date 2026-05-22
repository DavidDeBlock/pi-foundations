import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  parseAndRoute,
  runCli,
  type DataFn,
  type CliRunnerOptions,
  type ParsedArgs,
} from './cli-runner.js'

// ── Helpers ────────────────────────────────────────────────────────

/** Create a mock DataFn that returns structured output */
function createMockDataFn(
  result: { markdown: string; json?: unknown },
  shouldThrow?: boolean
): DataFn {
  return (dirPath: string) => {
    if (shouldThrow) throw new Error('Test error from data function')
    return result
  }
}

/** Create a mock DataFn that returns plain text */
function createMockTextDataFn(text: string, shouldThrow?: boolean): DataFn {
  return (_dirPath: string) => {
    if (shouldThrow) throw new Error('Test error from data function')
    return text
  }
}

// ── parseAndRoute Tests ────────────────────────────────────────────

describe('parseAndRoute — Argument parsing (no dataFn)', () => {
  it('parses --json flag and returns json: true', () => {
    const result = parseAndRoute(['--json']) as ParsedArgs
    expect(result).toEqual({ dirPath: '.', json: true, help: false })
  })

  it('parses --help flag and returns help: true', () => {
    const result = parseAndRoute(['--help']) as ParsedArgs
    expect(result).toEqual({ dirPath: '.', json: false, help: true })
  })

  it('parses both --json and --help flags', () => {
    const result = parseAndRoute(['--json', '--help']) as ParsedArgs
    expect(result).toEqual({ dirPath: '.', json: true, help: true })
  })

  it('extracts positional path argument', () => {
    const result = parseAndRoute(['/some/path/to/dir']) as ParsedArgs
    expect(result).toEqual({ dirPath: '/some/path/to/dir', json: false, help: false })
  })

  it('combines flags with positional path', () => {
    const result = parseAndRoute(['--json', '/custom/path']) as ParsedArgs
    expect(result).toEqual({ dirPath: '/custom/path', json: true, help: false })
  })

  it('handles --help before positional path', () => {
    const result = parseAndRoute(['--help', '/some/path']) as ParsedArgs
    expect(result).toEqual({ dirPath: '/some/path', json: false, help: true })
  })

  it('uses defaultPath when no positional argument provided', () => {
    const result = parseAndRoute([], 'docs') as ParsedArgs
    expect(result).toEqual({ dirPath: 'docs', json: false, help: false })
  })

  it('ignores unknown flags (passes them through silently)', () => {
    // Unknown flags are ignored — only --json and --help are recognized
    const result = parseAndRoute(['--unknown-flag']) as ParsedArgs
    expect(result).toEqual({ dirPath: '.', json: false, help: false })
  })

  it('handles empty args array with no default', () => {
    const result = parseAndRoute([]) as ParsedArgs
    expect(result.dirPath).toBe('.')
  })

  it('takes first non-flag argument as path (ignores subsequent)', () => {
    const result = parseAndRoute(['--json', '/first/path', '/second/path']) as ParsedArgs
    expect(result.dirPath).toBe('/first/path')
  })
})

// ── Output Routing Tests ───────────────────────────────────────────

describe('parseAndRoute — Output routing (structured DataFn)', () => {
  it('routes structured output to JSON when json flag is true', () => {
    const dataFn = createMockDataFn({ markdown: '# Hello', json: { key: 'value' } })
    const result = parseAndRoute(['--json'], '.', dataFn)
    expect(result).toBe('{\n  "key": "value"\n}')
  })

  it('routes structured output to Markdown when json flag is false', () => {
    const dataFn = createMockDataFn({ markdown: '# Hello World\n\nSome content' })
    const result = parseAndRoute([], '.', dataFn)
    expect(result).toBe('# Hello World\n\nSome content')
  })

  it('routes plain string output regardless of json flag', () => {
    const dataFn = createMockTextDataFn('plain text output')
    // Even with --json, plain strings are printed as-is (no JSON wrapping)
    const resultJson = parseAndRoute(['--json'], '.', dataFn)
    expect(resultJson).toBe('plain text output')

    const resultPlain = parseAndRoute([], '.', dataFn)
    expect(resultPlain).toBe('plain text output')
  })

  it('handles structured output with json field but no markdown', () => {
    const dataFn = createMockDataFn({ markdown: '', json: { items: [1, 2, 3] } })
    const result = parseAndRoute(['--json'], '.', dataFn)
    expect(result).toBe('{\n  "items": [\n    1,\n    2,\n    3\n  ]\n}')
  })

  it('handles structured output with only markdown (no json field)', () => {
    const dataFn = createMockDataFn({ markdown: '## Report' })
    const result = parseAndRoute(['--json'], '.', dataFn)
    // When json is requested but no json field exists, falls back to markdown
    expect(result).toBe('## Report')
  })
})

// ── Error Handling Tests ───────────────────────────────────────────

describe('parseAndRoute — Error handling', () => {
  it('wraps data function errors with context message', () => {
    const dataFn = createMockDataFn({ markdown: '' }, true)
    expect(() => parseAndRoute([], '.', dataFn)).toThrow('Error running script: Test error from data function')
  })

  it('handles non-Error exceptions (strings)', () => {
    const badDataFn: DataFn = (_dirPath: string) => { throw 'string error' }
    expect(() => parseAndRoute([], '.', badDataFn)).toThrow('Error running script: string error')
  })

  it('handles non-Error exceptions (numbers)', () => {
    const badDataFn: DataFn = (_dirPath: string) => { throw 42 as unknown as Error }
    expect(() => parseAndRoute([], '.', badDataFn)).toThrow('Error running script: 42')
  })

  it('handles null exceptions', () => {
    const badDataFn: DataFn = (_dirPath: string) => { throw null as unknown as Error }
    expect(() => parseAndRoute([], '.', badDataFn)).toThrow('Error running script: null')
  })
})

// ── runCli Integration Tests ───────────────────────────────────────

describe('runCli — Full CLI integration', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Reset argv to simulate direct execution (script.ts matches isDirectExecution check)
    process.argv = ['node', '/path/to/script.ts']
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints help text and exits with code 0 when --help is passed', () => {
    const options: CliRunnerOptions = {
      defaultPath: '.',
      helpText: 'Usage: my-script [path]',
    }

    // Set argv to include --help flag
    process.argv = ['node', '/path/to/script.ts', '--help']

    let exitCode: number | undefined
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code
      throw new Error('process.exit called')
    })

    expect(() => runCli(createMockDataFn({ markdown: '' }), 'script.ts', options)).toThrow('process.exit called')

    // Help should have been written to stdout
    const callArgs = (stdoutSpy.mock.calls[0] as any[])?.[0]
    expect(callArgs).toContain('Usage: my-script [path]')

    // Exit code 0 for help
    expect(exitCode).toBe(0)
  })

  it('executes data function and prints markdown output by default', () => {
    const options: CliRunnerOptions = { defaultPath: '.' }
    runCli(createMockDataFn({ markdown: '# Hello' }), 'script.ts', options)

    expect(stdoutSpy).toHaveBeenCalledWith('# Hello')
  })

  it('executes data function and prints JSON output when --json flag is used', () => {
    const options: CliRunnerOptions = { defaultPath: '.' }
    process.argv = ['node', '/path/to/script.ts', '--json']

    runCli(createMockDataFn({ markdown: '# Hello', json: { status: 'ok' } }), 'script.ts', options)

    expect(stdoutSpy).toHaveBeenCalledWith('{\n  "status": "ok"\n}')
  })

  it('passes dirPath to data function from positional argument', () => {
    const tmpDir = createTempDir()
    try {
      const mockFn = vi.fn().mockReturnValue({ markdown: '# Result' })
      process.argv = ['node', '/path/to/script.ts', tmpDir]

      runCli(mockFn, 'script.ts', { defaultPath: '.' })

      expect(mockFn).toHaveBeenCalledWith(tmpDir)
    } finally {
      cleanup(tmpDir)
    }
  })

  it('passes dirPath to data function from default path when no positional arg', () => {
    const tmpDir = createTempDir()
    try {
      const mockFn = vi.fn().mockReturnValue({ markdown: '# Result' })

      runCli(mockFn, 'script.ts', { defaultPath: tmpDir })

      expect(mockFn).toHaveBeenCalledWith(tmpDir)
    } finally {
      cleanup(tmpDir)
    }
  })

  it('wraps errors and exits with code 1', () => {
    const options: CliRunnerOptions = { defaultPath: '.' }

    let exitCode: number | undefined
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code
      throw new Error('process.exit called')
    })

    expect(() => runCli(createMockDataFn({ markdown: '' }, true), 'script.ts', options)).toThrow('process.exit called')

    // Error should have been written to stderr
    const errorCall = (stderrSpy.mock.calls[0] as any[])?.[0]
    expect(errorCall).toContain('Error running script:')
    expect(errorCall).toContain('Test error from data function')

    // Exit code 1 for errors
    expect(exitCode).toBe(1)
  })

  it('does not execute when imported (direct execution guard)', () => {
    const mockFn = vi.fn().mockReturnValue({ markdown: '' })

    // Simulate being imported by setting argv[1] to a different script name.
    // Use basename comparison — 'other-script.ts' !== 'script.ts'
    process.argv = ['node', '/path/to/other-script.ts']

    runCli(mockFn, 'script.ts', {})

    expect(mockFn).not.toHaveBeenCalled()
  })

  it('does not execute when script name matches (direct execution guard)', () => {
    const mockFn = vi.fn().mockReturnValue({ markdown: '' })

    // Simulate direct execution with matching script name in argv[1]
    process.argv = ['node', '/path/to/script.ts']

    runCli(mockFn, 'script.ts', {})

    expect(mockFn).toHaveBeenCalled()
  })
})

// ── Path Validation Tests ──────────────────────────────────────────

/** Create a temp directory for real filesystem tests */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-runner-test-'))
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

describe('parseAndRoute — Path validation', () => {
  it('rejects non-existent paths with error to stderr and exit(1)', () => {
    const dataFn = createMockDataFn({ markdown: '' })

    let exitCode: number | undefined
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code
      throw new Error('process.exit called')
    })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    expect(() => parseAndRoute(['/nonexistent/path'], '.', dataFn)).toThrow(
      'process.exit called'
    )

    expect(exitCode).toBe(1)
    const errorCall = (stderrSpy.mock.calls[0] as any[])?.[0]
    expect(errorCall).toContain('/nonexistent/path')
    expect(errorCall).toContain('does not exist')
  })

  it('rejects file paths with "is not a directory" error and exit(1)', () => {
    const dataFn = createMockDataFn({ markdown: '' })

    // Create a real temp file
    const tmpDir = createTempDir()
    try {
      const filePath = path.join(tmpDir, 'somefile.txt')
      fs.writeFileSync(filePath, 'test content')

      let exitCode: number | undefined
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        exitCode = code
        throw new Error('process.exit called')
      })

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      expect(() => parseAndRoute([filePath], '.', dataFn)).toThrow(
        'process.exit called'
      )

      expect(exitCode).toBe(1)
      const errorCall = (stderrSpy.mock.calls[0] as any[])?.[0]
      expect(errorCall).toContain(filePath)
      expect(errorCall).toContain('is not a directory')
    } finally {
      cleanup(tmpDir)
    }
  })

  it('passes valid directories through to dataFn normally', () => {
    const tmpDir = createTempDir()
    try {
      const mockFn = vi.fn().mockReturnValue({ markdown: '# Result' })

      parseAndRoute([tmpDir], '.', mockFn)

      expect(mockFn).toHaveBeenCalledWith(tmpDir)
    } finally {
      cleanup(tmpDir)
    }
  })

  it('skips path validation when no dataFn is provided (pure arg parsing)', () => {
    // Without dataFn, parseAndRoute returns ParsedArgs — no filesystem access needed
    const result = parseAndRoute(['/nonexistent/path']) as ParsedArgs
    expect(result.dirPath).toBe('/nonexistent/path')
  })
})

// ── runCli Path Validation Integration Tests ─────────────────────────

describe('runCli — Path validation integration', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.argv = ['node', '/path/to/script.ts']
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes validation error to stderr and exits with code 1 for non-existent path', () => {
    let exitCode: number | undefined
    vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
      exitCode = code
      throw new Error('process.exit called')
    })

    process.argv = ['node', '/path/to/script.ts', '/nonexistent/path']
    const options: CliRunnerOptions = { defaultPath: '.' }

    expect(() => runCli(createMockDataFn({ markdown: '' }), 'script.ts', options)).toThrow(
      'process.exit called'
    )

    expect(exitCode).toBe(1)
    const errorCall = (stderrSpy.mock.calls[0] as any[])?.[0]
    expect(errorCall).toContain('/nonexistent/path')
    expect(errorCall).toContain('does not exist')
  })

  it('passes valid directory through runCli without errors', () => {
    const tmpDir = createTempDir()
    try {
      process.argv = ['node', '/path/to/script.ts', tmpDir]
      const options: CliRunnerOptions = { defaultPath: '.' }

      runCli(createMockDataFn({ markdown: '# Hello' }), 'script.ts', options)

      expect(stdoutSpy).toHaveBeenCalledWith('# Hello')
    } finally {
      cleanup(tmpDir)
    }
  })
})

// ── Type Exports Tests ─────────────────────────────────────────────

describe('Type exports', () => {
  it('exports DataFn type (compile-time check)', () => {
    // This is a compile-time test — if the types aren't exported, this won't compile.
    const fn: DataFn = (_dirPath) => ({ markdown: 'test' })
    expect(typeof fn).toBe('function')
  })

  it('exports CliRunnerOptions interface (compile-time check)', () => {
    // Compile-time test — if the type isn't exported, this won't compile.
    const opts: CliRunnerOptions = { helpText: 'test', defaultPath: '.' }
    expect(opts.helpText).toBe('test')
  })

  it('exports runCli function', () => {
    expect(typeof runCli).toBe('function')
  })

  it('exports parseAndRoute function', () => {
    expect(typeof parseAndRoute).toBe('function')
  })
})
