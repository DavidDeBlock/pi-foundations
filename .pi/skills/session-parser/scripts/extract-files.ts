#!/usr/bin/env tsx
/**
 * Extract a clean overview of file operations from session logs.
 *
 * Shows which files were read, edited, or written per session — grouped by action type.
 * Much more concise than parse-session.ts for quick "what was touched?" checks.
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/extract-files.ts <path-to-jsonl> [options]
 *   npx tsx .pi/skills/session-parser/scripts/extract-files.ts --last N [--source agent|maestro|both]
 *
 * Options:
 *   --json           Output structured JSON only
 *   --edits-only     Show only edited/written files (skip reads)
 *   --reads-only     Show only read files
 *   --count          Show operation counts per file instead of listing each op
 *   --last N         Auto-discover the last N sessions and extract from each
 *   --source agent|maestro|both  Which session store to scan (default: both)
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────

const AGENT_SESSION_DIR = '/home/david/.pi/agent/sessions/--home-david-projects-pi-pos-v1--';
const MAESTRO_SESSION_DIR = path.resolve('.pi/maestro/sessions');

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let filePath: string | undefined;
let jsonOnly = false;
let editsOnly = false;
let readsOnly = false;
let showCount = false;
let lastN: number | undefined;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') jsonOnly = true;
  else if (arg === '--edits-only') editsOnly = true;
  else if (arg === '--reads-only') readsOnly = true;
  else if (arg === '--count') showCount = true;
  else if (arg === '--last' && i + 1 < args.length) {
    lastN = parseInt(args[++i], 10);
  } else if (arg === '--source' && i + 1 < args.length) {
    const val = args[++i];
    if (!['agent', 'maestro', 'both'].includes(val)) {
      console.error(`❌ Invalid --source value: ${val}. Must be agent, maestro, or both.`);
      process.exit(1);
    }
    sourceFilter = val as 'agent' | 'maestro' | 'both';
  } else if (!arg.startsWith('-')) {
    filePath = arg;
  }
}

// ── Resolve file paths ────────────────────────────────────────

const files: string[] = [];

if (filePath) {
  files.push(path.resolve(filePath));
} else if (lastN !== undefined) {
  const discovered = discoverSessions(sourceFilter);
  for (let i = 0; i < Math.min(lastN, discovered.length); i++) {
    files.push(discovered[i]);
  }
} else {
  console.error('❌ Error: Provide a file path or use --last N.');
  console.log('Usage: npx tsx .pi/skills/session-parser/scripts/extract-files.ts <path-to-jsonl>');
  console.log('       npx tsx .pi/skills/session-parser/scripts/extract-files.ts --last 5');
  process.exit(1);
}

// ── Process each file ─────────────────────────────────────────

const results: FileOverview[] = [];

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`⚠️  File not found: ${f}`);
    continue;
  }
  const overview = extractFileOperations(f);
  if (overview) results.push(overview);
}

if (results.length === 0) {
  console.log('📭 No file operations found.');
  process.exit(0);
}

// ── Output ─────────────────────────────────────────────────────

for (const r of results) {
  if (jsonOnly) {
    console.log(JSON.stringify(r, null, 2));
    continue;
  }

  const srcIcon = r.source === 'maestro' ? '🎼' : '🤖';
  const timeStr = new Date(r.timestamp).toLocaleString();

  // Filter based on flags
  let reads = editsOnly ? [] : r.reads;
  let writes = readsOnly ? [] : r.writes;

  if (reads.length === 0 && writes.length === 0) {
    console.log(`\n${srcIcon} ${r.id.substring(0, 8)}... | ${timeStr}`);
    console.log('   No matching file operations.');
    continue;
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`${srcIcon} Session: ${r.id.substring(0, 12)}... | ${timeStr}`);
  console.log(`   Model: ${r.model || 'unknown'} | Duration: ~${r.durationMinutes}m`);
  console.log('═'.repeat(64));

  if (writes.length > 0) {
    console.log('\n📝 Modified Files');
    for (const w of writes) {
      const icon = w.action === 'edit' ? '✏️' : w.action === 'write' ? '📄' : '🔧';
      if (showCount && w.count > 1) {
        console.log(`   ${icon} ${w.path} (${w.count}×)`);
      } else {
        console.log(`   ${icon} ${w.path}`);
      }
    }
  }

  if (reads.length > 0) {
    console.log('\n📖 Read Files');
    for (const r of reads) {
      const icon = '👁️';
      if (showCount && r.count > 1) {
        console.log(`   ${icon} ${r.path} (${r.count}×)`);
      } else {
        console.log(`   ${icon} ${r.path}`);
      }
    }
  }

  // Summary line
  const totalReads = reads.length;
  const totalWrites = writes.reduce((sum, w) => sum + (w.count || 1), 0);
  console.log(`\n   Total: ${totalReads} read(s), ${totalWrites} write/edit operation(s)`);
  console.log();
}

// ── Core extraction logic ──────────────────────────────────────

interface FileOp {
  path: string;
  action: 'read' | 'edit' | 'write' | 'bash';
  count?: number;
}

interface FileOverview {
  filePath: string;
  source: 'agent' | 'maestro';
  id: string;
  timestamp: string;
  model?: string;
  durationMinutes: number;
  reads: FileOp[];
  writes: FileOp[];
}

function extractFileOperations(filePath: string): FileOverview | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) return null;

  // Parse session metadata from first line
  let sessionId = '';
  let timestamp = '';
  let model: string | undefined;
  let minTsMs: number | undefined;
  let maxTsMs: number | undefined;

  try {
    const firstEvent = JSON.parse(lines[0]);
    if (firstEvent.type === 'session') {
      sessionId = firstEvent.id || '';
      timestamp = firstEvent.timestamp || '';
      minTsMs = toEpochMs(firstEvent.timestamp);
    }
  } catch { return null; }

  // Track model and max timestamp from all events
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'model_change') model = event.modelId || event.provider;
      const tsMs = toEpochMs(event.timestamp);
      if (tsMs) {
        maxTsMs = Math.max(maxTsMs ?? 0, tsMs);
      }
    } catch { /* skip */ }
  }

  // Extract file operations from tool calls
  const readMap = new Map<string, number>();
  const writeMap = new Map<string, { action: 'edit' | 'write'; count: number }>();

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'message' && event.message?.role === 'assistant') {
        const content = event.message.content || [];
        for (const part of content) {
          if (part.type === 'toolCall') {
            const name = part.name;
            const args = part.arguments || {};

            if (name === 'read' && typeof args.path === 'string') {
              readMap.set(args.path, (readMap.get(args.path) || 0) + 1);
            } else if ((name === 'edit' || name === 'write') && typeof args.path === 'string') {
              const existing = writeMap.get(args.path);
              if (existing) {
                existing.count++;
              } else {
                writeMap.set(args.path, { action: name as 'edit' | 'write', count: 1 });
              }
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  // Convert maps to arrays sorted by path
  const reads = Array.from(readMap.entries())
    .map(([path, count]) => ({ path, action: 'read' as const, count }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const writes = Array.from(writeMap.entries())
    .map(([path, { action, count }]) => ({ path, action, count }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const durationMinutes = minTsMs && maxTsMs ? Math.round((maxTsMs - minTsMs) / 60_000) : 0;

  return {
    filePath,
    source: filePath.startsWith(MAESTRO_SESSION_DIR) ? 'maestro' : 'agent',
    id: sessionId,
    timestamp,
    model,
    durationMinutes,
    reads,
    writes,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function toEpochMs(ts: unknown): number | undefined {
  if (!ts) return undefined;
  const n = typeof ts === 'number' ? ts : new Date(String(ts)).getTime();
  if (n > 3734083200000) return n;
  if (n < 1_000_000_000_000 && n > 0) return n * 1000;
  return n || undefined;
}

function discoverSessions(source: 'agent' | 'maestro' | 'both'): string[] {
  const jsonlFiles: string[] = [];

  if (source === 'agent' || source === 'both') {
    if (fs.existsSync(AGENT_SESSION_DIR)) {
      jsonlFiles.push(...fs.readdirSync(AGENT_SESSION_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(AGENT_SESSION_DIR, f)));
    }
  }

  if (source === 'maestro' || source === 'both') {
    if (fs.existsSync(MAESTRO_SESSION_DIR)) {
      jsonlFiles.push(...findJsonlRecursive(MAESTRO_SESSION_DIR));
    }
  }

  return jsonlFiles
    .map(f => ({ path: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.path);
}

function findJsonlRecursive(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        results.push(...findJsonlRecursive(fullPath));
      } else if (entry.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}
