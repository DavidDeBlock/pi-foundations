# ADR-007: Sequence Table for Document Numbering

**Status**: Accepted  
**Date**: 2026-05-19  

---

## Context

All financial documents in the POS require human-readable sequential numbers (`SA-0001`, `INV-0001`, `QT-0001`, etc.). These are unique-constrained in the schema and expected by shop staff for receipt referencing. Three approaches were considered:

| Option | Approach | Problem |
|--------|----------|---------|
| A | `MAX(sale_number)` + 1 | Race condition under concurrent checkouts — two simultaneous sales could collide on the same number |
| B | **Dedicated `sequences` table** with atomic `UPDATE ... SET current_value = current_value + 1` | None identified; chosen approach |
| C | UUIDs only, no sequential numbers | Loses human-readable receipt numbering that cashiers and customers naturally reference |

## Decision

Use a dedicated `sequences` table for all document number generation. One row per sequence name (`sale`, `invoice`, `quote`, etc.). Increment atomically via SQLite's implicit row-level locking on `UPDATE`.

```sql
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,           -- 'sale', 'invoice', 'quote', ...
  current_value INTEGER NOT NULL DEFAULT 0
);
```

Generation is a two-step query:
1. `UPDATE sequences SET current_value = current_value + 1 WHERE name = 'sale'`
2. `SELECT current_value FROM sequences WHERE name = 'sale'`

Both run inside the same transaction as the sale creation, guaranteeing uniqueness and ordering.

## Consequences

**Positive:**
- Collision-free under concurrent checkouts (SQLite serializes writes)
- Single table serves all document types — no per-table logic duplication
- Numbers are strictly sequential and gap-free within a transaction boundary

**Negative:**
- Adds one extra table to the schema
- Requires explicit seeding on first migration (`INSERT INTO sequences VALUES ('sale', 0), ('invoice', 0)`)

---

## History

| Date | Change | Author |
|------|--------|--------|
| 2026-05-19 | Created and accepted | David De Block |
