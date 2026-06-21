//! Card database — sync Scryfall bulk data into a local SQLite DB.
//!
//! Schema: one row per Arena/MTGA grpId (Scryfall's `arena_id`), keyed by that id.
//! Storage: `$XDG_DATA_HOME/mtga-logs/cards.db` (or `~/.local/share/mtga-logs/cards.db`).
//!
//! Sync: queries `/bulk-data` for the current `default_cards` URI + `updated_at`.
//! If the DB's stored `updated_at` matches, no download needed. Otherwise stream
//! the JSON to disk, then bulk-insert into a fresh DB and atomically rename.

use std::env;
use std::fmt;
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::{Deserializer, SeqAccess, Visitor};
use serde_json::Value;

const BULK_TYPE: &str = "default_cards";
const BULK_INDEX_URL: &str = "https://api.scryfall.com/bulk-data";
const HTTP_TIMEOUT: Duration = Duration::from_secs(900); // 15 min for 522 MB

/// Returns the directory used for card DB + cached JSON.
pub fn data_dir() -> PathBuf {
    if let Some(p) = env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(p).join("mtga-logs");
    }
    if let Some(home) = env::var_os("HOME") {
        return PathBuf::from(home).join(".local").join("share").join("mtga-logs");
    }
    PathBuf::from(".mtga-logs")
}

pub fn db_path() -> PathBuf {
    data_dir().join("cards.db")
}

pub fn json_path() -> PathBuf {
    data_dir().join("cards.json")
}

pub struct BulkInfo {
    pub download_uri: String,
    pub updated_at: String,
    pub size: u64,
}

/// Hit Scryfall's `/bulk-data` index and return the entry for `default_cards`.
pub fn fetch_bulk_info() -> Result<BulkInfo, String> {
    let resp = ureq::get(BULK_INDEX_URL)
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| format!("GET {}: {}", BULK_INDEX_URL, e))?;
    let body = resp
        .into_string()
        .map_err(|e| format!("read /bulk-data body: {}", e))?;
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("parse /bulk-data: {}", e))?;
    let items = v
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "/bulk-data: no `data` array".to_string())?;
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some(BULK_TYPE) {
            return Ok(BulkInfo {
                download_uri: item
                    .get("download_uri")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "/bulk-data: missing download_uri".to_string())?
                    .to_string(),
                updated_at: item
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "/bulk-data: missing updated_at".to_string())?
                    .to_string(),
                size: item.get("size").and_then(Value::as_i64).unwrap_or(0) as u64,
            });
        }
    }
    Err(format!("{} not found in /bulk-data", BULK_TYPE))
}

/// Open the DB, creating the schema if needed.
pub fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open db: {}", e))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS cards (
             arena_id        INTEGER PRIMARY KEY,
             scryfall_id     TEXT    NOT NULL UNIQUE,
             name            TEXT    NOT NULL,
             mana_cost       TEXT,
             cmc             REAL,
             type_line       TEXT,
             colors          TEXT,
             color_identity  TEXT,
             rarity          TEXT,
             set_code        TEXT,
             set_name        TEXT,
             collector_number TEXT,
             released_at     TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_name ON cards(name);
         CREATE INDEX IF NOT EXISTS idx_set ON cards(set_code);
         CREATE TABLE IF NOT EXISTS meta (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );",
    )
    .map_err(|e| format!("schema: {}", e))?;
    Ok(conn)
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM meta WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

#[derive(Debug)]
pub enum SyncStatus {
    UpToDate,
    Updated,
}

#[derive(Debug)]
pub struct SyncOutcome {
    pub status: SyncStatus,
    pub db_path: PathBuf,
    pub card_count: Option<usize>,
    pub updated_at: String,
}

