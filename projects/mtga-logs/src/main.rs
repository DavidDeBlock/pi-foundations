//! mtga-logs — read and print parsed MTG Arena `Player.log` data.
//!
//! Usage:
//!   mtga-logs                  # dump all parsed events (default)
//!   mtga-logs <PATH>           # read from PATH instead of default
//!   mtga-logs <PATH> --limit N # show only the last N events
//!   mtga-logs --scrub          # redact PII (tokens, names, IDs) before parsing
//!
//! Subcommands (read from the persistent store; auto-ingest the log first):
//!   mtga-logs inventory              # current gold, gems, wildcards
//!   mtga-logs inventory --history    # inventory across all snapshots in the store
//!   mtga-logs decks                  # list user decks (excludes netdecks)
//!   mtga-logs decks --all            # include netdecks
//!   mtga-logs deck <ID>              # show one deck's cards (uses card DB if synced)
//!   mtga-logs matches                # game results with deck used
//!   mtga-logs web [--all] [--system] [-o FILE]  # write self-contained HTML pages (decks + matches) to FILE
//!   #   --all      also include netdecks
//!   #   --system   also include precons/world-champ decks (names starting with "?=")
//!
//! Persistence (events.db at $XDG_DATA_HOME/mtga-logs/events.db):
//!   mtga-logs ingest                 # force re-ingest the log (normally automatic)
//!   mtga-logs store-info             # show DB row counts and last ingestion
//!
//! Card database (independent of any log file):
//!   mtga-logs sync-cards             # download Scryfall default-cards into a local SQLite DB
//!   mtga-logs sync-cards --info      # show DB status
//!   mtga-logs sync-cards --force     # re-download even if up to date
//!
//! Data notes:
//!   - The persistent store is the source of truth for read commands. Every
//!     subcommand that needs events first calls `store::maybe_ingest`, which
//!     is idempotent: a log file with the same (path, mtime, size) is not
//!     re-parsed. This means data survives MTGA's log rotation: both
//!     Player.log and Player.log.old (if present) are ingested in order.
//!   - `inventory` reads from DeckCollection.raw_start_hook.InventoryInfo,
//!     because the parser router dispatches StartHook to DeckCollection first
//!     and never emits Inventory events.
//!   - Total cards owned in your collection is NOT in the log (Wizards removed
//!     the GetPlayerCardsV3 endpoint in August 2021 and never replaced it).

mod cards;
mod store;
mod web;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use chrono::{DateTime, Utc};
use manasight_parser::{parse_whole_log, scrub_raw_log, GameEvent};
use rusqlite::Connection;
use serde_json::Value;

const DEFAULT_LOG: &str = "/mnt/mtga-logs/Player.log";

fn main() {
    let args: Vec<String> = env::args().collect();
    let config = match Config::from_args(&args) {
        Ok(c) => c,
        Err(msg) => {
            eprintln!("{}\n", msg);
            print_usage();
            process::exit(2);
        }
    };

    // Commands that don't need the log file — handle before reading.
    match &config.command {
        Command::SyncCards { force, info_only } => {
            run_sync_cards(*force, *info_only);
            return;
        }
        Command::StoreInfo => {
            run_store_info();
            return;
        }
        Command::DeckImport { path } => {
            run_deck_import(path.clone());
            return;
        }
        Command::Ingest { force } => {
            run_ingest(*force, &config.path);
            return;
        }
        _ => {}
    }

    // Read commands (inventory, decks, deck, matches, web) read from the
    // persistent store. We auto-ingest the log first (idempotent), then query.
    // The default `Events` mode is the only command that still reads the raw
    // log — it's the diagnostic for "what's in this file right now".
    match &config.command {
        Command::Inventory { history } => run_inventory(*history),
        Command::Decks { all } => run_decks(*all),
        Command::DeckDetail { id } => run_deck_detail(id),
        Command::Matches => run_matches(),
        Command::Web { all, output, show_system, with_cards, with_builder } => run_web(
            &config.path,
            *all,
            *show_system,
            output.as_deref(),
            *with_cards,
            *with_builder,
        ),
        Command::Events => {
            let text = match fs::read_to_string(&config.path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("error reading {}: {}", config.path.display(), e);
                    process::exit(1);
                }
            };
            let text = if config.scrub {
                scrub_raw_log(&text)
            } else {
                text
            };
            let events = parse_whole_log(&text);
            run_events(&config, events);
        }
        _ => unreachable!("handled above"),
    }
}

fn run_sync_cards(force: bool, info_only: bool) {
    if info_only {
        match cards::status() {
            Ok(s) => {
                if !s.exists {
                    println!("no card database at {}", s.db_path.display());
                    println!("run `mtga-logs sync-cards` to download (~520 MB)");
                } else {
                    println!("card database: {}", s.db_path.display());
                    println!("  Scryfall updated_at: {}", s.updated_at.as_deref().unwrap_or("?"));
                    println!("  cards:               {}", s.card_count.map(|n| n.to_string()).unwrap_or_else(|| "?".into()));
                    println!("  DB size:             {} MB", s.db_size.unwrap_or(0) / 1024 / 1024);
                }
            }
            Err(e) => {
                eprintln!("error: {}", e);
                process::exit(1);
            }
        }
        return;
    }

    match cards::sync(force) {
        Ok(out) => {
            match out.status {
                cards::SyncStatus::UpToDate => {
                    println!("card database already up to date ({} cards)", out.card_count.unwrap_or(0));
                    println!("location: {}", out.db_path.display());
                }
                cards::SyncStatus::Updated => {
                    println!(
                        "synced {} cards (Scryfall updated_at: {})",
                        out.card_count.unwrap_or(0),
                        out.updated_at
                    );
                    println!("location: {}", out.db_path.display());
                }
            }
        }
        Err(e) => {
            eprintln!("sync-cards failed: {}", e);
            process::exit(1);
        }
    }
}

