# Issue 1: Calendar Tab + Week View with Status Colors

**Labels:** `needs-triage` `feature` `ui` `vertical-slice-1`  
**Parent PRD:** [Repair Calendar View](../prds/repair-calendar.md)  

## User Story

As a shop operator, I want to see all active repairs on a weekly calendar grid color-coded by status, so that I can instantly gauge how busy the shop is.

## Acceptance Criteria

- [ ] New "Calendar" tab added alongside Repairs and Workers tabs in `RepairsFeature.tsx`
- [ ] Week view renders using `react-day-picker` v9 (already installed)
- [ ] Each repair appears as a colored block on its `plannedDate` cell
- [ ] Color mapping by status:
  - `intake` → neutral gray
  - `in_progress` → blue/amber tint
  - `on_hold` → orange/warning tint
  - `ready` → green tint
  - `completed` → muted/dimmed
  - `cancelled` → strikethrough or grayed out
- [ ] Small text label shows customer name or bike identifier inside each block
- [ ] Clicking a repair block does nothing yet (placeholder for Issue 3)

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `client/src/features/repairs/components/CalendarView.tsx` | Create | Main component wrapping day-picker grid with repair blocks |
| `client/src/features/repairs/components/CalendarCell.tsx` | Create | Individual day cell rendering repair markers with status colors |
| `client/src/features/repairs/routes.tsx` | Modify | Add Calendar route/tab alongside Repairs and Workers |

## Dependencies

- None (first slice, establishes the foundation)

## Testing Strategy

- **Unit test:** `CalendarCell` color mapping against all 6 statuses
- **Integration test:** `CalendarView` renders without errors when loaded with real repair data from store/loader
