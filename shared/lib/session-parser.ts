import * as fs from 'fs';
import * as path from 'path';
import { SessionSummary, FileOperation, Decision, ToolError, RawMessageEntry } from '../types/session-parser';

interface LogEvent {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: number | string;
  message?: any;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export function parseSessionLog(filePath: string): SessionSummary {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  let metadata: any = {};
  const fileOperations: FileOperation[] = [];
  const decisions: Decision[] = [];
  const errors: ToolError[] = [];
  const rawMessages: RawMessageEntry[] = [];

  // Track context for pairing tool calls with results
  const pendingToolCalls = new Map<string, any>();
  let maxTimestampMs: number | undefined;

  lines.forEach(line => {
    try {
      const event: LogEvent = JSON.parse(line);

      // Track max timestamp for duration calculation
      const tsMs = toEpochMs(event.timestamp);
      if (tsMs && (!maxTimestampMs || tsMs > maxTimestampMs)) {
        maxTimestampMs = tsMs;
      }

      if (event.type === 'session') {
        metadata.id = event.id;
        metadata.timestamp = event.timestamp;
      } else if (event.type === 'model_change') {
        metadata.model = event.modelId || event.provider;
      } else if (event.type === 'thinking_level_change') {
        metadata.thinkingLevel = event.thinkingLevel;
      }

      if (event.message) {
        const msg = event.message;
        
        // Handle Tool Calls
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'toolCall') {
              pendingToolCalls.set(part.id, {
                toolName: part.name,
                arguments: part.arguments || {},
                assistantMessageId: event.id,
                timestamp: event.timestamp
              });
            } else if (part.type === 'text') {
              const text = part.text;
              
              // Detect Decisions
              if (isDecisionPattern(text)) {
                decisions.push({
                  topic: extractTopic(text),
                  decision: extractDecision(text),
                  confidence: 'high',
                  source_pattern: text.substring(0, 100) + '...'
                });
                
                // Add to raw messages for context
                rawMessages.push({
                  id: event.id!,
                  role: 'assistant',
                  content: text,
                  timestamp: String(event.timestamp || '')
                });
              }

              // Detect Errors in text
              if (text.toLowerCase().includes('error') || text.toLowerCase().includes('failed')) {
                 errors.push({
                   type: 'text_error',
                   message: text.substring(0, 200),
                   context: `Assistant message ${event.id}`
                 });
              }
            }
          }
        }

        // Handle Tool Results (Success/Failure)
        if (msg.role === 'toolResult') {
          const toolCallId = msg.toolCallId || msg.parentId; // Fallback to parentId if ID not explicit in result
          const isFailure = msg.isError || false;
          
          let op: FileOperation | undefined;
          let toolName = '';

          // Try to find the associated tool call to get the name and arguments (file path)
          const callInfo = pendingToolCalls.get(toolCallId);
          if (callInfo) {
            toolName = callInfo.toolName;
            
            // Extract file path from arguments if available
            let toolFilePath = 'unknown';
            const args = callInfo.arguments || {};
            if (args.path) toolFilePath = args.path;

            const errorContent = extractToolContentString(msg.content);

            op = {
              path: toolFilePath,
              action: toolName as any,
              status: isFailure ? 'failed' : 'success',
              timestamp: String(tsMs || msg.timestamp || ''),
              error_message: isFailure ? (errorContent?.substring(0, 200) || 'Unknown error') : undefined
            };

            // If it failed, add to raw messages for debugging
            if (isFailure) {
               errors.push({
                 type: 'tool_error',
                 message: errorContent?.substring(0, 200),
                 context: `${toolName} on ${toolFilePath}`
               });

               // Add the result content to raw messages
               rawMessages.push({
                 id: event.id!,
                 role: 'toolResult',
                 content: errorContent || '',
                 timestamp: String(tsMs || msg.timestamp || '')
               });
            }

            pendingToolCalls.delete(toolCallId);
          } else {
             // Orphan result (might be bash or other tool)
             if (isFailure) {
               const orphanContent = extractToolContentString(msg.content);
               errors.push({
                 type: 'tool_error',
                 message: orphanContent?.substring(0, 200),
                 context: `Orphan tool result ${event.id}`
               });
             }
          }

          if (op) fileOperations.push(op);
        }
      }
    } catch (e) {
      // Ignore malformed lines
    }
  });

  // Calculate duration from first to last event timestamp
  const startMs = toEpochMs(metadata.timestamp);
  const endMs = maxTimestampMs ?? Date.now();
  metadata.duration_minutes = startMs ? Math.round((endMs - startMs) / 60000) : 0;

  // Generate Markdown
  const markdown = generateMarkdown(metadata, fileOperations, decisions, errors, rawMessages);
  
  // Generate JSON
  const json = {
    session: metadata,
    files_modified: fileOperations,
    decisions: decisions,
    errors: errors,
    raw_messages: rawMessages
  };

  return { markdown, json };
}