fn run_web(
    log_path: &std::path::Path,
    all: bool,
    show_system: bool,
    output: Option<&std::path::Path>,
    with_cards: bool,
    with_builder: bool,
) {
    // Auto-ingest: parses Player.log (and Player.log.old if present) only if
    // its fingerprint has changed since last ingest. Free on repeat runs.
    let stats = store::maybe_ingest(log_path).unwrap_or_else(|e| {
        eprintln!("ingest error: {}", e);
        process::exit(1);
    });
    if stats.events_seen > 0 {
        eprintln!("(ingested {} events)", stats.events_seen);
    }

    let card_db = if cards::db_path().exists() {
        cards::open_db(&cards::db_path()).ok()
    } else {
        None
    };
    if card_db.is_none() {
        eprintln!("(card database not found — cards will show as grpId)");
    } else {
        eprintln!("(using card database at {})", cards::db_path().display());
    }

    let store_conn = store::open_db().expect("open store db");
    let generated_at = Utc::now().format("%Y-%m-%d %H:%M UTC").to_string();
    let log_path_str = log_path.display().to_string();

    match output {
        Some(path) => {
            let pages_dir_name = match_pages_dir_for(path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("decks-matches")
                .to_string();

            // Build the landing page first so it always gets written even
            // if a downstream step fails.
            let index_stats = collect_index_stats(&store_conn, card_db.as_ref());
            let index_html = web::render_index(&web::IndexOptions {
                stats: index_stats,
                log_path: log_path.display().to_string(),
                generated_at: generated_at.clone(),
            });
            let index_path = index_path_for(path);
            if let Err(e) = fs::write(&index_path, &index_html) {
                eprintln!("error writing {}: {}", index_path.display(), e);
            }

            let decks_opts = web::RenderOptions {
                include_netdecks: all,
                show_system_decks: show_system,
                log_path: log_path_str.clone(),
                generated_at: generated_at.clone(),
                sections: web::Sections::Decks,
                sibling_link: Some(web::SiblingLink {
                    label: "View recent matches →",
                    href: sibling_filename(path, true),
                }),
                match_pages_dir: pages_dir_name.clone(),
            };
            let matches_opts = web::RenderOptions {
                include_netdecks: all,
                show_system_decks: show_system,
                log_path: log_path_str,
                generated_at,
                sections: web::Sections::Matches,
                sibling_link: Some(web::SiblingLink {
                    label: "← Back to decks",
                    href: sibling_filename(path, false),
                }),
                match_pages_dir: pages_dir_name,
            };

            let decks_html = web::render(&store_conn, card_db.as_ref(), &decks_opts);
            let matches_html = web::render(&store_conn, card_db.as_ref(), &matches_opts);

            let matches_path = matches_path_for(path);
            if let Err(e) = fs::write(path, &decks_html) {
                eprintln!("error writing {}: {}", path.display(), e);
                process::exit(1);
            }
            if let Err(e) = fs::write(&matches_path, &matches_html) {
                eprintln!("error writing {}: {}", matches_path.display(), e);
                process::exit(1);
            }
            // Per-match detail pages — one HTML file per match in a sibling
            // `matches/` directory. The matches table links to them.
            let (written, errors) = write_match_pages(
                &store_conn,
                card_db.as_ref(),
                path,
            );
            eprintln!(
                "wrote {} ({} KB) and {} ({} KB)",
                path.display(),
                decks_html.len() / 1024,
                matches_path.display(),
                matches_html.len() / 1024,
            );
            if written > 0 || errors > 0 {
                eprintln!("(match pages: {} written, {} errors)", written, errors);
            }

            // Catalog + builder pages (opt-in via --cards / --builder; default on).
            if with_cards {
                write_catalog_pages(path, &store_conn);
            }
            if with_builder {
                write_builder_pages(path, &store_conn);
            }
        }
        None => {
            let opts = web::RenderOptions {
                include_netdecks: all,
                show_system_decks: show_system,
                log_path: log_path_str,
                generated_at,
                sections: web::Sections::Both,
                sibling_link: None,
                match_pages_dir: "decks-matches".into(),
            };
            print!("{}", web::render(&store_conn, card_db.as_ref(), &opts));
        }
    }
}

/// Derive the matches file path from the decks file path:
///   /tmp/decks.html     → /tmp/decks-matches.html
///   /tmp/decks          → /tmp/decks-matches.html
fn matches_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = decks_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("decks");
    parent.join(format!("{}-matches.html", stem))
}

/// Derive the index page path. Always `<parent>/index.html` — a fixed name
/// (not derived from `decks_path`) so existing bookmarks keep working.
fn index_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join("index.html")
}

