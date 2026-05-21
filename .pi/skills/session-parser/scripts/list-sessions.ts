#!/usr/bin/env tsx
/**
 * List session files sorted newest-first with metadata.
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/list-sessions.ts [options] [session-dir]
 *
 * Options:
 *   --last N       Show only the last N sessions (default: all)
 *   --today        Show only today's sessions
 *   --path         Print file paths only (machine-readable)
 *
 * Defaults to project session directory if no path is given.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let lastN: number | undefined;
let todayOnly = false;
let pathsOnly = false;
let sessionDir: string;

const positionalArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--last' && i + 1 < args.length) {
    lastN = parseInt(args[++i], 10);
  } else if (arg === '--today') {
    todayOnly = true;
  } else if (arg === '--path') {
    pathsOnly = true;
  } else if (!arg.startsWith('-')) {
    positionalArgs.push(arg);
  }
}

// Resolve session directory:
// 1. Explicit argument
// 2. Current project's sessions (from cwd)
// 3. All projects' sessions (lists them)
if (positionalArgs.length > 0) {
  sessionDir = path.resolve(positionalArgs[0]);
} else {
  // Try to find the current project's session directory from cwd
  const home = process.env.HOME || os.homedir();
  const sessionsRoot = path.join(home, '.pi', 'agent', 'sessions');
  const cwdProjectSlug = '--' + process.cwd().replace(/\/+/g, '-') + '--';
  const candidatePath = path.join(sessionsRoot, cwdProjectSlug);

  if (fs.existsSync(candidatePath)) {
    sessionDir = candidatePath;
  } else {
    // Fall back: list all available projects and pick the first with sessions
    console.error('⚠️ No session directory found for current project.');
    console.error('   Specify a path, or use one of these:');
    if (fs.existsSync(sessionsRoot)) {
      const dirs = fs.readdirSync(sessionsRoot)
        .filter(d => !d.startsWith('.'))
        .sort()
        .slice(0, 10);
      if (dirs.length > 0) {
        for (const d of dirs) console.error(`     ${path.join(sessionsRoot, d)}`);
      }
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

// ── Parse metadata from first line of each file ────────────────

interface SessionMeta {
  filePath: string;
  fileName: string;
  id: string;
  timestamp: Date;
  sizeBytes: number;
  eventCount: number;
  title: string;
}

const sessions: SessionMeta[] = [];

for (const file of files) {
  const filePath = path.join(sessionDir, file);
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
    fileName: file,
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
console.log(`\n📋 Sessions in: ${sessionDir}`);
console.log(`   Total: ${sessions.length} session(s)\n`);

const pad = (s: string, len: number) => s.padEnd(len);
const trunc = (s: string, max: number) => s.length > max ? s.substring(0, max) + '…' : s;

// Header row
console.log(pad('#', 3) + '  ' + pad('Time', 22) + '  ' + pad('Size', 8) + '  ' + pad('Events', 7) + '  ' + pad('ID', 10) + '  Title');
console.log('-'.repeat(64));

sessions.forEach((s, i) => {
  const timeStr = formatTimestamp(s.timestamp);
  const sizeStr = formatSize(s.sizeBytes);
  const titleTrunc = trunc(s.title || '(no title)', 28);

  console.log(
    pad(String(i + 1), 3) + '  ' +
    pad(timeStr, 22) + '  ' +
    pad(sizeStr, 8) + '  ' +
    pad(String(s.eventCount), 7) + '  ' +
    pad(s.id, 10) + '  ' +
    titleTrunc
  );
});

console.log(`\n💡 Use the path to pipe into parse-session.ts:`);
console.log(`   tsx .pi/skills/session-parser/scripts/parse-session.ts <path>`);

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
