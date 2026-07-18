#!/usr/bin/env bash
# news-smoke.sh — end-to-end smoke test for the News & Weather
# slice (issues NW-001..NW-005). Boots an isolated server instance
# (temp data dir, random free port, scheduler DISABLED so we don't
# depend on network access during the smoke), seeds a few articles
# and a weather snapshot directly into the SQLite DB so the page
# has something to render, then walks the page + the manual refresh
# endpoint and asserts the expected state.
#
# Failure: prints what went wrong and exits non-zero. Cleanup
# always runs (trap) so a crashed run doesn't leave zombie
# processes or temp dirs behind.
#
# Usage:
#   bash scripts/news-smoke.sh           # from server/
#   or from anywhere:
#   bash /path/to/dashboard/server/scripts/news-smoke.sh

set -uo pipefail

# ── Resolve paths ────────────────────────────────────────────────────────

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

# Allow override via env, but default to the canonical pnpm + node from PATH.
PNPM_BIN=${PNPM_BIN:-pnpm}
NODE_BIN=${NODE_BIN:-node}

# sqlite3 CLI may not be installed in all dev environments. We fall
# back to a small inline Node script using `better-sqlite3` (already
# a server dependency) when the CLI is unavailable.
SQLITE_BIN=${SQLITE_BIN:-}

# Node helper for DB writes. Reads SQL from argv[1] (a here-doc)
# and executes it against argv[2] (the DB path). Uses
# `better-sqlite3` so the smoke is self-contained without needing
# the system `sqlite3` binary.
db_exec() {
  local db="$1" sql="$2"
  "$NODE_BIN" --input-type=module -e '
import Database from "better-sqlite3";
const dbPath = process.argv[1];
const sql = process.argv[2];
const db = new Database(dbPath);
try { db.exec(sql); } finally { db.close(); }
' "$db" "$sql"
}

# Single-row helper. Returns the first column of the first row.
db_query() {
  local db="$1" sql="$2"
  "$NODE_BIN" --input-type=module -e '
import Database from "better-sqlite3";
const dbPath = process.argv[1];
const sql = process.argv[2];
const db = new Database(dbPath, { readonly: true });
try {
  const row = db.prepare(sql).get();
  process.stdout.write(row == null ? "" : String(Object.values(row)[0] ?? ""));
} finally { db.close(); }
' "$db" "$sql"
}

# ── Helpers ──────────────────────────────────────────────────────────────

log()  { printf '\033[36m[news-smoke]\033[0m %s\n' "$*"; }
pass() { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
done_() { printf '\033[32m[news-smoke] DONE\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[news-smoke] ERROR\033[0m %s\n' "$*" >&2; exit 1; }

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

# ── Setup isolated environment ──────────────────────────────────────────

log "Setting up isolated news-smoke environment"
SMOKE_DIR=$(mktemp -d /tmp/dashboard-news-smoke.XXXXXX)
SMOKE_PORT=$(pick_free_port)
SMOKE_PASSWORD="news-smoke-$(date +%s)-$RANDOM"
BASE="http://127.0.0.1:$SMOKE_PORT"
DB_PATH="$SMOKE_DIR/news-smoke.db"

# Redirect data dir under the smoke temp so we don't touch the dev DB.
SMOKE_DATA_DIR="$SMOKE_DIR/data"
mkdir -p "$SMOKE_DATA_DIR"

log "  data dir : $SMOKE_DATA_DIR"
log "  db path  : $DB_PATH"
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
    printf '\033[31m[news-smoke] FAILED\033[0m %d check(s) failed\n' "$FAILURES" >&2
  fi
  exit $((code > 0 ? code : FAILURES))
}
trap cleanup EXIT INT TERM