/// Gather the stats displayed on the landing page.
fn collect_index_stats(
    store_conn: &Connection,
    card_db: Option<&Connection>,
) -> web::IndexStats {
    // Deck counts: user vs netdeck.
    let mut user_deck_count: u64 = 0;
    let mut netdeck_count: u64 = 0;
    if let Ok(mut stmt) = store_conn.prepare("SELECT is_netdeck FROM decks") {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, i64>(0)) {
            for r in rows.flatten() {
                if r != 0 {
                    netdeck_count += 1;
                } else {
                    user_deck_count += 1;
                }
            }
        }
    }
    // User-built decks (separate from played decks).
    let user_built_deck_count: u64 = store_conn
        .query_row("SELECT COUNT(*) FROM user_decks", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u64;
    // Match count.
    let match_count: u64 = store_conn
        .query_row("SELECT COUNT(*) FROM matches", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as u64;
    // Last match timestamp.
    let last_match = store_conn
        .query_row(
            "SELECT ts FROM matches ORDER BY ts DESC LIMIT 1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .ok()
        .and_then(|ts| chrono::DateTime::from_timestamp(ts, 0))
        .map(|dt| dt.format("%Y-%m-%d %H:%M UTC").to_string());
    // Card DB summary.
    let card_db_summary = card_db.and_then(|_| {
        cards::status().ok().and_then(|s| Some((s.card_count?, s.updated_at?)))
    });
    web::IndexStats {
        user_deck_count,
        netdeck_count,
        match_count,
        user_built_deck_count,
        last_match,
        card_db_summary,
    }
}
/// Directory where per-match detail pages are written (sibling to decks/matches
/// files). Created on demand.
fn match_pages_dir_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = decks_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("decks");
    parent.join(format!("{}-matches", stem))
}

/// Write one HTML file per match into `<stem>-matches/<match_id>.html`.
/// Returns (written, errors). Logs each error to stderr but doesn't abort.
fn write_match_pages(
    store_conn: &Connection,
    card_db: Option<&Connection>,
    decks_path: &std::path::Path,
) -> (usize, usize) {
    let dir = match_pages_dir_for(decks_path);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("error creating {}: {}", dir.display(), e);
        return (0, 0);
    }

    // Card DB summary (count + updated_at)
    let card_db_summary = card_db.and_then(|_| {
        cards::status().ok().and_then(|s| {
            Some((s.card_count?, s.updated_at?))
        })
    });

    // The matches index filename — used by each per-match page as a back link.
    let matches_index = sibling_filename(decks_path, true);

    let mut stmt = match store_conn.prepare(
        "SELECT match_id, ts, deck_id, event_name, result, reason, payload_json
         FROM matches ORDER BY ts DESC",
    ) {
        Ok(s) => s,
        Err(e) => { eprintln!("prepare match pages: {}", e); return (0, 1); }
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
        ))
    }) {
        Ok(r) => r,
        Err(e) => { eprintln!("query match pages: {}", e); return (0, 1); }
    };

    let mut written = 0usize;
    let mut errors = 0usize;
    for row in rows {
        let (match_id, ts, deck_id, event_name, result, reason, payload_json) = match row {
            Ok(v) => v,
            Err(e) => { eprintln!("read match row: {}", e); errors += 1; continue; }
        };
        let ts_dt = chrono::DateTime::from_timestamp(ts, 0)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);
        let result = result.unwrap_or_else(|| "?".into());
        let reason = reason.unwrap_or_default();
        let event_name = event_name.unwrap_or_else(|| "?".into());

        // Deck name + full deck value (None if not found)
        let (deck_name, your_deck) = match deck_id.as_deref() {
            Some(id) => match store::load_deck_value(store_conn, id) {
                Ok(Some(v)) => {
                    let name = v.get("Name").and_then(Value::as_str).unwrap_or("?").to_string();
                    (name, Some(v))
                }
                _ => ("(unknown)".to_string(), None),
            },
            None => ("(no deck)".to_string(), None),
        };

        let steps = store::load_match_steps(store_conn, &match_id).unwrap_or_default();
        let raw_payload: Value = serde_json::from_str(&payload_json).unwrap_or(Value::Null);

        let players = store::load_match_players(store_conn, &match_id).unwrap_or_default();
        let life_changes =
            store::load_match_life_changes(store_conn, &match_id).unwrap_or_default();
        let zone_transfers =
            store::load_match_zone_transfers(store_conn, &match_id).unwrap_or_default();

        let opts = web::MatchDetailOptions {
            match_id: match_id.clone(),
            result,
            reason,
            event_name,
            deck_name,
            timestamp: ts_dt,
            your_deck,
            steps,
            raw_payload,
            matches_index: matches_index.clone(),
            show_raw: false,
            card_db_summary: card_db_summary.clone(),
            players,
            life_changes,
            zone_transfers,
        };
        let html = web::render_match_detail(card_db, &opts);
        let file = dir.join(format!("{}.html", match_id));
        if let Err(e) = fs::write(&file, html) {
            eprintln!("error writing {}: {}", file.display(), e);
            errors += 1;
        } else {
            written += 1;
        }
    }
    (written, errors)
}

/// Compute the href for the sibling link from a given path. Both files live in
/// the same directory, so the href is just the sibling's filename.
fn sibling_filename(path: &std::path::Path, this_is_decks: bool) -> String {
    let filename = if this_is_decks {
        // From decks, link to the matches sibling.
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("decks");
        format!("{}-matches.html", stem)
    } else {
        // From matches, link back to the decks file.
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("decks.html")
            .to_string()
    };
    filename
}

/// Compute the catalog HTML path from the decks path (e.g. `/tmp/decks.html`
/// → `/tmp/cards.html`).
fn catalog_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join("cards.html")
}

/// Compute the catalog data JSON path (sibling of cards.html).
fn catalog_data_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join("cards-data.json")
}

/// Compute the builder HTML path.
fn builder_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join("builder.html")
}

/// Compute the builder data JSON path.
fn builder_data_path_for(decks_path: &std::path::Path) -> std::path::PathBuf {
    let parent = decks_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    parent.join("builder-data.json")
}

