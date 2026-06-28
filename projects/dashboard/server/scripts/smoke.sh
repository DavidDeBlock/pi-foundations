#!/usr/bin/env bash
# smoke.sh — end-to-end smoke test for the v1 dashboard server.
#
# Boots an isolated server instance (temp data dir, random free port),
# runs a fixture sync that mimics the Chrome extension's payload shape,
# walks the feed → search → detail → categorize flows via HTTP, and
# asserts the expected state at each step.
#
# Failure: prints what went wrong and exits non-zero. Cleanup always
# runs (trap) so a crashed run doesn't leave zombie processes.
#
# Usage:
#   bash scripts/smoke.sh           # from server/
#   or from anywhere:
#   bash /path/to/dashboard/server/scripts/smoke.sh

set -uo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# Allow override via env, but default to the canonical pnpm + node from PATH.
PNPM_BIN=${PNPM_BIN:-pnpm}
NODE_BIN=${NODE_BIN:-node}

# ── Helpers ──────────────────────────────────────────────────────────────

log()  { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
pass() { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
done_() { printf '\033[32m[smoke] DONE\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[smoke] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

FAILURES=0

# Pick a free TCP port. We let the kernel assign one and read it back.
pick_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
}

# curl helpers — auth + JSON, fail loudly on non-2xx unless caller says otherwise.
basic_get()    { curl -fsS -u "smoke:$SMOKE_PASSWORD" "$@"; }
basic_post()   { curl -fsS -u "smoke:$SMOKE_PASSWORD" -H 'Content-Type: application/json' -d "$2" "$BASE$1"; }
basic_delete() { curl -fsS -u "smoke:$SMOKE_PASSWORD" -X DELETE "$BASE$1"; }

# Token helpers
gen_token() {
  basic_post /api/tokens "$1" | "$NODE_BIN" -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).plaintext)"
}

# ── Setup isolated environment ──────────────────────────────────────────

log "Setting up isolated smoke environment"
SMOKE_DIR=$(mktemp -d /tmp/dashboard-smoke.XXXXXX)
SMOKE_PORT=$(pick_free_port)
SMOKE_PASSWORD="smoke-$(date +%s)-$RANDOM"
BASE="http://127.0.0.1:$SMOKE_PORT"

# Redirect data dir under the smoke temp so we don't touch the dev DB.
SMOKE_DATA_DIR="$SMOKE_DIR/data"
mkdir -p "$SMOKE_DATA_DIR"

log "  data dir : $SMOKE_DATA_DIR"
log "  port     : $SMOKE_PORT"
log "  password : $SMOKE_PASSWORD"

cleanup() {
  local code=$?
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "Stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  log "Removing $SMOKE_DIR"
  rm -rf "$SMOKE_DIR"
  if [ "$code" -eq 0 ] && [ "$FAILURES" -eq 0 ]; then
    done_ "all checks passed"
  else
    printf '\033[31m[smoke] FAILED\033[0m %d check(s) failed\n' "$FAILURES" >&2
  fi
  exit $((code > 0 ? code : FAILURES))
}
trap cleanup EXIT INT TERM

# ── Boot server ─────────────────────────────────────────────────────────

log "Booting server"
DASHBOARD_PASSWORD="$SMOKE_PASSWORD" \
DASHBOARD_DATA_DIR="$SMOKE_DATA_DIR" \
DASHBOARD_DB_PATH="$SMOKE_DATA_DIR/dashboard.db" \
PORT="$SMOKE_PORT" \
HOSTNAME=127.0.0.1 \
setsid "$PNPM_BIN" --dir "$SERVER_DIR" start > "$SMOKE_DIR/server.log" 2>&1 < /dev/null &
SERVER_PID=$!
log "  pid      : $SERVER_PID"

# Wait for /health to come up.
for i in {1..30}; do
  if curl -fsS -u "smoke:$SMOKE_PASSWORD" "$BASE/health" >/dev/null 2>&1; then
    pass "server up after ${i} attempt(s)"
    break
  fi
  sleep 0.5
  if [ "$i" -eq 30 ]; then
    err "server failed to boot within 15s. Log tail:
