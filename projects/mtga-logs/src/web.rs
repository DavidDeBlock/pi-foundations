//! Static HTML renderer for the parsed log.
//!
//! One self-contained HTML page listing all user decks (optionally including
//! netdecks) with their card lists. Each deck is rendered as a `<details>`
//! element so the page is interactive without any JavaScript. Card names come
//! from the Scryfall DB if available; otherwise they fall back to grpId.

use std::collections::HashMap;
use std::fmt::Write as _;

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::Value;

use crate::cards;
use crate::store;
use crate::{DeckSummary, MatchRecord};

pub struct RenderOptions {
    /// Include netdecks (imported decks). Default: user decks only.
    pub include_netdecks: bool,
    /// Show "system" decks whose name starts with "?=" (game-shipped precons,
    /// world-champ decks, etc. where the client never saw a friendly name).
    /// Default: hide them.
    pub show_system_decks: bool,
    /// Path to the source log, shown in the header.
    pub log_path: String,
    /// When the HTML was generated (display string, e.g. "2026-06-21 04:42 UTC").
    pub generated_at: String,
    /// Which sections to render.
    pub sections: Sections,
    /// Optional sibling link for navigation between decks/matches pages.
    pub sibling_link: Option<SiblingLink>,
    /// Directory name (relative to the matches file) where per-match detail
    /// pages live. Used to build the ↗ href in each match row.
    pub match_pages_dir: String,
}

#[derive(Clone, Copy)]
pub enum Sections {
    /// Decks only.
    Decks,
    /// Matches only.
    Matches,
    /// Both sections on the same page (used for stdout).
    Both,
}

pub struct SiblingLink {
    pub label: &'static str,
    pub href: String,
}

/// Render the full HTML page as a String. Output is self-contained (no external
/// assets); open in any browser or serve with any static file server.
///
/// Reads all data from the persistent store (events.db) — see `crate::store`.
pub fn render(store_db: &Connection, card_db: Option<&Connection>, opts: &RenderOptions) -> String {
    let decks = store::load_decks(store_db).expect("load decks from store");

    // Collect and sort decks: most-recently-played first.
    let mut summaries: Vec<(String, DeckSummary)> = decks.into_iter().collect();
    // Filter netdecks unless explicitly asked for.
    summaries.retain(|(_, s)| opts.include_netdecks || !s.is_netdeck);
    // Keep system decks in the DOM so the on-page toggle can reveal them.
    // The CSS hides them by default; `--system` opts-in to showing on load.
    summaries.sort_by(|a, b| b.1.last_seen.cmp(&a.1.last_seen));

    // Pre-compute card DB stats.
    let (db_card_count, db_updated_at) = match card_db {
        Some(_) => {
            let s = cards::status().ok();
            (
                s.as_ref().and_then(|s| s.card_count),
                s.and_then(|s| s.updated_at),
            )
        }
        None => (None, None),
    };

    // Pre-count totals for the summary line.
    let mut total_unique_cards = 0usize;
    let mut total_mainboard = 0i64;
    for (id, _) in &summaries {
        if let Ok(Some(deck)) = store::load_deck_value(store_db, id) {
            if let Some(main) = deck
                .get("list")
                .and_then(|l| l.get("MainDeck"))
                .and_then(Value::as_array)
            {
                total_unique_cards += main.len();
                total_mainboard += main
                    .iter()
                    .filter_map(|c| c.get("quantity").and_then(Value::as_i64))
                    .sum::<i64>();
            }
        }
    }

    // Pre-count matches for the summary line.
    let matches = store::load_matches(store_db).expect("load matches from store");
    let match_count = matches.len();

    // Count hidden "system" decks (for the toggle label). Only relevant when
    // the user hasn't already passed `--system` — in that case, none are hidden.
    let hidden_system_count = if opts.show_system_decks {
        0
    } else {
        summaries
            .iter()
            .filter(|(_, s)| is_system_deck(&s.name))
            .count()
    };

    // Estimate capacity: ~600 bytes per deck section + ~250 bytes per card row
    // (we now emit richer markup: data-image attrs, card-preview, summary
    // badges for color identity + crafting cost, etc.).
    let mut out = String::with_capacity(2048 + summaries.len() * 600 + total_unique_cards * 250);

    out.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    let title = match opts.sections {
        Sections::Matches => "MTG Arena Matches",
        _ => "MTG Arena Decks",
    };
    write!(&mut out, "<title>{}</title>\n", esc(title)).unwrap();
    out.push_str("<style>\n");
    out.push_str(include_str!("web.css"));
    out.push_str("</style>\n</head>\n<body>\n");

    // Header.
    let h1 = match opts.sections {
        Sections::Matches => "MTG Arena Matches",
        _ => "MTG Arena Decks",
    };
    write!(
        &mut out,
        "<h1>{}</h1>\n\
         <div class=\"meta\">from <code>{}</code> &middot; generated {}</div>\n",
        esc(h1),
        esc(&opts.log_path),
        esc(&opts.generated_at),
    )
    .unwrap();

    // Optional nav link to the sibling page (e.g. decks.html → matches.html).
    if let Some(link) = &opts.sibling_link {
        write!(
            &mut out,
            "<nav class=\"tabs\"><a href=\"{}\">{}</a></nav>\n",
            esc(&link.href),
            esc(link.label),
        )
        .unwrap();
    }

    // DB status banner.
    match card_db {
        Some(_) => {
            let count = db_card_count
                .map(|n| n.to_string())
                .unwrap_or_else(|| "?".into());
            let updated = db_updated_at.as_deref().unwrap_or("?");
            write!(
                &mut out,
                "<div class=\"banner ok\">\
                 Card names from Scryfall DB ({} cards; bulk updated {}).\
                 </div>\n",
                count,
                esc(updated),
            )
            .unwrap();
        }
        None => {
            out.push_str(
                "<div class=\"banner warn\">\
                 <strong>Card database not found.</strong> \
                 Cards show as grpId numbers. Run <code>mtga-logs sync-cards</code> \
                 (~520 MB) to enable names.\
                 </div>\n",
            );
        }
    }

    // Summary stats + filter toggle (only on decks page).
    if !summaries.is_empty() && matches!(opts.sections, Sections::Decks | Sections::Both) {
        write!(
            &mut out,
            "<div class=\"summary\">\
             <span><b>{}</b> decks</span>\
             <span><b>{}</b> unique mainboard cards</span>\
             <span><b>{}</b> total cards</span>\
             <span><b>{}</b> matches</span>\
             </div>\n",
            summaries.len(),
            total_unique_cards,
            total_mainboard,
            match_count,
        )
        .unwrap();

        if hidden_system_count > 0 {
            write!(
                &mut out,
                "<div class=\"filter-bar\">\
                 <label class=\"toggle\">\
                 <input type=\"checkbox\" id=\"toggle-system\">\
                 <span>Show <b>{}</b> system decks (precons, world-champ &mdash; no friendly name)</span>\
                 </label>\
                 </div>\n",
                hidden_system_count,
            )
            .unwrap();
        }
    }

    // Decks.
    if matches!(opts.sections, Sections::Decks | Sections::Both) {
        for (id, summary) in &summaries {
            let deck = match store::load_deck_value(store_db, id) {
                Ok(Some(d)) => d,
                _ => continue,
            };
            write_deck(&mut out, id, &deck, summary, card_db, opts.show_system_decks);
        }
    }

    // Matches.
    if !matches.is_empty()
        && matches!(opts.sections, Sections::Matches | Sections::Both)
    {
        write_matches(&mut out, &matches, &opts.match_pages_dir);
    }

    // Floating card preview (hidden until JS hovers a card with data-image).
    out.push_str(
        "<div id=\"card-preview\" aria-hidden=\"true\">\
         <img id=\"card-preview-img\" alt=\"\">\
         <div id=\"card-preview-meta\"></div>\
         </div>\n",
    );

    // Tiny inline script: hover handlers for card spans + system-deck toggle.
    out.push_str("<script>\n");
    out.push_str(CARD_HOVER_JS);
    out.push_str(SYSTEM_TOGGLE_JS);
    out.push_str("</script>\n");

    out.push_str("</body>\n</html>\n");
    out
}

