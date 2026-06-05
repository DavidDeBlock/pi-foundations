# Product Finder — Feature Overview

> **Purpose:** High-level architecture and state of the Product Finder feature.  
> **Last updated:** 2026-05-22  

---

## 🎯 Purpose

Product Finder allows users to search supplier catalogs (DST, Kruitbosch, Gransier) by EAN barcode or keyword, view results in a unified table with freshness indicators, and import selected products into the local parts inventory. It bridges external supplier data with internal POS catalog management.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Client (React)                    │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ SearchBar    │ │ ResultsTable │ │ ImportModal │ │
│  └──────────────┘ └──────────────┘ └─────────────┘ │
│         │              │              │             │
│  ┌─────────────────────────────────────────────────┐│
│  │ API Client (fetch wrappers)                     ││
│  └─────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────┘
                           │ HTTP /api/product-finder/*
┌──────────────────────────▼──────────────────────────┐
│                 Server (Hono)                       │
│  ┌───────────────────────────────────────────────┐  │
│  │ Routes: search, search/all, sync/:supplier,   │  │
│  │         import, suppliers, :supplier/detail   │  │
│  └───────────────────────────────────────────────┘  │
│         │                                            │
│  ┌──────▼──────────────────────────────────────┐    │
│  │ Search Service (orchestrator)               │    │
│  │ ├─ searchSupplierByEan()                    │    │
│  │ ├─ searchAllByEan()                         │    │
│  │ └─ syncSupplier()                           │    │
│  └──────┬──────────────────────────────────────┘    │
│         │                                            │
│  ┌──────▼──────────────────────────────────────┐    │
│  │ Supplier Registry (adapter pattern)         │    │
│  │ ├─ DST Adapter (real-time API)              │    │
│  │ ├─ Kruitbosch Adapter (local cache + sync)  │    │
│  │ └─ Gransier Adapter (local cache + sync)    │    │
│  └──────┬──────────────────────────────────────┘    │
│         │                                            │
│  ┌──────▼──────────────────────────────────────┐    │
│  │ Import Service → Parts table                │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────┘
                           │ Drizzle ORM
┌──────────────────────────▼──────────────────────────┐
│                   SQLite DB                         │
│  supplier_products (cached catalog)                 │
│  parts (local inventory)                            │
│  supplier_orders / supplier_order_lines             │
└─────────────────────────────────────────────────────┘
```

---

## 🔌 Supplier Adapters

Each supplier implements the `SupplierAdapter` interface:

| Adapter | Strategy | Auth | Sync Required? |
|---------|----------|------|----------------|
| **DST** (`dst/`) | Real-time API calls to DST aggregator | Token-based (session expiry tracked) | No — live queries only |
| **Kruitbosch** (`kruitbosch/`) | Local SQLite cache of synced catalog | None | Yes — manual sync button required |
| **Gransier** (`gransier/`) | Local SQLite cache of synced catalog | FTPS pull (credentials in env) | Yes — manual sync button required |

### Adapter Contract

```typescript
interface SupplierAdapter {
  id: string                    // 'dst' | 'kruitbosch' | 'gransier'
  name: string                  // Display name in UI
  isEnabled(): boolean          // Check env credentials
  getStatus(): SupplierAuthStatus
  searchByEan(ean): Promise<SearchResults>
  searchByKeyword(q, page?, size?): Promise<SearchResults>
  sync?(): Promise<{ success, importedCount }>  // Optional for cache suppliers
}
```

### Data Flow Per Search Type

**EAN Search (exact match):**
1. Client calls `GET /search?ean=XXX&supplier=kruitbosch`
2. Server routes to adapter's `searchByEan()`
3. Adapter queries local DB (K/G) or live API (DST)
4. Results mapped to unified `SupplierOffer[]` and returned

**Keyword Search (paginated):**
1. Client calls `GET /search?q=keyword&supplier=kruitbosch&page=0&size=20`
2. Server routes with pagination parameters
3. Adapter returns paginated results with `totalElements`, `totalPages`
4. Client renders pagination controls

**Combined Search (all suppliers):**
1. Client calls `GET /search/all?ean=XXX`
2. Server runs all active adapters in parallel (`Promise.allSettled`)
3. Results merged into single `SupplierOffer[]` array
4. No pagination (EAN searches are always unpaginated)

---

## 📊 Database Schema

### `supplier_products` — Cached Supplier Catalog

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID or supplier-specific ID |
| `ean_upc` | TEXT NOT NULL | Barcode identifier |
| `raw_json` | TEXT NOT NULL | Full supplier JSON blob — single source of truth |
| `supplier_name` | TEXT NOT NULL | 'dst', 'kruitbosch', or 'gransier' |
| `searched_at` | TIMESTAMP | Last synced/searched timestamp |

**Constraint:** Composite unique on `(ean_upc, supplier_name)` — same EAN can exist for different suppliers.

### Sync Status Tracking (file-based)

Located in `storage/sync-status/<supplier>.json`:
```json
{ "lastSyncedAt": "2026-05-22T10:30:00Z" }
// or on failure:
{ "lastSyncedAt": null, "error": "Connection timeout" }
```

Freshness logic (computed in `suppliers/index.ts`):
- **ok** (< 24h since last sync) → green dot
- **stale** (> 24h, ≤ 5 days) → yellow dot  
- **failed** (> 5 days or error) → red dot

---

## 🔌 API Surface

| Method | Endpoint | Description | Auth Required? |
|--------|----------|-------------|----------------|
| `GET` | `/api/product-finder/search?ean=XXX&supplier=kruitbosch` | Per-supplier EAN search | No* |
| `GET` | `/api/product-finder/search?q=keyword&supplier=kruitbosch&page=0&size=20` | Per-supplier keyword search | No* |
| `GET` | `/api/product-finder/search/all?ean=XXX` | Combined all-suppliers EAN search | No* |
| `POST` | `/api/product-finder/sync/:supplier` | Trigger catalog sync (K/G) | No* |
| `GET` | `/api/product-finder/suppliers` | List suppliers with status/freshness | No* |
| `POST` | `/api/product-finder/import` | Import product into local parts table | No* |
| `GET` | `/api/product-finder/:supplier/detail?ean=XXX` | Per-supplier product detail view | No* |

\* *Auth not explicitly enforced on these routes — may rely on parent route guards.*

---

## 🖥️ Client Components

```
ProductFinderPage.tsx          ← Main page (tabs, search bar, results table)
├── SearchBar                  ← Input field with EAN/keyword mode toggle
├── SearchResultsTable         ← Tabular display of SupplierOffer[]
│   ├── ExpandableRow          ← Detail card grid per row
│   └── Pagination controls    ← Page navigation (keyword search only)
├── ImportReviewModal          ← Confirmation dialog before import
└── freshness.ts               ← Freshness computation utilities
```

### Key States Managed in Component

- `activeTab`: `'dst'` | `'kruitbosch'` | `'gransier'`
- `offers`: `SupplierOffer[]` — search results
- `pagination`: `PaginationInfo \| null` — only populated for keyword searches
- `isSyncing`, `isImporting`, `isLoading` — loading indicators
- `selectedOffer`: `SupplierOffer \| null` — current import candidate
- `suppliers`: `SupplierInfo[]` — loaded on mount, drives tab enable/disable

---

## 📁 File Structure

```
client/src/features/product-finder/
├── routes/ProductFinderPage.tsx        ← Main page component
├── components/
│   ├── SearchBar.tsx                   ← Search input with mode toggle
│   ├── SearchResultsTable.tsx          ← Results grid + pagination
│   ├── ExpandableRow.tsx               ← Detail view per row
│   └── ImportReviewModal.tsx           ← Import confirmation dialog
├── services/api.ts                     ← Fetch wrappers for all endpoints
├── types.ts                            ← Frontend type definitions
└── utils/freshness.ts                  ← Freshness computation

server/src/features/product-finder/
├── index.ts                            ← Barrel exports (types + helpers)
├── routes/index.ts                     ← Hono route handlers (all endpoints)
├── types.ts                            ← Shared type definitions
├── services/search-service.ts          ← Search orchestrator
├── services/import-service.ts          ← Import into parts table logic
├── services/sync-status-service.ts     ← File-based sync status tracking
└── services/suppliers/
    ├── index.ts                        ← Supplier registry + list endpoint
    ├── base.ts                         ← SupplierAdapter interface
    ├── dst/                            ← DST adapter (real-time API)
    │   ├── adapter.ts                  ← Search implementation
    │   ├── auth.ts                     ← Token/session management
    │   └── detail-service.ts           ← Detail view fetching
    ├── kruitbosch/                     ← Kruitbosch adapter (local cache)
    │   ├── adapter.ts                  ← Local DB search + sync logic
    │   ├── detail-service.ts           ← Detail view from local cache
    │   └── sync-service.ts             ← FTPS pull → upsert into supplier_products
    └── gransier/                       ← Gransier adapter (local cache)
        ├── adapter.ts                  ← Local DB search + sync logic
        ├── detail-service.ts           ← Detail view from local cache
        └── sync-service.ts             ← FTPS pull → upsert into supplier_products
```

---

## ✅ Current State

| Area | Status | Notes |
|------|--------|-------|
| **DST Search** | ✅ Complete | Real-time API, EAN + keyword search, pagination working |
| **Kruitbosch Search** | ✅ Complete | Local cache search works; sync button functional |
| **Gransier Search** | ✅ Complete | Local cache search works; FTPS sync functional |
| **Combined Search** | ✅ Working | `/search/all` merges all suppliers in parallel |
| **Import Flow** | ✅ Working | Review modal → confirmation → parts table insert |
| **Detail Views** | ⚠️ Partial | Detail endpoints exist but UI expandable rows need polish (issue #120) |
| **Table Generalization** | ⚠️ Partial | Columns hardcoded per supplier; needs config-driven approach (issue #102) |
| **Auth Status Display** | ✅ Working | Freshness dots + tooltips show sync/auth state |

---

## 🐛 Known Gaps & Open Issues

### Active GitHub Issues
- **#120** — Product Finder Detail Pages: Expandable row views not fully polished (detail data fetches correctly but UI rendering needs work)
- **#106** — Autonomous Pipeline Engine for Maestro Orchestrator (unrelated to product finder, listed in roadmap)
- **#102** — Table Generalization + Gransier Mapping: Config-driven columns needed across all supplier tabs

### Structural Gaps
| Gap | Impact | Priority |
|-----|--------|----------|
| No config-driven column mapping | Each supplier tab has hardcoded columns; adding suppliers requires code changes | Medium |
| Detail view not fully integrated into ExpandableRow | Detail endpoints exist but UI doesn't consistently render all fields | Low-Medium |
| Kruitbosch image display bug | `PosImages` column may not map correctly for product images | Low |
| No auto-sync scheduling | Sync must be manually triggered; no cron/background job | Medium (nice-to-have) |

### Technical Debt
- **No Zod validation on import route** — Import endpoint accepts raw JSON without schema enforcement
- **Error messages inconsistent** — Some routes return `{ error }`, others `{ success: false, message }`
- **No rate limiting** on DST API calls (real-time supplier may have request limits)

---

## 🔮 Future Enhancements (from ROADMAP.md)

- [ ] Product Finder detail pages polish (#120)
- [ ] Table generalization + Gransier mapping (#102)
- [ ] Kruitbosch image display fix
- [ ] Import flow review/confirm screen enhancement
- [ ] Supplier catalog sync framework (generic pipeline for future suppliers)
- [ ] Supplier order workflow (create purchase orders from finder selections)

---

*This document is a living reference. Update when architecture changes or new suppliers are added.*