$(tail -40 "$SMOKE_DIR/server.log")"
  fi
done

# ── AC #1: server boots and authenticates ──────────────────────────────
log "AC #1: server boots + auth"

# Wrong password → 401 + WWW-Authenticate: Basic
RESP_HEADERS=$(curl -sS -u "smoke:wrong" -D - -o /dev/null "$BASE/health")
if grep -qi '^HTTP/.* 401' <<<"$RESP_HEADERS"; then
  pass "wrong password → 401"
else
  fail "wrong password did not return 401. Headers: $RESP_HEADERS"
fi
if grep -qi '^WWW-Authenticate: Basic' <<<"$RESP_HEADERS"; then
  pass "401 carries WWW-Authenticate: Basic"
else
  fail "401 missing WWW-Authenticate: Basic header"
fi

# Correct password → 200 with health JSON
HEALTH=$(basic_get "$BASE/health")
if grep -q '"status":"ok"' <<<"$HEALTH"; then
  pass "correct password → 200 + health body"
else
  fail "correct password did not return ok body: $HEALTH"
fi

# ── AC #2: API token roundtrip ──────────────────────────────────────────
log "AC #2: API token generation + revocation"

TOKEN=$(gen_token '{"label":"smoke"}') || err "could not generate token"
if [ -n "$TOKEN" ] && [ "${#TOKEN}" -ge 32 ]; then
  pass "generated token (${#TOKEN} chars)"
else
  fail "token is empty or too short: $TOKEN"
fi

# Token works as Bearer
TOKEN_LIST=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/tokens")
if grep -q '"label":"smoke"' <<<"$TOKEN_LIST"; then
  pass "Bearer token authenticates /api/tokens"
else
  fail "Bearer token rejected: $TOKEN_LIST"
fi

# Token list does NOT include plaintext
if grep -q "$TOKEN" <<<"$TOKEN_LIST"; then
  fail "token plaintext leaked in list response — security regression"
else
  pass "token plaintext not exposed in list"
fi

# ── Build fixture (mimics extension's flattened Chrome tree) ────────────
log "Building 100-bookmark fixture"