/// True for "system" decks whose friendly name was never seen by the MTGA
/// client. They have names like `?=?Loc/Decks/Precon/...` or `?=...`.
fn is_system_deck(name: &str) -> bool {
    name.starts_with("?=") || name == "?"
}

// =========================================================================
// Match-page enrichment: streak, per-deck stats, event breakdown, sparkline
// =========================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StreakKind {
    Win,
    Loss,
}

struct Streak {
    kind: Option<StreakKind>,
    count: usize,
}

struct DeckStats {
    name: String,
    games: usize,
    wins: usize,
    losses: usize,
    last_played: DateTime<Utc>,
}

struct EventStats {
    name: String,
    wins: usize,
    losses: usize,
}

fn compute_streak(matches: &[MatchRecord]) -> Streak {
    let mut sorted: Vec<&MatchRecord> = matches.iter().collect();
    sorted.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let first = match sorted.first().map(|m| m.result.as_str()) {
        Some("Win") => StreakKind::Win,
        Some("Loss") => StreakKind::Loss,
        _ => return Streak { kind: None, count: 0 },
    };
    let count = sorted
        .iter()
        .take_while(|m| m.result == first_label(first))
        .count();
    Streak { kind: Some(first), count }
}

fn first_label(k: StreakKind) -> &'static str {
    match k {
        StreakKind::Win => "Win",
        StreakKind::Loss => "Loss",
    }
}

fn compute_deck_stats(matches: &[MatchRecord]) -> Vec<DeckStats> {
    let mut by_deck: HashMap<String, DeckStats> = HashMap::new();
    for m in matches {
        let entry = by_deck.entry(m.deck_name.clone()).or_insert_with(|| DeckStats {
            name: m.deck_name.clone(),
            games: 0,
            wins: 0,
            losses: 0,
            last_played: m.timestamp,
        });
        entry.games += 1;
        if m.result == "Win" {
            entry.wins += 1;
        } else if m.result == "Loss" {
            entry.losses += 1;
        }
        if m.timestamp > entry.last_played {
            entry.last_played = m.timestamp;
        }
    }
    let mut v: Vec<DeckStats> = by_deck.into_values().collect();
    v.sort_by(|a, b| {
        b.games
            .cmp(&a.games)
            .then(b.last_played.cmp(&a.last_played))
    });
    v
}

fn compute_event_breakdown(matches: &[MatchRecord]) -> Vec<EventStats> {
    let mut by_event: HashMap<String, EventStats> = HashMap::new();
    for m in matches {
        let key = if m.event_name.is_empty() {
            "?".to_string()
        } else {
            m.event_name.clone()
        };
        let entry = by_event.entry(key).or_insert_with(|| EventStats {
            name: m.event_name.clone(),
            wins: 0,
            losses: 0,
        });
        if m.result == "Win" {
            entry.wins += 1;
        } else if m.result == "Loss" {
            entry.losses += 1;
        }
    }
    let mut v: Vec<EventStats> = by_event.into_values().collect();
    v.sort_by(|a, b| {
        (b.wins + b.losses)
            .cmp(&(a.wins + a.losses))
            .then(a.name.cmp(&b.name))
    });
    v
}

fn categorize_event(name: &str) -> &'static str {
    if name.is_empty() || name == "?" {
        "other"
    } else if name.contains("Draft") {
        "draft"
    } else if name.starts_with("Ladder") || name == "Ranked" {
        "ranked"
    } else if name.contains("DirectGame") {
        "play"
    } else if name.contains("Jump_In") || name.contains("QuickDraft") {
        "event"
    } else {
        "other"
    }
}

fn format_relative(ts: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let minutes = now.signed_duration_since(ts).num_minutes();
    if minutes < 0 {
        // future (clock skew) — show absolute date
        ts.format("%Y-%m-%d").to_string()
    } else if minutes < 1 {
        "just now".to_string()
    } else if minutes < 60 {
        format!("{}m ago", minutes)
    } else if minutes < 60 * 24 {
        format!("{}h ago", minutes / 60)
    } else if minutes < 60 * 24 * 30 {
        format!("{}d ago", minutes / (60 * 24))
    } else {
        ts.format("%Y-%m-%d").to_string()
    }
}

