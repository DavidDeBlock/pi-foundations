#!/usr/bin/env tsx
/**
 * List session files sorted newest-first with metadata.
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/list-sessions.ts [options]
 *
 * Options:
 *   --last N       Show only the last N sessions (default: all)
 *   --today        Show only today's sessions
 *   --path         Print file paths only (machine-readable)
 *   --source agent|maestro|both  Which session store to scan (default: both)
 *
 * Session stores:
 *   agent    — ~/.pi/agent/sessions/--home-david-projects-pi-pos-v1--/
 *             Flat .jsonl files from direct agent runs.
 *   maestro  — .pi/maestro/sessions/<number>/<flow>/session.jsonl
 *             Nested dirs from multi-agent pipeline runs.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────

const AGENT_SESSION_DIR = '/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--';
const MAESTRO_SESSION_DIR = path.resolve('.pi/maestro/sessions');

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let lastN: number | undefined;
let todayOnly = false;
let pathsOnly = false;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--last' && i + 1 < args.length) {
    lastN = parseInt(args[++i], 10);
  } else if (arg === '--today') {
    todayOnly = true;
  } else if (arg === '--path') {
    pathsOnly = true;
  } else if (arg === '--source' && i + 1 < args.length) {
    const val = args[++i];
    if (!['agent', 'maestro', 'both'].includes(val)) {
      console.error(`❌ Invalid --source value: ${val}. Must be agent, maestro, or both.`);
      process.exit(1);
    }
    sourceFilter = val as 'agent' | 'maestro' | 'both';
  } else if (!arg.startsWith('-')) {
    // Positional arg (legacy: session-dir override — still supported)
    console.warn(`⚠️  Positional path argument is deprecated. Use --source agent|maestro|both.`);
  }
}

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

// ── Parse metadata from first line of each file ────────────────

interface SessionMeta {
  filePath: string;
  fileName: string;
  source: 'agent' | 'maestro';
  id: string;
  timestamp: Date;
  sizeBytes: number;
  eventCount: number;
  title: string;
}

const sessions: SessionMeta[] = [];

for (const filePath of jsonlFiles) {
  const stat = fs.statSync(filePath);

  // Read first line for session metadata
  const firstLine = readFirstLine(filePath);
  if (!firstLine) continue;

  let parsed: any;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    continue;
  }

  if (parsed.type !== 'session') continue;

  // Count total events
  const eventCount = countLines(filePath);

  // Extract title from first user message
  const title = extractTitle(filePath);

  sessions.push({
    filePath,
    fileName: path.basename(filePath),
    source: filePath.startsWith(MAESTRO_SESSION_DIR) ? 'maestro' : 'agent',
    id: parsed.id?.substring(0, 8) || 'unknown',
    timestamp: new Date(parsed.timestamp),
    sizeBytes: stat.size,
    eventCount,
    title,
  });
}

// Sort newest first
sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

// Filter today
if (todayOnly) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const filtered: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.timestamp >= todayStart) filtered.push(s);
  }
  sessions.length = 0;
  sessions.push(...filtered);
}

// Limit to last N
if (lastN !== undefined && lastN > 0) {
  sessions.splice(lastN);
}

// ── Output ─────────────────────────────────────────────────────

if (pathsOnly) {
  for (const s of sessions) {
    console.log(s.filePath);
  }
  process.exit(0);
}

if (sessions.length === 0) {
  console.log('📭 No matching session files found.');
  process.exit(0);
}

// Table header
const sourceLabel = sourceFilter === 'both' ? '(agent + maestro)' : `(${sourceFilter})`;
console.log(`\n📋 Sessions ${sourceLabel}`);
console.log(`   Total: ${sessions.length} session(s)\n`);

const pad = (s: string, len: number) => s.padEnd(len);
const trunc = (s: string, max: number) => s.length > max ? s.substring(0, max) + '…' : s;

// Header row
console.log(pad('#', 3) + '  ' + pad('Time', 22) + '  ' + pad('Src', 8) + '  ' + pad('Size', 8) + '  ' + pad('Events', 7) + '  ' + pad('ID', 10) + '  Title');
console.log('-'.repeat(72));

sessions.forEach((s, i) => {
  const timeStr = formatTimestamp(s.timestamp);
  const srcIcon = s.source === 'maestro' ? '🎼' : '🤖';
  const sizeStr = formatSize(s.sizeBytes);
  const titleTrunc = trunc(s.title || '(no title)', 28);

  console.log(
    pad(String(i + 1), 3) + '  ' +
    pad(timeStr, 22) + '  ' +
    pad(srcIcon, 8) + '  ' +
    pad(sizeStr, 8) + '  ' +
    pad(String(s.eventCount), 7) + '  ' +
    pad(s.id, 10) + '  ' +
    titleTrunc
  );
});

console.log(`\n💡 Use the path to pipe into parse-session.ts:`);
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

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    let buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf);
    const chunk = buf.toString('utf8', 0, bytesRead);
    const newlineIdx = chunk.indexOf('\n');
    if (newlineIdx === -1) return chunk.trim();
    return chunk.substring(0, newlineIdx).trim();
  } finally {
    fs.closeSync(fd);
  }
}

function countLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').filter(l => l.trim()).length;
}

function extractTitle(filePath: string): string {
  // Read lines until we find the first user message, then grab a short snippet.
  // Skip messages that are mostly skill/system content (contain <skill> tags).
  const maxLines = 50;
  let lineCount = 0;

  const fileContent = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of fileContent.split('\n')) {
    if (!rawLine.trim()) continue;
    lineCount++;
    if (lineCount > maxLines) break;

    try {
      const event = JSON.parse(rawLine);
      if (event.type === 'message' && event.message?.role === 'user') {
        const textContent = extractTextContent(event.message.content);
        // Skip messages that are mostly skill content or system prompts
        if (textContent.includes('<skill ') || textContent.includes('You are the **')) continue;

        // Strip XML tags, collapse whitespace
        const cleaned = textContent.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (cleaned) return cleaned;
      }
    } catch {
      continue;
    }
  }

  // Fallback: use first user message even if it's skill content
  lineCount = 0;
  for (const rawLine of fileContent.split('\n')) {
    if (!rawLine.trim()) continue;
    lineCount++;
    if (lineCount > maxLines) break;

    try {
      const event = JSON.parse(rawLine);
      if (event.type === 'message' && event.message?.role === 'user') {
        const textContent = extractTextContent(event.message.content);
        // Skip system prompt fragments entirely in fallback too
        if (textContent.includes('You are the **')) continue;
        // Extract the user's actual question from after skill tags
        let cleaned = textContent.replace(/<skill[^>]*>[\s\S]*?<\/skill>/g, '').replace(/\s+/g, ' ').trim();
        if (cleaned) return cleaned;
      }
    } catch {
      continue;
    }
  }

  return '';
}

function extractTextContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n');
  }
  return String(content);
}

function formatTimestamp(date: Date): string {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const mins = date.getMinutes().toString().padStart(2, '0');
  return `${day}-${month} ${hours}:${mins}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
