//! Static HTML renderer for the parsed log.
//!
//! One self-contained HTML page listing all user decks (optionally including
//! netdecks) with their card lists. Each deck is rendered as a `<details>`
//! element so the page is interactive without any JavaScript. Card names come
//! from the Scryfall DB if available; otherwise they fall back to grpId.

use std::fmt::Write as _;

use manasight_parser::GameEvent;
use rusqlite::Connection;
use serde_json::Value;

use crate::cards;
use crate::{collect_decks, collect_matches, find_deck_value, DeckSummary, MatchRecord};

pub struct RenderOptions {
    /// Include netdecks (imported decks). Default: user decks only.
    pub include_netdecks: bool,
    /// Path to the source log, shown in the header.
    pub log_path: String,
    /// When the HTML was generated (display string, e.g. "2026-06-21 04:42 UTC").
    pub generated_at: String,
    /// Which sections to render.
    pub sections: Sections,
    /// Optional sibling link for navigation between decks/matches pages.
    pub sibling_link: Option<SiblingLink>,
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
pub fn render(events: &[GameEvent], card_db: Option<&Connection>, opts: &RenderOptions) -> String {
    let decks = collect_decks(events);

    // Collect and sort decks: most-recently-played first.
    let mut summaries: Vec<(String, DeckSummary)> = decks.into_iter().collect();
    summaries.retain(|(_, s)| opts.include_netdecks || !s.is_netdeck);
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
        if let Some(deck) = find_deck_value(events, id) {
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
    let matches = collect_matches(events);
    let match_count = matches.len();

    // Estimate capacity: ~400 bytes per deck section + ~150 bytes per card row.
    let mut out = String::with_capacity(2048 + summaries.len() * 400 + total_unique_cards * 150);

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

    // Summary stats (only on decks page; matches page has its own W-L summary).
    if !summaries.is_empty() {
        write!(
            &mut out,
            "<div class=\"summary\">\
             <span><strong>{}</strong> decks</span>\
             <span><strong>{}</strong> unique mainboard cards</span>\
             <span><strong>{}</strong> total mainboard cards</span>\
             <span><strong>{}</strong> matches</span>\
             </div>\n",
            summaries.len(),
            total_unique_cards,
            total_mainboard,
            match_count,
        )
        .unwrap();
    }

    // Decks.
    if matches!(opts.sections, Sections::Decks | Sections::Both) {
        for (id, summary) in &summaries {
            let deck = match find_deck_value(events, id) {
                Some(d) => d,
                None => continue,
            };
            write_deck(&mut out, id, &deck, summary, card_db);
        }
    }

    // Matches.
    if !matches.is_empty()
        && matches!(opts.sections, Sections::Matches | Sections::Both)
    {
        write_matches(&mut out, &matches);
    }

    out.push_str("</body>\n</html>\n");
    out
}

fn write_matches(out: &mut String, matches: &[MatchRecord]) {
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
        write!(
            out,
            "<tr>\
             <td class=\"date\">{}</td>\
             <td><span class=\"result {}\">{}</span></td>\
             <td class=\"deck-name\">{}</td>\
             <td class=\"event\">{}</td>\
             <td class=\"reason\">{}</td>\
             </tr>\n",
            esc(&date),
            result_class,
            esc(&m.result),
            esc(&m.deck_name),
            esc(&m.event_name),
            esc(&m.reason),
        )
        .unwrap();
    }

    out.push_str("</tbody>\n</table>\n");
}

fn write_deck(
    out: &mut String,
    id: &str,
    deck: &Value,
    summary: &DeckSummary,
    card_db: Option<&Connection>,
) {
    let last_played = summary
        .last_seen
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "-".into());
    let deck_type = if summary.is_netdeck {
        "netdeck"
    } else {
        "user"
    };

    write!(
        out,
        "<details class=\"deck\"{}>\n\
         <summary>\
         <span class=\"name\">{}</span>\
         <span class=\"badges\">\
         <span class=\"badge\">{}</span>\
         <span class=\"badge\">{} cards</span>\
         <span class=\"badge\">{} side</span>\
         <span class=\"badge\">played {}</span>\
         <span class=\"badge type-{}\">{}</span>\
         </span>\
         <span class=\"id\">{}</span>\
         </summary>\n",
        if summary.is_netdeck { "" } else { " open" },
        esc(&summary.name),
        esc(&summary.format),
        summary.main_count,
        summary.side_count,
        esc(&last_played),
        deck_type,
        deck_type,
        esc(id),
    )
    .unwrap();

    let list = deck.get("list");
    let main = list.and_then(|l| l.get("MainDeck")).and_then(Value::as_array);
    let side = list.and_then(|l| l.get("Sideboard")).and_then(Value::as_array);

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
         <th>Colors</th>\
         <th>Mana</th>\
         <th>Type</th>\
         <th>Rarity</th>\
         <th>Set</th>\
         <th>#</th>\
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
                let type_line = card.type_line.as_deref().unwrap_or("");
                let colors_html = render_colors(card.colors.as_deref());
                write!(
                    out,
                    "<tr><td class=\"qty\">{}</td>\
                     <td class=\"name\">{}</td>\
                     <td class=\"colors\">{}</td>\
                     <td class=\"mana\">{}</td>\
                     <td class=\"type\">{}</td>\
                     <td class=\"rarity {}\">{}</td>\
                     <td class=\"set\">{}</td>\
                     <td class=\"cn\">{}</td></tr>\n",
                    qty,
                    esc(&card.name),
                    colors_html,
                    esc(mana),
                    esc(type_line),
                    esc(&rarity_class),
                    esc(&rarity[..1.min(rarity.len())]),
                    esc(set),
                    esc(cn),
                )
                .unwrap();
            }
            None => {
                write!(
                    out,
                    "<tr><td class=\"qty\">{}</td>\
                     <td class=\"name\" colspan=\"7\">grpId {}</td></tr>\n",
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