fn write_dashboard(out: &mut String, matches: &[MatchRecord]) {
    if matches.is_empty() {
        return;
    }
    let streak = compute_streak(matches);
    let breakdown = compute_event_breakdown(matches);
    if streak.kind.is_none() && breakdown.is_empty() {
        return;
    }

    out.push_str("<div class=\"dashboard\">\n");

    // Left column: streak + event breakdown
    out.push_str("<div class=\"dash-left\">\n");
    if let Some(kind) = streak.kind {
        if streak.count >= 2 {
            let (cls, arrow, label) = match kind {
                StreakKind::Win => ("streak-win", "▲", "win"),
                StreakKind::Loss => ("streak-loss", "▼", "loss"),
            };
            let count = streak.count;
            write!(
                out,
                "<div class=\"streak {cls}\">{arrow} <b>{count}</b>-{label} streak</div>\n"
            )
            .unwrap();
        }
    }
    if !breakdown.is_empty() {
        out.push_str("<div class=\"event-breakdown\">\n");
        out.push_str("<span class=\"event-label\">By event</span>\n");
        for e in &breakdown {
            let cat = categorize_event(&e.name);
            let display_name = if e.name.is_empty() { "?" } else { &e.name };
            write!(
                out,
                "<span class=\"event-pill cat-{cat}\" title=\"{name}\">\
                 <span class=\"event-name\">{name}</span>\
                 <span class=\"wl-mini\">{w}W–{l}L</span>\
                 </span>\n",
                cat = cat,
                name = esc(display_name),
                w = e.wins,
                l = e.losses,
            )
            .unwrap();
        }
        out.push_str("</div>\n");
    }
    out.push_str("</div>\n"); // dash-left

    // Right column: sparkline of last 30 games
    out.push_str("<div class=\"dash-right\">\n");
    out.push_str("<div class=\"sparkline-label\">Last games (left = oldest)</div>\n");
    write_sparkline(out, matches);
    out.push_str("</div>\n"); // dash-right

    out.push_str("</div>\n"); // dashboard
}

fn write_sparkline(out: &mut String, matches: &[MatchRecord]) {
    let mut sorted: Vec<&MatchRecord> = matches.iter().collect();
    sorted.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let last_n: Vec<&MatchRecord> = sorted.iter().take(30).copied().collect();
    if last_n.is_empty() {
        return;
    }
    let n = last_n.len();
    let cell = 14;
    let gap = 3;
    let w = (n * (cell + gap) - gap).max(cell);
    let h = cell;

    write!(
        out,
        "<svg class=\"sparkline\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\" \
         aria-label=\"last {n} games\">\n",
        w = w,
        h = h,
        n = n
    )
    .unwrap();
    // Oldest first → leftmost.
    for (i, m) in last_n.iter().rev().enumerate() {
        let x = i * (cell + gap);
        let cls = match m.result.as_str() {
            "Win" => "r-win",
            "Loss" => "r-loss",
            _ => "r-unknown",
        };
        let title = format!(
            "{} · {} · {} · {}",
            m.timestamp.format("%Y-%m-%d %H:%M"),
            m.result,
            m.deck_name,
            if m.event_name.is_empty() { "?" } else { &m.event_name }
        );
        write!(
            out,
            "<rect class=\"{cls}\" x=\"{x}\" y=\"0\" width=\"{cell}\" height=\"{cell}\" rx=\"2\">\
             <title>{t}</title></rect>\n",
            cls = cls,
            x = x,
            cell = cell,
            t = esc(&title),
        )
        .unwrap();
    }
    out.push_str("</svg>\n");
}

fn write_deck_stats(out: &mut String, matches: &[MatchRecord]) {
    let stats = compute_deck_stats(matches);
    if stats.is_empty() {
        return;
    }

    out.push_str("<h3>By deck</h3>\n");
    out.push_str("<table class=\"deck-stats\">\n<thead><tr>");
    out.push_str("<th>Deck</th><th>G</th><th>W</th><th>L</th><th>Win%</th><th>Last played</th>");
    out.push_str("</tr></thead>\n<tbody>\n");

    let now = Utc::now();
    for s in &stats {
        let pct = if s.games > 0 { 100 * s.wins / s.games } else { 0 };
        // Only color-code win% when there are enough games for it to be meaningful.
        let pct_class = if s.games >= 3 {
            if pct >= 60 {
                "wl-good"
            } else if pct <= 40 {
                "wl-bad"
            } else {
                ""
            }
        } else {
            ""
        };
        let deck_label = if s.name == "(no deck)" || s.name == "(unknown)" {
            format!("<em>{}</em>", esc(&s.name))
        } else {
            esc(&s.name)
        };
        let ago = format_relative(s.last_played, now);
        write!(
            out,
            "<tr>\
             <td class=\"deck-name\">{name}</td>\
             <td class=\"g\">{games}</td>\
             <td class=\"w\">{wins}</td>\
             <td class=\"l\">{losses}</td>\
             <td class=\"pct {cls}\">{pct}%</td>\
             <td class=\"ago\">{ago}</td>\
             </tr>\n",
            name = deck_label,
            games = s.games,
            wins = s.wins,
            losses = s.losses,
            cls = pct_class,
            pct = pct,
            ago = esc(&ago),
        )
        .unwrap();
    }
    out.push_str("</tbody>\n</table>\n");
}

fn write_matches(out: &mut String, matches: &[MatchRecord], match_pages_dir: &str) {
    // Sort most-recent first.
    let mut sorted: Vec<&MatchRecord> = matches.iter().collect();
    sorted.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    let wins = sorted.iter().filter(|m| m.result == "Win").count();
    let losses = sorted.iter().filter(|m| m.result == "Loss").count();
    let total = sorted.len();
    let win_pct = if total > 0 { 100 * wins / total } else { 0 };

    write!(
        out,
        "<h2>Recent matches <span class=\"count\">{} games</span> \
         <span class=\"wl-summary\">{}<b>W</b>–{}<b>L</b> ({}%)</span></h2>\n",
        total, wins, losses, win_pct,
    )
    .unwrap();

    // Dashboard: streak, event breakdown, sparkline.
    write_dashboard(out, matches);

    // Per-deck stats table.
    write_deck_stats(out, matches);

    // Original full match log.
    out.push_str("<h3>All matches</h3>\n");
    out.push_str("<table class=\"matches\">\n<thead><tr>");
    out.push_str("<th>Date</th><th>Result</th><th>Deck</th><th>Event</th><th>Reason</th>");
    out.push_str("</tr></thead>\n<tbody>\n");

    for m in &sorted {
        let date = m.timestamp.format("%Y-%m-%d %H:%M").to_string();
        let result_class = match m.result.as_str() {
            "Win" => "win",
            "Loss" => "loss",
            _ => "unknown",
        };
        let row_id = format!("match-{}", m.match_id);
        // match_pages_dir lives as a sibling to the matches file itself, so
        // the href from here is just `<dir-name>/<match_id>.html`.
        write!(
            out,
            "<tr id=\"{}\">\
             <td class=\"date\">{}</td>\
             <td><span class=\"result {}\">{}</span></td>\
             <td class=\"deck-name\">{}</td>\
             <td class=\"event\">{}</td>\
             <td class=\"reason\">{}</td>\
             <td class=\"detail-link\"><a href=\"{}/{}.html\" \
             title=\"Match details (deck, steps)\">↗</a></td>\
             </tr>\n",
            esc(&row_id),
            esc(&date),
            result_class,
            esc(&m.result),
            esc(&m.deck_name),
            esc(&m.event_name),
            esc(&m.reason),
            esc(match_pages_dir),
            esc(&m.match_id),
        )
        .unwrap();
    }

    out.push_str("</tbody>\n</table>\n");
}