/// Write the catalog HTML page and the compact cards-data.json file.
/// Skipped silently if the card DB isn't available.
fn write_catalog_pages(decks_path: &std::path::Path, _store_conn: &Connection) {
    if !cards::db_path().exists() {
        eprintln!("(skipping catalog page: card DB not found)");
        return;
    }
    let data_path = catalog_data_path_for(decks_path);
    let html_path = catalog_path_for(decks_path);
    match cards::dump_catalog_json(&data_path) {
        Ok(n) => {
            let sz = std::fs::metadata(&data_path).map(|m| m.len() / 1024).unwrap_or(0);
            eprintln!("(wrote {} ({} KB, {} cards))", data_path.display(), sz, n);
        }
        Err(e) => {
            eprintln!("error writing catalog data {}: {}", data_path.display(), e);
            return;
        }
    }
    let card_db_summary = cards::status().ok().and_then(|s| {
        Some((s.card_count?, s.updated_at?))
    });
    let decks_filename = decks_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("decks.html")
        .to_string();
    let matches_filename = sibling_filename(decks_path, true);
    let html = web::render_catalog(card_db_summary, &decks_filename, &matches_filename);
    if let Err(e) = fs::write(&html_path, &html) {
        eprintln!("error writing {}: {}", html_path.display(), e);
        return;
    }
    eprintln!("(wrote {})", html_path.display());
}

