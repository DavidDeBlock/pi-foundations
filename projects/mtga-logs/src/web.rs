//! Static HTML renderer for the parsed log.
//!
//! One self-contained HTML page listing all user decks (optionally including
//! netdecks) with their card lists. Each deck is rendered as a `<details>`
//! element so the page is interactive without any JavaScript. Card names come
//! from the Scryfall DB if available; otherwise they fall back to grpId.

use std::fmt::Write as _;

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
        write_matches(&mut out, &matches);
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
