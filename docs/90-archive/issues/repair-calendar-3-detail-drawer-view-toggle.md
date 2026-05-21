# Issue 3: Detail Drawer + Day/Month Toggle

**Labels:** `needs-triage` `feature` `ui` `vertical-slice-3`  
**Parent PRD:** [Repair Calendar View](../prds/repair-calendar.md)  

## User Story

As a shop operator, I want to click any repair block to open a detail drawer and switch between day/week/month views, so that I can read/edit details without losing my place in the calendar.

## Acceptance Criteria

- [ ] Clicking a repair block opens a slide-over drawer (not page navigation)
- [ ] Drawer reuses existing `RepairDetailPanel` logic for displaying repair info
- [ ] Day/Week/Month toggle buttons work correctly with view switching
- [ ] Prev/Next week navigation works in all three views
- [ ] Completed/cancelled repairs appear muted/dimmed rather than hidden

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `client/src/features/repairs/components/CalendarDetailDrawer.tsx` | Create | Slide-over panel reusing existing detail logic for selected repair |
| `client/src/features/repairs/components/CalendarToolbar.tsx` | Modify | Add Day/Week/Month toggle + prev/next nav buttons |
| `client/src/features/repairs/components/CalendarCell.tsx` | Modify | Wire click handler to open drawer with selected repair ID |

## Dependencies

- Issue 2 (must have worker filter and both date types working)

## Testing Strategy

- **Integration test:** Drawer opens on click, displays correct repair data from store
- **Unit test:** View toggle correctly switches between Day/Week/Month modes
- **Visual regression:** Completed/cancelled repairs render with muted styling
