#!/usr/bin/env tsx
/**
 * scripts/parse-doc-file.ts — Parse a single markdown doc file.
 *
 * Extracts headings (with levels), section summaries, cross-references,
 * file flags (large file, draft/temp), and structural metadata. Outputs JSON
 * suitable for agent consumption or pipeline processing.
 *
 * Usage:
 *   npx tsx scripts/parse-doc-file.ts <path>                           # Parse single file to stdout
 *   npx tsx scripts/parse-doc-file.ts docs/10-domain/glossary.md       # Specific file
 *
 * @category analysis
 * @usage npx tsx scripts/parse-doc-file.ts <path>
 */

import { readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'fs'
import { resolve } from 'path'

// ── Types ──────────────────────────────────────────────────────

const DEFAULT_SUMMARY_LINES = 5
const LARGE_FILE_THRESHOLD_KB = 50
const MAX_PROCESSING_LINES = 2000 // Cap lines processed for very large files

export interface SectionInfo {
  heading: string
  level: number
  lineNumber: number
  summary: string
}

export interface DocFlags {
  largeFile?: boolean
}

export interface CrossReference {
  text: string
  target: string
  lineNumber: number
  isExternal: boolean
}

export interface DocAnalysis {
  filePath: string
  fileType: 'markdown' | 'binary'
  wordCount: number
  flags?: DocFlags
  sections: SectionInfo[]
  crossReferences: CrossReference[]
}

// ── Core Functions ─────────────────────────────────────────────

/**
 * Detect if file is binary by checking for null bytes in first chunk.
 */
function detectBinary(filePath: string): boolean {
  const stat = statSync(filePath)
  // Empty files are not binary
  if (stat.size === 0) return false

  const readSize = Math.min(512, stat.size)
  const buffer = Buffer.alloc(readSize)
  const fd = openSync(filePath, 'r')
  readSync(fd, buffer, 0, readSize, 0)
  closeSync(fd)
  // Null bytes in first chunk indicate binary
  return buffer.indexOf(0) !== -1
}

/**
 * Estimate word count from text.
 */
function estimateWordCount(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0)
  return words.length
}

/**
 * Parse a single doc file and extract structured analysis.
 */
export function parseDocFile(filePath: string): DocAnalysis {
  // Check for binary first
  if (detectBinary(filePath)) {
    return {
      filePath,
      fileType: 'binary',
      wordCount: 0,
      flags: {},
      sections: [],
      crossReferences: [],
    }
  }

  const stat = statSync(filePath)
  const content = readFileSync(filePath, 'utf-8')
  let lines = content.split('\n')

  // For large files, cap processing to first N lines (sampling strategy)
  const isLargeFile = (stat.size / 1024) > LARGE_FILE_THRESHOLD_KB
  if (isLargeFile && lines.length > MAX_PROCESSING_LINES) {
    lines = lines.slice(0, MAX_PROCESSING_LINES)
  }

  // First pass: find all heading positions
  interface HeadingPos { index: number; level: number }
  const headings: HeadingPos[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/) 
    if (match) {
      headings.push({ index: i, level: match[1].length })
    }
  }

  // Second pass: build sections with summaries
  const sections: SectionInfo[] = []

  for (let h = 0; h < headings.length; h++) {
    const headingLineIdx = headings[h].index
    const nextHeadingIdx = h + 1 < headings.length ? headings[h + 1].index : lines.length

    // Summary: first N non-empty, non-heading lines after the heading line
    const summaryLines: string[] = []
    for (let i = headingLineIdx + 1; i < nextHeadingIdx && summaryLines.length < DEFAULT_SUMMARY_LINES; i++) {
      const line = lines[i].trim()
      if (line && !lines[i].match(/^#{1,6}\s/)) {
        summaryLines.push(line)
      }
    }

    sections.push({
      heading: headings[h].index >= 0 ? lines[headingLineIdx].replace(/^#+\s+/, '') : '',
      level: headings[h].level,
      lineNumber: headingLineIdx + 1, // 1-indexed
      summary: summaryLines.join('\n'),
    })
  }

  // Third pass: detect cross-references (markdown links)
  const crossReferences: CrossReference[] = []

  for (let i = 0; i < lines.length; i++) {
    // Match markdown links: [text](url)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
    let match
    while ((match = linkRegex.exec(lines[i])) !== null) {
      const target = match[2].trim()
      crossReferences.push({
        text: match[1].trim(),
        target,
        lineNumber: i + 1, // 1-indexed
        isExternal: /^https?:\/\//.test(target),
      })
    }
  }

  // Estimate word count from processed content
  const wordCount = estimateWordCount(lines.join(' '))

  return {
    filePath,
    fileType: 'markdown',
    wordCount,
    flags: isLargeFile ? { largeFile: true } : {},
    sections,
    crossReferences,
  }
}

// ── CLI Entry Point ────────────────────────────────────────────

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const filePath = args[0]

  if (!filePath) {
    throw new Error('Usage: npx tsx scripts/parse-doc-file.ts <path>')
  }

  const resolvedPath = resolve(filePath)

  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`)
  }

  const analysis = parseDocFile(resolvedPath)

  // Output structured JSON suitable for agent consumption
  console.log(JSON.stringify(analysis, null, 2))
}

// Run if executed directly via tsx
if (import.meta.url.includes('parse-doc-file') && process.argv[1]?.endsWith('parse-doc-file.ts')) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
