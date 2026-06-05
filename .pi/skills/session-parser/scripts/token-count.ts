#!/usr/bin/env tsx
/**
 * Estimate token usage across all session logs.
 *
 * Session JSONL files do not store API-level token counts, so this script
 * estimates tokens from message content using the standard ~4 chars ≈ 1 token
 * approximation (reasonable for English + TypeScript mixed content).
 *
 * Usage:
 *   tsx .pi/skills/session-parser/scripts/token-count.ts [options]
 *
 * Options:
 *   --last N       Analyze only the last N sessions (default: all)
 *   --source agent|maestro|both  Which session store to scan (default: both)
 *   --json         Output structured JSON instead of human-readable table
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────

const AGENT_SESSIONS_ROOT = '/home/david/.pi/agent/sessions'; // all project dirs
const MAESTRO_SESSION_DIR = path.resolve('.pi/maestro/sessions');
const CHARS_PER_TOKEN = 4; // rough approximation for English + code

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let lastN: number | undefined;
let jsonOutput = false;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--last' && i + 1 < args.length) {
    lastN = parseInt(args[++i], 10);
  } else if (arg === '--json') {
    jsonOutput = true;
  } else if (arg === '--source' && i + 1 < args.length) {
    const val = args[++i];
    if (!['agent', 'maestro', 'both'].includes(val)) {
      console.error(`❌ Invalid --source value: ${val}. Must be agent, maestro, or both.`);
      process.exit(1);
    }
    sourceFilter = val as 'agent' | 'maestro' | 'both';
  }
}

// ── Helpers ────────────────────────────────────────────────────

function findJsonlRecursive(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } =>
        typeof block === 'object' && block !== null && block.type === 'text',
      )
      .map((b) => b.text || '')
      .join('');
  }
  return '';
}

interface SessionResult {
  source: 'agent' | 'maestro';
  filePath: string;
  timestamp: string;
  sessionId: string;
  totalMessages: number;
  userChars: number;
  assistantChars: number;
  toolChars: number;
  otherChars: number;
  totalChars: number;
  estimatedTokens: number;
}

function parseSession(filePath: string, source: 'agent' | 'maestro'): SessionResult {
  let timestamp = '';
  let sessionId = '';
  let userChars = 0;
  let assistantChars = 0;
  let toolChars = 0;
  let otherChars = 0;
  let totalMessages = 0;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const obj: Record<string, unknown> = JSON.parse(line);

    // Capture session metadata from first line
    if (obj.type === 'session') {
      timestamp = (obj.timestamp as string) || '';
      sessionId = (obj.id as string) || '';
      continue;
    }

    if (obj.type !== 'message') continue;
    totalMessages++;

    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const text = extractText(msg.content);
    const chars = text.length;
    const role = (msg.role as string) || '';

    switch (role) {
      case 'user':
        userChars += chars;
        break;
      case 'assistant':
        assistantChars += chars;
        break;
      case 'tool':
      case 'system':
        toolChars += chars;
        break;
      default:
        otherChars += chars;
    }
  }

  const totalChars = userChars + assistantChars + toolChars + otherChars;

  return {
    source,
    filePath,
    timestamp,
    sessionId,
    totalMessages,
    userChars,
    assistantChars,
    toolChars,
    otherChars,
    totalChars,
    estimatedTokens: Math.round(totalChars / CHARS_PER_TOKEN),
  };
}

// ── Discover sessions ──────────────────────────────────────────

const agentFiles: string[] = [];
const maestroFiles: string[] = [];

if (sourceFilter === 'agent' || sourceFilter === 'both') {
  if (fs.existsSync(AGENT_SESSIONS_ROOT)) {
    agentFiles.push(...findJsonlRecursive(AGENT_SESSIONS_ROOT));
  } else {
    console.warn(`⚠️  Agent sessions root not found: ${AGENT_SESSIONS_ROOT}`);
  }
}

if (sourceFilter === 'maestro' || sourceFilter === 'both') {
  if (fs.existsSync(MAESTRO_SESSION_DIR)) {
    maestroFiles.push(...findJsonlRecursive(MAESTRO_SESSION_DIR));
  } else {
    console.warn(`⚠️  Maestro session dir not found: ${MAESTRO_SESSION_DIR}`);
  }
}

// Sort newest-first by filename (timestamps are in the name)
agentFiles.sort().reverse();
maestroFiles.sort().reverse();

// Apply --last filter per source before merging
const filteredAgent = lastN ? agentFiles.slice(0, lastN) : agentFiles;
const filteredMaestro = lastN ? maestroFiles.slice(0, lastN) : maestroFiles;

// ── Parse all sessions ────────────────────────────────────────

const results: SessionResult[] = [];

for (const fp of filteredAgent) {
  try {
    results.push(parseSession(fp, 'agent'));
  } catch (err) {
    console.error(`❌ Failed to parse agent session: ${fp}`);
    console.error(String(err));
  }
}

for (const fp of filteredMaestro) {
  try {
    results.push(parseSession(fp, 'maestro'));
  } catch (err) {
    console.error(`❌ Failed to parse maestro session: ${fp}`);
    console.error(String(err));
  }
}

// Sort by timestamp descending
results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

// ── Output ─────────────────────────────────────────────────────

if (jsonOutput) {
  const totals = results.reduce(
    (acc, r) => ({
      sessions: acc.sessions + 1,
      messages: acc.messages + r.totalMessages,
      userTokens: acc.userTokens + Math.round(r.userChars / CHARS_PER_TOKEN),
      assistantTokens: acc.assistantTokens + Math.round(r.assistantChars / CHARS_PER_TOKEN),
      toolTokens: acc.toolTokens + Math.round(r.toolChars / CHARS_PER_TOKEN),
      otherTokens: acc.otherTokens + Math.round(r.otherChars / CHARS_PER_TOKEN),
      totalTokens: acc.totalTokens + r.estimatedTokens,
      agentSessions: acc.agentSessions + (r.source === 'agent' ? 1 : 0),
      maestroSessions: acc.maestroSessions + (r.source === 'maestro' ? 1 : 0),
    }),
    {
      sessions: 0,
      messages: 0,
      userTokens: 0,
      assistantTokens: 0,
      toolTokens: 0,
      otherTokens: 0,
      totalTokens: 0,
      agentSessions: 0,
      maestroSessions: 0,
    },
  );

  console.log(JSON.stringify({ totals, sessions: results }, null, 2));
} else {
  // Human-readable output
  const fmt = (n: number) => n.toLocaleString();
  const tokenFmt = (chars: number) => Math.round(chars / CHARS_PER_TOKEN).toLocaleString();

  console.log('\n📊 Token Usage Report\n');
  console.log(`   Sessions scanned: ${fmt(results.length)} (${fmt(filteredAgent.length)} agent, ${fmt(filteredMaestro.length)} maestro)`);
  console.log('');

  // Column headers
  const colSrc = 'Source';
  const colMsgs = 'Messages';
  const colTokens = 'Est. Tokens';
  const colUser = 'User';
  const colAsst = 'Assistant';
  const colTool = 'Tool/Other';
  const colId = 'Session ID';

  console.log(`   ${colSrc.padEnd(7)}  ${colMsgs.padStart(6)}  ${colTokens.padStart(12)}  ${colUser.padStart(9)}  ${colAsst.padStart(9)}  ${colTool.padStart(10)}  ${colId}`);
  console.log('   ' + '─'.repeat(85));

  for (const r of results.slice(0, 50)) { // show first 50 rows max
    const icon = r.source === 'agent' ? '🤖' : '🎼';
    const id = r.sessionId.substring(0, 8);
    console.log(
      `   ${icon}       ${String(r.totalMessages).padStart(6)}  ${tokenFmt(r.totalChars).padStart(12)}  ${tokenFmt(r.userChars).padStart(9)}  ${tokenFmt(r.assistantChars).padStart(9)}  ${tokenFmt(r.toolChars + r.otherChars).padStart(10)}  ${id}`,
    );
  }

  if (results.length > 50) {
    console.log(`   ... and ${results.length - 50} more sessions`);
  }

  // Totals
  const grandTotal = results.reduce((s, r) => s + r.totalChars, 0);
  const totalUser = results.reduce((s, r) => s + r.userChars, 0);
  const totalAsst = results.reduce((s, r) => s + r.assistantChars, 0);
  const totalTool = results.reduce((s, r) => s + r.toolChars + r.otherChars, 0);
  const totalMsgs = results.reduce((s, r) => s + r.totalMessages, 0);

  console.log('   ' + '─'.repeat(85));
  console.log(
    `   TOTAL      ${String(totalMsgs).padStart(6)}  ${tokenFmt(grandTotal).padStart(12)}  ${tokenFmt(totalUser).padStart(9)}  ${tokenFmt(totalAsst).padStart(9)}  ${tokenFmt(totalTool).padStart(10)}`,
  );
  console.log('');
  console.log(`   ⚠️  Estimated: chars / ${CHARS_PER_TOKEN} (rough approximation, not API-level billing data)`);
  console.log('');
}
