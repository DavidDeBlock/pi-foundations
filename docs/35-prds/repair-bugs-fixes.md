# PRD: Repair Flow Bug Fixes & Timer Simplification

## Problem Statement

The repair management flow has critical and usability bugs that break core business operations: completing repairs silently bypasses payment processing, adding/removing line items causes UI lag due to unnecessary route revalidation, and the timer/labor billing system is overly complex with a 100x pricing error and data loss on page refresh. These issues force operators into manual workarounds and risk financial/inventory discrepancies.

## Solution

Simplify the repair completion flow to enforce a single payment path via `RepairPaymentForm`. Replace the dead "Complete & Pay" button. Decouple the work timer from labor billing, turning it into a pure timecard that tracks cumulative minutes server-side. Update line item add/remove flows to use direct API calls for instant UI updates instead of route revalidation.

## User Stories

1. As a shop operator, I want to complete a repair only through the payment form, so that sales are automatically recorded and inventory is deducted without manual workarounds.
2. As a shop operator, I want the "Complete & Pay" button removed from the ready state, so that I don't accidentally bypass payment processing or create orphaned completed repairs.
3. As a shop operator, I want to complete $0 repairs (like free checkups) through the same payment form, so that all completions follow a consistent audit trail and no data is lost.
4. As a shop operator, I want line items to appear instantly after adding or removing them, without waiting for route revalidation or page refreshes.
5. As a shop mechanic, I want the work timer to act as a simple timecard that logs cumulative minutes server-side, so that my tracked time persists across page refreshes and isn't lost when the browser reloads.
6. As a shop operator, I want to manually enter labor minutes and hourly rates when adding a labor line item, so that billing is accurate and intuitive without complex automatic calculations or confusing decimal hours.
7. As a shop operator, I want the labor entry form to pre-fill with the logged timer minutes as a hint, so that I can quickly bill for tracked time with one click while retaining full control over the final amount.

## Implementation Decisions

- **Repair Completion Path:** Enforce single path via `RepairPaymentForm`. Remove `handleTransition('completed')` from the Actions section in the detail panel. The form handles status transition to `completed`, sale creation, payment recording, and inventory deduction atomically on the server.
- **Line Item Updates:** Replace route revalidation (`navigate('.', { replace: true })`) in add/remove handlers with direct calls to fetch updated repair items and update the Zustand store immediately. This eliminates unnecessary route loader re-execution and provides instant UI feedback.
- **Timer Simplification (Timecard):** Decouple timer from billing. The server `/timer/stop` endpoint will only calculate cumulative `elapsedSeconds`, save it, clear `timerStartedAt`, and return `{ elapsedSeconds }`. No labor calculations or worker rate lookups on stop. Remove the `LaborConfirmDialog` entirely.
- **Manual Labor Entry:** Replace `hoursWorked` with `minutesWorked` in the repair item schema. When adding a labor item, the UI shows logged time as a pre-filled hint (editable). The server calculates total price using `(minutes / 60) * hourlyRate`. This eliminates double-conversion bugs and makes billing intuitive for non-decimal minutes.
- **Schema/Validation Updates:** Update shared types and Zod schemas to reflect `minutesWorked` instead of `hoursWorked`. Adjust API contracts accordingly.

## Testing Decisions

- Test the atomic payment transaction on `/complete-payment` to ensure sales, sale items, payments, inventory deduction, and status updates all succeed or roll back together.
- Test timer persistence: start timer, stop it (verify server saves `elapsedSeconds`), refresh page, verify UI recovers correctly from server state without drift.
- Test line item add/remove: verify store updates immediately via direct API call without route revalidation.
- Test labor billing calculation: verify `(minutes / 60) * hourlyRate` produces correct cents on the server for various minute inputs (e.g., 33 min, 45 min).

## Out of Scope

- Actual SMS/email notification delivery (placeholder remains as-is).
- Complex split-payment UI enhancements beyond current form.
- Automatic labor billing based on timer duration.
- Bicycle status propagation changes outside standard lifecycle.
- Multi-worker time tracking or shift-based accounting.

## Further Notes

This PRD consolidates four related bugs into a single implementation session to avoid context switching and ensure consistent behavior across the repair flow. The core philosophy is **simplicity over automation**: timers track time, operators bill manually, payments are explicit. This reduces edge cases, eliminates conversion math errors, and aligns with how shop operators actually work in practice.
