# Line Items Standardization — Plan

## Scope

Standardize shared fields across all line-item tables. Each entity keeps its own table (no universal `line_items` table). Backorder part + bicycle lines consolidate into one table.

---

## 1. Schema Changes

### Shared Line-Item Contract

All four line-item tables will share these columns:

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | text (PK) | no | — | Primary key |
| `[parent_id]` | text (FK) | no | — | FK to respective parent table (`sale_items.sale_id`, `repair_items.repair_id`, etc.) |
| `line_type` | text | no | — | Enum: `product` \| `labor` \| `bicycle` |
| `product_id` | text (FK) | yes | — | FK to `products.id`. Only meaningful for `line_type = 'product'`. App-level enforcement. |
| `description` | text | no | — | Snapshot or free text |
| `quantity` | integer | no | 1 | Number of units |
| `unit_price_net` | integer (number) | no | — | Ex-tax cents per unit |
| `vat_rate` | integer | no | — | Basis points (e.g., 2100 = 21%) |
| `discount_percent` | integer | yes | NULL | Basis points. NULL = no discount |
| `line_total_net` | integer (number) | no | — | Computed: discounted net total |
| `line_total_vat` | integer (number) | no | — | Computed: VAT amount |
| `line_total_gross` | integer (number) | no | — | Computed: incl-tax total |
| `metadata_json` | text | yes | NULL | JSON blob for entity-specific data. Governed schema per line_type. |
| `created_at` | integer (timestamp) | no | now() | Creation timestamp |

### Metadata JSON Contract (Governed Schema)

```json
// product — no metadata needed
null  // or {}

// labor
{
  "billingType": "hourly" | "fixed",
  "minutesWorked": 45,        // only when billingType === "hourly"
  "hourlyRate": 6000          // only when billingType === "hourly" (cents)
}

// bicycle
{
  "brand": "Oxford",
  "model": "City X",
  "year": 2026,
  "color": "black",
  "frameSize": "M",
  "frameNumber": "ABC123"     // optional
}
```

### Calculation Contract (Service Layer)

Discount applies to **net** price before VAT (Belgian tax standard):

```typescript
const discountMultiplier = line.discountPercent != null 
  ? 1 - line.discountPercent / 10000 
  : 1;

const discountedUnitPriceNet = Math.round(line.unitPriceNet * discountMultiplier);
const lineTotalNet = discountedUnitPriceNet * line.quantity;
const vatAmount = Math.round(lineTotalNet * (line.vatRate / 10000));
const lineTotalGross = lineTotalNet + vatAmount;

return {
  line_total_net: lineTotalNet,
  line_total_vat: vatAmount,
  line_total_gross: lineTotalGross,
};
```

### Per-Table Changes

#### `sale_items` (ADD columns)
| Column | Action | Notes |
|--------|--------|-------|
| `line_type` | ADD COLUMN | Default `'product'`. Backfill from existing data. |
| `description` | ADD COLUMN | Nullable during migration, backfilled later. |
| `vat_rate` | ADD COLUMN | Already exists ✅ — no change needed. |
| `discount_percent` | ADD COLUMN | Already exists ✅ — no change needed. |
| `line_total_net` | ADD COLUMN | Computed from existing fields. Backfill required. |
| `line_total_vat` | ADD COLUMN | New field. Backfill required. |
| `metadata_json` | ADD COLUMN | NULL for all existing rows. |
| `created_at` | ADD COLUMN | Default now(). Backfilled with row creation time if available. |

**Columns to deprecate (keep for backward compat during transition):**
- `unitPrice` → derive from `unit_price_net` + discount at read time
- `lineTotal` → derive from `line_total_gross`
- `price` → redundant, keep only `unit_price_net`