/// HTML escaper for safe attribute values (no quotes).
fn esc_attr(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '"' => "&quot;".to_string(),
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' => c.to_string(),
            _ => '_'.to_string(),
        })
        .collect()
}

fn write_deck(
    out: &mut String,
    id: &str,
    deck: &Value,
    summary: &DeckSummary,
    card_db: Option<&Connection>,
    show_system_decks: bool,
) {
    let last_played = summary
        .last_seen
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "-".into());

    let list = deck.get("list");
    let main = list.and_then(|l| l.get("MainDeck")).and_then(Value::as_array);
    let side = list.and_then(|l| l.get("Sideboard")).and_then(Value::as_array);

    // Compute color identity (set of unique colors in the mainboard) and the
    // wildcard crafting cost.
    let mut color_set: std::collections::BTreeSet<char> = std::collections::BTreeSet::new();
    let mut craft = [0i64; 4]; // [C, U, R, M]
    if let Some(main_arr) = main {
        for c in main_arr {
            let qty = c.get("quantity").and_then(Value::as_i64).unwrap_or(1);
            let arena_id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
            if let Some(card) = card_db.and_then(|conn| cards::lookup(conn, arena_id)) {
                // Basic lands are free to craft, so don't count them in the
                // wildcard total (they have rarity "common" in Scryfall but
                // don't cost wildcards).
                let is_basic_land = card
                    .type_line
                    .as_deref()
                    .map(|t| t.starts_with("Basic Land"))
                    .unwrap_or(false);
                if is_basic_land {
                    // Still pull colors from lands so multi-color lands show
                    // up in the color identity pip.
                    if let Some(colors_json) = card.colors.as_deref() {
                        for ch in colors_json.chars() {
                            if matches!(ch, 'W' | 'U' | 'B' | 'R' | 'G') {
                                color_set.insert(ch);
                            }
                        }
                    }
                    continue;
                }
                // Colors array.
                if let Some(colors_json) = card.colors.as_deref() {
                    for ch in colors_json.chars() {
                        if matches!(ch, 'W' | 'U' | 'B' | 'R' | 'G') {
                            color_set.insert(ch);
                        }
                    }
                }
                // Rarity bucket.
                let bucket = match card.rarity.as_deref() {
                    Some("common") => 0,
                    Some("uncommon") => 1,
                    Some("rare") => 2,
                    Some("mythic") => 3,
                    _ => 0, // tokens/lands already filtered above
                };
                craft[bucket] += qty;
            }
        }
    }

    // Render color identity pips (W U B R G order, even if not all 5).
    let mut colors_html = String::new();
    for ch in ['W', 'U', 'B', 'R', 'G'] {
        if color_set.contains(&ch) {
            let lower = ch.to_ascii_lowercase();
            colors_html.push_str(&format!(
                "<span class=\"pip pip-{l}\" title=\"{c}\">{c}</span>",
                l = lower,
                c = ch,
            ));
        }
    }
    if colors_html.is_empty() {
        colors_html.push_str("<span class=\"colors-none\" title=\"Colorless\">\u{2014}</span>");
    }

    // Render crafting cost (only show non-zero buckets).
    let craft_labels = ["C", "U", "R", "M"];
    let mut craft_html = String::new();
    let mut any_craft = false;
    for (i, n) in craft.iter().enumerate() {
        if *n > 0 {
            craft_html.push_str(&format!(
                "<span class=\"craft-bucket craft-{}\">{}{}</span>",
                craft_labels[i].to_ascii_lowercase(),
                n,
                craft_labels[i],
            ));
            any_craft = true;
        }
    }
    let craft_html = if any_craft {
        format!("<span class=\"craft\" title=\"Wildcards needed to craft\">\u{2696} {}\u{202f}WC</span>", craft_html)
    } else {
        String::new()
    };

    // Deck type pill.
    let deck_type_pill = if summary.is_netdeck {
        "<span class=\"pill pill-netdeck\">netdeck</span>"
    } else if is_system_deck(&summary.name) {
        "<span class=\"pill pill-system\">system</span>"
    } else {
        "<span class=\"pill pill-user\">user</span>"
    };

    let format_pill = if summary.format.is_empty() {
        "<span class=\"pill pill-faint\">?</span>".to_string()
    } else {
        format!("<span class=\"pill pill-format\">{}</span>", esc(&summary.format))
    };

    // System decks (those whose name starts with "?=") live in the DOM
    // hidden by default; the on-page toggle reveals them. When the user
    // passed `--system`, they're shown by default.
    let is_sys = is_system_deck(&summary.name);
    let (data_system, extra_class) = if is_sys {
        ("true", if show_system_decks { " system-shown" } else { "" })
    } else {
        ("false", "")
    };

    write!(
        out,
        "<details class=\"deck{extra}\" data-system=\"{ds}\">\n\
         <summary>\
         <span class=\"caret\">\u{25b8}</span>\
         <span class=\"colors\">{colors}</span>\
         <span class=\"name\">{name}</span>\
         <span class=\"badges\">\
         {format_pill}\
         <span class=\"pill pill-count\"><b>{n}</b>&thinsp;cards</span>\
         {side_pill}\
         {craft_pill}\
         <span class=\"pill pill-played\">{played}</span>\
         {type_pill}\
         </span>\
         <span class=\"id\" title=\"{id}\">{id_short}</span>\
         </summary>\n",
        ds = data_system,
        extra = extra_class,
        colors = colors_html,
        name = esc(&summary.name),
        format_pill = format_pill,
        n = summary.main_count,
        side_pill = if summary.side_count > 0 {
            format!("<span class=\"pill pill-side\"><b>{}</b>&thinsp;side</span>", summary.side_count)
        } else {
            String::new()
        },
        craft_pill = craft_html,
        played = esc(&last_played),
        type_pill = deck_type_pill,
        id = esc(id),
        id_short = esc(&id[..id.len().min(8)]),
    )
    .unwrap();

    if let Some(main) = main {
        if !main.is_empty() {
            write_card_table(out, "Main deck", main, card_db);
        }
    }
    if let Some(side) = side {
        if !side.is_empty() {
            write_card_table(out, "Sideboard", side, card_db);
        }
    }

    out.push_str("</details>\n");
}

