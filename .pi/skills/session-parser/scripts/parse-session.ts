#!/usr/bin/env tsx
/**
 * CLI Wrapper for Session Parser Library
 * Usage: npx tsx .pi/skills/session-parser/scripts/parse-session.ts <path-to-jsonl>
 */

// Note: Ensure 'tsx' is installed globally (npm i -g tsx) or available via npx.
import { parseSessionLog } from '../../../../shared/lib/session-parser';
import * as path from 'path';

const filePath = process.argv[2];

if (!filePath) {
  console.error('❌ Error: No file path provided.');
  console.log('Usage: npx tsx .pi/skills/session-parser/scripts/parse-session.ts <path-to-jsonl>');
  process.exit(1);
}

// Resolve relative paths if needed (though usually absolute is passed)
const resolvedPath = path.resolve(filePath);

try {
  const summary = parseSessionLog(resolvedPath);

  // Output Markdown Section
  console.log('--- MARKDOWN SUMMARY ---');
  console.log(summary.markdown);

  // Output JSON Section
  console.log('\n--- STRUCTURED DATA (JSON) ---');
  console.log(JSON.stringify(summary.json, null, 2));

} catch (error: any) {
  console.error(`❌ Error parsing session log: ${error.message}`);
  process.exit(1);
}