# ── Boot server (scheduler DISABLED) ────────────────────────────────────
# `DASHBOARD_NEWS_INTERVAL_MIN=0` puts the scheduler in manual-only
# mode so this smoke doesn't depend on outbound network access to
# the real VRT NWS / Open-Meteo endpoints. The scheduler + fetcher
# pipeline is already covered by 85+ dedicated unit tests; this
# smoke verifies the boot wiring + the page + the manual refresh
# endpoint, which are the integration concerns specific to NW-005.
#
# `DASHBOARD_TLS_CERT=""` + `DASHBOARD_TLS_KEY=""` explicitly disable
# TLS even when the dev's `.env` enables it. The smoke binds to a
# loopback port over plain HTTP; using `curl --insecure` against a
# self-signed cert works but adds noise to the assertions. Plain
# HTTP is also the convention for the existing `smoke.sh` script.
#
# We invoke node directly via the `tsx/esm` loader rather than
# `pnpm start`. The pnpm → tsx → node chain swallows SIGTERM
# (tsx terminates its child before our signal handler fires),
# so the SIGTERM teardown assertion at the bottom of this script
# wouldn't fire. Direct node + tsx/esm keeps the signal handlers
# reachable.
log "Booting server (scheduler disabled, TLS disabled)"
DASHBOARD_PASSWORD="$SMOKE_PASSWORD" \
DASHBOARD_DATA_DIR="$SMOKE_DATA_DIR" \
DASHBOARD_DB_PATH="$DB_PATH" \
DASHBOARD_NEWS_INTERVAL_MIN=0 \
DASHBOARD_TLS_CERT="" \
DASHBOARD_TLS_KEY="" \
PORT="$SMOKE_PORT" \
HOSTNAME=127.0.0.1 \
setsid "$NODE_BIN" --import "$SERVER_DIR/node_modules/tsx/dist/loader.mjs" \
  "$SERVER_DIR/src/index.ts" \
  > "$SMOKE_DIR/server.log" 2>&1 < /dev/null &
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

# Confirm the scheduler logged as disabled.
if grep -q 'news scheduler disabled' "$SMOKE_DIR/server.log"; then
  pass "boot log reports 'news scheduler disabled'"
else
  fail "boot log missing the 'news scheduler disabled' line. Log tail:
$(tail -30 "$SMOKE_DIR/server.log")"
fi

# ── AC #1: page renders the empty state with seeded source count ─────
log "AC #1: /news-weather renders the meta line + empty states"

NEWS_HTML=$(basic_get "$BASE/news-weather")
if [ -n "$NEWS_HTML" ]; then
  pass "GET /news-weather → 200 + HTML"
else
  err "GET /news-weather returned empty body"
fi

# Seed migration (`025_news.sql`) registers 5 enabled sources.
if grep -q "5 sources enabled" <<<"$NEWS_HTML"; then
  pass "page reports '5 sources enabled' from seed migration"
else
  fail "expected '5 sources enabled' in meta line"
fi

# Weather snapshot is empty in a cold boot → empty-state block.
if grep -q 'data-weather="empty"' <<<"$NEWS_HTML"; then
  pass "weather block shows empty-state placeholder"
else
  fail "weather block did not render empty-state placeholder"
fi

# No articles → the "No news yet" fallback.
if grep -q "No news yet. Feeds will populate within 30 minutes." <<<"$NEWS_HTML"; then
  pass "page shows the no-articles fallback line"
else
  fail "page missing the 'No news yet' fallback"
fi

# Sidebar nav link is present.
if grep -q 'href="/news-weather"' <<<"$NEWS_HTML"; then
  pass "sidebar emits the /news-weather nav link"
else
  fail "sidebar missing /news-weather nav link"
fi
if grep -q 'data-sidebar-nav="news-weather"' <<<"$NEWS_HTML"; then
  pass "sidebar nav link carries data-sidebar-nav='news-weather'"
else
  fail "sidebar nav link missing data-sidebar-nav"
fi
if grep -q '<title>News & Weather — Dashboard</title>' <<<"$NEWS_HTML"; then
  pass "page <title> is 'News & Weather — Dashboard'"
else
  fail "page <title> not set as expected"
fi

