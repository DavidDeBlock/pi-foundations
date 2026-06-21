//! mtga-logs — read and print parsed MTG Arena `Player.log` data.
//!
//! Usage:
//!   mtga-logs                  # dump all parsed events (default)
//!   mtga-logs <PATH>           # read from PATH instead of default
//!   mtga-logs <PATH> --limit N # show only the last N events
//!   mtga-logs --scrub          # redact PII (tokens, names, IDs) before parsing
//!
//! Subcommands (operate on the parsed log, ignore --limit):
//!   mtga-logs inventory              # current gold, gems, wildcards
//!   mtga-logs inventory --history    # inventory across all snapshots in the log
//!   mtga-logs decks                  # list user decks (excludes netdecks)
//!   mtga-logs decks --all            # include netdecks
//!   mtga-logs deck <ID>              # show one deck's cards
//!   mtga-logs matches                # game results with deck used
//!
//! Data notes:
//!   - `inventory` reads from DeckCollection.raw_start_hook.InventoryInfo,
//!     because the parser router dispatches StartHook to DeckCollection first
//!     and never emits Inventory events.
//!   - Cards are shown as grpId numbers (Arena internal IDs). To map to names,
//!     join with Scryfall bulk data: https://scryfall.com/docs/api/bulk-data
//!   - Total cards owned in your collection is NOT in the log (Wizards removed
//!     the GetPlayerCardsV3 endpoint in August 2021 and never replaced it).

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use chrono::{DateTime, Utc};
use manasight_parser::{parse_whole_log, scrub_raw_log, GameEvent};
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

    match &config.command {
        Command::Events => run_events(&config, events),
        Command::Inventory { history } => run_inventory(&events, *history),
        Command::Decks { all } => run_decks(&events, *all),
        Command::DeckDetail { id } => run_deck_detail(&events, id),
        Command::Matches => run_matches(&events),
    }
}

fn print_usage() {
    eprintln!("Usage: mtga-logs [COMMAND] [PATH] [FLAGS]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  (default)              dump all parsed events");
    eprintln!("  inventory              current gold, gems, wildcards");
    eprintln!("  inventory --history    inventory across all log snapshots");
    eprintln!("  decks                  list user decks");
    eprintln!("  decks --all            include netdecks");
    eprintln!("  deck <ID>              show one deck's cards");
    eprintln!("  matches                game results with deck used");
    eprintln!();
    eprintln!("Global flags:");
    eprintln!("  PATH                   Player.log file (default: {})", DEFAULT_LOG);
    eprintln!("  --limit N              (default mode) show only the last N events");
    eprintln!("  --scrub                redact PII before parsing");
}

enum Command {
    Events,
    Inventory { history: bool },
    Decks { all: bool },
    DeckDetail { id: String },
    Matches,
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
                        _ => return Err("--all is only valid with the decks command".to_string()),
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

struct InventorySnapshot {
    gold: i64,
    gems: i64,
    wc_common: i64,
    wc_uncommon: i64,
    wc_rare: i64,
    wc_mythic: i64,
    vault_progress: i64,
    wc_track_position: i64,
    seq_id: i64,
}

impl InventorySnapshot {
    fn from_value(value: &Value) -> Option<Self> {
        let inv = value.get("InventoryInfo")?;
        Some(Self {
            gold: i64_from(inv, "Gold"),
            gems: i64_from(inv, "Gems"),
            wc_common: i64_from(inv, "WildCardCommons"),
            wc_uncommon: i64_from(inv, "WildCardUnCommons"),
            wc_rare: i64_from(inv, "WildCardRares"),
            wc_mythic: i64_from(inv, "WildCardMythics"),
            vault_progress: i64_from(inv, "TotalVaultProgress"),
            wc_track_position: i64_from(inv, "wcTrackPosition"),
            seq_id: i64_from(inv, "SeqId"),
        })
    }