#### `repair_items` (ADD columns)
| Column | Action | Notes |
|--------|--------|-------|
| `description` | ADD COLUMN | Nullable during migration. Backfill from product name or labor description. |
| `line_total_net` | ADD COLUMN | Computed. Backfill required. |
| `line_total_vat` | ADD COLUMN | New field. Backfill required. |
| `metadata_json` | ADD COLUMN | Migrate existing: `{ "billingType": ..., "minutesWorked": ..., "hourlyRate": ... }` for labor lines; `{}` for parts. |

**Columns to deprecate (keep during transition):**
- `unitPrice` → derive from `unit_price_net` + discount at read time
- `lineTotal` → derive from `line_total_gross`
- `minutesWorked`, `hourlyRate`, `billingType` → move into `metadata_json`

#### `quote_line_items` (ADD columns)
| Column | Action | Notes |
|--------|--------|-------|
| `line_type` | ADD COLUMN | Migrate existing: `'part'` → `'product'`, `'labor'` stays, `'bicycle'` stays. |
| `description` | ADD COLUMN | Nullable during migration. Backfill from product name or description. |
| `quantity` | ADD COLUMN | Default 1. Backfill all existing rows with 1. |
| `discount_percent` | ADD COLUMN | Already exists ✅ — no change needed. |
| `line_total_net` | ADD COLUMN | Computed. Backfill required. |
| `line_total_vat` | ADD COLUMN | New field. Backfill required. |
| `metadata_json` | ADD COLUMN | Migrate existing: `bicycleDetails` → merge into unified metadata; `{}` for parts/labor. |

**Columns to deprecate (keep during transition):**
- `productName` → keep as-is for backward compat, but `description` is the canonical field going forward
- `unitPriceNet`, `lineTotalGross` already exist ✅ — no change needed

#### Backorder Consolidation: `backorder_part_lines` + `backorder_bicycle_lines` → `backorder_line_items` (NEW TABLE)

Create new table with standardized schema. Migrate+merge data from both old tables:

| Source Field | Target Field | Transformation |
|-------------|-------------|----------------|
| — | `line_type` | `'product'` for part lines, `'bicycle'` for bicycle lines |
| `productId` | `product_id` | FK to products (only for part lines) |
| `name` | `description` | Snapshot of product name / bike description |
| `unitPrice` | → derive from `unit_price_net` + discount at read time | Deprecated |
| `quantity` | `quantity` | Direct copy |
| `lineTotal` | → derive from `line_total_gross` | Deprecated |
| `unitPriceNet`, `vatRate`, `discountPercent` | Same columns | Already standardized ✅ |
| — | `line_total_net` | Computed. Backfill required. |
| — | `line_total_vat` | New field. Backfill required. |
| — | `metadata_json` | Part lines: NULL/`{}`. Bicycle lines: `{ "brand": ..., "model": ..., ... }` from existing fields |

**Columns to deprecate (keep during transition):**
- `unitPrice`, `lineTotal` → derive at read time
- `name` → keep for backward compat, but `description` is canonical going forward
- Bicycle-specific columns (`brand`, `model`, `year`, `color`, `frameSize`) → move into `metadata_json`

---

## 2. Migration / Backfill Plan

### Phase 1: Schema Changes (DDL)