# ── AC #2: seed a weather snapshot + a few articles via direct SQL ─
# This is the integration side of the smoke: it verifies the page
# actually reads from `weather_snapshots` + `news_articles` tables
# populated by the (real) ingestion pipeline. We use sqlite3 CLI
# directly because it's faster than booting a node script for
# half a dozen inserts, and the SQL mirrors what the store writes.
log "AC #2: seed a weather snapshot + 4 articles (one per category)"

# The first-implementation seed (`025_news.sql`) only registers
# 4 news sources covering 3 categories. The page's fourth
# category ("Local and Politics") has no source yet — that's
# PRD-009 territory. For the smoke we add a synthetic 6th
# source so we can exercise all 4 article categories in one
# page render. Real fetches for this row are not exercised
# (the smoke runs with the scheduler disabled).
db_exec "$DB_PATH" "INSERT INTO news_sources
  (name, category, type, url, refresh_interval_min, enabled, created_at)
  SELECT 'BRUZZ Local', 'Local and Politics', 'rss',
         'https://www.bruzz.be/rss/local.xml', 30, 1,
         '2024-07-16T12:00:00.000Z'
  WHERE NOT EXISTS (
    SELECT 1 FROM news_sources WHERE url = 'https://www.bruzz.be/rss/local.xml'
  )"
WEATHER_ID=$(db_query "$DB_PATH" "SELECT id FROM news_sources WHERE type = 'json_api' LIMIT 1")
if [ -z "$WEATHER_ID" ]; then
  err "could not find seeded json_api source"
fi
log "  weather source id: $WEATHER_ID"

# Insert one snapshot.
NOW_ISO='2024-07-16T12:00:00.000Z'
CURRENT='{"temperature_2m":22.5,"apparent_temperature":23.1,"precipitation":0,"rain":0,"weather_code":1,"wind_speed_10m":12,"wind_gusts_10m":28}'
DAILY='[{"time":"2024-07-16","weather_code":1,"temperature_2m_max":24,"temperature_2m_min":14,"precipitation_probability_max":10},{"time":"2024-07-17","weather_code":3,"temperature_2m_max":22,"temperature_2m_min":13,"precipitation_probability_max":30},{"time":"2024-07-18","weather_code":61,"temperature_2m_max":19,"temperature_2m_min":12,"precipitation_probability_max":80},{"time":"2024-07-19","weather_code":95,"temperature_2m_max":20,"temperature_2m_min":13,"precipitation_probability_max":90},{"time":"2024-07-20","weather_code":2,"temperature_2m_max":21,"temperature_2m_min":14,"precipitation_probability_max":20},{"time":"2024-07-21","weather_code":0,"temperature_2m_max":25,"temperature_2m_min":15,"precipitation_probability_max":5},{"time":"2024-07-22","weather_code":0,"temperature_2m_max":27,"temperature_2m_min":17,"precipitation_probability_max":5}]'
HOURLY='[]'

if db_exec "$DB_PATH" "INSERT INTO weather_snapshots (source_id, fetched_at, current_json, daily_json, hourly_json) VALUES ($WEATHER_ID, '$NOW_ISO', '$CURRENT', '$DAILY', '$HOURLY')"; then
  pass "weather snapshot seeded (source_id=$WEATHER_ID)"
else
  fail "weather snapshot insert failed"
fi

# Insert one article per category, paired to its matching seed source.
seed_articles() {
  db_exec "$DB_PATH" "INSERT INTO news_articles (id, source_id, title, description, url, published_at, fetched_at) VALUES
  ('smoke-g',  (SELECT id FROM news_sources WHERE category='General'                              LIMIT 1), 'Smoke general headline', 'A short description.', 'https://www.vrt.be/vrtnws/nl/smoke-general',  '$NOW_ISO', '$NOW_ISO'),
  ('smoke-e',  (SELECT id FROM news_sources WHERE category='Economy'                              LIMIT 1), 'Smoke economy headline', 'Market summary.',     'https://www.tijd.be/smoke-economy',            '$NOW_ISO', '$NOW_ISO'),
  ('smoke-l',  (SELECT id FROM news_sources WHERE category='Local and Politics'                  LIMIT 1), 'Smoke local headline',   'Ghent news today.',  'https://www.bruzz.be/smoke-local',             '$NOW_ISO', '$NOW_ISO'),
  ('smoke-t',  (SELECT id FROM news_sources WHERE category='Technology and Cybersecurity'         LIMIT 1), 'Smoke security headline','Phishing alert.',     'https://ccb.belgium.be/smoke-security',        '$NOW_ISO', '$NOW_ISO')"
}
if seed_articles; then
  pass "4 articles seeded (one per news category)"