fn write_card_table(out: &mut String, title: &str, cards: &[Value], card_db: Option<&Connection>) {
    write!(
        out,
        "<table>\n<caption>{}</caption>\n<thead><tr>\
         <th class=\"qty\">Qty</th>\
         <th>Name</th>\
         <th>Mana</th>\
         <th>Type</th>\
         <th>Rarity</th>\
         <th>Set</th>\
         <th>Artist</th>\
         </tr></thead>\n<tbody>\n",
        esc(title),
    )
    .unwrap();
    for c in cards {
        let qty = c.get("quantity").and_then(Value::as_i64).unwrap_or(1);
        let arena_id = c.get("cardId").and_then(Value::as_i64).unwrap_or(0);
        match card_db.and_then(|conn| cards::lookup(conn, arena_id)) {
            Some(card) => {
                let mana = card.mana_cost.as_deref().unwrap_or("");
                let rarity = card.rarity.as_deref().unwrap_or("");
                let rarity_class = rarity.to_ascii_lowercase();
                let set = card.set_code.as_deref().unwrap_or("");
                let cn = card.collector_number.as_deref().unwrap_or("");
                let cn_short = if cn.len() > 4 { &cn[..4] } else { cn };
                let type_line = card.type_line.as_deref().unwrap_or("");
                let artist = card.artist.as_deref().unwrap_or("");
                let data_image = card.image_url.as_deref().unwrap_or("");
                let colors_html = render_colors(card.colors.as_deref());
                let rarity_letter = if rarity.is_empty() { "?".to_string() } else { rarity[..1.min(rarity.len())].to_string() };
                write!(
                    out,
                    "<tr><td class=\"qty\">{qty}</td>\
                     <td class=\"name\">\
                     <span class=\"card-name\" data-image=\"{img}\" data-mana=\"{mana_attr}\" data-rarity=\"{rarity}\" data-type=\"{ty}\" data-set=\"{setu}\" data-artist=\"{art}\" data-cn=\"{cn}\">{name}</span>\
                     {colors_after}\
                     </td>\
                     <td class=\"mana\">{mana}</td>\
                     <td class=\"type\">{type_line}</td>\
                     <td class=\"rarity {rarity_class}\">{rarity_letter}</td>\
                     <td class=\"set\">{set} <span class=\"cn\">#{cn_short}</span></td>\
                     <td class=\"artist\">{artist}</td>\
                     </tr>\n",
                    qty = qty,
                    img = esc(data_image),
                    mana_attr = esc(mana),
                    rarity = esc(rarity),
                    ty = esc(type_line),
                    setu = esc(set),
                    art = esc(artist),
                    cn = esc(cn),
                    name = esc(&card.name),
                    colors_after = if colors_html.is_empty() { String::new() } else { format!("<span class=\"colors-inline\">{}</span>", colors_html) },
                    mana = esc(mana),
                    type_line = esc(type_line),
                    rarity_class = esc(&rarity_class),
                    rarity_letter = esc(&rarity_letter),
                    set = esc(set),
                    cn_short = esc(cn_short),
                    artist = esc(artist),
                )
                .unwrap();
            }
            None => {
                write!(
                    out,
                    "<tr><td class=\"qty\">{}</td>\
                     <td class=\"name\" colspan=\"6\">grpId {}</td></tr>\n",
                    qty, arena_id,
                )
                .unwrap();
            }
        }
    }
    out.push_str("</tbody>\n</table>\n");
}

/// Render the Scryfall `colors` JSON array (e.g. `["W","U"]`) as colored pip
/// spans. Returns "&mdash;" if no colors (colorless / land).
fn render_colors(colors_json: Option<&str>) -> String {
    let Some(s) = colors_json else { return "&mdash;".into() };
    // Trim quotes if it came in as a JSON-quoted string.
    let s = s.trim().trim_matches('"');
    let mut out = String::new();
    let mut started = false;
    let mut depth = 0i32;
    let mut buf = String::new();
    for ch in s.chars() {
        match ch {
            '[' => { depth += 1; }
            ']' => { depth -= 1; }
            '"' => { /* skip quotes */ }
            ',' | ' ' if depth >= 1 => {
                if !buf.is_empty() {
                    if started { out.push(' '); }
                    push_pip(&mut out, &buf);
                    buf.clear();
                    started = true;
                }
            }
            c if depth >= 1 => buf.push(c),
            _ => {}
        }
    }
    if !buf.is_empty() {
        if started { out.push(' '); }
        push_pip(&mut out, &buf);
    }
    if out.is_empty() { "&mdash;".into() } else { out }
}

fn push_pip(out: &mut String, color: &str) {
    let letter = color.chars().next().unwrap_or('?').to_ascii_uppercase();
    write!(
        out,
        "<span class=\"pip pip-{}\" title=\"{}\">{}</span>",
        letter.to_ascii_lowercase(),
        esc(color),
        letter,
    )
    .unwrap();
}

/// Minimal HTML attribute / text escaper.
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

// =============================================================================
// Match detail page (one file per match)
// =============================================================================

