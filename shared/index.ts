/**
 * Shared library — barrel exports.
 *
 * All public APIs from shared/ are re-exported here so consumers can import
 * from a single canonical path: `shared/`.
 */

export {
  parseSessionLog,
  parseSessionLines,
  extractSessionMetadata,
  type SessionSummary,
  type FileOperation,
  type Decision,
  type ToolError,
  type RawMessageEntry,
  type ParsedEvent,
} from './lib/session-parser.js';