else
  fail "article seed insert failed"
fi

# ── AC #3: page now renders weather block + category headers ────
log "AC #3: /news-weather renders populated state"

NEWS_HTML=$(basic_get "$BASE/news-weather")

# Weather block flips to "ready" when a snapshot exists.
if grep -q 'data-weather="ready"' <<<"$NEWS_HTML"; then
  pass "weather block flipped to 'ready' state"
else
  fail "weather block did not flip to 'ready' after snapshot insert"
fi

# Current temp is rounded: 22.5 → 23
if grep -q 'news-weather-temp-value">23<' <<<"$NEWS_HTML"; then
  pass "current temperature renders as 23 (rounded from 22.5)"
else
  fail "current temperature did not render as 23"
fi

# WMO weather_code 1 → "Overwegend helder" (Dutch for 'Mainly clear').
if grep -q "Overwegend helder" <<<"$NEWS_HTML"; then
  pass "WMO code 1 mapped to 'Overwegend helder'"
else
  fail "WMO code 1 not mapped to 'Overwegend helder'"
fi

# Forecast heading rendered in Dutch.
if grep -q "Weersvoorspelling komende 7 dagen" <<<"$NEWS_HTML"; then
  pass "7-day forecast heading rendered in Dutch"
else
  fail "7-day forecast heading not in Dutch"
fi

# First forecast day label rendered in Dutch ('Vandaag').
if grep -q 'news-weather-day-label">Vandaag</span>' <<<"$NEWS_HTML"; then
  pass "first forecast day label is 'Vandaag'"
else
  fail "first forecast day label not 'Vandaag'"
fi

# Each of the 7 forecast day cards now carries an emoji icon
# span. The icon for code 1 is 🌤; for code 3 (which seeded
# fixtures use for several days) it's ☁️. We just assert
# presence, not the specific glyph — easier to maintain.
DAYS=$(grep -oc 'news-weather-day"' <<<"$NEWS_HTML" || true)
DAY_ICONS=$(grep -oc 'news-weather-day-icon"' <<<"$NEWS_HTML" || true)
if [ "$DAYS" = "7" ] && [ "$DAY_ICONS" = "7" ]; then
  pass "7 forecast day cards each carry an emoji icon"
else
  fail "expected 7 day cards + 7 day icons, got $DAYS days / $DAY_ICONS icons"
fi

# Current-condition icon span is rendered (sun family for code 0).
if grep -q 'class="news-weather-icon-current"' <<<"$NEWS_HTML"; then
  pass "current-condition icon span rendered"
else
  fail "current-condition icon span missing"
fi

# Stat labels rendered in Dutch.
for label in 'Voelt als' 'Regen' 'Neerslag' 'Windstoten' 'Vandaag min/max'; do
  if grep -q "$label" <<<"$NEWS_HTML"; then
    pass "Dutch stat label rendered: $label"
  else
    fail "Dutch stat label missing: $label"
  fi
done

# 7-day forecast row
DAYS=$(grep -oc 'news-weather-day"' <<<"$NEWS_HTML" || true)
if [ "$DAYS" = "7" ]; then
  pass "7-day forecast row renders all 7 day cards"
else
  fail "expected 7 day cards, got $DAYS"
fi

# Each category header is present (no longer omitted).
for cat in 'General' 'Economy' 'Local and Politics' 'Technology and Cybersecurity'; do
  if grep -q "<h2>$cat</h2>" <<<"$NEWS_HTML"; then
    pass "category header rendered: $cat"
  else
    fail "category header missing: $cat"
  fi
