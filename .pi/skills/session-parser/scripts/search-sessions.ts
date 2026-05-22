#!/usr/bin/env tsx
/**
 * Search across session logs for tool calls, file paths, errors, or text.
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/search-sessions.ts <query> [options] [session-dir]
 *
 * Options:
 *   --tool-name      Match against tool call names (e.g., "edit", "bash")
 *   --file-path      Match against file paths in tool arguments
 *   --errors-only    Only show sessions that contain errors
 *   --context N      Show N lines of context around matches (default: 1)
 *   --json           Output structured JSON instead of human-readable text
 *
 * Examples:
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts "pricing"
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts edit --tool-name
 *   tsx .pi/skills/session-parser/scripts/search-sessions.ts schema.prisma --file-path
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSessionLines, extractSessionMetadata } from '../../../../shared/index.js';

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let query: string | undefined;
let matchToolName = false;
let matchFilePath = false;
let errorsOnly = false;
let contextLines = 1;
let jsonOutput = false;
let sessionDir: string;

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

// Resolve session directory dynamically
if (positionalArgs.length > 1) {
  sessionDir = path.resolve(positionalArgs[1]);
} else {
  const home = process.env.HOME || os.homedir();
  const sessionsRoot = path.join(home, '.pi', 'agent', 'sessions');
  const cwdProjectSlug = '--' + process.cwd().replace(/\/+/g, '-') + '--';
  const candidatePath = path.join(sessionsRoot, cwdProjectSlug);

  if (fs.existsSync(candidatePath)) {
    sessionDir = candidatePath;
  } else {
    console.error('⚠️ No session directory found for current project.');
    console.error('   Specify a path as the last argument, or use one of these:');
    if (fs.existsSync(sessionsRoot)) {
      const dirs = fs.readdirSync(sessionsRoot)
        .filter(d => !d.startsWith('.'))
        .sort()
        .slice(0, 10);
      for (const d of dirs) console.error(`     ${path.join(sessionsRoot, d)}`);
    }
    process.exit(1);
  }
}

// ── Read directory ─────────────────────────────────────────────

if (!fs.existsSync(sessionDir)) {
  console.error(`❌ Session directory not found: ${sessionDir}`);
  process.exit(1);
}

const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

if (files.length === 0) {
  console.log('📭 No session files found.');
  process.exit(0);
}

// ── Search each file ───────────────────────────────────────────

interface SearchResult {
  filePath: string;
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

for (const file of files) {
  const filePath = path.join(sessionDir, file);

  // Extract session metadata using shared parser
  const meta = extractSessionMetadata(filePath);
  if (!meta.id) continue;

  const sessionId = meta.id || '';
  const timestamp = meta.timestamp || '';

  // Parse all events using shared parser (no inline JSONL parsing)
  const events = parseSessionLines(filePath);

  // If errors-only, check for any error tool results first
  if (errorsOnly) {
    const hasErrors = events.some(e => e.message?.role === 'toolResult' && e.message?.isError);
    if (!hasErrors) continue;
  }

  // Search for matches across parsed events
  const matches: Match[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
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
              contextBefore: getContext(events, i, contextLines),
              contextAfter: getContextAfter(events, i, contextLines),
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
                contextBefore: getContext(events, i, contextLines),
                contextAfter: getContextAfter(events, i, contextLines),
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
                contextBefore: getContext(events, i, contextLines),
                contextAfter: getContextAfter(events, i, contextLines),
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
                contextBefore: getContext(events, i, contextLines),
                contextAfter: getContextAfter(events, i, contextLines),
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
          contextBefore: getContext(events, i, contextLines),
          contextAfter: getContextAfter(events, i, contextLines),
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
            contextBefore: getContext(events, i, contextLines),
            contextAfter: getContextAfter(events, i, contextLines),
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
          contextBefore: getContext(events, i, contextLines),
          contextAfter: getContextAfter(events, i, contextLines),
        });
      }
    }
  }

  if (matches.length > 0) {
    results.push({ filePath, sessionId, timestamp, matches });
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

console.log(`\n🔍 Found ${results.length} session(s) matching "${query}" (${files.length} total)\n`);

for (const result of results) {
  const timeStr = result.timestamp ? new Date(result.timestamp).toLocaleString() : 'unknown';
  console.log(`📁 Session: ${result.sessionId?.substring(0, 8)}... | ${timeStr}`);
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

    // Context lines are already truncated strings from truncateEvent()
    if (match.contextAfter?.length > 0) {
      const ctxLine = match.contextAfter[0];
      // Show result status indicator if the context line mentions it
      if (ctxLine.includes('success')) {
        console.log(`     → ✅ success`);
      } else if (ctxLine.includes('error') || ctxLine.includes('Error')) {
        console.log(`     → ❌ error`);
      }
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

// ── Helpers ────────────────────────────────────────────────────

function getContext(events: import('../../../../shared/index.js').ParsedEvent[], index: number, count: number): string[] {
  const start = Math.max(0, index - count);
  return events.slice(start, index).map(e => truncateEvent(e));
}

function getContextAfter(events: import('../../../../shared/index.js').ParsedEvent[], index: number, count: number): string[] {
  const end = Math.min(events.length, index + 1 + count);
  return events.slice(index + 1, end).map(e => truncateEvent(e));
}

function truncateEvent(event: import('../../../../shared/index.js').ParsedEvent): string {
  if (event.message?.role === 'assistant') {
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          return truncate(part.text.substring(0, 120));
        }
        if (part.type === 'toolCall') {
          return `Tool: ${part.name}`;
        }
      }
    }
  }
  if (event.message?.role === 'toolResult') {
    const content = extractToolContentString(event.message.content);
    return truncate(content || '(empty result)');
  }
  if (event.message?.role === 'user') {
    const content = extractTextContent(event.message.content);
    return truncate(content || '(empty message)');
  }
  return `[${event.type}]`;
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