/// Write the deck builder HTML page and a JSON snapshot of current
/// user_decks. The HTML uses JavaScript + localStorage for editing; the
/// JSON snapshot is the initial state shown on page load.
fn write_builder_pages(decks_path: &std::path::Path, store_conn: &Connection) {
    let data_path = builder_data_path_for(decks_path);
    let html_path = builder_path_for(decks_path);

    let user_decks = store::load_user_decks(store_conn).unwrap_or_default();
    let cards_count = cards::status().ok().and_then(|s| s.card_count);
    let cards_updated = cards::status().ok().and_then(|s| s.updated_at);

    let json = match serde_json::to_string(&serde_json::json!({
        "v": 1,
        "user_decks": user_decks,
        "cards": { "count": cards_count, "updated_at": cards_updated },
    })) {
        Ok(s) => s,
        Err(e) => { eprintln!("error serializing builder data: {}", e); return; }
    };
    if let Err(e) = fs::write(&data_path, &json) {
        eprintln!("error writing {}: {}", data_path.display(), e);
        return;
    }
    eprintln!("(wrote {} ({} KB))", data_path.display(), json.len() / 1024);

    let decks_filename = decks_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("decks.html")
        .to_string();
    let cards_filename = catalog_path_for(decks_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("cards.html")
        .to_string();
    let html = web::render_builder(
        user_decks.len(),
        cards_count,
        cards_updated.as_deref(),
        &decks_filename,
        &cards_filename,
    );
    if let Err(e) = fs::write(&html_path, &html) {
        eprintln!("error writing {}: {}", html_path.display(), e);
        return;
    }
    eprintln!("(wrote {})", html_path.display());
}


fn print_usage() {
    eprintln!("Usage: mtga-logs [COMMAND] [PATH] [FLAGS]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  (default)              dump all parsed events");
    eprintln!("  inventory              current gold, gems, wildcards (from store)");
    eprintln!("  inventory --history    inventory across all snapshots in the store");
    eprintln!("  decks                  list user decks (from store)");
    eprintln!("  decks --all            include netdecks");
    eprintln!("  deck <ID>              show one deck's cards (from store)");
    eprintln!("  matches                game results with deck used (from store)");
    eprintln!("  web [--all] [--system] [-o FILE]  render self-contained HTML pages (decks + matches) to FILE (or stdout)");
    eprintln!("  ingest                 force re-ingest the log (usually automatic)");
    eprintln!("  store-info             show DB row counts and last ingestion");
    eprintln!("  sync-cards             download Scryfall card database (~520 MB)");
    eprintln!("  sync-cards --info      show card database status (no download)");
    eprintln!("  sync-cards --force     re-download even if up to date");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  PATH                   Player.log file (default: {})", DEFAULT_LOG);
    eprintln!("  --limit N              (default mode) show only the last N events");
    eprintln!("  --scrub                redact PII before parsing");
    eprintln!("  --force / --info       sync-cards flags (see above)");
}

enum Command {
    Events,
    Inventory { history: bool },
    Decks { all: bool },
    DeckDetail { id: String },
    Matches,
    Web {
        all: bool,
        show_system: bool,
        output: Option<PathBuf>,
        with_cards: bool,
        with_builder: bool,
    },
    SyncCards { force: bool, info_only: bool },
    Ingest { force: bool },
    StoreInfo,
    DeckImport { path: Option<PathBuf> },
}

struct Config {
    path: PathBuf,
    limit: Option<usize>,
    scrub: bool,
    command: Command,
}

impl Config {
    fn from_args(args: &[String]) -> Result<Self, String> {
        let mut path: Option<PathBuf> = None;
        let mut limit: Option<usize> = None;
        let mut scrub = false;
        let mut command = Command::Events;

        let mut i = 1;
        while i < args.len() {
            let arg = &args[i];
            match arg.as_str() {
                "--limit" => {
                    let v = args
                        .get(i + 1)
                        .ok_or_else(|| "--limit requires a value".to_string())?;
                    limit = Some(
                        v.parse()
                            .map_err(|_| format!("invalid --limit value: {}", v))?,
                    );
                    i += 2;
                }
                "--scrub" => {
                    scrub = true;
                    i += 1;
                }
                "--history" => {
                    command = match command {
                        Command::Events | Command::Inventory { .. } => {
                            Command::Inventory { history: true }
                        }
                        _ => return Err("--history is only valid with the inventory command".to_string()),
                    };
                    i += 1;
                }
                "--all" => {
                    command = match command {
                        Command::Events | Command::Decks { .. } => Command::Decks { all: true },
                        Command::Web { .. } => {
                            let (_all, output, show_system, with_cards, with_builder) =
                                match command {
                                    Command::Web { all, output, show_system, with_cards, with_builder } => {
                                        (all, output, show_system, with_cards, with_builder)
                                    }
                                    _ => unreachable!(),
                                };
                            Command::Web {
                                all: true,
                                output,
                                show_system,
                                with_cards,
                                with_builder,
                            }
                        }
                        _ => return Err("--all is only valid with the decks or web command".to_string()),
                    };
                    i += 1;
                }
                "--system" => {
                    command = match command {
                        Command::Web { .. } => {
                            let (all, output, with_cards, with_builder) = match command {
                                Command::Web { all, output, with_cards, with_builder, .. } => {
                                    (all, output, with_cards, with_builder)
                                }
                                _ => unreachable!(),
                            };
                            Command::Web {
                                all,
                                output,
                                show_system: true,
                                with_cards,
                                with_builder,
                            }
                        }
                        _ => return Err("--system is only valid with the web command".to_string()),
                    };
                    i += 1;
                }
                "--output" | "-o" => {
                    let v = args
                        .get(i + 1)
                        .ok_or_else(|| format!("{} requires a file path", arg))?;
                    let path = PathBuf::from(v);
                    command = match command {
                        Command::Events | Command::Web { .. } => {
                            let (all, show_system, with_cards, with_builder) = match &command {
                                Command::Web { all, show_system, with_cards, with_builder, .. } => {
                                    (*all, *show_system, *with_cards, *with_builder)
                                }
                                _ => (false, false, true, true),
                            };
                            Command::Web {
                                all,
                                show_system,
                                output: Some(path),
                                with_cards,
                                with_builder,
                            }
                        }
                        _ => return Err(format!("{} is only valid with the web command", arg)),
                    };
                    i += 2;
                }
                "--force" => {
                    command = match command {
                        Command::Events | Command::SyncCards { .. } => {
                            Command::SyncCards { force: true, info_only: false }
                        }
                        _ => return Err("--force is only valid with the sync-cards command".to_string()),
                    };
                    i += 1;
                }
                "--info" => {
                    command = match command {
                        Command::Events | Command::SyncCards { .. } => {
                            Command::SyncCards { force: false, info_only: true }
                        }
                        _ => return Err("--info is only valid with the sync-cards command".to_string()),
                    };
                    i += 1;
                }
                "inventory" => {
                    ensure_events(&command, "inventory")?;
                    command = Command::Inventory { history: false };
                    i += 1;
                }
                "decks" => {
                    ensure_events(&command, "decks")?;
                    command = Command::Decks { all: false };
                    i += 1;
                }
                "matches" => {
                    ensure_events(&command, "matches")?;
                    command = Command::Matches;
                    i += 1;
                }
                "sync-cards" => {
                    ensure_events(&command, "sync-cards")?;
                    command = Command::SyncCards { force: false, info_only: false };
                    i += 1;
                }
                "web" => {
                    ensure_events(&command, "web")?;
                    command = Command::Web {
                        all: false,
                        show_system: false,
                        output: None,
                        with_cards: true,
                        with_builder: true,
                    };
                    i += 1;
                }
                "--cards" => {
                    if let Command::Web { with_cards, .. } = &mut command {
                        *with_cards = true;
                    }
                    i += 1;
                }
                "--no-cards" => {
                    if let Command::Web { with_cards, .. } = &mut command {
                        *with_cards = false;
                    }
                    i += 1;
                }
                "--builder" => {
                    if let Command::Web { with_builder, .. } = &mut command {
                        *with_builder = true;
                    }
                    i += 1;
                }
                "--no-builder" => {
                    if let Command::Web { with_builder, .. } = &mut command {
                        *with_builder = false;
                    }
                    i += 1;
                }
                "ingest" => {
                    ensure_events(&command, "ingest")?;
                    command = Command::Ingest { force: false };
                    i += 1;
                }
                "store-info" => {
                    ensure_events(&command, "store-info")?;
                    command = Command::StoreInfo;
                    i += 1;
                }
                "deck-import" => {
                    ensure_events(&command, "deck-import")?;
                    let path = args
                        .get(i + 1)
                        .map(|s| PathBuf::from(s))
                        // Allow `-` to mean stdin (handled in run_deck_import).
                        .filter(|p| p != &PathBuf::from("-"));
                    command = Command::DeckImport { path };
                    i += match command {
                        Command::DeckImport { path: None } => 1,
                        _ => 2,
                    };
                }
                "deck" => {
                    ensure_events(&command, "deck")?;
                    let id = args
                        .get(i + 1)
                        .ok_or_else(|| "deck requires a deck ID as the next argument".to_string())?
                        .clone();
                    command = Command::DeckDetail { id };
                    i += 2;
                }
                other if other.starts_with("--") => {
                    return Err(format!("unknown flag: {}", other));
                }
                _ => {
                    if path.is_some() {
                        return Err(format!("unexpected positional arg: {}", arg));
                    }
                    path = Some(PathBuf::from(arg));
                    i += 1;
                }
            }
        }

        Ok(Self {
            path: path.unwrap_or_else(|| PathBuf::from(DEFAULT_LOG)),
            limit,
            scrub,
            command,
        })
    }
}

fn ensure_events(current: &Command, new_cmd: &str) -> Result<(), String> {
    if matches!(current, Command::Events) {
        Ok(())
    } else {
        Err(format!("conflicting subcommand: {}", new_cmd))
    }
}

// ============================================================================
// Default: dump all events
// ============================================================================

fn run_events(config: &Config, mut events: Vec<GameEvent>) {
    let total = events.len();
    if let Some(limit) = config.limit {
        if events.len() > limit {
            let drop = events.len() - limit;
            events = events.split_off(drop);
        }
    }

    eprintln!(
        "parsed {} events from {} (showing {}){}",
        total,
        config.path.display(),
        events.len(),
        if config.scrub { " [scrubbed]" } else { "" }
    );

    for event in &events {
        print_event(event);
    }
}

// ============================================================================
// inventory
// ============================================================================

pub(crate) struct InventorySnapshot {
    pub(crate) gold: i64,
    pub(crate) gems: i64,
    pub(crate) wc_common: i64,
    pub(crate) wc_uncommon: i64,
    pub(crate) wc_rare: i64,
    pub(crate) wc_mythic: i64,
    pub(crate) vault_progress: i64,
    pub(crate) wc_track_position: i64,
    pub(crate) seq_id: i64,
}

impl InventorySnapshot {
    fn wildcards_total(&self) -> i64 {
        self.wc_common + self.wc_uncommon + self.wc_rare + self.wc_mythic
    }
}

fn run_inventory(history: bool) {
    let stats = match store::maybe_ingest(&std::path::PathBuf::from(DEFAULT_LOG)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("ingest error: {}", e);
            process::exit(1);
        }
    };
    if stats.events_seen > 0 {
        eprintln!("(ingested {} events)", stats.events_seen);
    }

    let conn = store::open_db().expect("open store db");

    if history {
        let snapshots = store::load_inventory_history(&conn).expect("load history");
        if snapshots.is_empty() {
            eprintln!("no inventory data found");
            eprintln!("(open Arena to trigger a StartHook; the InventoryInfo lives in the response)");
            return;
        }
        println!("Inventory history ({} snapshots):", snapshots.len());
        println!();
        println!(
            "{:<20}  {:>8}  {:>6}  {:>4}  {:>4}  {:>4}  {:>4}  {:>6}  {:>5}",
            "Session start", "Gold", "Gems", "WCc", "WCu", "WCr", "WCm", "Vault", "SeqId"
        );
        let last_ts: Option<i64> = None;
        for snap in &snapshots {
            let _ = last_ts;
            println!(
                "{:<20}  {:>8}  {:>6}  {:>4}  {:>4}  {:>4}  {:>4}  {:>6}  {:>5}",
                "(by seq)",
                format_number(snap.gold),
                format_number(snap.gems),
                snap.wc_common,
                snap.wc_uncommon,
                snap.wc_rare,
                snap.wc_mythic,
                snap.vault_progress,
                snap.seq_id,
            );
        }
    } else {
        let snap = store::load_latest_inventory(&conn).expect("load latest inventory");
        let Some(snap) = snap else {
            eprintln!("no inventory data found");
            eprintln!("(open Arena to trigger a StartHook; the InventoryInfo lives in the response)");
            return;
        };
        println!(
            "Inventory snapshot (SeqId {})",
            snap.seq_id
        );
        println!();
        println!("  {:<26}  {:>10}", "Gold", format_number(snap.gold));
        println!("  {:<26}  {:>10}", "Gems", format_number(snap.gems));
        println!();
        println!("  Wildcards ({} total):", format_number(snap.wildcards_total()));
        println!("    {:<24}  {:>10}", "Common", format_number(snap.wc_common));
        println!("    {:<24}  {:>10}", "Uncommon", format_number(snap.wc_uncommon));
        println!("    {:<24}  {:>10}", "Rare", format_number(snap.wc_rare));
        println!("    {:<24}  {:>10}", "Mythic", format_number(snap.wc_mythic));
        println!();
        println!("  {:<26}  {:>10}", "Vault progress", format_number(snap.vault_progress));
        println!("  {:<26}  {:>10}", "Wildcard track position", snap.wc_track_position);
    }
}