/// Synchronize the card database with Scryfall. If `force`, re-download even
/// when `updated_at` already matches the local copy.
pub fn sync(force: bool) -> Result<SyncOutcome, String> {
    fs::create_dir_all(data_dir()).map_err(|e| format!("create data dir: {}", e))?;

    eprintln!("checking Scryfall bulk-data...");
    let info = fetch_bulk_info()?;
    eprintln!(
        "  {}: {} MB, updated {}",
        BULK_TYPE,
        info.size / 1024 / 1024,
        info.updated_at
    );

    let db_file = db_path();
    let conn = open_db(&db_file)?;
    let current_updated = meta_get(&conn, "updated_at");

    if !force && current_updated.as_deref() == Some(info.updated_at.as_str()) {
        let count: u64 = meta_get(&conn, "card_count")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        eprintln!("  already up to date ({} cards)", count);
        return Ok(SyncOutcome {
            status: SyncStatus::UpToDate,
            db_path: db_file,
            card_count: Some(count as usize),
            updated_at: info.updated_at,
        });
    }

    if let Some(prev) = current_updated {
        eprintln!("  local copy is from {}, refreshing...", prev);
    }

    eprintln!("downloading {}...", BULK_TYPE);
    let json_path = download_json(&info)?;

    eprintln!("importing into SQLite...");
    let card_count = import_json(&json_path, &info)?;

    Ok(SyncOutcome {
        status: SyncStatus::Updated,
        db_path: db_file,
        card_count: Some(card_count),
        updated_at: info.updated_at,
    })
}

/// Stream the bulk JSON file to `cards.json` (atomic via `.tmp` rename).
/// Resumes if a complete `.tmp` file is already present.
fn download_json(info: &BulkInfo) -> Result<PathBuf, String> {
    let final_path = json_path();
    let tmp_path = data_dir().join("cards.json.tmp");

    // Resume support: if tmp file exists with the expected size, skip download.
    if tmp_path.exists() {
        if let Ok(meta) = fs::metadata(&tmp_path) {
            if meta.len() == info.size {
                eprintln!("  resuming from existing tmp file ({:.1} MB)", meta.len() as f64 / 1024.0 / 1024.0);
                return finish_download(&tmp_path, &final_path);
            } else {
                eprintln!(
                    "  ignoring stale tmp file ({:.1} MB, expected {:.1} MB)",
                    meta.len() as f64 / 1024.0 / 1024.0,
                    info.size as f64 / 1024.0 / 1024.0
                );
                let _ = fs::remove_file(&tmp_path);
            }
        }
    }

    eprintln!(
        "  fetching from {}",
        info.download_uri
    );
    let resp = ureq::get(&info.download_uri)
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| format!("download: {}", e))?;

    let mut reader = resp.into_reader();
    let f = fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {}", e))?;
    let mut writer = BufWriter::with_capacity(64 * 1024, f);

    let mut buf = vec![0u8; 64 * 1024];
    let mut written: u64 = 0;
    let mut last_report: u64 = 0;
    let start = Instant::now();

    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read body: {}", e))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write tmp: {}", e))?;
        written += n as u64;
        if written - last_report >= 5 * 1024 * 1024 {
            report_progress(written, info.size, start);
            last_report = written;
        }
    }
    writer.flush().map_err(|e| format!("flush tmp: {}", e))?;
    report_progress(written, info.size, start);
    eprintln!();

    if info.size > 0 && written != info.size {
        // Keep tmp file in place so the next run can retry/resume
        return Err(format!(
            "size mismatch: got {} bytes, expected {}",
            written, info.size
        ));
    }

    finish_download(&tmp_path, &final_path)
}

fn finish_download(tmp_path: &Path, final_path: &Path) -> Result<PathBuf, String> {
    fs::rename(tmp_path, final_path).map_err(|e| format!("rename tmp to final: {}", e))?;
    Ok(final_path.to_path_buf())
}

