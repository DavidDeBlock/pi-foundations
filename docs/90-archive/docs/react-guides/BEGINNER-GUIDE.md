# Issue: Display Supplier Product Images in Product Finder UI

**Labels:** `needs-triage` `feature` `ui-enhancement`  
**Parent PRD:** [Product Finder](../../.pi/plans/archive/product-finder.md)  

## Problem Statement

When POS staff search for products via the DST Product Finder, they see only text data — supplier name, brand/model, prices, and stock warnings. There is no visual identification of the product. In a busy shop environment, operators scanning barcodes or typing keywords need to quickly confirm they're looking at the right physical item (e.g., distinguishing between similar-looking helmets from different brands). Without images, staff must rely entirely on text descriptions, which is error-prone when products share naming patterns or when multiple suppliers carry visually distinct but similarly named items.

## Solution

Display each product's image (when available from DST) alongside its details in all Product Finder views: the desktop table, mobile cards, and the import review modal. Images are optional — DST does not guarantee an image for every product. Where no image exists, a `Package` icon placeholder is shown instead. The feature adds zero backend changes; it consumes the existing `imageUrl` field on `SupplierOffer`, which is already populated from DST's `pos_image` array by the client-side mapping layer.

## User Stories

1. As a POS operator scanning barcodes at the counter, I want to see product images in the search results table so that I can visually confirm the correct item before importing
2. As a mobile user on a tablet or phone using the Product Finder, I want product images displayed prominently above each card's text so that visual identification works equally well on small screens
3. As an operator reviewing a product for import, I want to see the supplier's product image in the confirmation modal so that I can double-check before committing to create/update inventory
4. As a staff member browsing DST results with keyword search, I want images to appear consistently across paginated results so that visual scanning remains reliable as I load more pages
5. As an operator viewing products from suppliers who don't provide images (e.g., generic hardware), I want to see a neutral `Package` icon placeholder instead of a broken image or blank space so the UI stays consistent and professional
6. As a user on a slow connection, I want product images to load lazily so that the initial search results appear quickly without waiting for all images to download
7. As an accessibility-conscious operator using screen readers, I want every displayed image to have descriptive alt text (brand + model) so that non-visual users can identify products
8. As a staff member comparing offers from different suppliers for the same EAN, I want each row's thumbnail to show the supplier's version of the product image so I can spot quality differences between supplier photo sets
9. As an operator working in a bright shop environment, I want images rendered with proper contrast and rounded corners using the existing design system tokens so they integrate seamlessly into the POS aesthetic
10. As a future developer maintaining this feature, I want image display logic encapsulated in a shared `ImageFallback` component so that any new feature displaying products can reuse it without duplicating fallback handling

## Implementation Decisions

### Modules Built/Modified

| Module | Action | Purpose |
|--------|--------|---------|
| **`ImageFallback` (new UI primitive)** | Create | Shared `<img>` wrapper with automatic fallback to a `Package` icon when the source is missing, empty, or fails to load. Handles `onError`, `loading="lazy"`, and alt text in one place. Lives in `components/ui/` for reuse across features. |
| **`DSTProductList` (desktop table)** | Modify | Add a dedicated 48px-wide thumbnail column before the existing "Supplier" column. Each row renders its product image at 40×40px with `object-contain`, white background, and rounded corners. The column header is empty to avoid visual clutter. |
| **`DSTProductList` (mobile cards)** | Modify | Add a full-width image block (~80px tall) above the supplier name/brand/model text within each card. Uses `object-cover` for a clean fill. Only rendered when `imageUrl` is truthy — no placeholder on mobile to save vertical space where screen real estate is most constrained. |
| **`ImportReviewModal`** | Modify | Add product image between the read-only supplier info box and the editable form fields. Rendered at 128px height with `object-cover` and rounded corners. Only shown when `imageUrl` exists, keeping the modal lean for products without images. |

### Technical Decisions

- **Image source**: Consumes `SupplierOffer.imageUrl` — already populated by the existing DST mapping layer from `pos_image[0]`. No backend changes required.
- **Fallback strategy**: The `ImageFallback` component uses React state (`useState`) to track load failure via the native `<img onError>` handler. When triggered, it swaps the image for a centered `Package` icon in a muted placeholder box. This handles both missing URLs and broken/404 image endpoints.
- **Lazy loading**: All `<img>` elements use `loading="lazy"` (native browser lazy loading). No IntersectionObserver or third-party library needed.
- **Mobile card behavior**: Images are only shown when available on mobile cards (not replaced with a placeholder). This decision was made because mobile screens have limited vertical space, and a 48px icon placeholder would add visual noise without adding meaningful information — the Package icon is already visible in the desktop column for that purpose.
- **No image upload**: The feature only displays images provided by DST. No upload, crop, or replacement functionality is included.

### Architectural Decisions

- **Shared UI component over inline duplication**: Although this feature touches three components, the `ImageFallback` logic (error state, lazy loading, alt text) would be duplicated across all three if implemented inline. A shared component prevents this and serves future product-image needs (product detail pages, receive flow confirmations).
- **No changes to DST types or API**: The `imageUrl?: string` field already exists on `SupplierOffer`. We consume it as-is without modifying the shared type definition.

### Schema Changes

None — purely a frontend display enhancement. No database tables, migrations, or backend endpoints are modified.

### API Contracts

None — no new API calls. Images are fetched directly from DST's CDN URLs already embedded in `SupplierOffer.imageUrl`.

## Testing Decisions

### What Makes a Good Test

Tests should verify external behavior only:
- Does the component render an `<img>` with correct attributes when `src` is provided?
- Does it show the fallback icon when `src` is empty, null, or undefined?
- Does it switch to the fallback icon when the image fails to load (simulated `onError`)?
- Does the rendered output include proper alt text derived from brand and model?

### Modules to Test

**`ImageFallback` component** — This is the deep module that should be tested in isolation:
- Renders `<img>` with all passed props when `src` is truthy
- Shows fallback icon when `src` is falsy (null, undefined, empty string)
- Switches from image to fallback on simulated load error
- Applies custom className and aria-label correctly
- Uses default `Package` icon when no custom `fallbackIcon` is provided

### Prior Art

The codebase already has a similar pattern in the existing Radix UI `Avatar` component (`client/src/components/ui/avatar.tsx`), which wraps an image with a fallback. The `ImageFallback` component follows this same mental model but is more general-purpose (works with any `<img>` dimensions, not just circular avatars).

## Out of Scope

- **Image upload or replacement** — operators cannot crop, replace, or add images to products
- **DST API changes** — no modifications to the supplier data pipeline or image fetching logic
- **Shared type modifications** — `SupplierOffer.imageUrl` is consumed as-is; no new fields added
- **Backend caching of product images** — images are fetched directly from DST CDN URLs on each render
- **Image optimization (WebP conversion, resizing)** — relies on native browser behavior and DST's existing image hosting
- **Caching strategy beyond `loading="lazy"`** — no service worker or localStorage-based image cache in scope

## Further Notes

- The `SupplierOffer.imageUrl` field is already populated by the client-side mapping layer (`dst-products.service.ts`) from DST's `pos_image[]` array. This means the data pipeline was designed with images in mind from the start — we're simply surfacing what's already available.
- Some DST suppliers (particularly generic hardware distributors) may not provide product photos. The fallback icon ensures these products still display cleanly without visual gaps or broken image indicators.
- The `ImageFallback` component is placed in `components/ui/` rather than `features/product-finder/components/` because product images will appear in multiple features: the Product Finder search results, the import review modal, and potentially future product detail views and receive flow confirmations.