fn format_number(n: i64) -> String {
    let neg = n < 0;
    let s = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3 + 1);
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.insert(0, ',');
        }
        out.insert(0, c);
    }
    if neg {
        out.insert(0, '-');
    }
    out
}

// ============================================================================
// decks / deck
// ============================================================================

pub(crate) struct DeckSummary {
    pub(crate) name: String,
    pub(crate) format: String,
    pub(crate) main_count: i64,
    pub(crate) side_count: i64,
    pub(crate) is_netdeck: bool,
    pub(crate) last_seen: Option<DateTime<Utc>>,
}

fn run_decks(all: bool) {
    let stats = store::maybe_ingest(&std::path::PathBuf::from(DEFAULT_LOG)).unwrap_or_else(|e| {
        eprintln!("ingest error: {}", e);
        std::process::exit(1);
    });
    if stats.events_seen > 0 {
        eprintln!("(ingested {} events)", stats.events_seen);
    }
    let conn = store::open_db().expect("open store db");
    let decks = store::load_decks(&conn).expect("load decks");
    if decks.is_empty() {
        eprintln!("no deck data found");
        return;
    }

    let user_count = decks.values().filter(|d| !d.is_netdeck).count();
    let netdeck_count = decks.values().filter(|d| d.is_netdeck).count();
    if all {
        eprintln!("loaded {} decks", decks.len());
    } else {
        eprintln!(
            "loaded {} decks ({} user, {} netdeck hidden); use --all to include netdecks",
            decks.len(),
            user_count,
            netdeck_count
        );
    }

    let filtered: Vec<&DeckSummary> = decks
        .values()
        .filter(|d| all || !d.is_netdeck)
        .collect();
    if filtered.is_empty() {
        return;
    }

    let mut sorted = filtered;
    sorted.sort_by(|a, b| b.last_seen.cmp(&a.last_seen));

    println!();
    println!(
        "{:<45}  {:<12}  {:>5}  {:>4}  {}",
        "Name", "Format", "Cards", "Side", "Last played"
    );
    for d in sorted {
        let name = truncate(&d.name, 45);
        let last = d
            .last_seen
            .map(|t| t.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{:<45}  {:<12}  {:>5}  {:>4}  {}",
            name, d.format, d.main_count, d.side_count, last
        );
    }
}