fn report_progress(written: u64, total: u64, start: Instant) {
    let pct = if total > 0 {
        written as f64 / total as f64 * 100.0
    } else {
        0.0
    };
    let elapsed = start.elapsed().as_secs_f64().max(0.001);
    let speed = (written as f64 / 1024.0 / 1024.0) / elapsed;
    eprint!(
        "\r  {:.1} MB / {:.1} MB ({:>5.1}%) {:.1} MB/s   ",
        written as f64 / 1024.0 / 1024.0,
        total as f64 / 1024.0 / 1024.0,
        pct,
        speed
    );
    let _ = std::io::stderr().flush();
}

/// Parse the bulk JSON and bulk-insert into a fresh DB, then atomic-rename
/// over the existing DB.
fn import_json(json_path: &Path, info: &BulkInfo) -> Result<usize, String> {
    let tmp_db = data_dir().join("cards.db.new");
    let final_db = db_path();
    let _ = fs::remove_file(&tmp_db);
    // WAL mode leaves .db-wal/.db-shm files; clear them too.
    let _ = fs::remove_file(data_dir().join("cards.db-wal"));
    let _ = fs::remove_file(data_dir().join("cards.db-shm"));

    let conn = open_db(&tmp_db)?;
    // Bulk inserts in WAL inside a transaction are fast.
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin tx: {}", e))?;

    let f = fs::File::open(json_path).map_err(|e| format!("open json: {}", e))?;
    let reader = BufReader::with_capacity(64 * 1024, f);

    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let visitor = StreamingCardInsert {
        tx: &tx,
        count: 0,
        last_report: Instant::now(),
    };
    let count: usize = deserializer
        .deserialize_seq(visitor)
        .map_err(|e| format!("parse json array: {}", e))?;
    eprintln!("\r  imported {} cards total", count);

    // Metadata rows (must be inside the same tx for atomicity)
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('updated_at', ?1)",
        params![info.updated_at],
    )
    .map_err(|e| format!("meta updated_at: {}", e))?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('bulk_uri', ?1)",
        params![info.download_uri],
    )
    .map_err(|e| format!("meta bulk_uri: {}", e))?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('expected_size', ?1)",
        params![info.size.to_string()],
    )
    .map_err(|e| format!("meta size: {}", e))?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('downloaded_at', ?1)",
        params![chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|e| format!("meta downloaded_at: {}", e))?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('card_count', ?1)",
        params![count.to_string()],
    )
    .map_err(|e| format!("meta card_count: {}", e))?;

    tx.commit().map_err(|e| format!("commit: {}", e))?;
    drop(conn);

    // Atomic swap
    fs::rename(&tmp_db, &final_db).map_err(|e| format!("rename db: {}", e))?;
    // WAL files for the old DB may still exist; clean them up.
    let _ = fs::remove_file(data_dir().join("cards.db-wal"));
    let _ = fs::remove_file(data_dir().join("cards.db-shm"));

    Ok(count)
}

#[derive(Debug, Clone)]
pub struct CardRow {
    pub name: String,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub colors: Option<String>,
    pub rarity: Option<String>,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
}

