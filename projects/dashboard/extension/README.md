# Dashboard Sync — Chrome Extension

A minimal Manifest V3 extension that pushes your Chrome bookmarks to a
self-hosted [Dashboard server](../server). This is the v1 tracer bullet:
the extension installs, the options page saves and validates the API
token, the bulk sync endpoint is wired up (#004 + #005), and ongoing
change events trigger debounced syncs (#006).

## Install (unpacked)

## Install (unpacked)

1. Open `chrome://extensions/`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this directory (`projects/dashboard/extension`).
4. Right-click the extension's card → **Options**, or click the toolbar
   icon to open the options page.

The extension appears in the toolbar with Chrome's default icon. Real
icons live in `icons/` once they're added.

## Configure

The options page asks for two values:

| Field | Where to find it |
|-------|------------------|
| **Server URL** | The base URL of your dashboard server, e.g. `http://192.168.0.136:8080`. Must include the protocol and port. |
| **API token** | Generate at `/settings` on the dashboard. The plaintext is shown exactly once — copy it before closing the modal. |

When you click **Save and validate**, the extension:

1. Validates the URL shape.
2. Asks Chrome for host permission to the server's origin (a one-time
   prompt the first time you save each origin).
3. Calls `GET /api/tokens` with the token to confirm the server accepts
   it.
4. Stores the URL + token in `chrome.storage.local` if all three pass.

Any failure shows a clear error message and leaves the stored settings
unchanged.

### Permissions

The extension declares two permissions in `manifest.json`:

- `bookmarks` — read your Chrome bookmarks for sync (used in #005+)
- `storage` — `chrome.storage.local` for the URL + token
- `optional_host_permissions: ["http://*/*", "https://*/*"]` — broad
  pattern so the options page can ask for the *specific* origin at
  runtime. The extension never has access to origins you haven't
  explicitly approved.

## Architecture

```
extension/
├── manifest.json             # MV3 manifest
├── service-worker.js         # background SW — lifecycle + bookmark event listeners + debounced sync
├── lib/
│   ├── storage.js            # chrome.storage.local wrapper (config)
│   ├── api-client.js         # fetch + Bearer wrapper + validateToken
│   ├── sync.js               # read Chrome bookmarks + flatten + POST; tagged with `syncedFrom` marker
│   └── write-tracker.js      # (issue #006) feedback-loop prevention — dormant in v1 (read-only on Chrome side)
├── options/
│   ├── options.html          # the options page (also the popup)
│   ├── options.css
│   └── options.js            # form wiring + permission request + validate + initial sync trigger
└── icons/                    # placeholder for icon PNGs
```

No build step. Chrome loads the JS and HTML directly. ES modules are
used throughout (`type="module"` in the manifest + script tags); the
service worker uses Chrome's module SW support.

## Ongoing sync (#006)

The service worker subscribes to four `chrome.bookmarks` events:

| Event | When it fires |
|-------|---------------|
| `onCreated` | A bookmark or folder is created (UI, address bar, sync from another device) |
| `onChanged` | A bookmark's title, URL, or folder properties change |
| `onRemoved` | A bookmark or folder is deleted |
| `onMoved` | A bookmark or folder is dragged between folders |

Each event triggers a **300ms-debounced full-tree sync** to the server.
The server's [BookmarkDiffer](../server/src/bookmark-differ.ts)
computes the minimal CRUD ops (insert/update/delete/move) and applies
them transactionally. Multiple events that fire within 300ms coalesce
into a single sync.

Every sync request includes a `syncedFrom` field in the body so the
server can log which event triggered it (e.g.
`extension_event:onChanged`). See `lib/sync.js` for the marker values.

### Feedback-loop prevention

In v1 the extension is read-only on the Chrome side (per ADR-008), so
no feedback loop is possible. `lib/write-tracker.js` provides a
mechanism for v2: future write wrappers (around
`chrome.bookmarks.create/update/remove/move`) will mark chromeIds as
"just written by us" so the next event for them is ignored. The
service worker's event listeners already consult `shouldIgnore()` for
every event — the mechanism is in place, just dormant in v1.

## Smoke test

After loading the extension:

1. Open the dashboard's `/settings` page and create a token labeled
   "extension smoke test".
2. Copy the plaintext.
3. Open the extension's options page (right-click → Options, or click
   the toolbar icon).
4. Paste the server URL and token. Click **Save and validate**.
5. You should see a green "Settings saved. Token validated against the
   server." message.
6. Open DevTools on the options page (right-click → Inspect) — the
   service worker console shows `[dashboard] config updated`.

If you see a permission prompt for the server's origin, accept it. To
revoke: `chrome://extensions/` → Dashboard Sync → **Site access** →
remove the origin. Then **Clear saved settings** in the options page
to wipe the token.

## What's NOT here yet

- **Write-back to Chrome** — v1 is read-only on the Chrome side per
  ADR-008. v2 will add the dashboard → Chrome bookmark writers (with
  the `write-tracker` ignore mechanism).
- **Icons** — Chrome shows a default icon until you add PNGs to `icons/`.

See [`../docs/35-issues/`](../docs/35-issues/) for the full issue
tracker.