    fn wildcards_total(&self) -> i64 {
        self.wc_common + self.wc_uncommon + self.wc_rare + self.wc_mythic
    }
}

fn i64_from(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn collect_inventories(events: &[GameEvent]) -> Vec<(DateTime<Utc>, InventorySnapshot)> {
    let mut out = Vec::new();
    for event in events {
        if let GameEvent::DeckCollection(e) = event {
            if let Some(rsh) = e.payload().get("raw_start_hook") {
                if let Some(mut snap) = InventorySnapshot::from_value(rsh) {
                    if let Some(ts) = event.metadata().timestamp() {
                        // Silence unused mut warning: snap is built then moved; ts consumed here.
                        let _ = &mut snap;
                        out.push((ts, snap));
                    }
                }
            }
        }
    }
    out
}

fn run_inventory(events: &[GameEvent], history: bool) {
    let snapshots = collect_inventories(events);
    if snapshots.is_empty() {
        eprintln!("no inventory data found in log");
        eprintln!("(open Arena to trigger a StartHook; the InventoryInfo lives in the response)");
        return;
    }

    if history {
        println!("Inventory history ({} snapshots):", snapshots.len());
        println!();
        println!(
            "{:<20}  {:>8}  {:>6}  {:>4}  {:>4}  {:>4}  {:>4}  {:>6}  {:>5}",
            "Session start", "Gold", "Gems", "WCc", "WCu", "WCr", "WCm", "Vault", "SeqId"
        );
        for (ts, snap) in &snapshots {
            println!(
                "{:<20}  {:>8}  {:>6}  {:>4}  {:>4}  {:>4}  {:>4}  {:>6}  {:>5}",
                ts.format("%Y-%m-%d %H:%M:%S"),
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
        let (ts, snap) = snapshots.last().unwrap();
        println!(
            "Inventory snapshot from {} (SeqId {})",
            ts.format("%Y-%m-%d %H:%M:%S UTC"),
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

struct DeckSummary {
    name: String,
    format: String,
    main_count: i64,
    side_count: i64,
    is_netdeck: bool,
    last_seen: Option<DateTime<Utc>>,
}

fn attr_value(attrs: &Value, name: &str) -> Option<String> {
    attrs.as_array()?.iter().find_map(|a| {
        if a.get("name").and_then(Value::as_str) == Some(name) {
            a.get("value").and_then(Value::as_str).map(str::to_owned)
        } else {
            None
        }
    })
}

fn parse_last_played(v: &str) -> Option<DateTime<Utc>> {
    // Arena stores the value as a JSON-escaped quoted string:
    //   "\"2025-10-13T22:39:19.6016588+02:00\""
    let trimmed = v.trim();
    let inner = trimmed.trim_matches('"');
    let unescaped = inner.replace("\\\"", "\"");
    DateTime::parse_from_rfc3339(&unescaped)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn deck_summary_from_value(deck: &Value, fallback_last_seen: Option<DateTime<Utc>>) -> DeckSummary {
    let attrs = deck.get("Attributes").cloned().unwrap_or(Value::Null);
    let format = attr_value(&attrs, "Format").unwrap_or_else(|| "?".to_string());
    let last_played = attr_value(&attrs, "LastPlayed").and_then(|v| parse_last_played(&v));
    let list = deck.get("list");
    let main = list.and_then(|l| l.get("MainDeck")).and_then(Value::as_array);
    let side = list.and_then(|l| l.get("Sideboard")).and_then(Value::as_array);
    let sum_quantities = |arr: Option<&Vec<Value>>| -> i64 {
        arr.map(|a| a.iter().filter_map(|c| c.get("quantity").and_then(Value::as_i64)).sum())
            .unwrap_or(0)
    };
    DeckSummary {
        name: deck.get("Name").and_then(Value::as_str).unwrap_or("?").to_string(),
        format,
        main_count: sum_quantities(main),
        side_count: sum_quantities(side),
        is_netdeck: deck.get("IsNetDeck").and_then(Value::as_bool).unwrap_or(false),
        last_seen: last_played.or(fallback_last_seen),
    }
}

fn collect_decks(events: &[GameEvent]) -> HashMap<String, DeckSummary> {
    // Use the most recent DeckCollection (events are in chronological order).
    let mut out: HashMap<String, DeckSummary> = HashMap::new();
    for event in events.iter().rev() {
        if let GameEvent::DeckCollection(e) = event {
            let payload = e.payload();
            if let Some(decks) = payload.get("decks").and_then(Value::as_object) {
                let fallback_ts = event.metadata().timestamp();
                for (id, deck) in decks {
                    out.insert(id.clone(), deck_summary_from_value(deck, fallback_ts));
                }
            }
            break;
        }
    }
    out
}

fn run_decks(events: &[GameEvent], all: bool) {
    let decks = collect_decks(events);
    if decks.is_empty() {
        eprintln!("no deck data found in log");
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

fn find_deck_value<'a>(events: &'a [GameEvent], id: &str) -> Option<Value> {
    for event in events.iter().rev() {
        if let GameEvent::DeckCollection(e) = event {
            if let Some(deck) = e
                .payload()
                .get("decks")
                .and_then(Value::as_object)
                .and_then(|d| d.get(id))
            {
                return Some(deck.clone());
            }
        }
    }
    None
}

fn run_deck_detail(events: &[GameEvent], id: &str) {
    let deck = match find_deck_value(events, id) {
        Some(d) => d,
        None => {
            eprintln!("deck not found: {}", id);
            eprintln!("(run `mtga-logs decks` to list available decks)");
            return;
        }
    };

    let summary = deck_summary_from_value(&deck, None);
    let description = deck.get("Description").and_then(Value::as_str).unwrap_or("");

    println!("Deck:   {}", summary.name);
    println!("ID:     {}", id);
    println!("Format: {}", summary.format);
    if summary.is_netdeck {
        println!("Type:   netdeck (imported)");
    }
    if !description.is_empty() {
        println!("Desc:   {}", description);
    }
    if let Some(ls) = summary.last_seen {
        println!("Played: {}", ls.format("%Y-%m-%d %H:%M:%S UTC"));
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
            let id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
            println!("  {}x grpId {}", qty, id);
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
                let id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
                println!("  {}x grpId {}", qty, id);
            }
        }
        None => println!("Sideboard: (none)"),
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

struct MatchRecord {
    timestamp: DateTime<Utc>,
    deck_name: String,
    event_name: String,
    result: String,
    reason: String,
}

fn run_matches(events: &[GameEvent]) {
    let decks = collect_decks(events);
    let mut records: Vec<MatchRecord> = Vec::new();

    let mut last_deck_id: Option<String> = None;
    let mut last_event_name: Option<String> = None;
    let mut last_local_team: Option<i64> = None;

    for event in events {
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
                let Some(results) = game_info.get("results").and_then(Value::as_array) else {
                    continue;
                };
                // Pick the game-scope result for this game
                let game_result = results.iter().find(|r| {
                    r.get("scope").and_then(Value::as_str) == Some("MatchScope_Game")
                });
                let Some(r) = game_result else { continue };
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
                let ts = event.metadata().timestamp().unwrap_or_else(Utc::now);
                let deck_name = last_deck_id
                    .as_ref()
                    .and_then(|id| decks.get(id).map(|d| d.name.clone()))
                    .unwrap_or_else(|| "(unknown)".to_string());
                records.push(MatchRecord {
                    timestamp: ts,
                    deck_name,
                    event_name: last_event_name.clone().unwrap_or_else(|| "?".to_string()),
                    result: result.to_string(),
                    reason,
                });
            }
            _ => {}
        }
    }

    if records.is_empty() {
        eprintln!("no game results found in log");
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