/// Look up a single card by Arena grpId. Returns None if not in DB or DB missing.
pub fn lookup(conn: &Connection, arena_id: i64) -> Option<CardRow> {
    conn.query_row(
        "SELECT name, mana_cost, type_line, colors, rarity, set_code, collector_number
           FROM cards WHERE arena_id = ?1",
        params![arena_id],
        |r| {
            Ok(CardRow {
                name: r.get(0)?,
                mana_cost: r.get(1)?,
                type_line: r.get(2)?,
                colors: r.get(3)?,
                rarity: r.get(4)?,
                set_code: r.get(5)?,
                collector_number: r.get(6)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

// =============================================================================
// Streaming JSON array parser
// =============================================================================
//
// The Scryfall bulk file is a single JSON array of card objects (~600k entries,
// 522 MB). We use `serde_json::Deserializer::deserialize_seq` with a custom
// `Visitor` so we can read and insert one element at a time. This keeps peak
// memory at one Value + the 64 KB read buffer instead of 1.5 GB for the whole
// parsed tree.

struct StreamingCardInsert<'a> {
    tx: &'a rusqlite::Transaction<'a>,
    count: usize,
    last_report: Instant,
}

impl<'a> StreamingCardInsert<'a> {
    fn insert(&mut self, card: &Value) -> Result<(), String> {
        let obj = match card.as_object() {
            Some(o) => o,
            None => return Ok(()),
        };
        // Skip components, related cards, tokens, etc.
        if obj.get("object").and_then(Value::as_str) != Some("card") {
            return Ok(());
        }
        let arena_id = match obj.get("arena_id").and_then(Value::as_i64) {
            Some(id) => id,
            None => return Ok(()), // no MTGA mapping for this card
        };
        let scryfall_id = obj.get("id").and_then(Value::as_str).unwrap_or("");
        let name = obj.get("name").and_then(Value::as_str).unwrap_or("");
        let mana_cost = obj.get("mana_cost").and_then(Value::as_str);
        let cmc = obj.get("cmc").and_then(Value::as_f64);
        let type_line = obj.get("type_line").and_then(Value::as_str);
        let colors = obj.get("colors").map(|v| v.to_string());
        let color_identity = obj.get("color_identity").map(|v| v.to_string());
        let rarity = obj.get("rarity").and_then(Value::as_str);
        let set_code = obj.get("set").and_then(Value::as_str);
        let set_name = obj.get("set_name").and_then(Value::as_str);
        let collector_number = obj.get("collector_number").and_then(Value::as_str);
        let released_at = obj.get("released_at").and_then(Value::as_str);

        self.tx
            .execute(
                "INSERT OR IGNORE INTO cards
                 (arena_id, scryfall_id, name, mana_cost, cmc, type_line,
                  colors, color_identity, rarity, set_code, set_name,
                  collector_number, released_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    arena_id,
                    scryfall_id,
                    name,
                    mana_cost,
                    cmc,
                    type_line,
                    colors,
                    color_identity,
                    rarity,
                    set_code,
                    set_name,
                    collector_number,
                    released_at,
                ],
            )
            .map_err(|e| format!("insert at {}: {}", self.count, e))?;
        self.count += 1;

        if self.last_report.elapsed().as_secs() >= 2 {
            eprint!("\r  imported {} cards...", self.count);
            let _ = std::io::stderr().flush();
            self.last_report = Instant::now();
        }
        Ok(())
    }
}

impl<'de, 'a> Visitor<'de> for StreamingCardInsert<'a> {
    type Value = usize;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON array of card objects")
    }

    fn visit_seq<A: SeqAccess<'de>>(mut self, mut seq: A) -> Result<usize, A::Error> {
        while let Some(value) = seq.next_element::<Value>()? {
            self.insert(&value).map_err(serde::de::Error::custom)?;
        }
        Ok(self.count)
    }
}

#[derive(Debug)]
pub struct DbStatus {
    pub db_path: PathBuf,
    pub exists: bool,
    pub updated_at: Option<String>,
    pub card_count: Option<u64>,
    pub db_size: Option<u64>,
}

/// Report the current state of the local DB without contacting Scryfall.
pub fn status() -> Result<DbStatus, String> {
    let db_file = db_path();
    if !db_file.exists() {
        return Ok(DbStatus {
            db_path: db_file,
            exists: false,
            updated_at: None,
            card_count: None,
            db_size: None,
        });
    }
    let conn = Connection::open(&db_file).map_err(|e| format!("open db: {}", e))?;
    Ok(DbStatus {
        db_path: db_file.clone(),
        exists: true,
        updated_at: meta_get(&conn, "updated_at"),
        card_count: meta_get(&conn, "card_count").and_then(|s| s.parse().ok()),
        db_size: fs::metadata(&db_file).ok().map(|m| m.len()),
    })
}
