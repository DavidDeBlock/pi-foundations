---
name: vertical-slice-builder
description: Orchestrates end-to-end feature implementation (Plan -> Build -> Review) using a strict "Blueprint" approach with automated quality gates. Use when implementing complex features requiring high consistency and zero hallucination.
---

# Vertical Slice Builder Workflow

## Overview
This skill orchestrates the entire lifecycle of a vertical slice, ensuring that every line of code matches a prescriptive Blueprint before it is shown to the user. It acts as the "Manager" between the Planner, Builder, and Reviewer agents.

## The Rules
1. **Prescriptive Blueprints**: Plans must include specific Tailwind classes, Zod schemas, and exact logic. No vague descriptions like "make it look nice."
2. **Silent Re-work**: If the Reviewer finds an error, the Orchestrator sends a fix request to the Builder *without* showing the user. The loop continues until the Reviewer approves.
3. **Incremental Verification**: We only review the current slice's tasks against the plan file in `.pi/plans/active/`.

## Workflow

### Phase 1: Planning (One-time per feature)
1. Invoke **Planner** to create a detailed Blueprint.
2. Constraint: Save to `.pi/plans/active/{feature-name}.md`. If the folder does not exist, create it.
3. Ensure the plan includes:
   - Specific file paths and content descriptions.
   - Zod schemas for all API contracts (e.g., `z.object({ amount: z.number() })`).
   - Tailwind classes for key UI components (e.g., "Use `bg-blue-500` for primary buttons").

### Phase 2: Slice Execution Loop (Repeat per slice)
For each slice in the plan:

1. **Build**: Invoke **TypeScript Implementer** with the specific tasks for this slice from the Blueprint file.
   - *Instruction*: "Implement these tasks exactly as described in `.pi/plans/active/{feature-name}.md`."
2. **Review**: Invoke **Reviewer**.
   - *Instruction*: "Compare the code changes against `.pi/plans/active/{feature-name}.md` (specifically Slice N). Check for CSS mismatches, API schema errors, and logic gaps."
3. **Silent Re-work Loop**:
   - If Reviewer passes -> Proceed to next slice.
   - If Reviewer fails -> Pass the specific critique back to **TypeScript Implementer** as a "Fix Request". Do not show user. Repeat Step 2 & 3 until passed.

### Phase 3: Completion
1. Move the plan file from `.pi/plans/active/{feature-name}.md` to `.pi/plans/archive/{feature-name}.md`.
2. Notify user that the feature is complete and ready for manual testing.