fn run_deck_detail(id: &str) {
    let stats = store::maybe_ingest(&std::path::PathBuf::from(DEFAULT_LOG)).unwrap_or_else(|e| {
        eprintln!("ingest error: {}", e);
        std::process::exit(1);
    });
    if stats.events_seen > 0 {
        eprintln!("(ingested {} events)", stats.events_seen);
    }
    let conn = store::open_db().expect("open store db");
    let deck = match store::load_deck_value(&conn, id) {
        Ok(Some(d)) => d,
        Ok(None) => {
            eprintln!("deck not found: {}", id);
            eprintln!("(run `mtga-logs decks` to list available decks)");
            return;
        }
        Err(e) => {
            eprintln!("load error: {}", e);
            process::exit(1);
        }
    };

    let summary_name = deck.get("Name").and_then(Value::as_str).unwrap_or("?").to_string();
    let summary_format = deck
        .get("Attributes")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter().find_map(|x| {
                if x.get("name").and_then(Value::as_str) == Some("Format") {
                    x.get("value").and_then(Value::as_str).map(str::to_owned)
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| "?".to_string());
    let summary_is_netdeck = deck
        .get("IsNetDeck")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let description = String::new(); // Description isn't preserved in our store; would need a column.

    // Try to open the card DB; if present, show names; otherwise print grpId
    // and a one-time hint.
    let card_db = cards::open_db(&cards::db_path()).ok();
    if card_db.is_none() {
        eprintln!(
            "(card database not found at {} — names will show as grpId)",
            cards::db_path().display()
        );
        eprintln!("(run `mtga-logs sync-cards` to download ~520 MB and enable names)");
        eprintln!();
    }

    println!("Deck:   {}", summary_name);
    println!("ID:     {}", id);
    println!("Format: {}", summary_format);
    if summary_is_netdeck {
        println!("Type:   netdeck (imported)");
    }
    if !description.is_empty() {
        println!("Desc:   {}", description);
    }
    println!();

    let list = deck.get("list");
    let main = list.and_then(|l| l.get("MainDeck")).and_then(Value::as_array);
    let side = list.and_then(|l| l.get("Sideboard")).and_then(Value::as_array);

    if let Some(main) = main {
        let total: i64 = main.iter().filter_map(|c| c.get("quantity").and_then(Value::as_i64)).sum();
        println!("Main deck ({} cards across {} entries):", total, main.len());
        for c in main {
            let qty = c.get("quantity").and_then(Value::as_i64).unwrap_or(1);
            let arena_id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
            print_card_line("  ", qty, arena_id, card_db.as_ref());
        }
    } else {
        println!("Main deck: (none)");
    }
    println!();

    match side {
        Some(s) if s.is_empty() => println!("Sideboard: (empty)"),
        Some(s) => {
            let total: i64 = s.iter().filter_map(|c| c.get("quantity").and_then(Value::as_i64)).sum();
            println!("Sideboard ({} cards across {} entries):", total, s.len());
            for c in s {
                let qty = c.get("quantity").and_then(Value::as_i64).unwrap_or(1);
                let arena_id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
                print_card_line("  ", qty, arena_id, card_db.as_ref());
            }
        }
        None => println!("Sideboard: (none)"),
    }
}

fn print_card_line(prefix: &str, qty: i64, arena_id: i64, card_db: Option<&Connection>) {
    match card_db.and_then(|c| cards::lookup(c, arena_id)) {
        Some(card) => {
            let set = card.set_code.as_deref().unwrap_or("???");
            let cn = card.collector_number.as_deref().unwrap_or("?");
            let rarity = card.rarity.as_deref().unwrap_or("");
            let suffix = if rarity.is_empty() {
                format!(" [{} #{}]", set, cn)
            } else {
                format!(" [{} #{}, {}]", set, cn, rarity)
            };
            let mana = card.mana_cost.as_deref().unwrap_or("");
            let mana_part = if mana.is_empty() {
                String::new()
            } else {
                format!(" {}", mana)
            };
            println!("{}{}x {}{}{}", prefix, qty, card.name, mana_part, suffix);
        }
        None => {
            println!("{}{}x grpId {}", prefix, qty, arena_id);
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

// ============================================================================
// matches
// ============================================================================

pub(crate) struct MatchRecord {
    pub(crate) match_id: String,
    pub(crate) timestamp: DateTime<Utc>,
    pub(crate) deck_name: String,
    pub(crate) event_name: String,
    pub(crate) result: String,
    pub(crate) reason: String,
}

fn run_matches() {
    let stats = store::maybe_ingest(&std::path::PathBuf::from(DEFAULT_LOG)).unwrap_or_else(|e| {
        eprintln!("ingest error: {}", e);
        std::process::exit(1);
    });
    if stats.events_seen > 0 {
        eprintln!("(ingested {} events)", stats.events_seen);
    }
    let conn = store::open_db().expect("open store db");
    let records = store::load_matches(&conn).expect("load matches");
    if records.is_empty() {
        eprintln!("no game results found in store");
        eprintln!("(play a match — GameResult events are extracted from Player.log)");
        return;
    }

    println!("Match history ({} games):", records.len());
    println!();
    println!(
        "{:<17}  {:<28}  {:<14}  {:<5}  {}",
        "Date", "Deck", "Event", "Result", "Reason"
    );
    for r in &records {
        let date = r.timestamp.format("%Y-%m-%d %H:%M").to_string();
        let deck = truncate(&r.deck_name, 28);
        let event = truncate(&r.event_name, 14);
        println!(
            "{:<17}  {:<28}  {:<14}  {:<5}  {}",
            date, deck, event, r.result, r.reason
        );
    }
}

// ============================================================================
// ingest / store-info
// ============================================================================

fn run_ingest(force: bool, log_path: &PathBuf) {
    let stats = if force {
        store::force_ingest(log_path)
    } else {
        store::maybe_ingest(log_path)
    };
    match stats {
        Ok(s) => {
            if s.files_ingested == 0 && s.files_skipped == 0 {
                eprintln!("nothing to ingest (no Player.log found at {})", log_path.display());
                return;
            }
            for _ in 0..s.files_skipped {
                eprintln!("skipped: {} (already ingested)", log_path.display());
            }
            for _ in 0..s.files_ingested {
                eprintln!(
                    "ingested {}: {} events, {} decks upserted, {} matches inserted, {} inventory snapshots",
                    log_path.display(),
                    s.events_seen,
                    s.decks_upserted,
                    s.matches_inserted,
                    s.inventory_inserted,
                );
            }
        }
        Err(e) => {
            eprintln!("ingest error: {}", e);
            process::exit(1);
        }
    }
}

fn run_store_info() {
    let conn = match store::open_db() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("store open error: {}", e);
            process::exit(1);
        }
    };
    let s = match store::status(&conn) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("store status error: {}", e);
            process::exit(1);
        }
    };

    println!("Store:   {}", s.db_path.display());
    if let Some(v) = s.schema_version {
        println!("Schema:  v{}", v);
    }
    println!();
    println!("Ingestions:");
    println!("  files tracked       {}", s.ingestions);
    if let (Some(at), Some(sz)) = (s.last_ingestion_at, s.last_ingestion_size) {
        let dt = chrono::DateTime::from_timestamp(at, 0)
            .map(|t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string())
            .unwrap_or_else(|| "?".into());
        println!("  last ingestion at  {} ({} bytes parsed)", dt, sz);
    } else {
        println!("  last ingestion at  (never)");
    }
    println!();
    println!("Decks:    {} total ({} user, {} netdeck), {} user-built", s.decks_total, s.decks_user, s.decks_netdeck, s.user_decks);
    println!("Matches:  {}", s.matches);
    println!("Inventory snapshots: {} (latest: {})",
        s.inventory_snapshots,
        s.latest_inventory_ts
            .and_then(|t| chrono::DateTime::from_timestamp(t, 0)
                .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string()))
            .unwrap_or_else(|| "n/a".into()),
    );
}