// --- Helpers ---

/** Convert an ISO timestamp string or epoch ms to epoch milliseconds. */
function toEpochMs(ts?: number | string): number | undefined {
  if (ts === undefined || ts === null) return undefined;
  if (typeof ts === 'number') return ts;
  // Could be epoch ms stored as a string
  const numeric = Number(ts);
  if (Number.isFinite(numeric) && numeric > 1e12) return numeric; // epoch ms threshold
  const parsed = new Date(ts).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extract a plain text string from tool result content (array of parts or scalar). */
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

function isDecisionPattern(text: string): boolean {
  // Heuristics for grill-with-docs or similar structured sessions
  const patterns = [
    /✅ \*\*.*?\*\*/, // Confirmed decision
    /## 🔥 Question/, // New question block
    /\bOption [A-Z]\b/, // Option selection
    /Locked in/
  ];
  return patterns.some(p => p.test(text));
}

function extractTopic(text: string): string {
  const match = text.match(/## 🔥 Question \d+: (.+)/);
  if (match) return match[1];
  
  // Fallback to first few words of the decision confirmation
  const confirmMatch = text.match(/✅ \*\*(.*?)\*\*/);
  if (confirmMatch) return confirmMatch[1].substring(0, 50);
  
  return 'Unknown Topic';
}

function extractDecision(text: string): string {
  // Try to find the specific option or decision statement
  const match = text.match(/✅ \*\*(.*?)\*\*/);
  if (match) return match[1];
  
  const optMatch = text.match(/\bOption ([A-Z])\b/);
  if (optMatch) return `Option ${optMatch[1]}`;

  return 'Decision confirmed';
}

function generateMarkdown(meta: any, files: FileOperation[], decisions: Decision[], errors: ToolError[], rawMessages: RawMessageEntry[]): string {
  let md = `# Session Summary\n`;
  md += `**ID:** \`${meta.id?.substring(0,8)}...\` | **Time:** ${new Date(meta.timestamp).toLocaleString()} | **Duration:** ~${meta.duration_minutes}m  \n`;
  md += `**Model:** ${meta.model || 'Unknown'} | **Thinking Level:** ${meta.thinkingLevel || 'N/A'}\n\n`;

  // Files Modified
  if (files.length > 0) {
    md += `## 📁 File Operations Log\n`;
    md += `| Time | Action | File | Status | Notes |\n`;
    md += `|------|--------|------|--------|-------|\n`;
    files.forEach(f => {
      const time = f.timestamp ? (toEpochMs(f.timestamp) ? new Date(toEpochMs(f.timestamp)!).toLocaleTimeString() : '') : '';
      const statusIcon = f.status === 'success' ? '✅ Success' : '❌ Failed';
      md += `| ${time} | ${f.action.toUpperCase()} | \`${f.path}\` | ${statusIcon} | ${f.error_message || ''} |\n`;
    });
    md += `\n`;
  }

  // Decisions
  if (decisions.length > 0) {
    md += `## 🔑 Key Decisions & Confirmations\n`;
    md += `| Topic | Decision | Confidence |\n`;
    md += `|-------|----------|------------|\n`;
    decisions.forEach(d => {
      md += `| ${d.topic} | **${d.decision.substring(0, 60)}** | ${d.confidence} |\n`;
    });
    md += `\n`;
  }

  // Errors
  if (errors.length > 0) {
    md += `## ⚠️ Errors & Exceptions\n`;
    errors.forEach(e => {
      md += `- **${e.type}:** ${e.message}\n`;
      if (e.context) md += `  - Context: ${e.context}\n`;
    });
    md += `\n`;
  }

  // Raw Messages (Hybrid)
  if (rawMessages.length > 0) {
    md += `## 📝 Critical Context (Raw)\n\n\`\`\`json\n${JSON.stringify(rawMessages, null, 2)}\n\`\`\`\n`;
  }

  return md;
}
