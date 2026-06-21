//! Persistent event store backed by SQLite.
//!
//! Owns `~/.local/share/mtga-logs/events.db`. The DB is the source of truth for
//! the HTML view: the log file is input, the DB is history. Ingestion is
//! idempotent — a log file with the same `(path, mtime, size)` is never
//! re-parsed, so subsequent `web` calls are cheap.
//!
//! ## Schema
//!
//! - `ingestions` — one row per log file we've parsed (fingerprint = path +
//!   mtime + size). Skipping rows here is what makes ingestion idempotent.
//! - `decks` — one row per `deck_id`. Latest `DeckCollection` wins for
//!   contents; latest `DeckSubmission` wins for `last_seen`.
//! - `matches` — one row per `matchID` (the unique ID from
//!   `GameResult.game_info.matchID`). First-write-wins; matches are immutable.
//! - `inventory_snapshots` — append-only time series; one row per
//!   `InventoryInfo` snapshot extracted from
//!   `DeckCollection.raw_start_hook.InventoryInfo`.
//! - `match_states` — one row per `GameStateMessage.gameStateId` for every
//!   match. Captured by bracketing GameState events to the surrounding
//!   GameOver state (which has `game_info.matchID`). Used for per-match step
//!   timelines.
//! - `match_players` — both players (seat 1 = local, seat 2 = opponent) from
//!   `matchGameRoomStateChangedEvent.reservedPlayers`. Includes opponent
//!   `playerName`, avatar `courseId`, and `platformId` (when present in log).
//! - `match_life_changes` — `AnnotationType_ModifiedLife` deltas per seat.
//!   `affectedIds[0]` is the player seat (1 or 2); the `life` detail is the
//!   delta vs previous life total.
//! - `match_zone_transfers` — `AnnotationType_ZoneTransfer` events. The
//!   `affectedIds[0]` game-object instance ID is resolved against the same
//!   `GameStateMessage.gameObjects` array to attribute the move to a player
//!   and look up the card's `grpId`.
//!
//! ## Conflict resolution
//!
//! - **Decks**: latest `DeckCollection` payload wins for contents. A deck that
//!   disappears from the latest collection is **not** deleted from the DB
//!   (we never know about deletions from the log).
//! - **Matches**: `INSERT OR IGNORE`. A match ID never appears twice in the
//!   log, so first-write-wins is safe.
//! - **Inventory**: pure append. Every snapshot is preserved.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use manasight_parser::{parse_whole_log, GameEvent};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::{DeckSummary, InventorySnapshot, MatchRecord};

const SCHEMA_VERSION: &str = "4";

// ============================================================================
// paths
// ============================================================================

pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(p).join("mtga-logs");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local").join("share").join("mtga-logs");
    }
    PathBuf::from(".mtga-logs")
}

pub fn db_path() -> PathBuf {
    data_dir().join("events.db")
}

fn ensure_data_dir() -> Result<(), String> {
    fs::create_dir_all(data_dir()).map_err(|e| format!("create data dir: {}", e))
}

