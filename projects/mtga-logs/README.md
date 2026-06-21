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

# show one deck's full card list
./target/release/mtga-logs deck 65d90c69-392e-4a5e-b96c-bc2ecdd9f7b8

# match history with deck used and W/L
./target/release/mtga-logs matches
```

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
- **Cards are grpIds, not names.** Arena uses internal numeric IDs. To map to card names, join with Scryfall bulk data: <https://scryfall.com/docs/api/bulk-data>.
- **Total collection size is unavailable** — Wizards removed the `GetPlayerCardsV3` endpoint in August 2021 and never replaced it. You can see your decks' contents but not your full collection.
- **Match/deck join is heuristic:** for each `GameResult`, we use the most recent preceding `DeckSubmission` as the deck used. Matches started without a `DeckSubmission` (some event entry flows) show `(unknown)`.
- **The `manasight-parser` crate is used with `default-features = false`** to skip the `tailer` (tokio + filesystem tailing) feature. We only use the synchronous `parse_whole_log` entry point.
- `Player.log` is overwritten each time MTG Arena starts; the previous file is kept as `Player-prev.log`. Detailed Logs must be enabled in Arena's settings for rich events to be parsed.
- The MTG Arena log format is unstable and breaks without notice — the parser may need an update after each game patch.
- `--scrub` runs `manasight_parser::scrub_raw_log` on the raw log text before parsing. It redacts auth tokens, bearer tokens, display names, user IDs, session IDs, emails, IPs, and OS-specific user paths. Use it before pasting output into chat, sharing logs, or committing sample output.
