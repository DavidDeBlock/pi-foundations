#!/usr/bin/env tsx
/**
 * Extract verdict and summary from session logs.
 *
 * Scans backwards through a JSONL session to find the last assistant message
 * containing text, then extracts:
 *   - The full summary text (markdown)
 *   - Any fenced `verdict` code block with structured JSON inside
 *
 * Usage:
 *   npx tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path-to-jsonl> [options]
 *   npx tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last N [--source agent|maestro|both]
 *
 * Options:
 *   --json           Output structured JSON only (no markdown)
 *   --summary-only   Print summary text without verdict block
 *   --verdict-only   Print verdict JSON block only
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
let summaryOnly = false;
let verdictOnly = false;
let lastN: number | undefined;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--json') jsonOnly = true;
  else if (arg === '--summary-only') summaryOnly = true;
  else if (arg === '--verdict-only') verdictOnly = true;
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
  // Auto-discover sessions using list-sessions logic
  const discovered = discoverSessions(sourceFilter);
  for (let i = 0; i < Math.min(lastN, discovered.length); i++) {
    files.push(discovered[i]);
  }
} else {
  console.error('❌ Error: Provide a file path or use --last N.');
  console.log('Usage: npx tsx .pi/skills/session-parser/scripts/extract-verdict.ts <path-to-jsonl>');
  console.log('       npx tsx .pi/skills/session-parser/scripts/extract-verdict.ts --last 5');
  process.exit(1);
}

// ── Process each file ─────────────────────────────────────────

const results: ExtractedVerdict[] = [];

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`⚠️  File not found: ${f}`);
    continue;
  }
  const extracted = extractFromSession(f);
  if (extracted) results.push(extracted);
}

if (results.length === 0) {
  console.log('📭 No verdicts or summaries found.');
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

  if (summaryOnly) {
    console.log(`\n${srcIcon} ${r.id.substring(0, 8)}... | ${timeStr}`);
    console.log(`${r.summary || '(no summary found)'}`);
    continue;
  }

  if (verdictOnly) {
    if (r.verdictJson) {
      console.log(JSON.stringify(r.verdictJson, null, 2));
    } else {
      console.log(`⚠️  No verdict block in ${r.id.substring(0, 8)}...`);
    }
    continue;
  }

  // Default: full output
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`${srcIcon} Session: ${r.id.substring(0, 12)}... | ${timeStr}`);
  console.log(`   Model: ${r.model || 'unknown'} | Duration: ~${r.durationMinutes}m`);
  console.log('═'.repeat(64));

  if (r.verdictJson) {
    const v = r.verdictJson;
    const statusEmoji = v.status === 'approved' ? '✅' : v.status === 'rejected' ? '❌' : '⚠️';
    console.log(`\n${statusEmoji} Verdict: ${v.verdict || v.status || '(none)'}`);

    if (v.details) {
      console.log(`   ${v.details}`);
    }

    if (v.issues?.length > 0) {
      console.log(`\n   Issues (${v.issues.length}):`);
      for (const issue of v.issues) {
        console.log(`     • ${issue}`);
      }
    }

    if (v.findings?.length > 0) {
      console.log(`\n   Findings (${v.findings.length}):`);
      for (const finding of v.findings) {
        const label = typeof finding === 'string' ? finding : finding.detail || finding.dimension || JSON.stringify(finding);
        console.log(`     ✓ ${label}`);
      }
    }

    if (v.labels) {
      const adds = v.labels.add?.filter(Boolean);
      const removes = v.labels.remove?.filter(Boolean);
      if (adds?.length || removes?.length) {
        console.log(`\n   Labels: ${adds?.map(l => `+${l}`).join(', ') || ''} ${removes?.map(l => `-${l}`).join(', ') || ''}`.trim());
      }
    }
  } else {
    console.log('\n⚠️  No structured verdict block found.');
  }

  if (r.summary) {
    // Show summary truncated to last ~30 lines for readability
    const lines = r.summary.split('\n');
    const start = Math.max(0, lines.length - 25);
    console.log(`\n--- Summary (last ${Math.min(lines.length, 25)} lines) ---`);
    for (let i = start; i < lines.length; i++) {
      console.log(lines[i]);
    }
    if (lines.length > 25) {
      console.log(`\n   ... (${lines.length - 25} earlier lines omitted)`);
    }
  }

  console.log();
}

// ── Core extraction logic ──────────────────────────────────────

interface ExtractedVerdict {
  filePath: string;
  source: 'agent' | 'maestro';
  id: string;
  timestamp: string;
  model?: string;
  durationMinutes: number;
  summary?: string;
  verdictJson?: Record<string, unknown>;
}

function extractFromSession(filePath: string): ExtractedVerdict | null {
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

  // Scan backwards for last assistant message with text content
  let summaryText: string | null = null;

  for (let i = lines.length - 1; i >= 0 && i > lines.length - 20; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'message' && event.message?.role === 'assistant') {
        const textContent = extractTextFromMessage(event.message.content);
        if (textContent.trim()) {
          summaryText = textContent;
          break;
        }
      }
    } catch { /* skip */ }
  }

  // Extract verdict JSON from fenced code block
  let verdictJson: Record<string, unknown> | undefined;
  if (summaryText) {
    const match = summaryText.match(/```verdict\s*\n([\s\S]*?)\n```/);
    if (match) {
      try {
        verdictJson = JSON.parse(match[1]);
      } catch { /* malformed JSON, skip */ }
    }
  }

  const durationMinutes = minTsMs && maxTsMs ? Math.round((maxTsMs - minTsMs) / 60_000) : 0;

  return {
    filePath,
    source: filePath.startsWith(MAESTRO_SESSION_DIR) ? 'maestro' : 'agent',
    id: sessionId,
    timestamp,
    model,
    durationMinutes,
    summary: summaryText || undefined,
    verdictJson,
  };
}

// ── Helpers ────────────────────────────────────────────────────

function extractTextFromMessage(content: unknown): string {
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

function toEpochMs(ts: unknown): number | undefined {
  if (!ts) return undefined;
  const n = typeof ts === 'number' ? ts : new Date(String(ts)).getTime();
  // If it's already in milliseconds (> year 2100 as seconds would be huge), use as-is
  if (n > 3734083200000) return n;
  // Otherwise treat as seconds and convert
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

  // Sort newest first by file mtime
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