/// Render a single match detail page.
///
/// Includes:
/// - Match header (date, result, deck, event, reason)
/// - "Your deck" mini-view (cards grouped by type, with crafting cost)
/// - Game steps timeline (deduplicated phase/step transitions)
/// - Opponent deck placeholder (MTGA doesn't log opponent cards)
pub fn render_match_detail(
    card_db: Option<&Connection>,
    opts: &MatchDetailOptions,
) -> String {
    let mut out = String::with_capacity(8192);

    // Header
    out.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n");
    out.push_str("<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    write!(
        &mut out,
        "<title>Match — {} vs {}</title>\n",
        esc(&opts.result),
        esc(&opts.deck_name),
    )
    .unwrap();
    out.push_str("<style>\n");
    out.push_str(include_str!("web.css"));
    out.push_str("</style>\n</head>\n<body>\n");

    // Title + back link
    let result_class = match opts.result.as_str() {
        "Win" => "win",
        "Loss" => "loss",
        _ => "unknown",
    };
    write!(
        &mut out,
        "<nav class=\"tabs\"><a href=\"../{}.html\">{} Matches</a></nav>\n",
        esc(&opts.matches_index),
        esc("←"),
    )
    .unwrap();
    write!(
        &mut out,
        "<h1><span class=\"result {0}\">{1}</span> &middot; {2}</h1>\n\
         <div class=\"meta\">\
         <span class=\"event\">{3}</span> &middot; \
         {4} &middot; \
         match <code>{5}</code>\
         </div>\n",
        result_class,
        esc(&opts.result),
        esc(&opts.deck_name),
        esc(&opts.event_name),
        esc(&opts.timestamp.format("%Y-%m-%d %H:%M UTC").to_string()),
        esc(&opts.match_id),
    )
    .unwrap();

    // Banner — same as index
    if let Some((count, updated)) = &opts.card_db_summary {
        write!(
            &mut out,
            "<div class=\"banner ok\">Card names from Scryfall DB ({} cards; bulk updated {}).</div>\n",
            count,
            esc(updated),
        )
        .unwrap();
    } else {
        out.push_str(
            "<div class=\"banner warn\">\
             <strong>Card database not found.</strong> \
             Cards show as grpId numbers. Run <code>mtga-logs sync-cards</code> \
             (~520 MB) to enable names.\
             </div>\n",
        );
    }

    // === Your deck ===
    out.push_str("<section class=\"match-deck yours\">\n");
    out.push_str("<h2>Your deck</h2>\n");
    if let Some(deck) = &opts.your_deck {
        write_deck_summary_section(&mut out, deck, card_db);
    } else {
        out.push_str("<p class=\"muted\">No deck recorded for this match. \
                     (MTGA's deck submission event was not seen before this game.)</p>\n");
    }
    out.push_str("</section>\n");

    // === Opponent deck ===
    out.push_str("<section class=\"match-deck opponent\">\n");
    out.push_str("<h2>Opponent</h2>\n");
    write!(
        &mut out,
        "<p class=\"muted\">MTGA does not log the opponent's deck contents. \
         All we know is the event (<code>{}</code>) and the opponent team id ({}).</p>\n",
        esc(&opts.event_name),
        opts.opponent_team_id
            .map(|t| t.to_string())
            .unwrap_or_else(|| "?".into()),
    )
    .unwrap();
    out.push_str("</section>\n");

    // === Game steps timeline ===
    out.push_str("<section class=\"match-steps\">\n");
    out.push_str("<h2>Game steps</h2>\n");
    write_match_steps(&mut out, &opts.steps);
    out.push_str("</section>\n");

    // Match payload (raw JSON, collapsed)
    if opts.show_raw {
        write_raw_payload(&mut out, &opts.raw_payload);
    }

    // Card hover script (same as index)
    out.push_str("<script>\n");
    out.push_str(CARD_HOVER_JS);
    out.push_str("\n</script>\n");

    out.push_str("</body>\n</html>\n");
    out
}