**Step A:** Add new columns to existing tables
```sql
-- sale_items
ALTER TABLE sale_items ADD COLUMN line_type TEXT DEFAULT 'product';
ALTER TABLE sale_items ADD COLUMN description TEXT;
ALTER TABLE sale_items ADD COLUMN line_total_net INTEGER;
ALTER TABLE sale_items ADD COLUMN line_total_vat INTEGER;
ALTER TABLE sale_items ADD COLUMN metadata_json TEXT;
ALTER TABLE sale_items ADD COLUMN created_at INTEGER DEFAULT (strftime('%s', 'now'));

-- repair_items
ALTER TABLE repair_items ADD COLUMN description TEXT;
ALTER TABLE repair_items ADD COLUMN line_total_net INTEGER;
ALTER TABLE repair_items ADD COLUMN line_total_vat INTEGER;
ALTER TABLE repair_items ADD COLUMN metadata_json TEXT;

-- quote_line_items
ALTER TABLE quote_line_items ADD COLUMN line_type TEXT DEFAULT 'product';
ALTER TABLE quote_line_items ADD COLUMN description TEXT;
ALTER TABLE quote_line_items ADD COLUMN quantity INTEGER DEFAULT 1;
ALTER TABLE quote_line_items ADD COLUMN line_total_net INTEGER;
ALTER TABLE quote_line_items ADD COLUMN line_total_vat INTEGER;
ALTER TABLE quote_line_items ADD COLUMN metadata_json TEXT;

-- backorder consolidation: create new table
CREATE TABLE backorder_line_items ( ... ); -- full schema as defined above

-- Add indexes for new tables
CREATE INDEX idx_backorder_line_items_backorder_id ON backorder_line_items(backorder_id);
```

**Step B:** Backfill computed fields
- Run SQL scripts to compute `line_total_net`, `line_total_vat` from existing data on all four tables.
- Migrate metadata for repair items and bicycle lines into JSON format.
- Set `line_type` values: `'product'` for sale_items, backorder_part_lines; migrate quote_line_items types (`part` → `product`).

### Phase 2: Service Layer Updates (Dual-Write)

Update all service methods that create/update line items to write both old and new columns. This ensures zero data loss during transition.

**Affected services:**
- `repairItemService.ts` — create, update, delete repair items
- `saleItemService.ts` — create, update sale items
- `quoteLineItemService.ts` — create, update quote line items
- `backorderService.ts` — create/update backorder lines (merge from two tables to one)

### Phase 3: Read Path Migration

Update all read queries to use new columns (`line_total_net`, `line_total_vat`, `metadata_json`). Old columns remain readable for backward compat.

### Phase 4: Cleanup (Future Migration)

After verifying everything works:
- Drop deprecated columns (`unitPrice`, `lineTotal`, etc.) — requires SQLite table recreation
- Drop old backorder tables (`backorder_part_lines`, `backorder_bicycle_lines`)
- Remove old enum values from code

---

## 3. Affected Service / API Changes

### Services to Update

| File | Changes |
|------|---------|
| `repairItemService.ts` | Add `line_type`, `description`, `metadata_json` to create/update. Compute new financial fields. Migrate existing data on first read. |
| `saleItemService.ts` | Same as above + set default `line_type = 'product'`. Support labor/bicycle lines from repair/backorder conversions. |
| `quoteLineItemService.ts` | Add columns, migrate `part` → `product` enum, backfill quantity=1 for existing rows. |
| `backorderService.ts` | **Major change:** Replace two-table operations with single `backorder_line_items`. Merge part + bicycle lines into one table. Update all CRUD methods. |

### API Endpoints to Update

- `POST /api/repairs/:id/items` — accept new fields (`line_type`, `metadata_json`)
- `PUT /api/repair-items/:id` — accept new fields
- `POST /api/sales/:id/items` — accept new fields, support non-product line types
- `POST /api/quotes/:id/items` — accept new fields, migrate enum values
- `POST /api/backorders/:id/items` — **new endpoint** (consolidated table)
- `DELETE /api/backorder-part-lines/:id` → removed (merged into consolidated table)
- `DELETE /api/backorder-bicycle-lines/:id` → removed

### Type Definitions to Update

All line-item TypeScript types need updating:
```typescript
interface LineItemBase {
  id: string;
  parent_id: string; // or specific FK per table
  line_type: 'product' | 'labor' | 'bicycle';
  product_id?: string;
  description: string;
  quantity: number;
  unit_price_net: number;
  vat_rate: number;
  discount_percent: number | null;
  line_total_net: number;
  line_total_vat: number;
  line_total_gross: number;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
}
```

---

## 4. Tests Needed

