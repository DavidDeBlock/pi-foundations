
````md
# Settings System Plan

## Goal

Add a flexible settings system to the POS application without creating a separate database table for every module.

The system should support global shop settings and module-specific preferences such as opening hours, shop address, receipt options, sales defaults, repair preferences, calendar preferences, and display options.

The settings should be stored in the database as structured JSON values.

---

## 1. Core Idea

Create one generic `settings` table.

Each setting is stored as a key-value pair:

- `key`: unique setting name
- `value`: JSON object
- `updatedAt`: timestamp of last update

Example setting keys:

```txt
shop.profile
shop.openingHours
sales.preferences
repairs.preferences
backorders.preferences
calendar.preferences
receipt.settings
ui.preferences
````

This avoids creating many small tables such as:

```txt
sales_settings
repair_settings
calendar_settings
receipt_settings
shop_settings
```

---

## 2. Database Table

Create a table called `settings`.

Suggested structure:

```ts
settings {
  key: string primary key
  value: json/text not null
  updatedAt: string not null
}
```

The `value` field should store a JSON object.

Example:

```json
{
  "key": "shop.profile",
  "value": {
    "name": "De Velomaker",
    "street": "Example Street 1",
    "postalCode": "9000",
    "city": "Gent",
    "phone": "+32 ...",
    "email": "info@example.be",
    "vatNumber": "BE..."
  }
}
```

---

## 3. Setting Groups

### Shop profile

Stores general shop information.

```ts
shop.profile
```

Fields:

```ts
{
  name: string
  street?: string
  postalCode?: string
  city?: string
  phone?: string
  email?: string
  vatNumber?: string
  website?: string
}
```

---

### Opening hours

Stores weekly opening hours.

```ts
shop.openingHours
```

Example:

```ts
{
  monday: { open: "09:00", close: "18:00" },
  tuesday: { open: "09:00", close: "18:00" },
  wednesday: null,
  thursday: { open: "09:00", close: "18:00" },
  friday: { open: "09:00", close: "18:00" },
  saturday: { open: "09:00", close: "17:00" },
  sunday: null
}
```

`null` means the shop is closed that day.

---

### Sales preferences

```ts
sales.preferences
```

Example fields:

```ts
{
  defaultPaymentMethod: "card",
  allowSplitPayments: true,
  allowQuickSell: true,
  showStockWarnings: true
}
```

---

### Repair preferences

```ts
repairs.preferences
```

Example fields:

```ts
{
  defaultPlannedDaysAhead: 3,
  requireWorkerAssignment: true,
  allowReadyToInProgress: true,
  autoPauseTimerOnHold: true
}
```

---

### Backorder preferences

```ts
backorders.preferences
```

Example fields:

```ts
{
  defaultDepositPercentage: 25,
  allowedDepositPercentages: [10, 25, 50, 75, 100],
  depositNonRefundableAfterOrdered: true
}
```

---

### Receipt settings

```ts
receipt.settings
```

Example fields:

```ts
{
  showShopAddress: true,
  showVatNumber: true,
  showPaymentSummary: true,
  footerText: "Thank you for your purchase!"
}
```

---

### UI preferences

```ts
ui.preferences
```

Example fields:

```ts
{
  defaultDashboardView: "today",
  compactMode: false,
  currency: "EUR",
  dateFormat: "dd/MM/yyyy"
}
```

---

## 4. Validation

Because settings are stored as JSON, every setting group must have a validation schema.

Use Zod schemas for each setting key.

Example:

```ts
const shopProfileSettingsSchema = z.object({
  name: z.string().min(1),
  street: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  vatNumber: z.string().optional(),
  website: z.string().optional(),
});
```

The service layer should validate settings before saving them.

This keeps the flexibility of JSON while still keeping the data safe and predictable.

---

## 5. Settings Service

Create a `SettingsService`.

Responsibilities:

```ts
SettingsService.get(key)
SettingsService.getOrDefault(key)
SettingsService.update(key, value)
SettingsService.resetToDefault(key)
SettingsService.listAll()
```

The service should:

* read settings from the database
* validate settings before saving
* return default settings if no custom value exists yet
* update the `updatedAt` timestamp
* prevent unknown setting keys from being saved

---

## 6. Default Settings

Default settings should live in code, not only in the database.

Example:

```ts
const defaultSettings = {
  "sales.preferences": {
    defaultPaymentMethod: "card",
    allowSplitPayments: true,
    allowQuickSell: true,
    showStockWarnings: true
  },

  "repairs.preferences": {
    defaultPlannedDaysAhead: 3,
    requireWorkerAssignment: true,
    allowReadyToInProgress: true,
    autoPauseTimerOnHold: true
  }
};
```

When a setting does not exist in the database, the application should fall back to the default value.

This makes the system safe after a fresh install.

---

## 7. API Endpoints

Add simple settings endpoints.

```txt
GET    /settings
GET    /settings/:key
PUT    /settings/:key
POST   /settings/:key/reset
```

Example:

```txt
GET /settings/shop.profile
PUT /settings/shop.profile
```

The `PUT` endpoint should validate the submitted JSON against the schema for that specific key.

---

## 8. Frontend UI

Create a Settings page with sections.

Suggested sections:

```txt
Shop
Opening Hours
Sales
Repairs
Backorders
Receipts
User Interface
```

Each section should load and update one settings key.

Example:

```txt
Shop section → shop.profile
Opening Hours section → shop.openingHours
Sales section → sales.preferences
```

Avoid building one huge settings form.

Each section should be small and focused.

---

## 9. JSON Files

Do not use JSON files as the main storage for live settings.

JSON files may be used for:

* default settings
* seed data
* development examples
* first-install templates

The active settings should be stored in the database.

Reason:

* easier backups
* safer updates
* works better in server/client setup
* easier to edit through the UI
* avoids file permission issues
* avoids concurrent write problems

---

## 10. Implementation Order

### Step 1 — Create database table

Add the generic `settings` table.

### Step 2 — Define setting keys

Create a central list of allowed setting keys.

Example:

```ts
const SETTINGS_KEYS = {
  SHOP_PROFILE: "shop.profile",
  SHOP_OPENING_HOURS: "shop.openingHours",
  SALES_PREFERENCES: "sales.preferences",
  REPAIRS_PREFERENCES: "repairs.preferences",
  BACKORDERS_PREFERENCES: "backorders.preferences",
  RECEIPT_SETTINGS: "receipt.settings",
  UI_PREFERENCES: "ui.preferences",
} as const;
```

### Step 3 — Add default values

Create default settings for every key.

### Step 4 — Add Zod schemas

Create one validation schema per settings key.

### Step 5 — Build SettingsService

Implement reading, updating, resetting, and listing settings.

### Step 6 — Add API routes

Expose settings through backend endpoints.

### Step 7 — Build frontend settings page

Start with the most important settings:

1. Shop profile
2. Opening hours
3. Receipt settings
4. Sales preferences
5. Repair preferences

---

## 11. Important Rules

* Do not create separate settings tables per module.
* Do not allow unknown setting keys.
* Do not save unvalidated JSON.
* Keep defaults in code.
* Store active settings in the database.
* Keep each settings section small and focused.
* Prefer simple JSON objects over deeply nested structures.
* Only add settings that are actually used by the application.

---

## Result

The POS application will have a flexible, safe, and extendable settings system.

It will be easy to add new settings later without database table explosion, while still keeping validation, defaults, and clean application behavior.

```