/// Import user-built decks from a JSON file (or stdin if path is None).
///
/// JSON shape: see `store::import_user_decks_json`.
fn run_deck_import(path: Option<PathBuf>) {
    use std::io::Read;

    let (raw, source_name) = match path {
        Some(p) => {
            let s = std::fs::read_to_string(&p).unwrap_or_else(|e| {
                eprintln!("error: cannot read {}: {}", p.display(), e);
                process::exit(1);
            });
            (s, p.display().to_string())
        }
        None => {
            // Read all of stdin.
            let mut s = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut s) {
                eprintln!("error: cannot read stdin: {}", e);
                process::exit(1);
            }
            (s, "<stdin>".to_string())
        }
    };

    let conn = match store::open_db() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("store open error: {}", e);
            process::exit(1);
        }
    };

    match store::import_user_decks_json(&conn, &raw, &source_name) {
        Ok(stats) => {
            println!(
                "Imported from {}: {} decks ({} inserted, {} updated, {} rejected), {} card slots total",
                source_name,
                stats.decks_inserted + stats.decks_updated,
                stats.decks_inserted,
                stats.decks_updated,
                stats.decks_rejected,
                stats.cards_imported,
            );
            if stats.decks_rejected > 0 {
                process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("error: {}", e);
            process::exit(1);
        }
    }
}

// ============================================================================
// Event dump helpers (kept for the default mode)
// ============================================================================

fn event_category(event: &GameEvent) -> &'static str {
    match event {
        GameEvent::GameState(_) => "GameState",
        GameEvent::ClientAction(_) => "ClientAction",
        GameEvent::MatchState(_) => "MatchState",
        GameEvent::DraftBot(_) => "DraftBot",
        GameEvent::DraftHuman(_) => "DraftHuman",
        GameEvent::DraftComplete(_) => "DraftComplete",
        GameEvent::EventLifecycle(_) => "EventLifecycle",
        GameEvent::Session(_) => "Session",
        GameEvent::Rank(_) => "Rank",
        GameEvent::DeckCollection(_) => "DeckCollection",
        GameEvent::Inventory(_) => "Inventory",
        GameEvent::DeckSubmission(_) => "DeckSubmission",
        GameEvent::GameResult(_) => "GameResult",
        GameEvent::LogFileRotated(_) => "LogFileRotated",
        GameEvent::DetailedLoggingStatus(_) => "DetailedLoggingStatus",
        GameEvent::MatchConnectionState(_) => "MatchConnectionState",
        GameEvent::TcpConnectionClose(_) => "TcpConnectionClose",
        GameEvent::WebSocketClosed(_) => "WebSocketClosed",
        GameEvent::ConnectionError(_) => "ConnectionError",
        GameEvent::Truncation(_) => "Truncation",
        _ => "Unknown",
    }
}

fn print_event(event: &GameEvent) {
    let category = event_category(event);
    let ts_str = match event.metadata().timestamp() {
        Some(t) => t.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        None => "(no timestamp)".to_string(),
    };
    println!("[{}] {}: {}", ts_str, category, event.payload());
}
