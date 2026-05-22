#!/usr/bin/env tsx
/**
 * scripts/generate-questions.ts — Phase 3: Generate reviewer questions for uncertain classifications.
 *
 * Reads DOCS_INVENTORY.md and produces a list of review questions for entries with low-confidence
 * or missing classifications. Supports overview mode (all questions), batch mode (grouped by folder),
 * and answered-mode tracking via a questions file.
 *
 * Usage:
 *   npx tsx scripts/generate-questions.ts docs                              # All questions
 *   npx tsx scripts/generate-questions.ts docs --batch                      # Grouped by folder
 *   npx tsx scripts/generate-questions.ts docs --batch --size=3             # 3 groups per batch
 *   npx tsx scripts/generate-questions.ts docs --answered                   # Show answered questions
 *
 * @category maintenance
 * @usage npx tsx scripts/generate-questions.ts [docs-root] [--overview|--batch|--answered]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'

// ── Types (aligned with classify-inventory.ts) ─────────────────

interface InventoryBlock {
  id: string
  path: string
  folder: string
  size_kb: number
  lines: number
  status: string
  class: string | null
  confidence: string | null
  proposed_action: string | null
  approval: string | null
  risk: string | null
  reason: string | null
  questions: string[]
  related_files: string[]
  target_path: string | null
  current_step: string | null
  blocker: string | null
  last_updated: string
}

interface QuestionGroup {
  label: string
  ids: string[]
  paths: string[]
  classes: Set<string>
  actions: Set<string>
  reasons: string[]
}

// ── Parse inventory (same logic as classify-inventory.ts) ──────

function parseInventory(filePath: string): InventoryBlock[] {
  const content = readFileSync(resolve(filePath), 'utf-8')
  const blocks: InventoryBlock[] = []

  const yamlBlocks = content.split('```yaml')
  for (const raw of yamlBlocks) {
    const endIdx = raw.indexOf('```')
    if (endIdx === -1) continue

    const yamlText = raw.slice(0, endIdx).trim()
    if (!yamlText) continue

    const block: Partial<InventoryBlock> = {}
    for (const line of yamlText.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const key = line.slice(0, colonIdx).trim()
      let value = line.slice(colonIdx + 1).trim()

      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim()
        value = inner ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')) : []
      }
      if (value === 'null') value = null
      if (key === 'size_kb' || key === 'lines') {
        value = value !== null ? Number(value) : null
      }
      block[key] = value
    }

    if (block.id && typeof block.id === 'string' && block.id.startsWith('F')) {
      blocks.push(block as InventoryBlock)
    }
  }
  return blocks
}

// ── Derive group label from folder/path patterns ───────────────

function deriveGroupLabel(path: string, folder: string): string {
  // Root-level files
  if (folder === 'docs' || folder === '(root)') return 'Root docs/'

  // Extract meaningful folder name
  const parts = path.split('/')
  if (parts.length >= 3 && parts[1] !== '_system') {
    return `docs/${parts[1]}/`
  }
  return folder
}

// ── Group entries by category ──────────────────────────────────

function groupEntries(entries: InventoryBlock[]): Map<string, QuestionGroup> {
  const groups = new Map<string, QuestionGroup>()

  for (const entry of entries) {
    const label = deriveGroupLabel(entry.path, entry.folder)
    if (!groups.has(label)) {
      groups.set(label, {
        label,
        ids: [],
        paths: [],
        classes: new Set(),
        actions: new Set(),
        reasons: [],
      })
    }

    const group = groups.get(label)!
    group.ids.push(entry.id)
    group.paths.push(entry.path)
    if (entry.class) group.classes.add(entry.class)
    if (entry.proposed_action) group.actions.add(entry.proposed_action!)
    if (entry.reason) group.reasons.push(entry.reason)
  }

  return groups
}

// ── Count existing questions in DOCS_QUESTIONS.md ──────────────

function countExistingQuestions(filePath: string): number {
  if (!existsSync(resolve(filePath))) return 0
  const content = readFileSync(resolve(filePath), 'utf-8')
  // Match ## Q### patterns
  const matches = content.matchAll(/## Q(\d{3})/g)
  let maxNum = 0
  for (const match of matches) {
    const num = parseInt(match[1], 10)
    if (num > maxNum) maxNum = num
  }
  return maxNum
}

// ── Extract file IDs from active (unanswered) questions ───────

function extractActiveQuestionIds(filePath: string): Set<string> {
  if (!existsSync(resolve(filePath))) return new Set()
  const content = readFileSync(resolve(filePath), 'utf-8')

  // Split into question blocks by ## Q### headings
  const blocks = content.split(/## Q\d{3}/)
  const activeIds = new Set<string>()

  for (const block of blocks) {
    if (!block.trim()) continue

    // Check if this block is answered (- [x] Answered or in "Answered Questions" section)
    const isAnswered = /- \[x\]\s*Answered/i.test(block)
    if (isAnswered) continue

    // Extract file IDs from Related Files line
    const relatedMatch = block.match(/\*\*Related Files:\*\*\s*(.*)/i)
    if (relatedMatch) {
      const idsStr = relatedMatch[1].trim()
      const ids = idsStr.split(',').map(id => id.trim()).filter(id => id.startsWith('F'))
      for (const id of ids) activeIds.add(id)
    }
  }

  return activeIds
}

// ── OVERVIEW MODE ──────────────────────────────────────────────

function runOverview(inventoryPath: string): void {
  const blocks = parseInventory(inventoryPath)

  // Filter entries needing human review (medium confidence or null class)
  const needsReview = blocks.filter(
    b => b.confidence === 'medium' || b.class === null,
  )

  if (needsReview.length === 0) {
    console.log('✅ No entries need human review — all classified with high confidence.')
    return
  }

  const groups = groupEntries(needsReview)

  // Output compact summary table
  console.log(`📋 Phase 3 Overview — ${needsReview.length} entries need human review\n`)
  console.log('| # | Group | Files | Classes | Actions |')
  console.log('|---|-------|-------|---------|---------|')

  let groupNum = 0
  for (const [label, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groupNum++
    const classes = [...group.classes].join(', ') || '—'
    const actions = [...group.actions].join(', ') || '—'
    console.log(
      `| ${String(groupNum).padStart(2, ' ')} | \`${label}\` | ${group.ids.join(', ')} | ${classes} | ${actions} |`,
    )
  }

  console.log(`\n💡 Use --batch to generate questions for each group.`)
  console.log(`   Example: npx tsx scripts/generate-questions.ts docs --batch --size=1`)
  console.log(`            npx tsx scripts/generate-questions.ts docs --batch --size=3 --start=2`)
}

// ── BATCH MODE ─────────────────────────────────────────────────

function runBatch(
  inventoryPath: string,
  questionsPath: string,
  batchSize: number,
  startOffset: number,
): void {
  const blocks = parseInventory(inventoryPath)

  // Filter entries needing human review
  let needsReview = blocks.filter(
    b => b.confidence === 'medium' || b.class === null,
  )

  if (needsReview.length === 0) {
    console.log('✅ No entries need human review.')
    return
  }

  // Deduplicate: skip entries already covered by active (unanswered) questions
  const activeIds = extractActiveQuestionIds(questionsPath)
  if (activeIds.size > 0) {
    needsReview = needsReview.filter(b => !activeIds.has(b.id))
    console.log(`📝 Skipped ${activeIds.size} entries already covered by active questions.`)
  }

  if (needsReview.length === 0) {
    console.log('✅ All reviewable entries already have active questions.')
    return
  }

  // Get the batch slice
  const totalEntries = needsReview.length
  const startIdx = Math.min(startOffset, totalEntries - 1)
  const endIdx = Math.min(startOffset + batchSize, totalEntries)

  if (startIdx >= totalEntries) {
    console.log(`✅ All ${totalEntries} entries have been processed. No more batches.`)
    return
  }

  const batchSlice = needsReview.slice(startIdx, endIdx)

  // Group this batch
  const groups = groupEntries(batchSlice)

  // Count existing questions to determine next Q number
  let qNum = countExistingQuestions(questionsPath) + 1

  // Build question entries for this batch
  const newQuestions: string[] = []

  for (const [label, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const classes = [...group.classes].join(', ') || 'unclassified'
    const actions = [...group.actions].join(', ') || 'unknown'

    // Derive question text from context
    let questionText = ''
    if (actions.includes('archive') && !actions.includes('move')) {
      questionText = `Should these ${group.ids.length} file(s) be archived? They are classified as "${classes}" with proposed action: archive.`
    } else if (actions.includes('move')) {
      const targets = group.paths.map(p => {
        // Find target from inventory block
        const block = blocks.find(b => b.path === p)
        return block?.target_path ? `${p} → ${block.target_path}` : p
      })
      questionText = `Should these files be moved? Classified as "${classes}". Proposed moves:\n${targets.map(t => `- ${t}`).join('\n')}`
    } else {
      questionText = `How should these ${group.ids.length} file(s) be handled? Currently classified as "${classes}" with actions: ${actions}.`
    }

    // Summarize reasons (take first unique reason per entry, deduplicate)
    const uniqueReasons = [...new Set(group.reasons)].slice(0, 2)
    const contextText = uniqueReasons.length > 0
      ? `Classification reasoning: ${uniqueReasons.join('; ')}`
      : 'No specific classification reasoning provided.'

    newQuestions.push(`## Q${String(qNum).padStart(3, '0')} — Review: ${label}

**Related Files:** ${group.ids.join(', ')}  
**Context:** ${contextText}  
**Question:** ${questionText}  

- [ ] Answered  
- **Answer:** _(fill during Phase 3)_`)

    qNum++
  }

  // Append to DOCS_QUESTIONS.md
  const resolvedQPath = resolve(questionsPath)
  let existingContent = ''
  if (existsSync(resolvedQPath)) {
    existingContent = readFileSync(resolvedQPath, 'utf-8')
  }

  // Remove placeholder and format example before inserting
  existingContent = existingContent.replace('_No active questions._\n', '')
  // Remove the "Question Format" documentation block (no longer needed once real questions exist)
  const formatBlockRegex = /### Question Format\s*```markdown[\s\S]*?```\n?\n/g
  if (existingContent.includes('Q00') || existingContent.includes('Q0')) {
    // Real questions already exist — strip the format example
    existingContent = existingContent.replace(formatBlockRegex, '')
  }

  // Insert before "Answered Questions" section (preferred) or append
  const answeredSectionIdx = existingContent.indexOf('## Answered Questions')
  let updatedContent: string

  if (answeredSectionIdx !== -1) {
    // Get content before answered section, clean up trailing separators/blank lines
    const beforeRaw = existingContent.slice(0, answeredSectionIdx)
    const before = beforeRaw.replace(/\s*---\s*$/, '').trimEnd()
    const answeredRest = existingContent.slice(answeredSectionIdx + '## Answered Questions'.length)
    // Ensure blank line between heading and first question
    const after = '\n\n---\n\n## Answered Questions\n\n' + answeredRest.replace(/^\s*\n?/, '')
    updatedContent = `${before}\n\n${newQuestions.join('\n\n')}${after}`
  } else {
    // No answered section — append at end
    const trimmed = existingContent.trimEnd()
    updatedContent = `${trimmed}\n\n${newQuestions.join('\n\n')}`
  }

  writeFileSync(resolvedQPath, updatedContent, 'utf-8')

  // Console summary
  console.log(`📝 Batch ${startIdx + 1}–${endIdx} of ${totalEntries}`)
  console.log(`   Generated ${newQuestions.length} question(s): Q${qNum - newQuestions.length}–Q${qNum - 1}`)
  console.log(`   Written to: ${resolvedQPath}\n`)

  // Show remaining count
  const remaining = totalEntries - endIdx
  if (remaining > 0) {
    console.log(`📊 Remaining: ${remaining} entries in ${Math.ceil(remaining / batchSize)} more batch(es)` )
    console.log(`   Next: npx tsx scripts/generate-questions.ts docs --batch --size=${batchSize} --start=${endIdx}`)
  } else {
    console.log('✅ All entries processed — no remaining batches.')
  }
}

// ── ANSWERED MODE — Extract answered questions as JSONL ───────

interface AnsweredQuestion {
  id: string
  relatedFiles: string[]
  context: string
  question: string
  answer: string
}

function parseAnsweredQuestions(filePath: string): AnsweredQuestion[] {
  if (!existsSync(resolve(filePath))) return []
  const content = readFileSync(resolve(filePath), 'utf-8')
  const results: AnsweredQuestion[] = []

  // Split into question blocks by ## Q### headings
  const blockRegex = /## (Q\d{3})\s*—\s*.+?\n([\s\S]*?)(?=## Q\d{3}|## Answered|$)/g
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(content)) !== null) {
    const qId = match[1] // e.g. "Q002"
    const body = match[2]

    // Check if answered
    if (!/- \[x\]\s*Answered/i.test(body)) continue

    // Extract Related Files
    const relatedMatch = body.match(/\*\*Related Files:\*\*\s*(.*)/i)
    const relatedFiles: string[] = relatedMatch
      ? relatedMatch[1].split(',').map(s => s.trim()).filter(id => id.startsWith('F'))
      : []

    // Extract Context
    const contextMatch = body.match(/\*\*Context:\*\*\s*(.*)/i)
    const context = contextMatch ? contextMatch[1].trim() : ''

    // Extract Question
    const questionMatch = body.match(/\*\*Question:\*\*\s*(.*)/is)
    const question = questionMatch ? questionMatch[1].trim().replace(/^\n/, '').trim() : ''

    // Extract Answer — grab everything after **Answer:** until end of block or next field
    const answerMatch = body.match(/- \*\*Answer:\*\*\s*(.*)/is)
    let answer = ''
    if (answerMatch) {
      answer = answerMatch[1].trim()
    }

    results.push({ id: qId, relatedFiles, context, question, answer })
  }

  return results
}

function runAnswered(questionsPath: string): void {
  const answered = parseAnsweredQuestions(questionsPath)

  if (answered.length === 0) {
    console.log('✅ No answered questions found.')
    return
  }

  // Output as JSONL — one line per answered question
  for (const q of answered) {
    console.log(JSON.stringify(q))
  }
}

// ── CLI Entry Point ────────────────────────────────────────────

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const docsDir = args[0] ? resolve(args[0]) : resolve('docs')
  const inventoryPath = join(docsDir, '_system', 'DOCS_INVENTORY.md')
  const questionsPath = join(docsDir, '_system', 'DOCS_QUESTIONS.md')

  // Parse flags
  const overviewMode = args.includes('--overview')
  const batchMode = args.includes('--batch')
  const answeredMode = args.includes('--answered')
  const batchSizeMatch = args.find(a => a.startsWith('--size='))
  const startMatch = args.find(a => a.startsWith('--start='))
  const batchSize = batchSizeMatch ? parseInt(batchSizeMatch.split('=')[1], 10) : 5
  const startOffset = startMatch ? parseInt(startMatch.split('=')[1], 10) : 0

  if (!overviewMode && !batchMode && !answeredMode) {
    console.log('Usage:')
    console.log('  npx tsx scripts/generate-questions.ts docs --overview              # summary of entries needing review')
    console.log('  npx tsx scripts/generate-questions.ts docs --batch                 # generate questions for first batch')
    console.log('  npx tsx scripts/generate-questions.ts docs --batch --size=3        # generate questions for 3 groups')
    console.log('  npx tsx scripts/generate-questions.ts docs --batch --start=5       # resume from offset 5')
    console.log('  npx tsx scripts/generate-questions.ts docs --answered              # extract answered questions as JSONL')
    process.exit(1)
  }

  if (!existsSync(inventoryPath)) {
    throw new Error(`Inventory file not found: ${inventoryPath}\nRun scan-inventory.ts first.`)
  }

  if (overviewMode) {
    runOverview(inventoryPath)
  } else if (batchMode) {
    runBatch(inventoryPath, questionsPath, batchSize, startOffset)
  } else if (answeredMode) {
    runAnswered(questionsPath)
  }
}

// Run if executed directly via tsx
if (import.meta.url.includes('generate-questions') && process.argv[1]?.endsWith('generate-questions.ts')) {
  main().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}