done

# Article cards render with the expected source names. The first
# three are from the first-implementation seed (`025_news.sql`):
# VRT NWS, De Tijd — General (note the em-dash + space), CCB
# News. BRUZZ is the synthetic source we added above for the
# "Local and Politics" category.
for src in 'VRT NWS' 'De Tijd' 'BRUZZ' 'CCB News'; do
  if grep -q "$src" <<<"$NEWS_HTML"; then
    pass "source name appears in rendered HTML: $src"
  else
    fail "source name missing from HTML: $src"
  fi
done

# Article cards link out with target=_blank rel=noopener.
if grep -q 'target="_blank"' <<<"$NEWS_HTML" && grep -q 'rel="noopener"' <<<"$NEWS_HTML"; then
  pass "article links use target=_blank + rel=noopener"
else
  fail "article links missing target=_blank or rel=noopener"
fi

# Empty-state markers are gone.
ABSENT_MARKERS=(
  'data-news="empty"'
  'No news yet'
  'data-weather="empty"'
)
for marker in "${ABSENT_MARKERS[@]}"; do
  if ! grep -q "$marker" <<<"$NEWS_HTML"; then
    pass "absent marker (correctly hidden when populated): $marker"
  else
    fail "absent marker unexpectedly present: $marker"
  fi
done

# ── AC #4: POST /api/news/refresh runs a tick ────────────────────
log "AC #4: POST /api/news/refresh"

# With the scheduler disabled (interval=0), this is the only way
# to drive ingestion. The seeded sources were JUST fetched by the
# direct SQL inserts above, so the due-check sees them as fresh;
# we re-set their last_fetched_at to NULL to force a re-tick, OR
# we rely on the response showing `fetchedCount: N` if any source
# is due (which it isn't, given the explicit interval of 0 — but
# the manual route runs the orchestrator regardless).
#
# To force the tick to actually do work, we wipe last_fetched_at
# on all enabled sources so the due-check passes.
db_exec "$DB_PATH" "UPDATE news_sources SET last_fetched_at = NULL, last_successful_fetch_at = NULL"

REFRESH_BODY=$(basic_post /api/news/refresh '{}')
if grep -q '"succeededCount"' <<<"$REFRESH_BODY"; then
  pass "POST /api/news/refresh → 200 + TickSummary JSON"
else
  fail "POST /api/news/refresh did not return TickSummary: $REFRESH_BODY"
fi

# At least one source should have been fetched (we just nulled
# every source's last_fetched_at). The seed has 5 enabled sources.
FETCHED=$(echo "$REFRESH_BODY" | "$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).fetchedCount))')
if [ "$FETCHED" -ge 1 ]; then
  pass "tick fetched $FETCHED source(s) after clearing last_fetched_at"
else
  fail "tick fetched $FETCHED sources (expected ≥1)"
fi

# ── AC #5: auth gates the manual endpoint ────────────────────────
log "AC #5: auth gates /api/news/refresh"

WRONG_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -u "smoke:wrong" -X POST "$BASE/api/news/refresh")
if [ "$WRONG_CODE" = "401" ]; then
  pass "wrong password → 401"
else
  fail "wrong password returned $WRONG_CODE (expected 401)"
fi

# ── AC #6: SIGTERM tears down the scheduler cleanly ──────────────
log "AC #6: SIGTERM teardown"

# The cleanup trap will kill the server on exit, so we set
# SERVER_PID="" to disable the trap's kill and then send SIGTERM
# directly. This lets the server's signal handler run + log the
# shutdown path before the process exits.
kill -TERM "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

for i in {1..10}; do
  # Use pgrep to look for any lingering server processes.
  if ! pgrep -f "tsx src/index.ts" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if grep -q 'received; stopping scheduler' "$SMOKE_DIR/server.log"; then
  pass "server logged SIGTERM and shutdown path"
else
  fail "server did not log shutdown path. Log tail:
$(tail -20 "$SMOKE_DIR/server.log")"
fi