/// Write the per-match "Your deck" panel: deck name, format, color identity,
/// card counts, and the card list with crafting cost.
fn write_deck_summary_section(out: &mut String, deck: &Value, card_db: Option<&Connection>) {
    let name = deck.get("Name").and_then(Value::as_str).unwrap_or("?");
    let format = deck.get("format").and_then(Value::as_str).unwrap_or("");
    write!(out, "<h3>{}</h3>\n", esc(name)).unwrap();
    if !format.is_empty() {
        write!(out, "<span class=\"pill pill-format\">{}</span>\n", esc(format)).unwrap();
    }

    // Card counts + color identity + crafting cost (reuse same logic as
    // the deck list — but inline rather than nesting <details>).
    let main = deck.get("list").and_then(|l| l.get("MainDeck")).and_then(Value::as_array);
    let side = deck.get("list").and_then(|l| l.get("Sideboard")).and_then(Value::as_array);
    let main_count: i64 = main
        .map(|a| a.iter().filter_map(|c| c.get("quantity").and_then(Value::as_i64)).sum())
        .unwrap_or(0);
    let side_count: i64 = side
        .map(|a| a.iter().filter_map(|c| c.get("quantity").and_then(Value::as_i64)).sum())
        .unwrap_or(0);
    write!(
        out,
        "<div class=\"meta\"><b>{}</b> cards main / <b>{}</b> side</div>\n",
        main_count, side_count,
    )
    .unwrap();

    // Build card rows
    if let Some(main) = main {
        let mut rows: Vec<&Value> = main.iter().collect();
        rows.sort_by(|a, b| {
            let an = a.get("card_title").and_then(Value::as_str).unwrap_or("");
            let bn = b.get("card_title").and_then(Value::as_str).unwrap_or("");
            an.cmp(bn)
        });
        out.push_str("<table class=\"cards\"><thead><tr>");
        out.push_str("<th>Qty</th><th>Name</th><th>Mana</th><th>Type</th><th>Rarity</th>");
        out.push_str("</tr></thead>\n<tbody>\n");
        for c in rows {
            let qty = c.get("quantity").and_then(Value::as_i64).unwrap_or(1);
            // Two shapes of card entries exist in the data:
            //   - { id, card_title, quantity }  (from DeckSubmission / deck list)
            //   - { cardId, quantity }          (from mainboard_json / raw arena payload)
            let grp_id = c
                .get("id")
                .or_else(|| c.get("cardId"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let card = card_db.and_then(|conn| cards::lookup(conn, grp_id));
            let name = card.as_ref().map(|c| c.name.as_str()).unwrap_or("");
            let mana = card.as_ref().and_then(|c| c.mana_cost.clone()).unwrap_or_default();
            let type_line = card.as_ref().and_then(|c| c.type_line.clone()).unwrap_or_default();
            let rarity = card.as_ref().and_then(|c| c.rarity.clone()).unwrap_or_default();
            let image_url = card.as_ref().and_then(|c| c.image_url.clone()).unwrap_or_default();
            let display_name = if name.is_empty() || name == "?" {
                format!("#{}", grp_id)
            } else {
                name.to_string()
            };
            write!(
                out,
                "<tr>\
                 <td class=\"qty\">{}</td>\
                 <td>{}</td>\
                 <td class=\"mana\">{}</td>\
                 <td class=\"type-line\">{}</td>\
                 <td class=\"rarity r-{}\">{}</td>\
                 </tr>\n",
                qty,
                if image_url.is_empty() {
                    format!("<span class=\"card-name\">{}</span>", esc(&display_name))
                } else {
                    format!(
                        "<span class=\"card-name\" data-image=\"{}\">{}</span>",
                        esc_attr(&image_url),
                        esc(&display_name)
                    )
                },
                esc(&mana),
                esc(&type_line),
                rarity.to_ascii_lowercase(),
                esc(&rarity),
            )
            .unwrap();
        }
        out.push_str("</tbody>\n</table>\n");
    }
}

/// Write the game steps timeline. The data has many duplicate rows (Diff
/// events between transitions); we deduplicate by (game_number, turn_number,
/// phase, step) so only transitions appear.
///
/// Note: Diff events typically lack `game_info.gameNumber`, so we carry the
/// last-seen game_number forward when it's None. Same idea for active_player.
fn write_match_steps(out: &mut String, steps: &[store::MatchStep]) {
    if steps.is_empty() {
        out.push_str("<p class=\"muted\">No step data captured for this match. \
                     (Likely the match happened before detailed logs were enabled.)</p>\n");
        return;
    }

    // Forward-fill game_number so dedup works across Diff events.
    let mut last_game: Option<i64> = None;
    let mut keyed: Vec<(i64, i64, String, String, &store::MatchStep)> = Vec::with_capacity(steps.len());
    for s in steps {
        if let Some(g) = s.game_number {
            last_game = Some(g);
        }
        let key_game = last_game.unwrap_or(0);
        keyed.push((
            key_game,
            s.turn_number.unwrap_or(0),
            s.phase.clone().unwrap_or_default(),
            s.step.clone().unwrap_or_default(),
            s,
        ));
    }

    // Deduplicate consecutive identical (game, turn, phase, step) tuples.
    // Empty rows (turn 0 + empty phase + empty step) are skipped entirely so
    // they don't break the dedup chain between real states.
    let mut deduped: Vec<(i64, i64, String, String, &store::MatchStep)> = Vec::new();
    let mut prev_key: Option<(i64, i64, &str, &str)> = None;
    for (g, t, p, st, s) in &keyed {
        let is_empty = *t == 0 && p.is_empty() && st.is_empty();
        if is_empty {
            continue;
        }
        let key = (*g, *t, p.as_str(), st.as_str());
        if Some(key) != prev_key {
            deduped.push((*g, *t, p.clone(), st.clone(), *s));
            prev_key = Some(key);
        }
    }

    write!(
        out,
        "<div class=\"meta\">{} total states captured, {} unique transitions</div>\n",
        steps.len(),
        deduped.len(),
    )
    .unwrap();

    out.push_str("<table class=\"steps\"><thead><tr>");
    out.push_str("<th>Game</th><th>Turn</th><th>Phase</th><th>Step</th><th>Active</th>");
    out.push_str("</tr></thead>\n<tbody>\n");
    for (g, t, p, st, s) in &deduped {
        let phase = p.trim_start_matches("Phase_");
        let step = st.trim_start_matches("Step_");
        let (active_text, active_class) = s
            .active_player
            .map(|a| if a == 1 { ("You", "you") } else { ("Opp", "opp") })
            .unwrap_or(("", ""));
        write!(
            out,
            "<tr>\
             <td class=\"gnum\">{}</td>\
             <td class=\"tnum\">{}</td>\
             <td class=\"phase\">{}</td>\
             <td class=\"step\">{}</td>\
             <td class=\"active {}\">{}</td>\
             </tr>\n",
            g,
            t,
            esc(phase),
            esc(step),
            active_class,
            active_text,
        )
        .unwrap();
    }
    out.push_str("</tbody>\n</table>\n");
}

fn write_raw_payload(out: &mut String, payload: &Value) {
    out.push_str("<section class=\"raw\">\n");
    out.push_str("<h3>Raw payload</h3>\n");
    out.push_str("<details><summary>GameResult.gameInfo</summary>\n");
    out.push_str("<pre>");
    out.push_str(&esc(&serde_json::to_string_pretty(payload).unwrap_or_default()));
    out.push_str("</pre>\n</details>\n");
    out.push_str("</section>\n");
}

/// Options for rendering a single match detail page.
pub struct MatchDetailOptions {
    pub match_id: String,
    pub result: String,
    pub reason: String,
    pub event_name: String,
    pub deck_name: String,
    pub timestamp: DateTime<Utc>,
    pub your_deck: Option<Value>,
    pub opponent_team_id: Option<i64>,
    pub steps: Vec<store::MatchStep>,
    pub raw_payload: Value,
    pub matches_index: String,
    pub show_raw: bool,
    /// `(card_count, updated_at)` from `cards::status()`, if available.
    pub card_db_summary: Option<(u64, String)>,
}

// =============================================================================
// Inline scripts
// =============================================================================

/// Show a floating card image when hovering any `<span class="card-name">`.
/// The image source is in `data-image`; a small meta line under the image
/// shows mana cost, type, rarity, set, and artist.
const CARD_HOVER_JS: &str = r#"
(function () {
  var preview = document.getElementById('card-preview');
  var img = document.getElementById('card-preview-img');
  var meta = document.getElementById('card-preview-meta');
  if (!preview || !img || !meta) return;

  var cards = document.querySelectorAll('.card-name[data-image]');
  cards.forEach(function (el) {
    el.addEventListener('mouseenter', function (e) {
      var url = el.getAttribute('data-image');
      if (!url) return;
      img.src = url;
      img.alt = el.textContent || '';
      var mana = el.getAttribute('data-mana') || '';
      var ty   = el.getAttribute('data-type')  || '';
      var rar  = el.getAttribute('data-rarity')|| '';
      var set  = el.getAttribute('data-set')   || '';
      var artist = el.getAttribute('data-artist') || '';
      var cn    = el.getAttribute('data-cn')   || '';
      var parts = [];
      if (mana)   parts.push('<span class="cmeta-mana">' + mana + '</span>');
      if (ty)     parts.push('<span class="cmeta-type">' + ty + '</span>');
      if (rar)    parts.push('<span class="cmeta-rarity r-' + rar + '">' + rar + '</span>');
      if (set)    parts.push('<span class="cmeta-set">' + set + (cn ? ' #' + cn : '') + '</span>');
      if (artist) parts.push('<span class="cmeta-artist">' + artist + '</span>');
      meta.innerHTML = parts.join(' \u00b7 ');
      preview.classList.add('visible');
    });
    el.addEventListener('mouseleave', function () {
      preview.classList.remove('visible');
    });
  });

  // Follow the mouse so the preview is always close to the cursor.
  document.addEventListener('mousemove', function (e) {
    if (!preview.classList.contains('visible')) return;
    var pad = 18;
    var w = preview.offsetWidth;
    var h = preview.offsetHeight;
    var x = e.clientX + pad;
    var y = e.clientY + pad;
    if (x + w > window.innerWidth)  x = e.clientX - w - pad;
    if (y + h > window.innerHeight) y = e.clientY - h - pad;
    preview.style.left = x + 'px';
    preview.style.top  = y + 'px';
  });
})();
"#;

/// Toggle visibility of `<details class="deck" data-system="true">` rows.
const SYSTEM_TOGGLE_JS: &str = r#"
(function () {
  var cb = document.getElementById('toggle-system');
  if (!cb) return;
  cb.addEventListener('change', function () {
    var show = cb.checked;
    document.querySelectorAll('.deck[data-system="true"]').forEach(function (d) {
      d.classList.toggle('system-shown', show);
    });
  });
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn mk(ts: i64, result: &str, deck: &str) -> MatchRecord {
        MatchRecord {
            match_id: format!("test-{}", ts),
            timestamp: Utc.timestamp_opt(ts, 0).unwrap(),
            deck_name: deck.to_string(),
            event_name: "Ladder".to_string(),
            result: result.to_string(),
            reason: "Game".to_string(),
        }
    }

    #[test]
    fn streak_no_matches() {
        let s = compute_streak(&[]);
        assert!(s.kind.is_none());
        assert_eq!(s.count, 0);
    }

    #[test]
    fn streak_single_win() {
        let s = compute_streak(&[mk(1, "Win", "A")]);
        assert_eq!(s.kind, Some(StreakKind::Win));
        assert_eq!(s.count, 1); // 1 = "no streak yet", badge hidden
    }

    #[test]
    fn streak_two_wins_in_a_row() {
        let matches = vec![
            mk(20, "Win", "A"), // most recent
            mk(10, "Win", "A"),
            mk(5, "Loss", "A"),
        ];
        let s = compute_streak(&matches);
        assert_eq!(s.kind, Some(StreakKind::Win));
        assert_eq!(s.count, 2);
    }

    #[test]
    fn streak_interrupted() {
        // Most recent first: Win, Win, Loss, Win.
        // Streak of most-recent is 2 (Win, Win), then Loss breaks it.
        let matches = vec![
            mk(40, "Win", "A"),
            mk(30, "Win", "A"),
            mk(20, "Loss", "A"),
            mk(10, "Win", "A"),
        ];
        let s = compute_streak(&matches);
        assert_eq!(s.kind, Some(StreakKind::Win));
        assert_eq!(s.count, 2);
    }

    #[test]
    fn streak_three_losses() {
        let matches = vec![
            mk(30, "Loss", "A"),
            mk(20, "Loss", "A"),
            mk(10, "Loss", "A"),
            mk(5, "Win", "A"),
        ];
        let s = compute_streak(&matches);
        assert_eq!(s.kind, Some(StreakKind::Loss));
        assert_eq!(s.count, 3);
    }

    #[test]
    fn deck_stats_groups_and_sorts() {
        let matches = vec![
            mk(30, "Win", "DeckA"),
            mk(20, "Loss", "DeckA"),
            mk(10, "Win", "DeckB"),
            mk(5, "Win", "DeckA"),
        ];
        let stats = compute_deck_stats(&matches);
        // DeckA has 3 games, DeckB has 1
        assert_eq!(stats[0].name, "DeckA");
        assert_eq!(stats[0].games, 3);
        assert_eq!(stats[0].wins, 2);
        assert_eq!(stats[0].losses, 1);
        assert_eq!(stats[1].name, "DeckB");
        assert_eq!(stats[1].games, 1);
        assert_eq!(stats[1].wins, 1);
    }

    #[test]
    fn event_breakdown_sorts_by_volume() {
        let mut matches = vec![
            mk(40, "Win", "A"),
            mk(30, "Win", "A"),
            mk(20, "Loss", "A"),
            mk(10, "Win", "B"),
            mk(5, "Win", "B"),
        ];
        matches[0].event_name = "Ladder".to_string();
        matches[1].event_name = "Ladder".to_string();
        matches[2].event_name = "Ladder".to_string();
        matches[3].event_name = "Draft".to_string();
        matches[4].event_name = "Draft".to_string();
        let breakdown = compute_event_breakdown(&matches);
        assert_eq!(breakdown[0].name, "Ladder"); // 3 games > 2 games
        assert_eq!(breakdown[0].wins, 2);
        assert_eq!(breakdown[0].losses, 1);
        assert_eq!(breakdown[1].name, "Draft");
    }

    #[test]
    fn format_relative_recent() {
        // ts is in the past relative to `now`.
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        assert_eq!(format_relative(now, now), "just now");
        let five_min_ago = now - chrono::Duration::minutes(5);
        assert_eq!(format_relative(five_min_ago, now), "5m ago");
        let three_h_ago = now - chrono::Duration::hours(3);
        assert_eq!(format_relative(three_h_ago, now), "3h ago");
        let two_d_ago = now - chrono::Duration::days(2);
        assert_eq!(format_relative(two_d_ago, now), "2d ago");
    }

    #[test]
    fn categorize_event_groups_correctly() {
        assert_eq!(categorize_event("Ladder"), "ranked");
        assert_eq!(categorize_event("DirectGame"), "play");
        assert_eq!(categorize_event("Draft_Standard_2024"), "draft");
        assert_eq!(categorize_event("Jump_In_2024"), "event");
        // QuickDraft is a draft format, so categorized as draft (contains "Draft").
        assert_eq!(categorize_event("QuickDraft_2024"), "draft");
        assert_eq!(categorize_event(""), "other");
        assert_eq!(categorize_event("RandomThing"), "other");
    }
}
