#### DEEPER CODEBASE CONTEXT — Search vs Detail Service Gap Analysis

**Finding 1: `brand`, `model`, `imageUrl` already returned by search services but NOT by detail services**

Both supplier search functions (`searchKruitboschByEan`, `searchGransierByEan`) already select and return `brand`, `imageUrl`, and (for Kruitbosch) `model`. However, the detail services only return `color`, `vatRateBasisPoints`, and `fullDescription`. The builder needs to add these fields to the detail service queries.

| Field | Search Service Returns? | Detail Service Returns? |
|-------|------------------------|------------------------|
| `brand` | ✅ Both | ❌ Neither |
| `model` | ✅ Kruitbosch only | ❌ Neither |
| `imageUrl` | ✅ Both | ❌ Neither |
| `category` | ❌ Neither (in interface but NOT selected from DB) | ❌ Neither |
| `itemNumber` | ✅ Both | ❌ Neither |

**Finding 2: `category` is a real gap — in interfaces but never queried from DB**

Both `KruitboschLocalOffer` and `GransierLocalOffer` interfaces declare `category?: string`, but neither search function's SQL query selects `kruitboschProducts.category` or `gransierProducts.category`. The builder must add the column to both the search queries AND the detail service queries.

**Finding 3: Price fields (`costPriceNet`, `sellPriceNet`) in search results, NOT in detail responses**

The search services already compute and return `costPriceNet`/`sellPriceNet` (plus gross conversions). The AC3 requirement for "price-highlight for cost/retail prices" means adding these to the detail service response shapes. This is a straightforward extension — no new DB columns needed.

**Finding 4: `parts.quantityOnHand` cannot serve as stockMin/Max substitute**

The `parts` table has `quantityOnHand`, but there is NO join mechanism between supplier EAN (`kruitbosch_products.eanUpc`) and part SKU (`parts.barcode`). The import flow creates parts from search results, but the link is one-way (import → new part). Stock data in the detail view would require a separate lookup by imported part barcode, which is outside this feature's scope.

**Finding 5: Frontend `ProductDetail` type needs extension**

Current `ProductDetail` interface (`client/src/features/product-finder/types.ts`) has:
- ✅ `category?: string | null` — already present
- ❌ Missing: `brand`, `model`, `imageUrl`, `itemNumber`, `costPriceNet`, `sellPriceNet`

The builder must extend this type to include the new fields.

**Finding 6: DST detail service as reference pattern**

`server/src/features/product-finder/services/suppliers/dst/detail-service.ts` returns a richer shape (10+ fields) with proper null handling, optional typing, and error resilience. The builder should follow this pattern for consistency — extend response interfaces with `?` optional fields and handle nulls gracefully.
