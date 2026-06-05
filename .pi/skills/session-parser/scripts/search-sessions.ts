#!/usr/bin/env tsx
/**
 * Search across session logs for tool calls, file paths, errors, or text.
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/search-sessions.ts <query> [options]
 *
 * Options:
 *   --tool-name      Match against tool call names (e.g., "edit", "bash")
 *   --file-path      Match against file paths in tool arguments
 *   --errors-only    Only show sessions that contain errors
 *   --context N      Show N lines of context around matches (default: 1)
 *   --json           Output structured JSON instead of human-readable text
 *   --source agent|maestro|both  Which session store to scan (default: both)
 *
 * Session stores:
 *   agent    — ~/.pi/agent/sessions/--home-david-projects-pi-pos-v1--/
 *             Flat .jsonl files from direct agent runs.
 *   maestro  — .pi/maestro/sessions/<number>/<flow>/session.jsonl
 *             Nested dirs from multi-agent pipeline runs.
 *
 * Examples:
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts "pricing"
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts edit --tool-name
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts schema.prisma --file-path
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────

const AGENT_SESSION_DIR = '/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--';
const MAESTRO_SESSION_DIR = path.resolve('.pi/maestro/sessions');

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let query: string | undefined;
let matchToolName = false;
let matchFilePath = false;
let errorsOnly = false;
let contextLines = 1;
let jsonOutput = false;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';

const positionalArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--tool-name') {
    matchToolName = true;
  } else if (arg === '--file-path') {
    matchFilePath = true;
  } else if (arg === '--errors-only') {
    errorsOnly = true;
  } else if (arg === '--context' && i + 1 < args.length) {
    contextLines = parseInt(args[++i], 10);
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--source' && i + 1 < args.length) {
    const val = args[++i];
    if (!['agent', 'maestro', 'both'].includes(val)) {
      console.error(`❌ Invalid --source value: ${val}. Must be agent, maestro, or both.`);
      process.exit(1);
    }
    sourceFilter = val as 'agent' | 'maestro' | 'both';
  } else if (!arg.startsWith('-')) {
    positionalArgs.push(arg);
  }
}

if (positionalArgs.length < 1 && !errorsOnly) {
  console.error('❌ Error: Search query is required.');
  console.log('Usage: npx tsx .pi/skills/session-parser/scripts/search-sessions.ts <query> [options]');
  process.exit(1);
}

query = positionalArgs[0] || '';

// ── Discover .jsonl files ──────────────────────────────────────

const jsonlFiles: string[] = [];

if (sourceFilter === 'agent' || sourceFilter === 'both') {
  if (fs.existsSync(AGENT_SESSION_DIR)) {
    const agentFiles = fs.readdirSync(AGENT_SESSION_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(AGENT_SESSION_DIR, f));
    jsonlFiles.push(...agentFiles);
  } else {
    console.warn(`⚠️  Agent session dir not found: ${AGENT_SESSION_DIR}`);
  }
}

if (sourceFilter === 'maestro' || sourceFilter === 'both') {
  if (fs.existsSync(MAESTRO_SESSION_DIR)) {
    const maestroFiles = findJsonlRecursive(MAESTRO_SESSION_DIR);
    jsonlFiles.push(...maestroFiles);
  } else {
    console.warn(`⚠️  Maestro session dir not found: ${MAESTRO_SESSION_DIR}`);
  }
}

if (jsonlFiles.length === 0) {
  console.log('📭 No session files found.');
  process.exit(0);
}

// ── Search each file ───────────────────────────────────────────

interface SearchResult {
  filePath: string;
  source: 'agent' | 'maestro';
  sessionId: string;
  timestamp: string;
  matches: Match[];
}

interface Match {
  lineIndex: number;
  eventType: string;
  matchType: 'tool-name' | 'file-path' | 'error' | 'text';
  snippet: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

const results: SearchResult[] = [];

for (const filePath of jsonlFiles) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());

  // Parse session metadata from first line
  let sessionId = '';
  let timestamp = '';
  try {
    const firstEvent = JSON.parse(lines[0]);
    if (firstEvent.type === 'session') {
      sessionId = firstEvent.id || '';
      timestamp = firstEvent.timestamp || '';
    }
  } catch {
    continue;
  }

  // If errors-only, check for any error tool results first
  if (errorsOnly) {
    const hasErrors = lines.some(line => {
      try {
        const event = JSON.parse(line);
        return event.message?.role === 'toolResult' && event.message?.isError;
      } catch {
        return false;
      }
    });

    if (!hasErrors) continue;
  }

  // Search for matches
  const matches: Match[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let event: any;

    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event.message) continue;

    const msg = event.message;
    let matched = false;
    let matchType: Match['matchType'] = 'text';

    // Check tool calls (assistant messages with content array)
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'toolCall') {
          if (matchToolName && part.name?.toLowerCase().includes(query.toLowerCase())) {
            matched = true;
            matchType = 'tool-name';
            matches.push({
              lineIndex: i,
              eventType: event.type || '',
              matchType,
              snippet: `Tool call: ${part.name}`,
              contextBefore: getContext(lines, i, contextLines),
              contextAfter: getContextAfter(lines, i, contextLines),
            });
          }

          if (matchFilePath) {
            const args = part.arguments || {};
            const argStr = JSON.stringify(args);
            if (argStr.toLowerCase().includes(query.toLowerCase())) {
              matched = true;
              matchType = 'file-path';
              matches.push({
                lineIndex: i,
                eventType: event.type || '',
                matchType,
                snippet: `Tool ${part.name} → path in args`,
                contextBefore: getContext(lines, i, contextLines),
                contextAfter: getContextAfter(lines, i, contextLines),
              });
            }
          }

          if (!matchToolName && !matchFilePath && query) {
            const partStr = JSON.stringify(part);
            if (partStr.toLowerCase().includes(query.toLowerCase())) {
              matched = true;
              matchType = 'text';
              matches.push({
                lineIndex: i,
                eventType: event.type || '',
                matchType,
                snippet: truncate(JSON.stringify(part).substring(0, 200)),
                contextBefore: getContext(lines, i, contextLines),
                contextAfter: getContextAfter(lines, i, contextLines),
              });
            }
          }
        }

        if (part.type === 'text') {
          if (!matchToolName && !matchFilePath && query) {
            if (part.text?.toLowerCase().includes(query.toLowerCase())) {
              matched = true;
              matchType = 'text';
              matches.push({
                lineIndex: i,
                eventType: event.type || '',
                matchType,
                snippet: truncate(part.text.substring(0, 200)),
                contextBefore: getContext(lines, i, contextLines),
                contextAfter: getContextAfter(lines, i, contextLines),
              });
            }
          }
        }
      }
    }

    // Check tool results for errors or text matches
    if (msg.role === 'toolResult') {
      const content = extractToolContentString(msg.content);

      if (errorsOnly && msg.isError) {
        matchType = 'error';
        matches.push({
          lineIndex: i,
          eventType: event.type || '',
          matchType,
          snippet: truncate(content?.substring(0, 200) || '(empty error)'),
          contextBefore: getContext(lines, i, contextLines),
          contextAfter: getContextAfter(lines, i, contextLines),
        });
      }

      if (!matchToolName && !matchFilePath && content && query) {
        if (content.toLowerCase().includes(query.toLowerCase())) {
          matchType = 'text';
          matches.push({
            lineIndex: i,
            eventType: event.type || '',
            matchType,
            snippet: truncate(content.substring(0, 200)),
            contextBefore: getContext(lines, i, contextLines),
            contextAfter: getContextAfter(lines, i, contextLines),
          });
        }
      }
    }

    // Check user messages for text matches
    if (msg.role === 'user' && !matchToolName && !matchFilePath && query) {
      const content = extractTextContent(msg.content);
      if (content?.toLowerCase().includes(query.toLowerCase())) {
        matchType = 'text';
        matches.push({
          lineIndex: i,
          eventType: event.type || '',
          matchType,
          snippet: truncate(content.substring(0, 200)),
          contextBefore: getContext(lines, i, contextLines),
          contextAfter: getContextAfter(lines, i, contextLines),
        });
      }
    }
  }

  if (matches.length > 0) {
    results.push({
      filePath,
      source: filePath.startsWith(MAESTRO_SESSION_DIR) ? 'maestro' : 'agent',
      sessionId,
      timestamp,
      matches
    });
  }
}

// Sort by most matches first
results.sort((a, b) => b.matches.length - a.matches.length);

// ── Output ─────────────────────────────────────────────────────

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

if (results.length === 0) {
  console.log(`📭 No matches found for "${query}" in ${files.length} session(s).`);
  process.exit(0);
}

const sourceLabel = sourceFilter === 'both' ? '(agent + maestro)' : `(${sourceFilter})`;
console.log(`\n🔍 Found ${results.length} session(s) matching "${query}" in ${jsonlFiles.length} files ${sourceLabel}\n`);

for (const result of results) {
  const timeStr = result.timestamp ? new Date(result.timestamp).toLocaleString() : 'unknown';
  const srcIcon = result.source === 'maestro' ? '🎼' : '🤖';
  console.log(`${srcIcon} Session: ${result.sessionId?.substring(0, 8)}... | ${timeStr}`);
  console.log(`   File: ${path.basename(result.filePath)}`);
  console.log(`   Matches: ${result.matches.length}\n`);

  // Show up to 5 matches per session
  const shown = result.matches.slice(0, 5);
  for (const match of shown) {
    const typeLabel = match.matchType === 'tool-name' ? '🔧 tool' :
                      match.matchType === 'file-path' ? '📁 path' :
                      match.matchType === 'error' ? '⚠️ error' : '💬 text';

    console.log(`   ${typeLabel} [line ${match.lineIndex}]`);
    console.log(`     ${match.snippet}`);

    if (match.contextAfter?.length > 0) {
      const ctxLine = match.contextAfter[0];
      // Show a short snippet of the next event type for context
      try {
        const ctxEvent = JSON.parse(ctxLine);
        if (ctxEvent.message?.role === 'toolResult') {
          console.log(`     → result: ${ctxEvent.message.isError ? '❌ error' : '✅ success'}`);
        }
      } catch {}
    }

    console.log();
  }

  if (result.matches.length > 5) {
    console.log(`   ... and ${result.matches.length - 5} more match(es)\n`);
  }

  console.log('-'.repeat(60));
  console.log();
}

console.log(`💡 Parse a session for full details:`);
console.log(`   tsx .pi/skills/session-parser/scripts/parse-session.ts <path>`);

// ── Recursive file discovery ───────────────────────────────────

/** Recursively find all .jsonl files in a directory tree. */
function findJsonlRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...findJsonlRecursive(fullPath));
      } else if (entry.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors on unreadable dirs
  }
  return results;
}

// ── Helpers ────────────────────────────────────────────────────

function getContext(lines: string[], index: number, count: number): string[] {
  const start = Math.max(0, index - count);
  return lines.slice(start, index).map(l => truncate(l));
}

function getContextAfter(lines: string[], index: number, count: number): string[] {
  const end = Math.min(lines.length, index + 1 + count);
  return lines.slice(index + 1, end).map(l => truncate(l));
}

function truncate(s: string, max = 120): string {
  // Remove excessive whitespace and control chars for display
  const cleaned = s.replace(/\n/g, ' ').replace(/\r/g, '').trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.substring(0, max).trimEnd() + '…';
}

function extractToolContentString(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text);
    return texts.length > 0 ? texts.join('\n') : undefined;
  }
  return String(content);
}

function extractTextContent(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  }
  return undefined;
}