pub fn open_db() -> Result<Connection, String> {
    ensure_data_dir()?;
    let conn = Connection::open(db_path()).map_err(|e| format!("open db: {}", e))?;
    // WAL gives us concurrent reads while a write is happening (handy if
    // someone hits `web` while a slow `ingest` is running in the background).
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("enable WAL: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    // First, read the existing schema version (if any). If it's older than
    // SCHEMA_VERSION, run incremental migrations. This lets us add new
    // tables without losing existing data.
    let existing_version = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok();

    // v3 -> v4: add user_decks table for the deck builder.
    if existing_version.as_deref() == Some("3") {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS user_decks (
                deck_id         TEXT    PRIMARY KEY,
                name            TEXT    NOT NULL,
                format          TEXT,
                notes           TEXT,
                first_created   INTEGER NOT NULL,
                last_modified   INTEGER NOT NULL,
                mainboard_json  TEXT    NOT NULL,
                sideboard_json  TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_user_decks_modified
                ON user_decks(last_modified DESC);
            UPDATE meta SET value = '4' WHERE key = 'schema_version';
            "#,
        )
        .map_err(|e| format!("migrate v3->v4: {}", e))?;
    }

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ingestions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT    NOT NULL,
            source_mtime INTEGER NOT NULL,
            source_size  INTEGER NOT NULL,
            parsed_at    INTEGER NOT NULL,
            event_count  INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestions_fingerprint
            ON ingestions(source_path, source_mtime, source_size);

        CREATE TABLE IF NOT EXISTS decks (
            deck_id           TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            format            TEXT,
            is_netdeck        INTEGER NOT NULL DEFAULT 0,
            first_seen        INTEGER,
            last_seen         INTEGER NOT NULL,
            last_collection_ts INTEGER,
            mainboard_json    TEXT NOT NULL,
            sideboard_json    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decks_last_seen
            ON decks(last_seen DESC);

        CREATE TABLE IF NOT EXISTS matches (
            match_id     TEXT PRIMARY KEY,
            ts           INTEGER NOT NULL,
            deck_id      TEXT,
            event_name   TEXT,
            result       TEXT,
            reason       TEXT,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_matches_ts
            ON matches(ts DESC);

        CREATE TABLE IF NOT EXISTS inventory_snapshots (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            ts               INTEGER NOT NULL,
            gold             INTEGER,
            gems             INTEGER,
            wc_common        INTEGER,
            wc_uncommon      INTEGER,
            wc_rare          INTEGER,
            wc_mythic        INTEGER,
            vault_progress   INTEGER,
            seq_id           INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_inventory_ts
            ON inventory_snapshots(ts DESC);

        CREATE TABLE IF NOT EXISTS match_states (
            match_id        TEXT    NOT NULL,
            game_state_id   INTEGER NOT NULL,
            ts              INTEGER NOT NULL,
            game_number     INTEGER,
            turn_number     INTEGER,
            phase           TEXT,
            step            TEXT,
            active_player   INTEGER,
            decision_player INTEGER,
            stage           TEXT,
            PRIMARY KEY (match_id, game_state_id)
        );
        CREATE INDEX IF NOT EXISTS idx_match_states_ts
            ON match_states(match_id, ts);

        -- match_players: one row per (match, seat) — both players recorded
        -- from the matchGameRoomStateChangedEvent. `is_local` marks the
        -- first player in the MatchState.players[] array (the local user
        -- running the MTGA client).
        CREATE TABLE IF NOT EXISTS match_players (
            match_id    TEXT    NOT NULL,
            seat_id     INTEGER NOT NULL,
            team_id     INTEGER NOT NULL,
            player_name TEXT    NOT NULL,
            user_id     TEXT    NOT NULL,
            course_id   TEXT,
            platform_id TEXT,
            is_local    INTEGER NOT NULL DEFAULT 0,
            event_id    TEXT,
            PRIMARY KEY (match_id, seat_id)
        );
        CREATE INDEX IF NOT EXISTS idx_match_players_user
            ON match_players(user_id);

        -- match_life_changes: AnnotationType_ModifiedLife deltas. `seat_id`
        -- is 1 (us) or 2 (opponent). `delta` is the change vs the previous
        -- life total (negative = damage, positive = lifegain).
        CREATE TABLE IF NOT EXISTS match_life_changes (
            match_id      TEXT    NOT NULL,
            annotation_id INTEGER NOT NULL,
            ts            INTEGER NOT NULL,
            seat_id       INTEGER NOT NULL,
            delta         INTEGER NOT NULL,
            PRIMARY KEY (match_id, annotation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_life_match
            ON match_life_changes(match_id, annotation_id);

        -- match_zone_transfers: AnnotationType_ZoneTransfer events. `seat_id`
        -- is the owner_seat_id of the affected game object (NULL if the
        -- object wasn't in the same GameStateMessage's gameObjects array).
        -- `grp_id` is the card ID (NULL if unresolved).
        CREATE TABLE IF NOT EXISTS match_zone_transfers (
            match_id      TEXT    NOT NULL,
            annotation_id INTEGER NOT NULL,
            ts            INTEGER NOT NULL,
            seat_id       INTEGER,
            grp_id        INTEGER,
            category      TEXT    NOT NULL,
            zone_src      INTEGER,
            zone_dest     INTEGER,
            PRIMARY KEY (match_id, annotation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_zone_match
            ON match_zone_transfers(match_id, annotation_id);

        -- user_decks: decks built by the user in the deck builder. Decks
        -- imported via `mtga-logs deck-import` live here. They share the
        -- same DB as played decks (which live in `decks`) but use a
        -- distinct deck_id prefix ("user-<8chars>") to avoid collision
        -- with Arena-deck UUIDs. Cards are stored as JSON arrays of
        -- {grpId, quantity} to match the existing `decks.mainboard_json`
        -- shape.
        CREATE TABLE IF NOT EXISTS user_decks (
            deck_id         TEXT    PRIMARY KEY,
            name            TEXT    NOT NULL,
            format          TEXT,
            notes           TEXT,
            first_created   INTEGER NOT NULL,
            last_modified   INTEGER NOT NULL,
            mainboard_json  TEXT    NOT NULL,
            sideboard_json  TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_decks_modified
            ON user_decks(last_modified DESC);
        "#,
    )
    .map_err(|e| format!("init schema: {}", e))?;

    // Record schema version if not present.
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|e| format!("write schema_version: {}", e))?;

    let _ = existing_version; // silence unused warning
    Ok(())
}

// ============================================================================
// ingestion
// ============================================================================

#[derive(Debug, Default, Clone)]
pub struct IngestStats {
    pub files_ingested: usize,
    pub files_skipped: usize,
    pub events_seen: usize,
    pub decks_upserted: usize,
    pub matches_inserted: usize,
    pub inventory_inserted: usize,
}

/// Find candidate log files (Player.log + Player.log.old if present), parse
/// and ingest any new ones (by fingerprint). Returns aggregate stats.
pub fn maybe_ingest(log_path: &Path) -> Result<IngestStats, String> {
    let conn = open_db()?;

    // If the log file doesn't exist (e.g. MTGA isn't running, or the user
    // passed a bogus path), warn and return a zeroed result so the caller
    // can still render from the DB.
    if !log_path.exists() {
        eprintln!(
            "warning: log not found at {} — rendering from cache",
            log_path.display()
        );
        return Ok(IngestStats::default());
    }

    // Build candidate file list.
    let old_path = log_path.with_file_name("Player.log.old");
    let mut candidates: Vec<PathBuf> = vec![log_path.to_path_buf()];
    if old_path.exists() {
        candidates.push(old_path);
    }

    // Process oldest first so latest wins for last_seen on shared deck_ids.
    candidates.sort_by_key(|p| {
        fs::metadata(p)
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });

    let mut total = IngestStats::default();
    for path in &candidates {
        let stats = ingest_one_file(&conn, path)?;
        total.files_ingested += stats.files_ingested;
        total.files_skipped += stats.files_skipped;
        total.events_seen += stats.events_seen;
        total.decks_upserted += stats.decks_upserted;
        total.matches_inserted += stats.matches_inserted;
        total.inventory_inserted += stats.inventory_inserted;
    }
    Ok(total)
}

/// Always re-ingest `log_path`, even if a prior ingestion with the same
/// fingerprint exists. Used by the explicit `ingest` subcommand.
pub fn force_ingest(log_path: &Path) -> Result<IngestStats, String> {
    let conn = open_db()?;
    ingest_one_file(&conn, log_path)
}

fn ingest_one_file(conn: &Connection, path: &Path) -> Result<IngestStats, String> {
    let meta = fs::metadata(path).map_err(|e| format!("stat {}: {}", path.display(), e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("mtime {}: {}", path.display(), e))?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let size = meta.len() as i64;
    let path_str = path.display().to_string();

    // Idempotency: skip if we've already ingested this exact file version.
    let already: bool = conn
        .query_row(
            "SELECT 1 FROM ingestions
             WHERE source_path = ?1 AND source_mtime = ?2 AND source_size = ?3
             LIMIT 1",
            params![path_str, mtime, size],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if already {
        return Ok(IngestStats {
            files_skipped: 1,
            ..Default::default()
        });
    }

    let events = parse_log(path)?;
    let event_count = events.len() as i64;
    let mut stats = IngestStats {
        events_seen: events.len(),
        ..Default::default()
    };

    // 1. DeckCollection — overwrite contents for any deck currently in it.
    //    Use the latest event of this type in the file (events are ordered).
    let mut latest_dc: Option<&GameEvent> = None;
    for event in events.iter().rev() {
        if matches!(event, GameEvent::DeckCollection(_)) {
            latest_dc = Some(event);
            break;
        }
    }
    if let Some(GameEvent::DeckCollection(e)) = latest_dc {
        let ts = e.metadata().timestamp().map(|t| t.timestamp()).unwrap_or(0);
        if let Some(decks) = e.payload().get("decks").and_then(Value::as_object) {
            for (id, deck) in decks {
                upsert_deck_from_collection(conn, id, deck, ts)?;
                stats.decks_upserted += 1;
            }
        }
        // Inventory snapshot, if present.
        if let Some(info) = e
            .payload()
            .get("raw_start_hook")
            .and_then(|h| h.get("InventoryInfo"))
        {
            insert_inventory_snapshot(conn, ts, info)?;
            stats.inventory_inserted += 1;
        }
    }

    // 2. DeckSubmission — update last_seen for every deck we've ever seen.
    for event in &events {
        if let GameEvent::DeckSubmission(e) = event {
            let p = e.payload();
            if let Some(id) = p.get("deck_id").and_then(Value::as_str) {
                let ts = e.metadata().timestamp().map(|t| t.timestamp()).unwrap_or(0);
                update_deck_last_seen(conn, id, ts)?;
            }
        }
    }

    // 3. Matches — single pass to track deck_id/event_name/local_team context.
    //    Local team is the team of the player whose userId appears in
    //    `authenticateResponse` events (the user running the MTGA client).
    //    Tracking by index in `players[0]` is wrong: the local user can
    //    be in either position (we've seen both seat 1 and seat 2 in the
    //    same log).
    let local_user_ids: HashSet<String> = events
        .iter()
        .filter_map(|e| match e {
            GameEvent::Session(s) => {
                let p = s.payload();
                if p.get("type").and_then(Value::as_str) == Some("session_authenticate") {
                    p.get("raw_response")
                        .and_then(|r| r.get("authenticateResponse"))
                        .and_then(|r| r.get("clientId"))
                        .and_then(Value::as_str)
                        .map(String::from)
                } else {
                    None
                }
            }
            _ => None,
        })
        .collect();
    let mut last_deck_id: Option<String> = None;
    let mut last_event_name: Option<String> = None;
    let mut last_local_team: Option<i64> = None;
    for event in &events {
        match event {
            GameEvent::DeckSubmission(e) => {
                let p = e.payload();
                if let Some(id) = p.get("deck_id").and_then(Value::as_str) {
                    last_deck_id = Some(id.to_string());
                }
                if let Some(name) = p.get("event_name").and_then(Value::as_str) {
                    last_event_name = Some(name.to_string());
                }
            }
            GameEvent::MatchState(e) => {
                let p = e.payload();
                // Set last_local_team to the team of the player whose
                // userId is one of our local user IDs. Fall back to the
                // previous value if no match (shouldn't happen in a well-
                // formed log).
                if let Some(players) = p.get("players").and_then(Value::as_array) {
                    for player in players {
                        if let Some(uid) = player.get("user_id").and_then(Value::as_str) {
                            if local_user_ids.contains(uid) {
                                if let Some(team) = player.get("team_id").and_then(Value::as_i64) {
                                    last_local_team = Some(team);
                                }
                                break;
                            }
                        }
                    }
                }
            }
            GameEvent::GameResult(e) => {
                let p = e.payload();
                let Some(game_info) = p.get("game_info") else { continue };
                let Some(match_id) = game_info.get("matchID").and_then(Value::as_str) else {
                    continue;
                };
                let Some(results) = game_info.get("results").and_then(Value::as_array) else {
                    continue;
                };
                let Some(r) = results.iter().find(|r| {
                    r.get("scope").and_then(Value::as_str) == Some("MatchScope_Game")
                }) else {
                    continue;
                };
                let Some(winning_team) = r.get("winningTeamId").and_then(Value::as_i64) else {
                    continue;
                };
                let result = match last_local_team {
                    Some(local) if local == winning_team => "Win",
                    Some(_) => "Loss",
                    None => "?",
                };
                let reason = r
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim_start_matches("ResultReason_")
                    .to_string();
                let ts = event.metadata().timestamp().map(|t| t.timestamp()).unwrap_or(0);

                let n = insert_match(
                    conn,
                    match_id,
                    ts,
                    last_deck_id.as_deref(),
                    last_event_name.as_deref(),
                    result,
                    &reason,
                    &p.to_string(),
                )?;
                if n > 0 {
                    stats.matches_inserted += 1;
                }
            }
            _ => {}
        }
    }

    // Record this ingestion so we never re-parse this exact file.
    conn.execute(
        "INSERT INTO ingestions
            (source_path, source_mtime, source_size, parsed_at, event_count)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            path_str,
            mtime,
            size,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            event_count,
        ],
    )
    .map_err(|e| format!("record ingestion: {}", e))?;

    // 4. Game states — bracket to match IDs by walking events forward,
    //    picking up matchID from game_info and propagating it to subsequent
    //    events until the next game_info.matchID overwrites it.
    ingest_game_states(conn, &events)?;
    ingest_match_context(conn, &events)?;

    stats.files_ingested = 1;
    Ok(stats)
}

/// Tag each GameStateEvent with the most recent matchID seen (from
/// `game_info.matchID` on game-start/game-over events). Events with no
/// preceding game_info.matchID are skipped — these are typically the very
/// first ConnectResp before any game has formally started.
fn ingest_game_states(conn: &Connection, events: &[GameEvent]) -> Result<(), String> {
    let mut current_match: Option<String> = None;
    let mut states_inserted = 0usize;

    let tx = conn.unchecked_transaction()
        .map_err(|e| format!("begin match_states tx: {}", e))?;

    for event in events {
        if let GameEvent::GameState(gs) = event {
            let p = gs.payload();

            // 1. Update current_match if this state carries game_info.matchID.
            if let Some(gi) = p.get("game_info") {
                if let Some(mid) = gi.get("matchID").and_then(Value::as_str) {
                    current_match = Some(mid.to_string());
                }
            }

            let Some(match_id) = current_match.as_deref() else { continue };
            let Some(gsid) = p.get("game_state_id").and_then(Value::as_i64) else { continue };

            // game_state_id is unique per game; (match_id, game_state_id) is
            // a natural PK. Skip if already inserted (re-ingestion safety).
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM match_states WHERE match_id = ?1 AND game_state_id = ?2",
                    params![match_id, gsid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if exists {
                continue;
            }

            let ts = gs.metadata().timestamp().map(|t| t.timestamp()).unwrap_or(0);
            let game_number = p
                .get("game_info")
                .and_then(|gi| gi.get("gameNumber"))
                .and_then(Value::as_i64);
            let stage = p
                .get("game_info")
                .and_then(|gi| gi.get("stage"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let turn = p
                .get("turn_info")
                .and_then(|ti| ti.get("turn_number"))
                .and_then(Value::as_i64);
            let phase = p
                .get("turn_info")
                .and_then(|ti| ti.get("phase"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let step = p
                .get("turn_info")
                .and_then(|ti| ti.get("step"))
                .and_then(Value::as_str)
                .map(|s| s.to_string());
            let active = p
                .get("turn_info")
                .and_then(|ti| ti.get("active_player"))
                .and_then(Value::as_i64);
            let decision = p
                .get("turn_info")
                .and_then(|ti| ti.get("decision_player"))
                .and_then(Value::as_i64);

            tx.execute(
                "INSERT OR IGNORE INTO match_states
                    (match_id, game_state_id, ts, game_number, turn_number,
                     phase, step, active_player, decision_player, stage)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    match_id,
                    gsid,
                    ts,
                    game_number,
                    turn,
                    phase,
                    step,
                    active,
                    decision,
                    stage,
                ],
            )
            .map_err(|e| format!("insert match_state: {}", e))?;
            states_inserted += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("commit match_states: {}", e))?;
    if states_inserted > 0 {
        eprintln!("(inserted {} match_states)", states_inserted);
    }
    Ok(())
}

/// Ingest opponent-identity, life-delta, and zone-transfer events.
///
/// Walks every event once, branching on type:
///
/// - **`MatchState`** (from `matchGameRoomStateChangedEvent`): inserts
///   `match_players` rows. The first player in `payload.players[]` is
///   treated as the local user (`is_local=1`) — the manasight parser
///   preserves source order from `reservedPlayers`, and MTGA emits the
///   local player first. The richer fields (`courseId`, `platformId`,
///   `sessionId`) live in `payload.raw_match_state.gameRoomInfo...`
///   and are pulled from there.
///
/// - **`GameState`**: walks `payload.annotations` for
///   `AnnotationType_ModifiedLife` (inserts `match_life_changes`) and
///   `AnnotationType_ZoneTransfer` (inserts `match_zone_transfers`).
///   For zone transfers, the affected game-object instance ID is
///   resolved against the same message's `payload.game_objects` array
///   to attribute the move to a player and read the card's `grpId`.
///
/// `current_match` is carried forward from any source that yields one
/// (MatchState.Playing and `game_info.matchID`) so events between match
/// boundaries are still tagged.
fn ingest_match_context(conn: &Connection, events: &[GameEvent]) -> Result<(), String> {
    let mut current_match: Option<String> = None;
    let mut players_inserted = 0usize;
    let mut life_inserted = 0usize;
    let mut zone_inserted = 0usize;

    // Track local userIds collected from `authenticateResponse` Session
    // events. The user running the MTGA client can be in any position
    // inside `reservedPlayers[]` (we've seen seat 1 AND seat 2 in the same
    // log), so the correct way to identify the local user is by their
    // `clientId`, not by index. The parser exposes the screen name as
    // `payload.screen_name` and the full response (with `clientId`) as
    // `payload.raw_response.authenticateResponse.clientId`.
    let mut local_user_ids: HashSet<String> = HashSet::new();
    for event in events {
        if let GameEvent::Session(s) = event {
            let p = s.payload();
            if p.get("type").and_then(Value::as_str) == Some("session_authenticate") {
                if let Some(uid) = p
                    .get("raw_response")
                    .and_then(|r| r.get("authenticateResponse"))
                    .and_then(|r| r.get("clientId"))
                    .and_then(Value::as_str)
                {
                    local_user_ids.insert(uid.to_string());
                }
            }
        }
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin match_context tx: {}", e))?;

    for event in events {
        // 1. MatchState — player identity + final results.
        if let GameEvent::MatchState(ms) = event {
            let p = ms.payload();
            let match_id = p
                .get("match_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if match_id.is_empty() {
                continue;
            }
            current_match = Some(match_id.clone());

            // Map user_id -> (courseId, platformId, sessionId) from
            // the rich reservedPlayers array. The parser exposes
            // user_id/player_name/system_seat_id/team_id in the
            // `players` field, but the extras (courseId, platformId)
            // are only in raw_match_state.
            let mut rich: HashMap<String, (Option<String>, Option<String>, Option<String>)> =
                HashMap::new();
            if let Some(rs) = p
                .get("raw_match_state")
                .and_then(|r| r.get("gameRoomInfo"))
                .and_then(|g| g.get("gameRoomConfig"))
                .and_then(|c| c.get("reservedPlayers"))
                .and_then(Value::as_array)
            {
                for player in rs {
                    if let Some(uid) = player.get("userId").and_then(Value::as_str) {
                        let course = player
                            .get("courseId")
                            .and_then(Value::as_str)
                            .map(String::from);
                        let platform = player
                            .get("platformId")
                            .and_then(Value::as_str)
                            .map(String::from);
                        let session = player
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(String::from);
                        rich.insert(uid.to_string(), (course, platform, session));
                    }
                }
            }

            // Pull the event_id from the MatchState payload (e.g.
            // "Jump_In_2024", "Ladder"). We attach it to every player row
            // — the value is per-match, not per-player, but storing it
            // here avoids a separate table just for one column.
            let match_event_id = p
                .get("event_id")
                .and_then(Value::as_str)
                .map(String::from);

            // Insert both players. `is_local` is set by matching user_id
            // against local userIds collected from authenticateResponse
            // events. (Index-based assignment is wrong: the local user
            // can appear in any position in reservedPlayers[].)
            if let Some(players) = p.get("players").and_then(Value::as_array) {
                for player in players {
                    let seat = player
                        .get("system_seat_id")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let team = player
                        .get("team_id")
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let name = player
                        .get("player_name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let uid = player
                        .get("user_id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let (course, platform, _session) = rich
                        .get(&uid)
                        .cloned()
                        .unwrap_or((None, None, None));
                    let is_local = if local_user_ids.contains(&uid) {
                        1
                    } else {
                        0
                    };

                    let n = tx
                        .execute(
                            "INSERT OR REPLACE INTO match_players
                                (match_id, seat_id, team_id, player_name, user_id,
                                 course_id, platform_id, is_local, event_id)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                            params![
                                match_id,
                                seat,
                                team,
                                name,
                                uid,
                                course,
                                platform,
                                is_local,
                                match_event_id,
                            ],
                        )
                        .map_err(|e| format!("insert match_player: {}", e))?;
                    players_inserted += n;
                }
            }

            // Insert per-game results from finalMatchResult, if present.
            if let Some(results) = p.get("game_results").and_then(Value::as_array) {
                for _r in results {
                    // (game_results is structured for Bo3 breakdown in
                    // future work; for now the per-game winningTeamId
                    // surfaces via matches.result from ConnectResp.)
                }
            }
            continue;
        }

        // 2. GameState — annotations (life deltas + zone transfers).
        if let GameEvent::GameState(gs) = event {
            let p = gs.payload();

            // Update current_match from game_info if present.
            if let Some(gi) = p.get("game_info") {
                if let Some(mid) = gi.get("matchID").and_then(Value::as_str) {
                    current_match = Some(mid.to_string());
                }
            }
            let Some(match_id) = current_match.as_deref() else {
                continue;
            };

            let ts = gs
                .metadata()
                .timestamp()
                .map(|t| t.timestamp())
                .unwrap_or(0);

            // Build a map of game-object instance_id -> (owner_seat_id, grp_id)
            // for resolving zone transfers within this same message.
            let mut obj_map: HashMap<i64, (Option<i64>, Option<i64>)> = HashMap::new();
            if let Some(objects) = p.get("game_objects").and_then(Value::as_array) {
                for o in objects {
                    if let Some(iid) = o.get("instance_id").and_then(Value::as_i64) {
                        let seat = o.get("owner_seat_id").and_then(Value::as_i64);
                        let grp = o.get("grp_id").and_then(Value::as_i64);
                        obj_map.insert(iid, (seat, grp));
                    }
                }
            }

            if let Some(anns) = p.get("annotations").and_then(Value::as_array) {
                for ann in anns {
                    let ann_id = ann.get("id").and_then(Value::as_i64).unwrap_or(0);
                    let ann_type = ann.get("type").and_then(Value::as_str).unwrap_or("");

                    match ann_type {
                        "AnnotationType_ModifiedLife" => {
                            let seat = ann
                                .get("affected_ids")
                                .and_then(|a| a.as_array())
                                .and_then(|a| a.first())
                                .and_then(Value::as_i64)
                                .unwrap_or(0);
                            let delta = ann.get("life").and_then(Value::as_i64).unwrap_or(0);
                            let n = tx
                                .execute(
                                    "INSERT OR IGNORE INTO match_life_changes
                                        (match_id, annotation_id, ts, seat_id, delta)
                                     VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![match_id, ann_id, ts, seat, delta],
                                )
                                .map_err(|e| format!("insert life_change: {}", e))?;
                            life_inserted += n;
                        }
                        "AnnotationType_ZoneTransfer" => {
                            let inst_id = ann
                                .get("affected_ids")
                                .and_then(|a| a.as_array())
                                .and_then(|a| a.first())
                                .and_then(Value::as_i64);
                            let (seat, grp) = match inst_id {
                                Some(iid) => obj_map.get(&iid).cloned().unwrap_or((None, None)),
                                None => (None, None),
                            };
                            let category = ann
                                .get("category")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let zone_src = ann.get("zone_src").and_then(Value::as_i64);
                            let zone_dest = ann.get("zone_dest").and_then(Value::as_i64);
                            let n = tx
                                .execute(
                                    "INSERT OR IGNORE INTO match_zone_transfers
                                        (match_id, annotation_id, ts, seat_id, grp_id,
                                         category, zone_src, zone_dest)
                                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                                    params![
                                        match_id, ann_id, ts, seat, grp, category, zone_src, zone_dest
                                    ],
                                )
                                .map_err(|e| format!("insert zone_transfer: {}", e))?;
                            zone_inserted += n;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    tx.commit()
        .map_err(|e| format!("commit match_context: {}", e))?;
    if players_inserted > 0 || life_inserted > 0 || zone_inserted > 0 {
        eprintln!(
            "(match_context: {} players, {} life changes, {} zone transfers)",
            players_inserted, life_inserted, zone_inserted
        );
    }
    Ok(())
}

fn upsert_deck_from_collection(
    conn: &Connection,
    deck_id: &str,
    deck: &Value,
    collection_ts: i64,
) -> Result<(), String> {
    let name = deck
        .get("Name")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();
    let format = attr_value(deck, "Format");
    let is_netdeck = deck
        .get("IsNetDeck")
        .and_then(Value::as_bool)
        .unwrap_or(false) as i64;
    let last_played_ts = attr_value(deck, "LastPlayed").and_then(|v| {
        let inner = v.trim().trim_matches('"').replace("\\\"", "\"");
        chrono::DateTime::parse_from_rfc3339(&inner)
            .ok()
            .map(|dt| dt.timestamp())
    });
    let last_seen_ts = last_played_ts
        .map(|t| t.max(collection_ts))
        .unwrap_or(collection_ts);

    let mainboard_json = serde_json::to_string(
        deck.get("list")
            .and_then(|l| l.get("MainDeck"))
            .unwrap_or(&Value::Null),
    )
    .map_err(|e| format!("serialize mainboard: {}", e))?;
    let sideboard_json = serde_json::to_string(
        deck.get("list")
            .and_then(|l| l.get("Sideboard"))
            .unwrap_or(&Value::Null),
    )
    .map_err(|e| format!("serialize sideboard: {}", e))?;

    conn.execute(
        r#"INSERT INTO decks
              (deck_id, name, format, is_netdeck, first_seen, last_seen,
               last_collection_ts, mainboard_json, sideboard_json)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(deck_id) DO UPDATE SET
              name = excluded.name,
              format = excluded.format,
              is_netdeck = excluded.is_netdeck,
              last_seen = MAX(last_seen, excluded.last_seen),
              last_collection_ts = excluded.last_collection_ts,
              mainboard_json = excluded.mainboard_json,
              sideboard_json = excluded.sideboard_json"#,
        params![
            deck_id,
            name,
            format,
            is_netdeck,
            last_seen_ts, // first_seen starts as last_seen; UPDATE below keeps min
            last_seen_ts,
            collection_ts,
            mainboard_json,
            sideboard_json,
        ],
    )
    .map_err(|e| format!("upsert deck: {}", e))?;
    Ok(())
}

fn update_deck_last_seen(conn: &Connection, deck_id: &str, ts: i64) -> Result<(), String> {
    // Bump last_seen. If the deck was only seen in a DeckSubmission (never in
    // a DeckCollection), insert a placeholder row so matches can reference it.
    conn.execute(
        r#"INSERT INTO decks (deck_id, name, last_seen, mainboard_json, sideboard_json)
           VALUES (?1, '?', ?2, '[]', '[]')
           ON CONFLICT(deck_id) DO UPDATE SET
              last_seen = MAX(last_seen, excluded.last_seen),
              first_seen = COALESCE(first_seen, excluded.last_seen)"#,
        params![deck_id, ts],
    )
    .map_err(|e| format!("update deck last_seen: {}", e))?;
    Ok(())
}

fn insert_match(
    conn: &Connection,
    match_id: &str,
    ts: i64,
    deck_id: Option<&str>,
    event_name: Option<&str>,
    result: &str,
    reason: &str,
    payload_json: &str,
) -> Result<usize, String> {
    let n = conn
        .execute(
            r#"INSERT OR IGNORE INTO matches
                  (match_id, ts, deck_id, event_name, result, reason, payload_json)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            params![match_id, ts, deck_id, event_name, result, reason, payload_json],
        )
        .map_err(|e| format!("insert match: {}", e))?;
    Ok(n)
}

fn insert_inventory_snapshot(
    conn: &Connection,
    ts: i64,
    inv: &Value,
) -> Result<(), String> {
    fn pick(v: &Value, key: &str) -> Option<i64> {
        v.get(key).and_then(Value::as_i64)
    }
    conn.execute(
        r#"INSERT INTO inventory_snapshots
              (ts, gold, gems, wc_common, wc_uncommon, wc_rare, wc_mythic,
               vault_progress, seq_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"#,
        params![
            ts,
            pick(inv, "Gold"),
            pick(inv, "Gems"),
            pick(inv, "WildCardCommons"),
            pick(inv, "WildCardUnCommons"),
            pick(inv, "WildCardRares"),
            pick(inv, "WildCardMythics"),
            pick(inv, "TotalVaultProgress"),
            pick(inv, "SeqId"),
        ],
    )
    .map_err(|e| format!("insert inventory: {}", e))?;
    Ok(())
}

fn attr_value(deck: &Value, name: &str) -> Option<String> {
    let attrs = deck.get("Attributes")?.as_array()?;
    attrs.iter().find_map(|a| {
        if a.get("name").and_then(Value::as_str) == Some(name) {
            a.get("value").and_then(Value::as_str).map(str::to_owned)
        } else {
            None
        }
    })
}

// ============================================================================
// log parsing (small wrapper for testability)
// ============================================================================

fn parse_log(path: &Path) -> Result<Vec<GameEvent>, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    Ok(parse_whole_log(&text))
}

// ============================================================================
// queries — return shapes that web.rs / CLI already consume
// ============================================================================

pub fn load_decks(conn: &Connection) -> Result<HashMap<String, DeckSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT deck_id, name, format, is_netdeck, last_seen,
                    mainboard_json, sideboard_json
             FROM decks",
        )
        .map_err(|e| format!("prepare load_decks: {}", e))?;
    let mut out = HashMap::new();
    let rows = stmt
        .query_map([], |row| {
            let deck_id: String = row.get(0)?;
            let name: String = row.get(1)?;
            let format: Option<String> = row.get(2)?;
            let is_netdeck: i64 = row.get(3)?;
            let last_seen: Option<i64> = row.get(4)?;
            let mainboard_json: String = row.get(5)?;
            let sideboard_json: String = row.get(6)?;
            Ok((
                deck_id,
                name,
                format.unwrap_or_else(|| "?".into()),
                is_netdeck != 0,
                last_seen,
                mainboard_json,
                sideboard_json,
            ))
        })
        .map_err(|e| format!("query decks: {}", e))?;
    for r in rows {
        let (id, name, format, is_netdeck, last_seen, main_json, side_json) =
            r.map_err(|e| format!("read deck row: {}", e))?;
        let main: Value = serde_json::from_str(&main_json).unwrap_or(Value::Null);
        let side: Value = serde_json::from_str(&side_json).unwrap_or(Value::Null);
        let main_count = sum_quantities(main.as_array());
        let side_count = sum_quantities(side.as_array());
        let last_seen_dt = last_seen.and_then(|t| {
            chrono::DateTime::from_timestamp(t, 0).map(|dt| dt.with_timezone(&chrono::Utc))
        });
        out.insert(
            id,
            DeckSummary {
                name,
                format,
                main_count,
                side_count,
                is_netdeck,
                last_seen: last_seen_dt,
            },
        );
    }
    Ok(out)
}

pub fn load_deck_value(conn: &Connection, deck_id: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, format, is_netdeck, mainboard_json, sideboard_json
             FROM decks WHERE deck_id = ?1",
        )
        .map_err(|e| format!("prepare load_deck_value: {}", e))?;
    let row = stmt
        .query_row(params![deck_id], |row| {
            let name: String = row.get(0)?;
            let format: Option<String> = row.get(1)?;
            let is_netdeck: i64 = row.get(2)?;
            let main: String = row.get(3)?;
            let side: String = row.get(4)?;
            Ok((name, format, is_netdeck != 0, main, side))
        })
        .ok();
    let Some((name, format, is_netdeck, main_json, side_json)) = row else {
        return Ok(None);
    };
    let main: Value = serde_json::from_str(&main_json).unwrap_or(json!([]));
    let side: Value = serde_json::from_str(&side_json).unwrap_or(json!([]));
    // Build a Value in the same shape `find_deck_value` returns so web.rs
    // doesn't need to change. The shape web.rs expects:
    //   { Name, IsNetDeck, list: { MainDeck, Sideboard }, Attributes: [{name, value}] }
    let mut attrs = vec![];
    if let Some(f) = format {
        attrs.push(json!({ "name": "Format", "value": f }));
    }
    Ok(Some(json!({
        "Name": name,
        "IsNetDeck": is_netdeck,
        "list": { "MainDeck": main, "Sideboard": side },
        "Attributes": attrs,
    })))
}

pub fn load_matches(conn: &Connection) -> Result<Vec<MatchRecord>, String> {
    // Need deck names too — left join.
    let mut stmt = conn
        .prepare(
            "SELECT m.match_id, m.ts, COALESCE(d.name, ''), m.event_name,
                    m.result, m.reason, m.deck_id
             FROM matches m
             LEFT JOIN decks d ON d.deck_id = m.deck_id
             ORDER BY m.ts DESC",
        )
        .map_err(|e| format!("prepare load_matches: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let match_id: String = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let deck_name: String = row.get(2)?;
            let event_name: Option<String> = row.get(3)?;
            let result: Option<String> = row.get(4)?;
            let reason: Option<String> = row.get(5)?;
            let deck_id: Option<String> = row.get(6)?;
            Ok((
                match_id,
                ts,
                deck_name,
                event_name.unwrap_or_else(|| "?".into()),
                result.unwrap_or_else(|| "?".into()),
                reason.unwrap_or_default(),
                deck_id,
            ))
        })
        .map_err(|e| format!("query matches: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        let (match_id, ts, deck_name, event_name, result, reason, deck_id) =
            r.map_err(|e| format!("read match row: {}", e))?;
        let ts_dt = chrono::DateTime::from_timestamp(ts, 0)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);
        let deck_name = if deck_name.is_empty() {
            if deck_id.is_some() {
                "(unknown)".to_string()
            } else {
                "(no deck)".to_string()
            }
        } else {
            deck_name
        };
        out.push(MatchRecord {
            match_id,
            timestamp: ts_dt,
            deck_name,
            event_name,
            result,
            reason,
        });
    }
    Ok(out)
}

pub fn load_latest_inventory(conn: &Connection) -> Result<Option<InventorySnapshot>, String> {
    conn.query_row(
        "SELECT gold, gems, wc_common, wc_uncommon, wc_rare, wc_mythic,
                vault_progress, seq_id
         FROM inventory_snapshots
         ORDER BY ts DESC LIMIT 1",
        [],
        |row| {
            Ok(InventorySnapshot {
                gold: row.get(0)?,
                gems: row.get(1)?,
                wc_common: row.get(2)?,
                wc_uncommon: row.get(3)?,
                wc_rare: row.get(4)?,
                wc_mythic: row.get(5)?,
                vault_progress: row.get(6)?,
                wc_track_position: 0,
                seq_id: row.get(7)?,
            })
        },
    )
    .ok()
    .map_or(Ok(None), |v| Ok(Some(v)))
}

pub fn load_inventory_history(conn: &Connection) -> Result<Vec<InventorySnapshot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ts, gold, gems, wc_common, wc_uncommon, wc_rare, wc_mythic,
                    vault_progress, seq_id
             FROM inventory_snapshots
             ORDER BY ts ASC",
        )
        .map_err(|e| format!("prepare load_inventory_history: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let _ts: i64 = row.get(0)?;
            Ok(InventorySnapshot {
                gold: row.get(1)?,
                gems: row.get(2)?,
                wc_common: row.get(3)?,
                wc_uncommon: row.get(4)?,
                wc_rare: row.get(5)?,
                wc_mythic: row.get(6)?,
                vault_progress: row.get(7)?,
                wc_track_position: 0,
                seq_id: row.get(8)?,
            })
        })
        .map_err(|e| format!("query inventory: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read inventory row: {}", e))?);
    }
    Ok(out)
}

// ============================================================================
// match detail (steps + game progression)
// ============================================================================

/// One row of the per-match step timeline.
#[derive(Debug, Clone)]
pub struct MatchStep {
    pub game_number: Option<i64>,
    pub turn_number: Option<i64>,
    pub phase: Option<String>,
    pub step: Option<String>,
    pub active_player: Option<i64>,
    pub decision_player: Option<i64>,
    pub stage: Option<String>,
    pub ts: i64,
}

/// Load all recorded states for a match, ordered by ts ascending.
///
/// Returns rows where game_state_id, turn_number, phase, step, and stage
/// are populated whenever the parser saw those fields. The render layer is
/// expected to deduplicate consecutive identical (turn, phase, step) entries.
pub fn load_match_steps(conn: &Connection, match_id: &str) -> Result<Vec<MatchStep>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT game_number, turn_number, phase, step, active_player,
                    decision_player, stage, ts
             FROM match_states
             WHERE match_id = ?1
             ORDER BY ts ASC, game_state_id ASC",
        )
        .map_err(|e| format!("prepare load_match_steps: {}", e))?;
    let rows = stmt
        .query_map(params![match_id], |row| {
            Ok(MatchStep {
                game_number: row.get(0)?,
                turn_number: row.get(1)?,
                phase: row.get(2)?,
                step: row.get(3)?,
                active_player: row.get(4)?,
                decision_player: row.get(5)?,
                stage: row.get(6)?,
                ts: row.get(7)?,
            })
        })
        .map_err(|e| format!("query load_match_steps: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read match_step row: {}", e))?);
    }
    Ok(out)
}

/// Load the raw GameResult payload for a match (contains the full
/// game_info with teams, players, winningTeamId, etc.).
pub fn load_match_payload(conn: &Connection, match_id: &str) -> Result<Option<Value>, String> {
    let row: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM matches WHERE match_id = ?1",
            params![match_id],
            |r| r.get(0),
        )
        .ok();
    match row {
        None => Ok(None),
        Some(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| format!("parse match payload: {}", e)),
    }
}

// ============================================================================
// match_players — opponent identity
// ============================================================================

#[derive(Debug, Clone)]
pub struct MatchPlayer {
    pub seat_id: i64,
    pub team_id: i64,
    pub player_name: String,
    pub user_id: String,
    pub course_id: Option<String>,
    pub platform_id: Option<String>,
    pub is_local: bool,
    pub event_id: Option<String>,
}

/// Load both players (local + opponent) for a match, sorted by seat_id.
pub fn load_match_players(conn: &Connection, match_id: &str) -> Result<Vec<MatchPlayer>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seat_id, team_id, player_name, user_id, course_id,
                    platform_id, is_local, event_id
             FROM match_players
             WHERE match_id = ?1
             ORDER BY seat_id ASC",
        )
        .map_err(|e| format!("prepare load_match_players: {}", e))?;
    let rows = stmt
        .query_map(params![match_id], |row| {
            Ok(MatchPlayer {
                seat_id: row.get(0)?,
                team_id: row.get(1)?,
                player_name: row.get(2)?,
                user_id: row.get(3)?,
                course_id: row.get(4)?,
                platform_id: row.get(5)?,
                is_local: row.get::<_, i64>(6)? != 0,
                event_id: row.get(7)?,
            })
        })
        .map_err(|e| format!("query load_match_players: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read match_player row: {}", e))?);
    }
    Ok(out)
}

/// Load the opponent name (player where is_local = 0) for many matches at
/// once. Returns a HashMap keyed by match_id. Used by the matches index
/// page to show an Opponent column without a per-row N+1 query.
pub fn load_opponent_names(
    conn: &Connection,
    match_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    if match_ids.is_empty() {
        return Ok(out);
    }
    // Build the IN clause placeholders.
    let placeholders: Vec<String> = (0..match_ids.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT match_id, player_name FROM match_players
         WHERE is_local = 0 AND match_id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare load_opponent_names: {}", e))?;
    let params: Vec<&dyn rusqlite::ToSql> =
        match_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(&*params, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query load_opponent_names: {}", e))?;
    for r in rows {
        let (mid, name) = r.map_err(|e| format!("read opponent row: {}", e))?;
        out.insert(mid, name);
    }
    Ok(out)
}

/// Load the event_id for many matches at once. event_id is the same for
/// both player rows of a match, so we just take any row's value.
pub fn load_match_event_ids(
    conn: &Connection,
    match_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    if match_ids.is_empty() {
        return Ok(out);
    }
    let placeholders: Vec<String> = (0..match_ids.len()).map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT DISTINCT match_id, event_id FROM match_players
         WHERE event_id IS NOT NULL AND event_id != '' AND match_id IN ({})",
        placeholders.join(",")
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare load_match_event_ids: {}", e))?;
    let params: Vec<&dyn rusqlite::ToSql> =
        match_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(&*params, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query load_match_event_ids: {}", e))?;
    for r in rows {
        let (mid, eid) = r.map_err(|e| format!("read event_id row: {}", e))?;
        out.insert(mid, eid);
    }
    Ok(out)
}

// ============================================================================
// match_life_changes — life total deltas
// ============================================================================

#[derive(Debug, Clone)]
pub struct LifeChange {
    pub annotation_id: i64,
    pub ts: i64,
    pub seat_id: i64,
    pub delta: i64,
}

/// Load life-total deltas for a match, ordered by annotation_id (event order).
pub fn load_match_life_changes(
    conn: &Connection,
    match_id: &str,
) -> Result<Vec<LifeChange>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT annotation_id, ts, seat_id, delta
             FROM match_life_changes
             WHERE match_id = ?1
             ORDER BY annotation_id ASC",
        )
        .map_err(|e| format!("prepare load_match_life_changes: {}", e))?;
    let rows = stmt
        .query_map(params![match_id], |row| {
            Ok(LifeChange {
                annotation_id: row.get(0)?,
                ts: row.get(1)?,
                seat_id: row.get(2)?,
                delta: row.get(3)?,
            })
        })
        .map_err(|e| format!("query load_match_life_changes: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read life_change row: {}", e))?);
    }
    Ok(out)
}

// ============================================================================
// match_zone_transfers — card movement
// ============================================================================

#[derive(Debug, Clone)]
pub struct ZoneTransfer {
    pub annotation_id: i64,
    pub ts: i64,
    pub seat_id: Option<i64>,
    pub grp_id: Option<i64>,
    pub category: String,
    pub zone_src: Option<i64>,
    pub zone_dest: Option<i64>,
}

/// Load zone-transfer events for a match, ordered by annotation_id.
pub fn load_match_zone_transfers(
    conn: &Connection,
    match_id: &str,
) -> Result<Vec<ZoneTransfer>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT annotation_id, ts, seat_id, grp_id, category,
                    zone_src, zone_dest
             FROM match_zone_transfers
             WHERE match_id = ?1
             ORDER BY annotation_id ASC",
        )
        .map_err(|e| format!("prepare load_match_zone_transfers: {}", e))?;
    let rows = stmt
        .query_map(params![match_id], |row| {
            Ok(ZoneTransfer {
                annotation_id: row.get(0)?,
                ts: row.get(1)?,
                seat_id: row.get(2)?,
                grp_id: row.get(3)?,
                category: row.get(4)?,
                zone_src: row.get(5)?,
                zone_dest: row.get(6)?,
            })
        })
        .map_err(|e| format!("query load_match_zone_transfers: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("read zone_transfer row: {}", e))?);
    }
    Ok(out)
}

// ============================================================================
// status
// ============================================================================

pub struct StoreStatus {
    pub db_path: PathBuf,
    pub schema_version: Option<String>,
    pub ingestions: usize,
    pub last_ingestion_at: Option<i64>,
    pub last_ingestion_size: Option<i64>,
    pub decks_total: usize,
    pub decks_user: usize,
    pub decks_netdeck: usize,
    pub user_decks: usize,
    pub matches: usize,
    pub match_states: usize,
    pub inventory_snapshots: usize,
    pub latest_inventory_ts: Option<i64>,
}

pub fn status(conn: &Connection) -> Result<StoreStatus, String> {
    let mut s = StoreStatus {
        db_path: db_path(),
        schema_version: None,
        ingestions: 0,
        last_ingestion_at: None,
        last_ingestion_size: None,
        decks_total: 0,
        decks_user: 0,
        decks_netdeck: 0,
        user_decks: 0,
        matches: 0,
        match_states: 0,
        inventory_snapshots: 0,
        latest_inventory_ts: None,
    };
    s.schema_version = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok();
    s.ingestions = conn
        .query_row("SELECT COUNT(*) FROM ingestions", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .unwrap_or(0);
    let last = conn
        .query_row(
            "SELECT parsed_at, source_size FROM ingestions
             ORDER BY parsed_at DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    if let Some((at, sz)) = last {
        s.last_ingestion_at = Some(at);
        s.last_ingestion_size = Some(sz);
    }
    s.decks_total = conn
        .query_row("SELECT COUNT(*) FROM decks", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .unwrap_or(0);
    s.decks_user = conn
        .query_row(
            "SELECT COUNT(*) FROM decks WHERE is_netdeck = 0",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n as usize)
        .unwrap_or(0);
    s.decks_netdeck = conn
        .query_row(
            "SELECT COUNT(*) FROM decks WHERE is_netdeck = 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n as usize)
        .unwrap_or(0);
    s.user_decks = conn
        .query_row("SELECT COUNT(*) FROM user_decks", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as usize)
        .unwrap_or(0);
    s.matches = conn
        .query_row("SELECT COUNT(*) FROM matches", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .unwrap_or(0);
    s.inventory_snapshots = conn
        .query_row("SELECT COUNT(*) FROM inventory_snapshots", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|n| n as usize)
        .unwrap_or(0);
    s.match_states = conn
        .query_row("SELECT COUNT(*) FROM match_states", [], |r| r.get::<_, i64>(0))
        .map(|n| n as usize)
        .unwrap_or(0);
    s.latest_inventory_ts = conn
        .query_row("SELECT MAX(ts) FROM inventory_snapshots", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .ok()
        .flatten();
    Ok(s)
}

fn sum_quantities(arr: Option<&Vec<Value>>) -> i64 {
    arr.map(|a| {
        a.iter()
            .filter_map(|c| c.get("quantity").and_then(Value::as_i64))
            .sum()
    })
    .unwrap_or(0)
}

// ============================================================================
// user_decks — user-built decks (separate from played decks).
//
// These decks live in their own table to keep them clean from the
// noisy played-deck history. They share the `events.db` file with the
// rest of the data (single source of truth), but use a distinct
// deck_id prefix ("user-<8chars>") so they never collide with Arena
// deck UUIDs.
//
// The JSON shape on disk (used by `deck-import`) is:
//   {
//     "decks": [
//       {
//         "deck_id": "user-abc12345",   // optional; auto-generated if missing
//         "name": "Selesnya Tokens v2",
//         "format": "Standard",
//         "notes": "Trying Anointed Procession",
//         "mainboard": [{"grpId": 123, "quantity": 4}, ...],
//         "sideboard":  [{"grpId": 456, "quantity": 2}, ...]
//       }
//     ]
//   }
// ============================================================================

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserDeck {
    pub deck_id: String,
    pub name: String,
    pub format: Option<String>,
    pub notes: Option<String>,
    pub first_created: i64,
    pub last_modified: i64,
    pub mainboard: Vec<UserDeckCard>,
    pub sideboard: Vec<UserDeckCard>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct UserDeckCard {
    #[serde(rename = "grpId", alias = "id")]
    pub grp_id: i64,
    pub quantity: i64,
}

/// Result of a deck-import operation.
#[derive(Debug, Default, serde::Serialize)]
pub struct ImportStats {
    pub decks_inserted: usize,
    pub decks_updated: usize,
    pub decks_rejected: usize,
    pub cards_imported: usize,
}

/// Load all user_decks, most-recently-modified first.
pub fn load_user_decks(conn: &Connection) -> Result<Vec<UserDeck>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT deck_id, name, format, notes, first_created,
                    last_modified, mainboard_json, sideboard_json
             FROM user_decks
             ORDER BY last_modified DESC",
        )
        .map_err(|e| format!("prepare load_user_decks: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UserDeckRow {
                deck_id: row.get(0)?,
                name: row.get(1)?,
                format: row.get(2)?,
                notes: row.get(3)?,
                first_created: row.get(4)?,
                last_modified: row.get(5)?,
                mainboard_json: row.get(6)?,
                sideboard_json: row.get(7)?,
            })
        })
        .map_err(|e| format!("query load_user_decks: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        let row = r.map_err(|e| format!("read user_deck row: {}", e))?;
        out.push(UserDeck {
            deck_id: row.deck_id,
            name: row.name,
            format: row.format,
            notes: row.notes,
            first_created: row.first_created,
            last_modified: row.last_modified,
            mainboard: parse_user_deck_cards(&row.mainboard_json)?,
            sideboard: parse_user_deck_cards(&row.sideboard_json)?,
        });
    }
    Ok(out)
}

struct UserDeckRow {
    deck_id: String,
    name: String,
    format: Option<String>,
    notes: Option<String>,
    first_created: i64,
    last_modified: i64,
    mainboard_json: String,
    sideboard_json: String,
}

fn parse_user_deck_cards(s: &str) -> Result<Vec<UserDeckCard>, String> {
    serde_json::from_str(s).map_err(|e| format!("parse user_deck cards JSON: {}", e))
}

/// Load a single user_deck by id.
pub fn load_user_deck(conn: &Connection, deck_id: &str) -> Result<Option<UserDeck>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT deck_id, name, format, notes, first_created,
                    last_modified, mainboard_json, sideboard_json
             FROM user_decks
             WHERE deck_id = ?1",
        )
        .map_err(|e| format!("prepare load_user_deck: {}", e))?;
    let mut rows = stmt
        .query(params![deck_id])
        .map_err(|e| format!("query load_user_deck: {}", e))?;
    if let Ok(Some(row)) = rows.next() {
        let deck = UserDeck {
            deck_id: row.get(0).map_err(|e| format!("read deck_id: {}", e))?,
            name: row.get(1).map_err(|e| format!("read name: {}", e))?,
            format: row.get(2).map_err(|e| format!("read format: {}", e))?,
            notes: row.get(3).map_err(|e| format!("read notes: {}", e))?,
            first_created: row.get(4).map_err(|e| format!("read first_created: {}", e))?,
            last_modified: row.get(5).map_err(|e| format!("read last_modified: {}", e))?,
            mainboard: parse_user_deck_cards(
                &row.get::<_, String>(6).map_err(|e| format!("read mainboard_json: {}", e))?,
            )?,
            sideboard: parse_user_deck_cards(
                &row.get::<_, String>(7).map_err(|e| format!("read sideboard_json: {}", e))?,
            )?,
        };
        Ok(Some(deck))
    } else {
        Ok(None)
    }
}

/// Generate a `user-<8chars>` deck_id, using 8 hex chars from a fresh
/// timestamp + a small randomizer. Collision probability is negligible
/// for personal deck-builder use (16^8 = 4B).
fn gen_user_deck_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let salt = (nanos ^ (nanos >> 32)) as u32;
    format!("user-{:08x}", salt & 0xffffffff)
}

/// Insert or update a single user_deck. If `deck.deck_id` already
/// exists, the row is updated and `first_created` is preserved. If it
/// does not exist, `first_created` is set to `last_modified`.
pub fn upsert_user_deck(conn: &Connection, deck: &mut UserDeck) -> Result<(), String> {
    // Auto-assign a deck_id if the caller didn't provide one.
    if deck.deck_id.is_empty() || !deck.deck_id.starts_with("user-") {
        deck.deck_id = gen_user_deck_id();
    }

    let now = deck.last_modified;
    let main_json = serde_json::to_string(&deck.mainboard)
        .map_err(|e| format!("serialize mainboard: {}", e))?;
    let side_json = serde_json::to_string(&deck.sideboard)
        .map_err(|e| format!("serialize sideboard: {}", e))?;

    // UPSERT; preserve first_created if the row already exists.
    conn.execute(
        "INSERT INTO user_decks
            (deck_id, name, format, notes, first_created, last_modified,
             mainboard_json, sideboard_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(deck_id) DO UPDATE SET
            name = excluded.name,
            format = excluded.format,
            notes = excluded.notes,
            last_modified = excluded.last_modified,
            mainboard_json = excluded.mainboard_json,
            sideboard_json = excluded.sideboard_json",
        params![
            deck.deck_id,
            deck.name,
            deck.format,
            deck.notes,
            deck.first_created,
            now,
            main_json,
            side_json,
        ],
    )
    .map_err(|e| format!("upsert user_deck: {}", e))?;
    Ok(())
}

/// Delete a user_deck by id. Returns true if a row was removed.
pub fn delete_user_deck(conn: &Connection, deck_id: &str) -> Result<bool, String> {
    let n = conn
        .execute("DELETE FROM user_decks WHERE deck_id = ?1", params![deck_id])
        .map_err(|e| format!("delete user_deck: {}", e))?;
    Ok(n > 0)
}

/// Import a JSON document (file or stdin) into the user_decks table.
/// Returns ImportStats with counts and any errors encountered.
///
/// `source_name` is shown in error messages (e.g. the file path or "<stdin>").
pub fn import_user_decks_json(
    conn: &Connection,
    raw: &str,
    source_name: &str,
) -> Result<ImportStats, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON in {source_name}: {e}"))?;

    // Accept either `{"decks": [...]}` or a bare `[...]` or a bare single
    // `{...}` deck object.
    let arr_value = if let Some(arr) = value.as_array() {
        arr.clone()
    } else if let Some(obj) = value.as_object() {
        if let Some(d) = obj.get("decks") {
            d.as_array()
                .cloned()
                .ok_or_else(|| format!("{source_name}: 'decks' must be an array"))?
        } else {
            vec![value.clone()]
        }
    } else {
        return Err(format!("{source_name}: expected object or array"));
    };

    let mut stats = ImportStats::default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for (i, dv) in arr_value.iter().enumerate() {
        let tag = format!("{source_name}[{i}]");
        match parse_user_deck_json(dv, now) {
            Ok(mut deck) => {
                let existing_first = load_user_deck(conn, &deck.deck_id)
                    .ok()
                    .flatten()
                    .map(|d| d.first_created);
                if let Some(fc) = existing_first {
                    deck.first_created = fc;
                }
                stats.cards_imported +=
                    (deck.mainboard.len() + deck.sideboard.len()) as usize;
                let existed = load_user_deck(conn, &deck.deck_id)
                    .ok()
                    .flatten()
                    .is_some();
                if upsert_user_deck(conn, &mut deck).is_ok() {
                    if existed {
                        stats.decks_updated += 1;
                    } else {
                        stats.decks_inserted += 1;
                    }
                } else {
                    stats.decks_rejected += 1;
                }
            }
            Err(e) => {
                eprintln!("warning: skipping {tag}: {e}");
                stats.decks_rejected += 1;
            }
        }
    }

    Ok(stats)
}

fn parse_user_deck_json(v: &Value, default_ts: i64) -> Result<UserDeck, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "expected an object".to_string())?;
    let name = obj
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing required field 'name'".to_string())?;
    let deck_id = obj
        .get("deck_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let format = obj.get("format").and_then(Value::as_str).map(String::from);
    let notes = obj.get("notes").and_then(Value::as_str).map(String::from);
    let mainboard = parse_card_list(obj.get("mainboard"))?;
    let sideboard = parse_card_list(obj.get("sideboard"))?;
    if name.trim().is_empty() {
        return Err("'name' is empty".to_string());
    }
    Ok(UserDeck {
        deck_id,
        name: name.to_string(),
        format,
        notes,
        first_created: default_ts,
        last_modified: default_ts,
        mainboard,
        sideboard,
    })
}

fn parse_card_list(v: Option<&Value>) -> Result<Vec<UserDeckCard>, String> {
    let arr = match v {
        Some(a) => a
            .as_array()
            .ok_or_else(|| "mainboard/sideboard must be an array".to_string())?,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::with_capacity(arr.len());
    for (i, c) in arr.iter().enumerate() {
        let grp_id = c
            .get("grpId")
            .or_else(|| c.get("id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("card[{i}]: missing grpId"))?;
        let quantity = c
            .get("quantity")
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("card[{i}]: missing quantity"))?;
        if quantity <= 0 {
            return Err(format!("card[{i}]: quantity must be positive (got {quantity})"));
        }
        out.push(UserDeckCard { grp_id, quantity });
    }
    Ok(out)
}

// ============================================================================
// tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Open an in-memory DB, run init_schema, return the connection.
    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        // Ensure the parent dir exists so init_schema doesn't choke on
        // db_path() (which reads XDG dirs).
        ensure_data_dir().expect("ensure data dir");
        init_schema(&conn).expect("init schema");
        conn
    }

    fn sample_deck_json(name: &str, qty: i64) -> String {
        format!(
            r#"{{
                "name": "{}",
                "format": "Standard",
                "mainboard": [{{"grpId": 1, "quantity": {}}}],
                "sideboard": [{{"grpId": 99, "quantity": 2}}]
            }}"#,
            name, qty
        )
    }

    #[test]
    fn schema_bumps_to_v4_with_user_decks() {
        let conn = fresh_db();
        let v: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "4");
        // Table must exist.
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM user_decks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn import_single_deck_inserts() {
        let conn = fresh_db();
        let raw = sample_deck_json("Test Deck A", 4);
        let stats = import_user_decks_json(&conn, &raw, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 1);
        assert_eq!(stats.decks_updated, 0);
        assert_eq!(stats.decks_rejected, 0);
        let decks = load_user_decks(&conn).unwrap();
        assert_eq!(decks.len(), 1);
        assert_eq!(decks[0].name, "Test Deck A");
        assert_eq!(decks[0].mainboard.len(), 1);
        assert_eq!(decks[0].mainboard[0].grp_id, 1);
        assert_eq!(decks[0].mainboard[0].quantity, 4);
        assert_eq!(decks[0].deck_id.starts_with("user-"), true);
    }

    #[test]
    fn import_reimport_updates_existing() {
        let conn = fresh_db();
        let raw1 = sample_deck_json("Original", 4);
        import_user_decks_json(&conn, &raw1, "<test>").unwrap();
        let deck_id = load_user_decks(&conn).unwrap()[0].deck_id.clone();
        // Re-import with same deck_id but different name/qty.
        let raw2 = format!(
            r#"{{ "deck_id": "{}", "name": "Updated", "mainboard": [{{"grpId": 1, "quantity": 3}}] }}"#,
            deck_id
        );
        let stats = import_user_decks_json(&conn, &raw2, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 0);
        assert_eq!(stats.decks_updated, 1);
        let decks = load_user_decks(&conn).unwrap();
        assert_eq!(decks.len(), 1);
        assert_eq!(decks[0].name, "Updated");
        assert_eq!(decks[0].mainboard[0].quantity, 3);
    }

    #[test]
    fn import_preserves_first_created_on_update() {
        let conn = fresh_db();
        let raw = sample_deck_json("Test", 4);
        import_user_decks_json(&conn, &raw, "<test>").unwrap();
        let deck = load_user_decks(&conn).unwrap()[0].clone();
        // Simulate the passage of time by manually updating last_modified.
        conn.execute(
            "UPDATE user_decks SET last_modified = last_modified + 100 WHERE deck_id = ?1",
            params![deck.deck_id],
        )
        .unwrap();
        let raw2 = format!(
            r#"{{ "deck_id": "{}", "name": "Renamed", "mainboard": [] }}"#,
            deck.deck_id
        );
        import_user_decks_json(&conn, &raw2, "<test>").unwrap();
        let after = load_user_deck(&conn, &deck.deck_id).unwrap().unwrap();
        assert_eq!(after.first_created, deck.first_created);
        assert!(after.last_modified >= deck.last_modified);
    }

    #[test]
    fn import_multi_deck_wrapper() {
        let conn = fresh_db();
        let raw = r#"{
            "decks": [
                {"name": "Deck A", "mainboard": [{"grpId": 1, "quantity": 4}]},
                {"name": "Deck B", "mainboard": [{"grpId": 2, "quantity": 3}]}
            ]
        }"#;
        let stats = import_user_decks_json(&conn, raw, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 2);
        assert_eq!(load_user_decks(&conn).unwrap().len(), 2);
    }

    #[test]
    fn import_bare_array_works() {
        let conn = fresh_db();
        let raw = r#"[
            {"name": "Bare A", "mainboard": [{"grpId": 1, "quantity": 4}]},
            {"name": "Bare B", "mainboard": [{"grpId": 2, "quantity": 3}]}
        ]"#;
        let stats = import_user_decks_json(&conn, raw, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 2);
    }

    #[test]
    fn import_rejects_invalid_decks_but_keeps_valid() {
        let conn = fresh_db();
        let raw = r#"{
            "decks": [
                {"name": "Good", "mainboard": [{"grpId": 1, "quantity": 4}]},
                {"name": "", "mainboard": []},
                {"name": "Missing qty", "mainboard": [{"grpId": 1}]},
                {"name": "Negative qty", "mainboard": [{"grpId": 1, "quantity": -1}]}
            ]
        }"#;
        let stats = import_user_decks_json(&conn, raw, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 1);
        assert_eq!(stats.decks_rejected, 3);
        // Only the valid deck should be present.
        assert_eq!(load_user_decks(&conn).unwrap().len(), 1);
    }

    #[test]
    fn import_rejects_garbage_json() {
        let conn = fresh_db();
        let err = import_user_decks_json(&conn, "not json", "<test>");
        assert!(err.is_err());
        assert_eq!(load_user_decks(&conn).unwrap().len(), 0);
    }

    #[test]
    fn delete_user_deck_works() {
        let conn = fresh_db();
        let raw = sample_deck_json("To Delete", 4);
        import_user_decks_json(&conn, &raw, "<test>").unwrap();
        let id = load_user_decks(&conn).unwrap()[0].deck_id.clone();
        assert!(delete_user_deck(&conn, &id).unwrap());
        assert_eq!(load_user_decks(&conn).unwrap().len(), 0);
        // Second delete is a no-op.
        assert!(!delete_user_deck(&conn, &id).unwrap());
    }

    #[test]
    fn status_reports_user_deck_count() {
        let conn = fresh_db();
        let s = status(&conn).unwrap();
        assert_eq!(s.user_decks, 0);
        import_user_decks_json(&conn, &sample_deck_json("A", 4), "<t>").unwrap();
        import_user_decks_json(&conn, &sample_deck_json("B", 4), "<t>").unwrap();
        let s = status(&conn).unwrap();
        assert_eq!(s.user_decks, 2);
        assert_eq!(s.schema_version.as_deref(), Some("4"));
    }

    #[test]
    fn parse_user_deck_card_accepts_id_alias() {
        // Some JSON decks use "id" instead of "grpId" for the card key.
        let conn = fresh_db();
        let raw = r#"{
            "name": "Alias Test",
            "mainboard": [{"id": 93645, "quantity": 4}]
        }"#;
        let stats = import_user_decks_json(&conn, raw, "<test>").unwrap();
        assert_eq!(stats.decks_inserted, 1);
        let deck = load_user_decks(&conn).unwrap();
        assert_eq!(deck[0].mainboard[0].grp_id, 93645);
    }
}

