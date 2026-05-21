# PRD: Repair Calendar View

**Status:** Draft  
**Labels:** `needs-triage` `feature` `ui`  
**Created:** 2026-05-05  

## Problem Statement

As a repair shop operator, you have no visual overview of your shop's workload across time. You can only see repairs in a list view with status filters, making it impossible to quickly answer "how busy are we this week?" or "who's picking up today?".

## Solution

Add a **Calendar View** tab alongside existing Repairs and Workers tabs. It displays all active repairs on a weekly grid (with day/month toggle options), color-coded by repair status. Users can filter by worker, click any repair to open the detail drawer, but no drag-and-drop editing — just view + quick actions from the drawer.

## User Stories

1. As a shop operator, I want to see all active repairs on a weekly calendar grid, so that I can instantly gauge how busy the shop is
2. As a shop operator, I want each repair block to be color-coded by status (intake/in_progress/on_hold/ready/completed), so that I can spot bottlenecks at a glance
3. As a shop operator, I want both `plannedDate` and `pickupDate` shown as separate markers on the calendar, so that I see both "work happening" and "pickups coming"
4. As a shop operator, I want to filter the calendar by individual worker via a dropdown at the top, so that I can check if someone is overloaded or underutilized
5. As a shop operator, I want to click any repair block to open a detail drawer (reusing existing RepairDetailPanel), so that I can read/edit details without losing my place in the calendar
6. As a shop operator, I want multi-day repairs to show separate markers for each date rather than spanning bars, so that status changes are accurately represented at each point in time
7. As a shop operator, I want to switch between Day/Week/Month views with Week as default, so that I can zoom in or out depending on my planning horizon
8. As a shop operator, I want completed/cancelled repairs to appear muted or dimmed rather than hidden, so that historical data is still visible but doesn't distract from active work

## Implementation Decisions

- **Placement:** New "Calendar" tab in `RepairsFeature.tsx` alongside Repairs/Workers tabs
- **Library:** Use existing `react-day-picker` v9 (already installed) — no new dependencies needed
- **Data flow:** Calendar fetches same repairs data as the list view via loader; store already has all repair state
- **Visual encoding:** Compact colored blocks per status, small text label (customer name or bike identifier), separate markers for plannedDate vs pickupDate
- **Interaction model:** Click → detail drawer/panel. No drag-and-drop. View-only calendar with quick actions from the drawer.
- **Worker filter:** Dropdown at top of calendar view, default "All Workers"

## Modules to Build

1. `CalendarView` — Main component wrapping day-picker grid with repair blocks
2. `CalendarCell` — Individual day cell rendering repair markers with status colors
3. `CalendarToolbar` — Worker dropdown + Day/Week/Month toggle + navigation (prev/next)
4. `CalendarDetailDrawer` — Slide-over panel reusing existing detail logic for selected repair

## Testing Decisions

- Test `CalendarCell` color mapping against all 6 statuses in isolation
- Test worker filter correctly subsets repairs by `assignedTo`
- Test that both plannedDate and pickupDate render as separate markers on different days
- Integration test: CalendarView renders without errors when loaded with real repair data

## Out of Scope

- Drag-and-drop rescheduling
- Creating new repairs from the calendar (double-click to create)
- Recurring/subscription repairs
- Mobile-responsive calendar grid (assume desktop/tablet for now)
- Export/print calendar views
