# Repair Bugs Fix — Vertical Slice Breakdown

## Parent PRD
`docs/prd/repair-bugs-fixes.md`

---

## Slices (Draft)

### 1. Timer as Timecard — Remove Labor Confirmation, Persist Cumulative Minutes
- **Type:** AFK
- **Blocked by:** None
- **Stories covered:** 5, 6, 7
- **Scope:**
  - Strip `LaborConfirmDialog` and all labor confirmation logic from the client
  - Simplify `/timer/stop` server endpoint to only calculate + save cumulative `elapsedSeconds`, return `{ elapsedSeconds }` — no worker rate lookups, no suggested totals
  - Replace `hoursWorked` → `minutesWorked` in shared types & Zod schemas
  - Update Add Item dialog: show logged time as pre-filled hint for labor items; server calculates `(min/60) × hourlyRate`
  - Delete `LaborConfirmDialog.tsx`

### 2. Instant Line Item Updates — Direct API Calls Replace Route Revalidation
- **Type:** AFK
- **Blocked by:** None
- **Stories covered:** 4
- **Scope:**
  - Replace `navigate('.', { replace: true })` in both `handleAddItem` and `handleRemoveItem` with direct calls to `getRepairWithItems()` + `setRepairItems()`
  - Remove the stale comments about "Task 4.4 refetch"

### 3. Enforce Single Payment Path — Remove Dead "Complete & Pay" Button
- **Type:** AFK
- **Blocked by:** None
- **Stories covered:** 1, 2, 3
- **Scope:**
  - Remove the "Complete & Pay" button from the Actions section when status is `ready` (it's dead code that only PATCHes status)
  - Keep `RepairPaymentForm` as the sole completion path — it already handles everything atomically
  - Ensure $0 repairs can still complete through the form

---

## Notes
- All three slices are independent and can be implemented in parallel.
- Ready to publish to GitHub issues once repo integration is set up.
