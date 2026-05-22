/**
 * scripts/lib/script-runner.ts — Standardized CLI runner for all scripts.
 *
 * Provides a thin, opinionated entry point that handles:
 *   --json          → Output as JSON (via existing toJson helper)
 *   --help          → Show help text and exit 0
 *   positional path → Target directory/file path (defaults to '.')
 *
 * Each script exports `generateOutput(targetPath, json?, help?)` and calls
 * `runScript()` at the bottom instead of handling CLI boilerplate inline.
 *
 * Usage in a script:
 *   import { runScript } from './lib/script-runner.js'
 *
 *   export function generateOutput(
 *     targetPath: string, json = false, help = false
 *   ): string {
 *     // your logic here
 *   }
 *
 *   // At bottom of file:
 *   if (import.meta.url.includes('my-script.ts')) {
 *     runScript(generateOutput)
 *   }
 */

import { basename } from 'node:path'

// ── Types ────────────────────────────────────────────────────────

/** Output generator function signature for all scripts */
export type GenerateOutputFn = (
  targetPath: string,
  json?: boolean,
  help?: boolean,
) => string

/** Parsed CLI arguments with custom flags support */
export interface ParsedArgs {
  /** Target path (positional argument or default) */
  targetPath: string
  /** --json flag */
  json: boolean
  /** --help flag */
  help: boolean
  /** Raw args for scripts with custom flags */
  rawArgs: string[]
}

/** Options passed to runScript for customization */
export interface ScriptRunnerOptions {
  /** Default path when none provided (default: '.') */
  defaultPath?: string
  /** Exit code on error (default: 1) */
  exitCodeOnError?: number
}

// ── Argument Parsing ─────────────────────────────────────────────

/**
 * Parse CLI arguments into structured options.
 * Handles --json, --help, and positional path argument.
 */
export function parseArgs(
  args: string[],
  options: ScriptRunnerOptions = {}
): ParsedArgs {
  let json = false
  let help = false
  let targetPath: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      json = true
    } else if (arg === '--help') {
      help = true
    } else if (!arg.startsWith('-')) {
      // First non-flag argument is the target path
      if (!targetPath) targetPath = arg
    }
  }

  return {
    json,
    help,
    rawArgs: args,
    targetPath: targetPath ?? options.defaultPath ?? '.',
  }
}

// ── Output Writing ───────────────────────────────────────────────

/**
 * Write output to stdout with proper handling for JSON vs text.
 */
export function writeOutput(output: string): void {
  // Use process.stdout.write for both — avoids trailing newline duplication
  process.stdout.write(output)
}

// ── Main Runner ──────────────────────────────────────────────────

/**
 * Run a script with standardized CLI handling.
 *
 * @param generateOutput - The script's output generator function
 * @param options - Optional runner configuration
 */
export function runScript(
  generateOutput: GenerateOutputFn,
  options: ScriptRunnerOptions = {}
): void {
  const args = process.argv.slice(2)
  const parsed = parseArgs(args, options)

  if (parsed.help) {
    writeOutput(generateOutput(parsed.targetPath, false, true))
    process.exit(0)
  }

  try {
    const output = generateOutput(parsed.targetPath, parsed.json)
    writeOutput(output)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(options.exitCodeOnError ?? 1)
  }
}

// ── Direct Execution Guard ───────────────────────────────────────

/**
 * Check if the current file is being executed directly (not imported by tests).
 * Use this guard to prevent runner execution during test imports.
 */
export function isDirectExecution(scriptName: string): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false

  // Check if the script name appears in the path or matches basename
  const base = basename(argv1)
  return base === scriptName || argv1.includes(scriptName)
}

// ── Convenience: runScriptIfDirect ───────────────────────────────

/**
 * Run a script only when executed directly (not imported by tests).
 * Combines the direct execution guard with runScript.
 */
export function runScriptIfDirect(
  generateOutput: GenerateOutputFn,
  scriptName: string,
  options: ScriptRunnerOptions = {}
): void {
  if (!isDirectExecution(scriptName)) return
  runScript(generateOutput, options)
}

// ── Custom Flag Runner ───────────────────────────────────────────

/** Output generator that receives parsed args with custom flags */
export type GenerateOutputWithArgsFn = (args: ParsedArgs) => string

/** Options for runScriptWithCustomFlags */
export interface ScriptRunnerWithFlagsOptions extends ScriptRunnerOptions {
  /** Custom flag parser function. Returns additional options object. */
  parseCustomFlags?: (rawArgs: string[]) => Record<string, unknown>
}

/**
 * Run a script with custom CLI flags support.
 * Scripts can define their own flag parsing logic while still using the runner for:
 *   - --json / --help handling
 *   - positional path resolution
 *   - output writing
 *   - error handling
 */
export function runScriptWithCustomFlags(
  generateOutput: GenerateOutputWithArgsFn,
  scriptName: string,
  options: ScriptRunnerWithFlagsOptions = {}
): void {
  if (!isDirectExecution(scriptName)) return

  const args = process.argv.slice(2)
  const parsed = parseArgs(args, options)

  // Parse custom flags if provided
  const customFlags = options.parseCustomFlags?.(parsed.rawArgs) ?? {}

  if (parsed.help) {
    writeOutput(generateOutput({ ...parsed, rawArgs: [...parsed.rawArgs] }))
    process.exit(0)
  }

  try {
    const output = generateOutput({ ...parsed, rawArgs: [...parsed.rawArgs], ...customFlags })
    writeOutput(output)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(options.exitCodeOnError ?? 1)
  }
}