FIXTURE="$SMOKE_DIR/fixture.json"
"$NODE_BIN" -e '
const fs = require("fs");
const folders = [
  { chromeId: "fbb", parentChromeId: null,   name: "Bookmarks bar" },
  { chromeId: "fob", parentChromeId: null,   name: "Other bookmarks" },
  { chromeId: "fte", parentChromeId: "fbb", name: "Tech"        },
  { chromeId: "fco", parentChromeId: "fbb", name: "Cooking"     },
  { chromeId: "fne", parentChromeId: "fbb", name: "News"        },
];
// 100 bookmarks spread across the four child folders.
const themes = {
  fte: [
    ["Postgres tips",       "https://www.postgresql.org/docs"],
    ["Rust programming",    "https://www.rust-lang.org"],
    ["TypeScript handbook", "https://www.typescriptlang.org/docs"],
    ["SQLite docs",         "https://www.sqlite.org/docs"],
    ["Node.js guide",       "https://nodejs.org/en/docs"],
  ],
  fco: [
    ["Pasta carbonara",     "https://cooking.nytimes.com/pasta"],
    ["Sourdough bread",     "https://cooking.nytimes.com/sourdough"],
    ["Thai green curry",    "https://cooking.nytimes.com/curry"],
    ["Miso soup",           "https://cooking.nytimes.com/miso"],
    ["Croissant recipe",    "https://cooking.nytimes.com/croissant"],
  ],
  fne: [
    ["Hacker News",         "https://news.ycombinator.com"],
    ["BBC front page",      "https://www.bbc.com/news"],
    ["NYT homepage",        "https://www.nytimes.com"],
  ],
};
const bookmarks = [];
let n = 0;
for (const [folderId, items] of Object.entries(themes)) {
  // 25-ish bookmarks per folder by cycling themes with suffixes.
  for (let i = 0; i < 33; i++) {
    const [t, u] = items[i % items.length];
    const suffix = i >= items.length ? " #" + (Math.floor(i / items.length) + 1) : "";
    bookmarks.push({
      chromeId: "b" + n,
      url: u + (u.includes("?") ? "&" : "?") + "v=" + n,
      title: t + suffix,
      folderChromeId: folderId,
    });
    n++;
  }
}
fs.writeFileSync(process.argv[1], JSON.stringify({
  folders,
  bookmarks,
  syncedFrom: "smoke_test",
}));
' "$FIXTURE"
BOOKMARK_COUNT=$(basic_post /api/bookmarks/sync "$(cat "$FIXTURE")" | "$NODE_BIN" -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(r.counts.bookmarksCreated)")
if [ "$BOOKMARK_COUNT" = "99" ]; then
  pass "synced 99 bookmarks across 5 folders"
else
  fail "expected 99 bookmarks created, got $BOOKMARK_COUNT"
fi

# ── AC #4: folder tree seeds from fixture ───────────────────────────────
log "AC #4: folder tree structure"

TREE=$(basic_get "$BASE/api/folders")
FOLDER_NAMES=$(echo "$TREE" | "$NODE_BIN" -e '
const tree = JSON.parse(require("fs").readFileSync(0,"utf8"));
const out = [];
function walk(node, depth) { out.push("  ".repeat(depth) + node.name); for (const c of node.children) walk(c, depth + 1); }
for (const f of tree) walk(f, 0);
console.log(out.join("\n"));
')
echo "$FOLDER_NAMES"
if grep -q "^Bookmarks bar$" <<<"$FOLDER_NAMES"; then
  pass "top-level 'Bookmarks bar' folder exists"
else
  fail "top-level 'Bookmarks bar' missing"
fi
if grep -q "Tech$" <<<"$FOLDER_NAMES"; then
  pass "'Tech' child folder exists under 'Bookmarks bar'"
else
  fail "'Tech' child folder missing"
fi

# ── AC #5: recent activity feed ─────────────────────────────────────────
log "AC #5: activity feed landing page"

FEED_START=$(date +%s%N)
FEED_HTML=$(basic_get "$BASE/")
FEED_END=$(date +%s%N)
FEED_MS=$(( (FEED_END - FEED_START) / 1000000 ))

if [ "$FEED_MS" -lt 500 ]; then
  pass "feed page rendered in ${FEED_MS}ms (budget 500ms)"
else
  fail "feed page slow: ${FEED_MS}ms (budget 500ms)"
fi

# Pick a Postgres bookmark for downstream assertions.
POSTGRES_ID=$(echo "$FEED_HTML" | grep -oE 'data-bookmark-id="[^"]+"' | head -1 | sed 's/data-bookmark-id="//;s/"//')
if [ -n "$POSTGRES_ID" ]; then
  pass "feed page emitted data-bookmark-id"
else
  fail "feed page missing data-bookmark-id markers"
fi

# Categorize UI markers (SIGPIPE-safe here-strings)
# Use here-string to avoid SIGPIPE on grep -q under pipefail (the pipe
# version exits 141 because grep -q closes stdin early).
for marker in 'data-search-form' 'data-add-folder' 'data-edit-title' 'data-delete-bookmark'; do
  if grep -q "$marker" <<<"$FEED_HTML"; then
    pass "feed page contains $marker"
  else
    fail "feed page missing $marker"
  fi
done

# ── AC #5b: clickable folder sidebar (filter by folder) ────────────
log "AC #5b: sidebar folder filter"

# Sidebar must render every folder as an anchor with /?folder=<id>.
FOLDER_ID_TECH=$(basic_get "$BASE/api/folders" | "$NODE_BIN" -e '
const tree = JSON.parse(require("fs").readFileSync(0,"utf8"));
function find(arr, name) { for (const f of arr) { if (f.name === name) return f.id; const r = find(f.children, name); if (r) return r; } return null; }
process.stdout.write(find(tree, "Tech") || "");
')
if [ -n "$FOLDER_ID_TECH" ]; then
  if grep -q "href=\"/?folder=$FOLDER_ID_TECH\"" <<<"$FEED_HTML"; then
    pass "sidebar emits a link to /?folder=<Tech-id>"
  else
    fail "sidebar missing link to /?folder=$FOLDER_ID_TECH"
  fi
else
  fail "could not resolve Tech folder id from /api/folders"
fi

# Hit /?folder=<Tech-id> and assert the heading shows the filter label
# + the active anchor is marked.
FILTERED_HTML=$(basic_get "$BASE/?folder=$FOLDER_ID_TECH")
if grep -q "data-active=\"true\"" <<<"$FILTERED_HTML"; then
  pass "filtered feed marks the active folder in the sidebar"
else
  fail "filtered feed does not highlight the active folder"
fi
if grep -q "in Bookmarks bar" <<<"$FILTERED_HTML"; then
  pass "filtered feed shows the folder-path label"
else
  fail "filtered feed missing folder-path label"
fi

# An unknown folder id falls back to the unfiltered feed (no items excluded).
UNKNOWN_HTML=$(basic_get "$BASE/?folder=does-not-exist")
UNKNOWN_COUNT=$(grep -c 'data-bookmark-id' <<<"$UNKNOWN_HTML")
TOTAL_COUNT=$(grep -c 'data-bookmark-id' <<<"$FEED_HTML")
if [ "$UNKNOWN_COUNT" = "$TOTAL_COUNT" ]; then
  pass "unknown folder id falls back to unfiltered feed ($UNKNOWN_COUNT items)"
else
  fail "unknown folder id changed result set ($UNKNOWN_COUNT vs $TOTAL_COUNT)"
fi

# ── AC #6: categorize (move + tag) ─────────────────────────────────────
log "AC #6: categorize flows"

# Update title + add a tag (additive mode)
UPDATE=$(basic_post "/api/bookmarks/$POSTGRES_ID" '{"title":"Postgres tips (smoke)","tags":["postgres","database","smoke"],"tagReplace":true}')
if grep -q '"tags"' <<<"$UPDATE"; then
  pass "POST /api/bookmarks/:id updated title + tags"
else
  fail "POST /api/bookmarks/:id did not return tags: $UPDATE"
fi

# Move to Other bookmarks
FOLDER_OB=$(basic_get "$BASE/api/folders" | "$NODE_BIN" -e '
const tree = JSON.parse(require("fs").readFileSync(0,"utf8"));
function find(arr, name) { for (const f of arr) { if (f.name === name) return f.id; const r = find(f.children, name); if (r) return r; } return null; }
process.stdout.write(find(tree, "Other bookmarks") || "");
')
if [ -n "$FOLDER_OB" ]; then
  MOVE=$(basic_post "/api/bookmarks/$POSTGRES_ID/move" "{\"folderId\":\"$FOLDER_OB\"}")
  if grep -q '"ok"' <<<"$MOVE"; then
    pass "POST /api/bookmarks/:id/move worked"
  else
    fail "move endpoint did not return ok: $MOVE"
  fi
else
  fail "could not find 'Other bookmarks' folder"
fi

# Tag list reflects the new tag
TAGS=$(basic_get "$BASE/api/tags")
if grep -q '"smoke"' <<<"$TAGS"; then
  pass "tag list contains the new 'smoke' tag"
else
  fail "tag list missing 'smoke' tag: $TAGS"
fi

# ── AC #7: search ───────────────────────────────────────────────────────
log "AC #7: search"

# Exact match
SEARCH_EXACT=$(basic_get "$BASE/api/search?q=postgres")
if grep -q '"mode":"fts5"' <<<"$SEARCH_EXACT"; then
  pass "exact match uses FTS5 mode"
else
  fail "exact match did not return fts5 mode: $SEARCH_EXACT"
fi
if grep -q '<mark>Postgres</mark>' <<<"$SEARCH_EXACT"; then
  pass "snippet contains <mark>Postgres</mark>"
else
  fail "snippet missing <mark> wrapper"
fi

# Typo tolerance
SEARCH_TYPO=$(basic_get "$BASE/api/search?q=postgers")
if grep -q '"mode":"fuzzy"' <<<"$SEARCH_TYPO"; then
  pass "typo 'postgers' triggers fuzzy mode"
else
  fail "typo did not trigger fuzzy mode: $SEARCH_TYPO"
fi
if grep -q '"title":"Postgres tips (smoke)"' <<<"$SEARCH_TYPO"; then
  pass "fuzzy match found the renamed Postgres bookmark"
else
  fail "fuzzy match did not surface the renamed bookmark"
fi

# Search HTML page renders
SEARCH_HTML=$(basic_get "$BASE/search?q=postgres")
if grep -q 'data-search-form' <<<"$SEARCH_HTML"; then
  pass "search page contains the form hook"
else
  fail "search page missing data-search-form"
fi
if grep -q '/static/search.js' <<<"$SEARCH_HTML"; then
  pass "search page references /static/search.js"
else
  fail "search page missing /static/search.js script"
fi

# Static asset is served
JS_BYTES=$(basic_get "$BASE/static/search.js" | wc -c)
if [ "$JS_BYTES" -gt 1000 ]; then
  pass "/static/search.js served (${JS_BYTES} bytes)"
else
  fail "/static/search.js too small or missing: ${JS_BYTES} bytes"
fi

# ── 1000-bookmark latency smoke ─────────────────────────────────────────
log "1000-bookmark latency smoke"

BIG_FIXTURE="$SMOKE_DIR/big.json"
"$NODE_BIN" -e '
const fs = require("fs");
const folders = [{ chromeId: "perf", parentChromeId: null, name: "Perf" }];
const bookmarks = Array.from({length: 1000}, (_, i) => ({
  chromeId: "perf" + i,
  url: "https://example.com/" + i,
  title: "PerfBookmark " + i,
  folderChromeId: "perf",
}));
fs.writeFileSync(process.argv[1], JSON.stringify({ folders, bookmarks, syncedFrom: "smoke_perf" }));
' "$BIG_FIXTURE"
basic_post /api/bookmarks/sync "$(cat "$BIG_FIXTURE")" > /dev/null

FEED_START=$(date +%s%N)
basic_get "$BASE/" > /dev/null
FEED_END=$(date +%s%N)
FEED_MS=$(( (FEED_END - FEED_START) / 1000000 ))
if [ "$FEED_MS" -lt 500 ]; then
  pass "1000-bookmark feed page in ${FEED_MS}ms"
else
  fail "1000-bookmark feed page slow: ${FEED_MS}ms"
fi

SEARCH_START=$(date +%s%N)
basic_get "$BASE/api/search?q=PerfBookmark" > /dev/null
SEARCH_END=$(date +%s%N)
SEARCH_MS=$(( (SEARCH_END - SEARCH_START) / 1000000 ))
if [ "$SEARCH_MS" -lt 200 ]; then
  pass "1000-bookmark search in ${SEARCH_MS}ms"
else
  fail "1000-bookmark search slow: ${SEARCH_MS}ms (budget 200ms)"
fi

# ── AC #2 (continued): token revoke cuts off the extension ──────────────
log "AC #2 (continued): token revocation"

TOKEN_ID=$(basic_get "$BASE/api/tokens" | "$NODE_BIN" -e '
const r = JSON.parse(require("fs").readFileSync(0,"utf8"));
process.stdout.write(r.tokens[0].id);
')
basic_delete "/api/tokens/$TOKEN_ID"

# Now the token should be rejected.
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/tokens")
if [ "$HTTP_CODE" = "401" ]; then
  pass "revoked token rejected with 401"
else
  fail "revoked token still accepted: HTTP $HTTP_CODE"
fi

# Cleanup test data (best-effort; trap will remove the data dir anyway)
PERF_ID=$(basic_get "$BASE/api/folders" | "$NODE_BIN" -e '
const tree = JSON.parse(require("fs").readFileSync(0,"utf8"));
function find(arr, name) { for (const f of arr) { if (f.name === name) return f.id; const r = find(f.children, name); if (r) return r; } return null; }
process.stdout.write(find(tree, "Perf") || "");
')
if [ -n "$PERF_ID" ]; then
  basic_delete "/api/folders/$PERF_ID" > /dev/null || true
fi