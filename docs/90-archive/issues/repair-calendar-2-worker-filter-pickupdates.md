# Issue 2: Worker Filter + PickupDate Markers

**Labels:** `needs-triage` `feature` `ui` `vertical-slice-2`  
**Parent PRD:** [Repair Calendar View](../prds/repair-calendar.md)  

## User Story

As a shop operator, I want to filter by worker and see both planned work and pickups on the calendar, so that I can check if someone is overloaded or underutilized.

## Acceptance Criteria

- [ ] Worker dropdown at top of CalendarView with "All Workers" default
- [ ] Filtering correctly subsets repairs by `assignedTo` field
- [ ] Both `plannedDate` and `pickupDate` render as separate markers on different days
- [ ] Multi-day repairs show distinct markers (no spanning bars) — e.g., blue block for planned work, green marker for pickup
- [ ] Status colors apply consistently to both date types

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `client/src/features/repairs/components/CalendarToolbar.tsx` | Create | Worker dropdown + view toggle buttons (Day/Week/Month) |
| `client/src/features/repairs/components/CalendarCell.tsx` | Modify | Render multiple markers per day if needed |
| `client/src/features/repairs/components/CalendarView.tsx` | Modify | Wire up worker filter state |

## Dependencies

- Issue 1 (must have calendar grid rendering first)

## Testing Strategy

- **Unit test:** Worker filter correctly subsets repairs by `assignedTo`
- **Integration test:** Both plannedDate and pickupDate render as separate markers on different days
