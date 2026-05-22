/**
 * _lib/cli-runner.ts — Deep CLI orchestration layer for all scripts.
 *
 * Owns all CLI plumbing so scripts only implement pure domain functions (`DataFn`).
 * Handles argument parsing, path resolution, help display, output routing, error wrapping,
 * and direct-execution guards in one place.
 *
 * Usage in a script:
 *   import { runCli } from '../_lib/cli-runner.js'
 *
 *   export function myDataFn(dirPath: string): { markdown: string; json?: unknown } | string {
 *     // your domain logic here
 *   }
 *
 *   runCli(myDataFn, 'my-script.ts', { helpText: '...', defaultPath: '.' })
 */

import { basename } from 'node:path'
import { existsSync, statSync } from 'node:fs'

// ── Types ────────────────────────────────────────────────────────

/**
 * Pure domain function that takes a directory path and returns output.
 * Returns either structured data (markdown + optional JSON) or plain text.
 */
export type DataFn = (dirPath: string) => { markdown: string; json?: unknown } | string

/** Options for configuring the CLI runner */
export interface CliRunnerOptions {
  /** Help text to display when --help is passed */
  helpText?: string
  /** Default directory path when none provided as positional argument */
  defaultPath?: string
}

// ── Argument Parsing & Routing ───────────────────────────────────

/** Parsed CLI arguments — exported for test type assertions */
export interface ParsedArgs {
  dirPath: string
  json: boolean
  help: boolean
}

/**
 * Parse CLI arguments and route to the appropriate output format.
 * Exported for independent unit testing without file system or subprocess overhead.
 *
 * When called with a dataFn, executes it and returns formatted output.
 * When called without a dataFn, returns parsed args for inspection.
 *
 * @param args - Command-line arguments (process.argv.slice(2))
 * @param defaultPath - Default path when no positional argument is provided
 * @param dataFn - Optional domain function to execute
 * @returns Formatted output string when dataFn provided, or ParsedArgs for inspection
 */
export function parseAndRoute(
  args: string[],
  defaultPath?: string,
  dataFn?: DataFn
): string | ParsedArgs {
  // ── Parse flags and positional path ────────────────────────────
  let json = false
  let help = false
  let dirPath: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      json = true
    } else if (arg === '--help') {
      help = true
    } else if (!arg.startsWith('-')) {
      // First non-flag argument is the target path
      if (dirPath === undefined) dirPath = arg
    }
  }

  const parsed: ParsedArgs = {
    json,
    help,
    dirPath: dirPath ?? defaultPath ?? '.',
  }

  // ── If no dataFn, return parsed args for inspection (unit testing) ─
  if (!dataFn) {
    return parsed
  }

  // ── Help routing ───────────────────────────────────────────────
  if (parsed.help) {
    return '' // Caller handles printing and exiting
  }

  // ── Path validation ────────────────────────────────────────────
  const targetDir = parsed.dirPath
  if (!existsSync(targetDir)) {
    process.stderr.write(`Error: ${targetDir} does not exist\n`)
    process.exit(1)
  }
  const stats = statSync(targetDir)
  if (!stats.isDirectory()) {
    process.stderr.write(`Error: ${targetDir} is not a directory\n`)
    process.exit(1)
  }

  // ── Execute data function & route output ───────────────────────
  try {
    const result = dataFn(parsed.dirPath)

    // Handle structured vs plain-text return types
    if (typeof result === 'string') {
      // Plain text — always print as-is regardless of --json flag
      return result
    }

    // Structured: { markdown: string; json?: unknown }
    if (parsed.json && result.json !== undefined) {
      return JSON.stringify(result.json, null, 2)
    }

    // Default to markdown output
    return result.markdown
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Error running script: ${message}`)
  }
}

// ── Main Runner ──────────────────────────────────────────────────

/**
 * Run a script with full CLI orchestration.
 * Handles help display, argument parsing, output routing, error handling, and exit codes.
 *
 * @param dataFn - The domain function to execute
 * @param scriptName - Script filename for direct-execution guard (e.g., 'my-script.ts')
 * @param options - Optional configuration (helpText, defaultPath)
 */
export function runCli(
  dataFn: DataFn,
  scriptName: string,
  options?: CliRunnerOptions
): void {
  // ── Direct execution guard ───────────────────────────────────
  if (!isDirectExecution(scriptName)) return

  const args = process.argv.slice(2)

  // ── Help display & early exit ────────────────────────────────
  const hasHelpFlag = args.some(arg => arg === '--help')
  if (hasHelpFlag && options?.helpText) {
    process.stdout.write(options.helpText + '\n')
    process.exit(0)
  }

  // ── Execute & route output ───────────────────────────────────
  try {
    const result = parseAndRoute(args, options?.defaultPath, dataFn)
    // When called with dataFn, parseAndRoute always returns a string
    // (help case is handled above; error case throws)
    if (typeof result === 'string') {
      process.stdout.write(result)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error running script: ${message}\n`)
    process.exit(1)
  }
}

// ── Direct Execution Guard ───────────────────────────────────────

/**
 * Check if the current file is being executed directly (not imported by tests).
 *
 * Handles two invocation patterns:
 *   - Explicit: `tsx scripts/index.ts` → argv[1] = "/path/to/scripts/index.ts"
 *   - Directory: `tsx scripts/` → argv[1] = "/path/to/scripts" (resolved to index file)
 */
function isDirectExecution(scriptName: string): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false

  // Case 1: Direct match on basename (e.g., "tsx scripts/index.ts")
  const base = basename(argv1)
  if (base === scriptName) return true

  // Case 2: Directory invocation — argv[1] is a directory path that Node
  // resolved to an index file. Check if the path exists as a directory and
  // the script name matches a common index filename.
  try {
    const stat = statSync(argv1)
    if (stat.isDirectory()) {
      const indexNames = ['index.ts', 'index.js', 'index.mjs']
      return indexNames.includes(scriptName)
    }
  } catch {
    // Path doesn't exist — not a directory invocation
  }

  return false
}
