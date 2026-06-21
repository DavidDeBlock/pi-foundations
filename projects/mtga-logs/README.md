# mtga-logs

CLI for reading and exploring an MTG Arena `Player.log`. Backed by [`manasight-parser`](https://github.com/manasight/manasight-parser) (Rust crate v0.5).

## Build

```bash
cd projects/mtga-logs
cargo build --release
```

Binary lands at `target/release/mtga-logs`.

## Subcommands

```bash
# default: dump all parsed events (one per line, JSON payload)
./target/release/mtga-logs --limit 20

# current wallet snapshot (gold, gems, wildcards, vault)
./target/release/mtga-logs inventory

# inventory across all snapshots in the log
./target/release/mtga-logs inventory --history

# list your decks (93 user decks by default, 93 netdecks hidden)
./target/release/mtga-logs decks

# include netdecks too
./target/release/mtga-logs decks --all

# show one deck's full card list (uses card DB if synced — see below)
./target/release/mtga-logs deck 65d90c69-392e-4a5e-b96c-bc2ecdd9f7b8

# match history with deck used and W/L
./target/release/mtga-logs matches

# render a self-contained HTML page of all your decks (and their cards)
./target/release/mtga-logs web -o decks.html
./target/release/mtga-logs web --all -o decks-with-netdecks.html  # include netdecks
```

## Web view

`web` generates self-contained dark-themed HTML pages you can open in any browser. When `-o FILE` is given, it produces two files that link to each other:

- `FILE` (e.g. `decks.html`) — deck list with collapsible card tables
- `FILE`-matches.html (e.g. `decks-matches.html`) — match history with W/L badges and a win-rate summary

```bash
./target/release/mtga-logs web -o /tmp/decks.html         # writes both files (47 user decks, ~630 KB)
./target/release/mtga-logs web --all -o /tmp/decks.html   # include netdecks (140 decks, ~3.4 MB)
./target/release/mtga-logs web --system -o /tmp/d.html    # also show precons / world-champ decks ("?=" names)
./target/release/mtga-logs web > decks.html               # stdout: single combined page (no nav links)
```

### Decks page

Each deck is a closed `<details>` block; click the row to expand. The collapsed summary shows:

- **Color identity pips** — W/U/B/R/G in the deck's colors
- **Name** (bold)
- **Format pill** — Standard / Alchemy / Historic / etc.
- **Card count** — `60 cards`, `9 side`
- **Crafting cost** — wildcards needed (`19C 10U 6R`); basic lands excluded
- **Played date** — most recent `DeckSubmission`
- **Type pill** — `user` (green) / `netdeck` (red) / `system` (orange)
- **ID** (faded, right-aligned)

The card table inside each expanded deck shows:

- **Qty** — count in mainboard / sideboard
- **Name** — from the Scryfall DB. **Hover any card to see a Scryfall card image** (loaded on demand from their CDN)
- **Mana** — cost in `{W}{U}{B}` notation
- **Type** — full type line
- **Rarity** — color-coded letter (c/u/r/m)
- **Set** + collector number
- **Artist**

A toggle in the header bar reveals hidden **system decks** (the `?=?Loc/Decks/Precon/...` rows — game-shipped precons / world-champ decks whose friendly name was never seen by the MTGA client).

**Default filtering:**

- Hides netdecks (use `--all` to show them)
- Hides system decks (use `--system` to show them; or click the toggle on the rendered page)

### Matches page

Above the match list, a **dashboard** adds three quick-glance views:

- **Streak badge** (top-left) — `▲ 2-win streak` or `▼ 3-loss streak`; only shown for runs of 2+
- **By event** chips — W–L breakdown per event type (Ladder, DirectGame, Draft, etc.), color-coded by category
- **Last games sparkline** (top-right) — SVG row of up to 30 games, oldest on the left; hover a square for date/result/deck

Below the dashboard, a **per-deck stats table** groups matches by deck:

| Deck          | G | W | L | Win% | Last played |
|---------------|---|---|---|------|-------------|
| Mono White MK3| 4 | 2 | 2 | 50%  | 8h ago      |
| (no deck)     | 5 | 3 | 2 | 60%  | 2026-06-21  |

Win% is color-coded green/red only when the deck has 3+ games. `(no deck)` and `(unknown)` rows are shown in italic.

The full **match table** lists every game result found in the log:

- **Date** — when the game finished
- **Result** — green Win / red Loss / gray ? badge
- **Deck** — joined heuristically from the most recent preceding `DeckSubmission`
- **Event** — `Ladder`, `Jump_In_2024`, etc.
- **Reason** — `Game`, `Concede`, `Timeout`, ...

A "8 GAMES · 5W–3L (62%)" summary sits at the top. Deck names show `(no deck)` for matches that started without a preceding `DeckSubmission`.

### Serving on the network

Quick-and-dirty: regenerate, then serve with Python's built-in HTTP server (no install needed on Ubuntu):

```bash
mtga-logs web -o /tmp/decks.html
cd /tmp && python3 -m http.server 8000 --bind 0.0.0.0
# then open http://<server-ip>:8000/decks.html from any other device on the LAN
```

If the connection is refused, you may need `sudo ufw allow from 192.168.0.0/24 to any port 8000`.

## Persistence: events.db is the source of truth

All read commands (`inventory`, `decks`, `deck <ID>`, `matches`, `web`) read from a persistent SQLite database at `~/.local/share/mtga-logs/events.db`, **not** directly from the current `Player.log`. This survives MTGA's log rotation: both `Player.log` and `Player.log.old` are ingested in one pass.

```
Player.log ────ingest────▶ events.db ────query────▶ HTML / CLI output
   (and Player.log.old)
```

### How it works

Every read command first calls `store::maybe_ingest(log_path)`:

1. Compute fingerprint `(path, mtime, size)` for `Player.log` and `Player.log.old` (if present)
2. Look up each fingerprint in the `ingestions` table
3. If seen before → skip. Otherwise → parse the whole file and upsert.

A match in the same fingerprint means the file hasn't changed → near-instant.
A different fingerprint (e.g. MTGA rotated the log) → ingest the new content → accumulate over time.

Result: `web` runs are ~30ms when the log hasn't changed, ~2 seconds on first run / after rotation.

### Schema

| Table | Purpose | Rows |
|---|---|---|
| `ingestions` | Fingerprint per parsed log file | 1 per (path × mtime × size) |
| `decks` | One row per `deck_id`; latest `DeckCollection` wins for contents | all decks ever seen |
| `matches` | One row per `matchID` (from `GameResult.game_info.matchID`) | one per game |
| `inventory_snapshots` | Append-only time series of `InventoryInfo` | one per Arena session |
| `meta` | Schema version | 1 row |

### Conflict resolution

| Data | Rule | Why |
|---|---|---|
| Deck contents | Latest `DeckCollection` payload wins | Decks you edit in MTGA; latest is "what it was" |
| Deck deletion | Deck stays in DB | We never see "deleted" events; keeps history |
| Match | First-write-wins by `matchID` | Matches are immutable events |
| Inventory | Append every snapshot | History is interesting (when did you spend that gold?) |

### Commands

```bash
mtga-logs store-info   # show DB row counts and last ingestion time
mtga-logs ingest       # force re-ingest (skips the fingerprint check)
```

### Reset

To wipe everything and re-ingest from the current log:

```bash
rm ~/.local/share/mtga-logs/events.db
mtga-logs web -o /tmp/decks.html
```

### Layout

```
~/.local/share/mtga-logs/
├── cards.db        # Scryfall (18,767 Arena-mapped cards)
├── cards.json      # Scryfall cached bulk (~520 MB)
└── events.db       # your parsed MTGA Arena history (this feature)
```

## Card name database

`deck <ID>` shows card names instead of grpId numbers when a local Scryfall mirror is synced:

```bash
# one-time setup: downloads the Scryfall default-cards bulk file (~520 MB,
# ~12 seconds at 40 MB/s, then ~5 seconds to import into SQLite)
./target/release/mtga-logs sync-cards

# subsequent runs are instant — only re-downloads when Scryfall publishes an update
./target/release/mtga-logs sync-cards

# show current DB status (no network call)
./target/release/mtga-logs sync-cards --info

# force a re-download (e.g. after a long time, or to recover from corruption)
./target/release/mtga-logs sync-cards --force
```

Storage: `~/.local/share/mtga-logs/cards.db` (~5 MB SQLite) and `cards.json` (~520 MB cached JSON).

The join key is **MTGA `grpId` = Scryfall `arena_id`**. Verified end-to-end with a real deck card (`grpId 75472` → "Riddlemaster Sphinx"). On this log, **99.4%** of your deck cards (5374/5404) resolve to a Scryfall card; the few misses are typically Alchemy rebalances or newly-released cards not yet indexed.

## Global flags

```bash
PATH                  # Player.log file (default: /mnt/mtga-logs/Player.log)
--limit N             # (default mode) show only the last N events
--scrub               # redact PII before parsing
```

Example: `mtga-logs --scrub /path/to/other.log inventory --history`

## Output examples

**`inventory`**
```
Inventory snapshot from 2026-06-21 04:42:57 UTC (SeqId 69)

  Gold                            51,800
  Gems                             1,600

  Wildcards (194 total):
    Common                            88
    Uncommon                          58
    Rare                              27
    Mythic                            21

  Vault progress                     538
  Wildcard track position             16
```

**`inventory --history`**
```
Inventory history (9 snapshots):

Session start             Gold    Gems   WCc   WCu   WCr   WCm   Vault  SeqId
2026-06-21 00:51:50     51,850   1,600    88    58    27    21     535      1
2026-06-21 01:28:18     52,100   1,600    88    58    27    21     535     18
2026-06-21 01:42:14     51,100   1,600    88    58    27    21     538     28
2026-06-21 04:42:57     51,800   1,600    88    58    27    21     538     69
```

**`decks`**
```
loaded 186 decks (93 user, 93 netdeck hidden); use --all to include netdecks

Name                                           Format        Cards  Side  Last played
Cat Attack (2)                                 Standard         60     0  2026-06-21
Budget Dino's                                  Standard         60     0  2026-06-21
Selesnya Tokens (no SB)                        Standard         60     0  2026-06-21
```

**`deck <ID>`** (with card DB synced)
```
Deck:   Mono White MK2
ID:     1f87e561-3f62-4e5b-94ae-4c052bc97312
Format: Standard
Played: 2025-10-12 22:07:47 UTC

Main deck (60 cards across 17 entries):
  3x Leonin Vanguard {W} [fdn #499, uncommon]
  2x Exemplar of Light {2}{W}{W} [fdn #11, rare]
  23x Plains [anb #115, common]
  4x Sheltered by Ghosts {1}{W} [dsk #30, uncommon]
  3x Leyline of Hope {2}{W}{W} [dsk #18, rare]
  ...

Sideboard: (empty)
```

**`matches`**
```
Match history (8 games):

Date               Deck                          Event           Result  Reason
2026-06-21 01:07   (unknown)                     ?               Loss    Game
2026-06-21 02:01   Mono White MK3                Ladder          Loss    Concede
2026-06-21 02:13   Mono White MK3                Ladder          Win     Game
2026-06-21 03:16   Mono White MK3                Ladder          Win     Timeout
```

## Notes

- **Where inventory comes from:** the `manasight-parser` router dispatches `StartHook` responses to `DeckCollection` first, which claims every entry — so `Inventory` events are never emitted. We work around this by reading `DeckCollection.raw_start_hook.InventoryInfo` directly.
- **Card names** come from a locally-synced SQLite mirror of Scryfall's `default_cards` bulk data (see "Card name database" above). Without it, `deck <ID>` falls back to grpId numbers and prints a one-time hint to run `sync-cards`.
- **Total collection size is unavailable** — Wizards removed the `GetPlayerCardsV3` endpoint in August 2021 and never replaced it. You can see your decks' contents but not your full collection.
- **Match/deck join is heuristic:** for each `GameResult`, we use the most recent preceding `DeckSubmission` as the deck used. Matches started without a `DeckSubmission` (some event entry flows) show `(unknown)`.
- **The `manasight-parser` crate is used with `default-features = false`** to skip the `tailer` (tokio + filesystem tailing) feature. We only use the synchronous `parse_whole_log` entry point.
- `Player.log` is overwritten each time MTG Arena starts; the previous file is kept as `Player-prev.log`. Detailed Logs must be enabled in Arena's settings for rich events to be parsed.
- The MTG Arena log format is unstable and breaks without notice — the parser may need an update after each game patch.
- `--scrub` runs `manasight_parser::scrub_raw_log` on the raw log text before parsing. It redacts auth tokens, bearer tokens, display names, user IDs, session IDs, emails, IPs, and OS-specific user paths. Use it before pasting output into chat, sharing logs, or committing sample output.