### Unit Tests

| Test | Description |
|------|-------------|
| `calculateLineTotals` | Verify discount applies to net before VAT. Edge cases: 0% discount, max discount (100%), NULL discount, basis point precision. |
| `validateMetadataJson` | Service-layer validation for each line_type's metadata contract. Reject invalid structures. |
| `migrateRepairItemMetadata` | Test migration of existing repair items into unified metadata_json format. |
| `migrateBicycleLineMetadata` | Test migration of bicycle-specific columns into metadata_json. |

### Integration Tests

| Test | Description |
|------|-------------|
| Create sale item with labor line_type | Verify all fields stored correctly, financial totals computed. |
| Create repair item with metadata_json | Verify labor metadata (billingType, minutesWorked, hourlyRate) persisted. |
| Convert quote to repair — line items preserved | Verify line_type, metadata, and financial fields survive conversion. |
| Backorder part + bicycle lines → consolidated table | Verify both types merge correctly into single table with proper line_type values. |
| Discount on sale item | Verify net/vat/gross calculation with discount applied. |

### Migration Tests

| Test | Description |
|------|-------------|
| Backfill financial fields | Verify all existing rows have correct `line_total_net` and `line_total_vat`. |
| Metadata migration round-trip | Migrate → read back → verify data integrity (no loss). |
| Enum migration (`part` → `product`) | Verify all quote_line_items with type='part' migrated to 'product'. |

---

## 5. Risks and Rollback Notes

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **SQLite ALTER TABLE limitations** — Cannot DROP COLUMN or RENAME in older versions. New columns add storage but are harmless. | Low | Phase 4 cleanup requires table recreation (expensive). Defer until confident. |
| **Backorder consolidation data loss** — Merging two tables into one risks losing rows if FK references aren't updated. | High | Full backup before migration. Verify row counts match after merge. Test on staging first. |
| **Dual-write complexity** — Service layer must write to both old and new columns during transition. Risk of drift. | Medium | Write a shared `createLineItem` helper that handles dual-write automatically. |
| **Read path inconsistency** — Old code reads deprecated columns, new code reads new columns. Temporary mismatch possible. | Medium | All read queries updated in same PR as write changes. No partial rollout. |
| **Metadata JSON validation gaps** — If service layer doesn't validate, invalid JSON could corrupt data. | Medium | Add Zod/Yup validation at service boundary before persisting. |

### Rollback Plan

1. **Schema rollback:** New columns are harmless (read-only during transition). No schema rollback needed unless critical bug found.
2. **Code rollback:** Revert service layer changes to old column names/structures. Old columns remain readable.
3. **Backorder consolidation rollback:** If merge fails, drop `backorder_line_items` table and restore from backup of old tables.
4. **Data rollback:** Full DB backup taken before migration. Restore if backfill produces incorrect values.

### Pre-Migration Checklist

- [ ] Full database backup (`.dump` or `.backup`)
- [ ] Staging environment with production-like data
- [ ] Migration scripts tested on staging
- [ ] All service layer changes in single PR (no partial rollout)
- [ ] Integration tests pass on staging
- [ ] Rollback plan documented and verified

---

## Summary of Decisions

| Decision | Choice |
|----------|--------|
| Unified table vs separate tables | Separate tables, standardized fields |
| Backorder consolidation | Merge part + bicycle lines into one `backorder_line_items` table |
| `line_type` enum values | `product` \| `labor` \| `bicycle` (no `part`, no `custom`) |
| Calculation responsibility | Application layer (service code) |
| Metadata JSON governance | Governed schema per line_type, validated at service layer, nullable |
| Product_id FK enforcement | App-level only (nullable in DB) |
| Migration approach | ADD columns to existing tables + backfill (no table recreation yet) |
| Discount application | On net price before VAT (Belgian tax standard) |
| `discountedUnitPriceNet` storage | Derive at read time, don't store |
