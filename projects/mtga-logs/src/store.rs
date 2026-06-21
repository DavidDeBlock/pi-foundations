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
//!
//! ## Conflict resolution
//!
//! - **Decks**: latest `DeckCollection` payload wins for contents. A deck that
//!   disappears from the latest collection is **not** deleted from the DB
//!   (we never know about deletions from the log).
//! - **Matches**: `INSERT OR IGNORE`. A match ID never appears twice in the
//!   log, so first-write-wins is safe.
//! - **Inventory**: pure append. Every snapshot is preserved.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use manasight_parser::{parse_whole_log, GameEvent};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::{DeckSummary, InventorySnapshot, MatchRecord};

const SCHEMA_VERSION: &str = "1";

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
        "#,
    )
    .map_err(|e| format!("init schema: {}", e))?;

    // Record schema version if not present.
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION],
    )
    .map_err(|e| format!("write schema_version: {}", e))?;
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
                if let Some(players) = p.get("players").and_then(Value::as_array) {
                    if let Some(first) = players.first() {
                        if let Some(team) = first.get("team_id").and_then(Value::as_i64) {
                            last_local_team = Some(team);
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

    stats.files_ingested = 1;
    Ok(stats)
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
            "SELECT m.ts, COALESCE(d.name, ''), m.event_name, m.result, m.reason, m.deck_id
             FROM matches m
             LEFT JOIN decks d ON d.deck_id = m.deck_id
             ORDER BY m.ts DESC",
        )
        .map_err(|e| format!("prepare load_matches: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let ts: i64 = row.get(0)?;
            let deck_name: String = row.get(1)?;
            let event_name: Option<String> = row.get(2)?;
            let result: Option<String> = row.get(3)?;
            let reason: Option<String> = row.get(4)?;
            let deck_id: Option<String> = row.get(5)?;
            Ok((
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
        let (ts, deck_name, event_name, result, reason, deck_id) =
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
    pub matches: usize,
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
        matches: 0,
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
