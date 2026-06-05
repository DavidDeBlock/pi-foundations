# Pi Agent Configuration

This directory contains configuration and documentation for the Pi agent system.

## Structure

- `skills/` - Skill definitions (one per specialized role)
- `plans/` - Generated task plans and briefs
- `docs/` - Architecture documents and design decisions

## How to Use

The project follows a controlled, step-by-step engineering process:

1. **Planner** breaks down broad requests into actionable slices
2. **Architect** validates structural decisions
3. **Builder** implements planned features
4. **Reviewer** validates quality and consistency

See `.pi/prompts/start.md` for the full project vision and process.

## Current Status

- ✅ Architecture v0.0.1 complete (`.pi/docs/architecture-v001.md`)
- ✅ Folder structure created
- ✅ App ↔ Feature communication infrastructure (event emitter, notification service, global store)
- ⏭️ Next: Auth feature implementation
