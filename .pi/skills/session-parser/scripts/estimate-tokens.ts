#!/usr/bin/env tsx
/**
 * Estimate billed tokens per session using cumulative context growth.
 *
 * Each API call sends: system prompt + all prior messages (growing context).
 * This estimates total billed = Σ(system_prompt + cumulative_context) for each assistant turn.
 *
 * Usage:
 *   tsx .pi/skills/session-parser/scripts/estimate-tokens.ts [options]
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

// Estimate system prompt size from loaded files (~10K tokens)
// .pi/SYSTEM.md + ~/.pi/agent/AGENTS.md + .pi/WORLD.md + CONTEXT.md + skill files
const ESTIMATED_SYSTEM_PROMPT_CHARS = 50_000; // ~12,500 tokens per API call
// Thinking/reasoning multiplier — thinking tokens aren't stored in JSONL.
// Claude with extended thinking typically uses 1-3x the visible output in reasoning.
const THINKING_MULTIPLIER = 1.5; // default: assume thinking ≈ 50% of assistant output

// ── CLI parsing ────────────────────────────────────────────────

const args = process.argv.slice(2);
let lastN: number | undefined;
let jsonOutput = false;
let sourceFilter: 'agent' | 'maestro' | 'both' = 'both';
let thinkingMultiplier = THINKING_MULTIPLIER;

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
  } else if (arg === '--thinking' && i + 1 < args.length) {
    thinkingMultiplier = parseFloat(args[++i]);
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

interface SessionEstimate {
  thinkingTokens: number;
  source: 'agent' | 'maestro';
  filePath: string;
  timestamp: string;
  sessionId: string;
  totalMessages: number;
  apiCalls: number; // assistant responses = API calls
  systemPromptTokens: number; // system_prompt × api_calls
  contextGrowthTokens: number; // cumulative message content across all turns
  estimatedBilledTokens: number; // sum of both
  breakdown: {
    userChars: number;
    assistantChars: number;
    toolResultChars: number;
    otherChars: number;
  };
}

function estimateSession(filePath: string, source: 'agent' | 'maestro'): SessionEstimate {
  let timestamp = '';
  let sessionId = '';
  let apiCalls = 0;
  let cumulativeContextChars = 0; // grows with each message
  let totalBilledChars = 0; // sum of context sent per API call

  let userChars = 0;
  let assistantChars = 0;
  let toolResultChars = 0;
  let otherChars = 0;

  const content = fs.readFileSync(filePath, 'utf-8');
  let totalMessages = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const obj: Record<string, unknown> = JSON.parse(line);

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

    // Track per-role totals
    switch (role) {
      case 'user':
        userChars += chars;
        break;
      case 'assistant':
        assistantChars += chars;
        apiCalls++; // each assistant response = one API call
        break;
      case 'toolResult':
        toolResultChars += chars;
        break;
      default:
        otherChars += chars;
    }

    // Context grows with every message
    cumulativeContextChars += chars;

    // Each assistant turn sends: system_prompt + all prior messages (including this one)
    if (role === 'assistant') {
      totalBilledChars += ESTIMATED_SYSTEM_PROMPT_CHARS + cumulativeContextChars;
    }
  }

  const estimatedBilledTokens = Math.round(totalBilledChars / CHARS_PER_TOKEN);
  const systemPromptTokens = apiCalls * Math.round(ESTIMATED_SYSTEM_PROMPT_CHARS / CHARS_PER_TOKEN);
  const contextGrowthTokens = estimatedBilledTokens - systemPromptTokens;

  // Estimate thinking tokens: not stored in JSONL.
  // With extended thinking, Claude generates substantial reasoning per API call before responding.
  // We estimate a base amount per API call scaled by the multiplier.
  const THINKING_TOKENS_PER_CALL = 5_000; // baseline: ~5K reasoning tokens per turn
  const thinkingTokens = Math.round(apiCalls * THINKING_TOKENS_PER_CALL * thinkingMultiplier);

  return {
    source,
    filePath,
    timestamp,
    sessionId,
    totalMessages,
    apiCalls,
    systemPromptTokens,
    contextGrowthTokens,
    estimatedBilledTokens,
    thinkingTokens,
    breakdown: { userChars, assistantChars, toolResultChars, otherChars },
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

const results: SessionEstimate[] = [];

for (const fp of filteredAgent) {
  try {
    results.push(estimateSession(fp, 'agent'));
  } catch (err) {
    console.error(`❌ Failed to parse agent session: ${fp}`);
    console.error(String(err));
  }
}

for (const fp of filteredMaestro) {
  try {
    results.push(estimateSession(fp, 'maestro'));
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
      apiCalls: acc.apiCalls + r.apiCalls,
      systemPromptTokens: acc.systemPromptTokens + r.systemPromptTokens,
      contextGrowthTokens: acc.contextGrowthTokens + r.contextGrowthTokens,
      estimatedBilledTokens: acc.estimatedBilledTokens + r.estimatedBilledTokens,
      thinkingTokens: acc.thinkingTokens + r.thinkingTokens,
      totalWithThinking: acc.totalWithThinking + (r.estimatedBilledTokens + r.thinkingTokens),
      agentSessions: acc.agentSessions + (r.source === 'agent' ? 1 : 0),
      maestroSessions: acc.maestroSessions + (r.source === 'maestro' ? 1 : 0),
    }),
    {
      sessions: 0,
      apiCalls: 0,
      systemPromptTokens: 0,
      contextGrowthTokens: 0,
      estimatedBilledTokens: 0,
      thinkingTokens: 0,
      totalWithThinking: 0,
      agentSessions: 0,
      maestroSessions: 0,
    },
  );

  console.log(JSON.stringify({ totals, sessions: results }, null, 2));
} else {
  const fmt = (n: number) => n.toLocaleString();

  console.log('\n📊 Estimated Billed Tokens Report\n');
  console.log(`   Sessions scanned: ${fmt(results.length)} (${fmt(filteredAgent.length)} agent, ${fmt(filteredMaestro.length)} maestro)`);
  console.log(`   System prompt estimate: ~${Math.round(ESTIMATED_SYSTEM_PROMPT_CHARS / CHARS_PER_TOKEN).toLocaleString()} tokens per API call`);
  console.log(`   Thinking multiplier: ${thinkingMultiplier}x (use --thinking N to adjust)`);
  console.log('');

  // Column headers
  console.log(`   Source  API Calls  Billed      +Thinking    Total       Sys Prompt    Context Growth  Session ID`);
  console.log('   ' + '─'.repeat(110));

  for (const r of results.slice(0, 50)) {
    const icon = r.source === 'agent' ? '🤖' : '🎼';
    const id = r.sessionId.substring(0, 8);
    const totalWithThinking = r.estimatedBilledTokens + r.thinkingTokens;
    console.log(
      `   ${icon}       ${String(r.apiCalls).padStart(9)}  ${fmt(r.estimatedBilledTokens).padStart(9)}  ${fmt(r.thinkingTokens).padStart(10)}  ${fmt(totalWithThinking).padStart(9)}  ${fmt(r.systemPromptTokens).padStart(10)}  ${fmt(r.contextGrowthTokens).padStart(14)}  ${id}`,
    );
  }

  if (results.length > 50) {
    console.log(`   ... and ${results.length - 50} more sessions`);
  }

  // Totals
  const grandTotal = results.reduce((s, r) => s + r.estimatedBilledTokens, 0);
  const totalThinking = results.reduce((s, r) => s + r.thinkingTokens, 0);
  const grandTotalWithThinking = grandTotal + totalThinking;
  const totalSysPrompt = results.reduce((s, r) => s + r.systemPromptTokens, 0);
  const totalContextGrowth = results.reduce((s, r) => s + r.contextGrowthTokens, 0);
  const totalApiCalls = results.reduce((s, r) => s + r.apiCalls, 0);

  console.log('   ' + '─'.repeat(110));
  console.log(
    `   TOTAL      ${String(totalApiCalls).padStart(9)}  ${fmt(grandTotal).padStart(9)}  ${fmt(totalThinking).padStart(10)}  ${fmt(grandTotalWithThinking).padStart(9)}  ${fmt(totalSysPrompt).padStart(10)}  ${fmt(totalContextGrowth).padStart(14)}`,
  );
  console.log('');
  console.log(`   ⚠️  Billed = system_prompt(${Math.round(ESTIMATED_SYSTEM_PROMPT_CHARS / CHARS_PER_TOKEN).toLocaleString()} tokens) × API calls + cumulative context growth`);
  console.log(`   ⚠️  Thinking estimated as ${thinkingMultiplier}x assistant output (not stored in JSONL)`);
  console.log('');
}
