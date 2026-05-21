# Gransier FTP Integration Plan

## Context
Integrate the Gransier supplier into the existing Product Finder application. Unlike DST (real-time API), Gransier follows a **pull-based** pattern: download the catalog via FTPS, store it locally, and search against the local database. Only the Dutch (`NL`) variant of the catalog is required.

## Scope
- **Protocol**: FTPS (Explicit TLS) on port 21.
- **Data Source**: `Articles_NL.CSV` (UTF-16LE, semicolon-separated).
- **Sync Strategy**: Manual trigger via UI button. Resume-safe upserts (`ON CONFLICT`).
- **Search**: Local SQL queries for both EAN and Keyword searches.

---

## Implementation Phases

### Phase 1: Database Schema
- Add `gransier_products` table to Drizzle ORM schema.
- **Columns**:
    - `id`, `eanUpc` (unique), `itemNumber`, `brand`, `name`, `description`.
    - Pricing: `costPriceNet`, `sellPriceNet` (stored as integer cents).
    - Metadata: `vatRateBasisPoints`, `imageUrl`, `category`, `color`, `isActive`.

### Phase 2: Sync Service & Adapter
- **Sync Logic (`sync-service.ts`)**:
    - Use `basic-ftp` library for FTPS connectivity.
    - Download and decode UTF-16LE CSV content.
    - Parse rows → Map Gross EUR prices to Net Cents (÷ 1.21) → Bulk upsert into the database.
- **Adapter Logic (`adapter.ts`)**:
    - Implement `searchByEan()` and `searchByKeyword()` against the local table.
    - Map results to the unified `SupplierOffer` interface.

### Phase 3: Routes & UI
- **Backend**: Add `POST /sync/gransier` endpoint to trigger the sync service.
- **Frontend**: 
    - Add "Gransier" tab alongside DST and Kruitbosch tabs on the Product Finder page.
    - Implement a "Sync Gransier" button connected to the new server endpoint.

---

## Decisions & Constraints
1. **FTP Library**: Use `basic-ftp` (lightweight, standard Node.js FTPS support).
2. **Error Handling**: Sync failures are handled via database-level upserts (`ON CONFLICT`) to ensure partial progress is preserved and sync can resume safely.
3. **Validation**: Invalid EAN formats or malformed rows are imported as-is; search logic handles invalid data gracefully rather than blocking the entire sync.
