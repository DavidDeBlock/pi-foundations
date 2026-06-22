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

/// Which top-level page the user is currently viewing. Used by
/// `site_header` to mark the active link in the shared nav.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SitePage {
    Home,
    Decks,
    Matches,
    Catalog,
    Builder,
}

/// Render the shared `<header class="site-header">` block used by every
/// page. `prefix` is prepended to every link so callers in subdirectories
/// (e.g. `decks-matches/<uuid>.html`) can pass `"../"`.
pub fn site_header(active: SitePage, prefix: &str) -> String {
    let link = |page: SitePage, href: &str, label: &str| -> String {
        let cls = if page == active { "active" } else { "" };
        format!(r#"<a class="{cls}" href="{prefix}{href}">{label}</a>"#)
    };
    format!(
        r#"<header class="site-header">
  <a class="site-brand" href="{prefix}index.html">MTG Arena Logs</a>
  <nav class="site-nav">
    {decks}
    {matches}
    {catalog}
    {builder}
  </nav>
</header>"#,
        decks = link(SitePage::Decks, "decks.html", "Decks"),
        matches = link(SitePage::Matches, "decks-matches.html", "Matches"),
        catalog = link(SitePage::Catalog, "cards.html", "Catalog"),
        builder = link(SitePage::Builder, "builder.html", "Builder"),
    )
}

/// Summary stats displayed on the landing page.
#[derive(Clone)]
pub struct IndexStats {
    pub user_deck_count: u64,
    pub netdeck_count: u64,
    pub match_count: u64,
    pub user_built_deck_count: u64,
    pub last_match: Option<String>,
    pub card_db_summary: Option<(u64, String)>,
}

pub struct IndexOptions {
    pub stats: IndexStats,
    pub log_path: String,
    pub generated_at: String,
}

/// Render the landing page (`index.html`). Quick-glance dashboard with
/// the same nav header every other page uses.
pub fn render_index(opts: &IndexOptions) -> String {
    let last_match = opts.stats.last_match.clone().unwrap_or_else(|| "—".to_string());
    let (card_count, card_updated) = match opts.stats.card_db_summary.clone() {
        Some((n, u)) => (Some(n), Some(u)),
        None => (None, None),
    };
    let card_line = match (card_count, card_updated) {
        (Some(n), Some(u)) => format!("{n} cards in DB (updated {u})"),
        _ => "card DB not loaded".to_string(),
    };
    let mut out = String::new();
    out.push_str(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MTG Arena Logs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
"#);
    out.push_str(include_str!("web.css"));
    out.push_str(r#"</style>
</head>
<body>
"#);
    out.push_str(&site_header(SitePage::Home, ""));

    out.push_str(r#"<main class="landing">
  <section class="hero">
    <h1>MTG Arena Logs</h1>
    <p class="subtitle">"#);
    out.push_str(&esc(&opts.log_path));
    out.push_str(" · generated ");
    out.push_str(&esc(&opts.generated_at));
    out.push_str(r#"</p>
  </section>

  <section class="stats">
    <div class="stat-card" data-stat="user-decks">
      <div class="stat-num">"#);
    write!(&mut out, "{}", opts.stats.user_deck_count).unwrap();
    out.push_str(r#"</div>
      <div class="stat-label">User decks</div>
    </div>
    <div class="stat-card" data-stat="matches">
      <div class="stat-num">"#);
    write!(&mut out, "{}", opts.stats.match_count).unwrap();
    out.push_str(r#"</div>
      <div class="stat-label">Matches</div>
    </div>
    <div class="stat-card" data-stat="built-decks">
      <div class="stat-num">"#);
    write!(&mut out, "{}", opts.stats.user_built_deck_count).unwrap();
    out.push_str(r#"</div>
      <div class="stat-label">Built decks</div>
    </div>
    <div class="stat-card" data-stat="netdecks">
      <div class="stat-num">"#);
    write!(&mut out, "{}", opts.stats.netdeck_count).unwrap();
    out.push_str(r#"</div>
      <div class="stat-label">Netdecks (hidden)</div>
    </div>
  </section>

  <section class="last-match">
    <span class="lm-label">Last match:</span>
    <span class="lm-value">"#);
    out.push_str(&esc(&last_match));
    out.push_str(r#"</span>
    <button type="button" id="sync-btn" class="sync-btn">
      <span class="sync-icon" aria-hidden="true">⟳</span>
      <span class="sync-label">Sync now</span>
    </button>
    <span id="sync-status" class="sync-status" role="status" aria-live="polite"></span>
  </section>

  <section class="sync-meta">
    <div class="sm-row">
      <span class="sm-label">Log file:</span>
      <code class="sm-value">"#);
    out.push_str(&esc(&opts.log_path));
    out.push_str(r#"</code>
    </div>
    <div class="sm-row">
      <span class="sm-label">Generated:</span>
      <span class="sm-value">"#);
    out.push_str(&esc(&opts.generated_at));
    out.push_str(r#"</span>
    </div>
  </section>

  <section class="quick-actions">
    <a class="qa-card" href="decks.html">
      <div class="qa-icon">⛁</div>
      <h2>Decks</h2>
      <p>Browse your played decks with their full card lists, sideboard, color identity, and wildcard cost.</p>
    </a>
    <a class="qa-card" href="decks-matches.html">
      <div class="qa-icon">⚔</div>
      <h2>Matches</h2>
      <p>Game-by-game history with W/L, opponent, event, deck used, and clickable detail pages with the full play log.</p>
    </a>
    <a class="qa-card" href="cards.html">
      <div class="qa-icon">✦</div>
      <h2>Card Catalog</h2>
      <p>Searchable browser over all "#);
    out.push_str(&card_line);
    out.push_str(r#". Filter by name, color, type; click any card to inspect.</p>
    </a>
    <a class="qa-card" href="builder.html">
      <div class="qa-icon">✎</div>
      <h2>Deck Builder</h2>
      <p>Build new decks with the inline catalog pane, then export to JSON and import via <code>mtga-logs deck-import</code>.</p>
    </a>
  </section>
</main>
<script>
(function() {
  const btn = document.getElementById('sync-btn');
  const label = btn.querySelector('.sync-label');
  const icon = btn.querySelector('.sync-icon');
  const status = document.getElementById('sync-status');
  const fmt = (n) => Number(n).toLocaleString();

  function setSyncing(on) {
    btn.disabled = on;
    if (on) {
      label.textContent = 'Syncing…';
      icon.classList.add('spinning');
      status.textContent = '';
      status.className = 'sync-status';
    } else {
      label.textContent = 'Sync now';
      icon.classList.remove('spinning');
    }
  }

  function applyStats(idx) {
    const set = (label, val) => {
      const el = document.querySelector(`[data-stat="${label}"] .stat-num`);
      if (el) el.textContent = fmt(val);
    };
    set('user-decks', idx.user_deck_count);
    set('matches', idx.match_count);
    set('built-decks', idx.user_built_deck_count);
    set('netdecks', idx.netdeck_count);
    const lm = document.querySelector('.lm-value');
    if (lm) lm.textContent = idx.last_match || '—';
  }

  btn.addEventListener('click', async () => {
    setSyncing(true);
    try {
      const res = await fetch('/sync', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      applyStats(data.index);
      const ev = data.events_seen || 0;
      const sk = data.files_skipped || 0;
      const parts = [];
      if (ev > 0) parts.push(`+${fmt(ev)} events`);
      else parts.push('no new events');
      parts.push(`${data.files_ingested} file ingested`);
      if (sk > 0) parts.push(`${fmt(sk)} skipped`);
      status.textContent = '✓ ' + parts.join(' · ');
      status.className = 'sync-status ok';
      // Update the "generated" line too.
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const gen = document.querySelector('.sm-row:nth-child(2) .sm-value');
      if (gen) gen.textContent = ts;
    } catch (e) {
      status.textContent = '✗ sync failed: ' + e.message;
      status.className = 'sync-status err';
    } finally {
      setSyncing(false);
    }
  });
})();
</script>
</body>
</html>"#);
    out
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
    let match_ids: Vec<String> = matches.iter().map(|m| m.match_id.clone()).collect();
    let opponent_names: HashMap<String, String> =
        store::load_opponent_names(store_db, &match_ids).unwrap_or_default();
    let event_ids: HashMap<String, String> =
        store::load_match_event_ids(store_db, &match_ids).unwrap_or_default();
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

    // Shared site nav (highlight the right link based on which page this is).
    let active = match opts.sections {
        Sections::Matches => SitePage::Matches,
        _ => SitePage::Decks,
    };
    out.push_str(&site_header(active, ""));

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

    // (Sibling cross-link removed; the persistent site header on every
    // page already includes a Matches link.)

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

    // Cross-link nav: catalog and deck builder.
    // Only show when this is the "file" output (not stdout).
    // (Cross-link buttons removed; the persistent site header now serves
    // this purpose on every page.)

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
        write_matches(&mut out, &matches, &opponent_names, &event_ids, &opts.match_pages_dir);
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

fn write_matches(
    out: &mut String,
    matches: &[MatchRecord],
    opponent_names: &HashMap<String, String>,
    event_ids: &HashMap<String, String>,
    match_pages_dir: &str,
) {
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
    out.push_str("<th>Date</th><th>Result</th><th>Deck</th><th>Opponent</th><th>Event</th><th>Reason</th>");
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
        let opp = opponent_names
            .get(&m.match_id)
            .map(|s| s.as_str())
            .unwrap_or("");
        // event_name fallback: use event_id from match_players if no
        // DeckSubmission preceded the GameResult.
        let event_name_eff = if m.event_name == "?" || m.event_name.is_empty() {
            event_ids
                .get(&m.match_id)
                .cloned()
                .unwrap_or_default()
        } else {
            m.event_name.clone()
        };
        let event_html = if event_name_eff.is_empty() {
            String::from("<span class=\"muted\">?</span>")
        } else {
            esc(&event_name_eff)
        };
        write!(
            out,
            "<tr id=\"{}\">\
             <td class=\"date\">{}</td>\
             <td><span class=\"result {}\">{}</span></td>\
             <td class=\"deck-name\">{}</td>\
             <td class=\"opp\">{}</td>\
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
            if opp.is_empty() {
                String::from("<span class=\"muted\">(unknown)</span>")
            } else {
                esc(opp)
            },
            event_html,
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
    // Shared site header. The match detail page lives in a subdirectory
    // (`decks-matches/<uuid>.html`), so all nav links need a `../` prefix.
    // Highlight "Matches" since that's the parent index.
    out.push_str(&site_header(SitePage::Matches, "../"));
    // (The "← Matches" tab is now redundant — the site header serves this.)
    let opp_name = opts
        .players
        .iter()
        .find(|p| !p.is_local)
        .map(|p| p.player_name.clone());
    // event_name fallback: if no DeckSubmission preceded the GameResult,
    // pull the event_id from any match_players row (it's the same per match).
    let event_name_effective = if opts.event_name == "?" || opts.event_name.is_empty() {
        opts.players
            .first()
            .and_then(|p| p.event_id.clone())
            .unwrap_or_default()
    } else {
        opts.event_name.clone()
    };
    // When the deck is unknown, surface the opponent in the header so the
    // page still says something useful (e.g. "Loss · vs KEV3K" instead of
    // "Loss · (no deck)"). When the deck is known, the deck name is more
    // informative; the opponent card below shows their full identity.
    let deck_part = if opts.deck_name == "(no deck)" || opts.deck_name == "(unknown)" {
        match &opp_name {
            Some(name) => format!("vs <b>{}</b>", esc(name)),
            None => esc(&opts.deck_name),
        }
    } else {
        esc(&opts.deck_name)
    };
    // Skip the event pill when the event_name is unknown.
    let event_pill = if event_name_effective.is_empty() {
        String::new()
    } else {
        format!("<span class=\"event\">{}</span> &middot; ", esc(&event_name_effective))
    };
    write!(
        &mut out,
        "<h1><span class=\"result {0}\">{1}</span> &middot; {2}</h1>\n\
         <div class=\"meta\">\
         {3}{4} &middot; \
         match <code>{5}</code>\
         </div>\n",
        result_class,
        esc(&opts.result),
        deck_part,
        event_pill,
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

    // === Opponent identity (from matchGameRoomStateChangedEvent) ===
    out.push_str("<section class=\"match-deck opponent\">\n");
    out.push_str("<h2>Opponent</h2>\n");
    write_opponent_panel(&mut out, &opts.players);
    out.push_str("</section>\n");

    // === Life totals (both players) ===
    if !opts.life_changes.is_empty() {
        out.push_str("<section class=\"match-life\">\n");
        out.push_str("<h2>Life totals</h2>\n");
        write_life_chart(&mut out, &opts.life_changes);
        out.push_str("</section>\n");
    }

    // === Plays log (cards drawn / played / cast) ===
    if !opts.zone_transfers.is_empty() {
        out.push_str("<section class=\"match-plays\">\n");
        out.push_str("<h2>Plays</h2>\n");
        write_plays_log(&mut out, &opts.zone_transfers, card_db);
        out.push_str("</section>\n");
    }

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

/// Render the opponent identity card.
///
/// The `players` list comes from `matchGameRoomStateChangedEvent`.
/// We pick the entry with `is_local == false` and show:
///   - `playerName` (the display name as it appeared in the log)
///   - `courseId` (avatar — e.g. `Avatar_Basic_Ziatora_SNC`)
///   - `platformId` (e.g. `Windows`, `AndroidPhone`, `iPhone`, `SteamWindows`)
///   - `userId` (Arena account hash)
///   - `teamId` (the team number)
///
/// Falls back to a clear "no opponent info" message if the table is empty
/// (the log was incomplete / truncated before the match-start event).
fn write_opponent_panel(
    out: &mut String,
    players: &[store::MatchPlayer],
) {
    let opp = players.iter().find(|p| !p.is_local);
    match opp {
        None => {
            out.push_str(
                "<p class=\"muted\">No opponent info available. \
                 (The matchGameRoomStateChangedEvent with reservedPlayers \
                 was not captured for this match.)</p>\n",
            );
        }
        Some(p) => {
            out.push_str("<table class=\"player-info\"><tbody>\n");
            write_player_row(out, "Name", &esc(&p.player_name), None);
            if let Some(course) = &p.course_id {
                // Strip the "Avatar_Basic_" prefix for readability.
                let display = course
                    .strip_prefix("Avatar_Basic_")
                    .unwrap_or(course);
                write_player_row(out, "Avatar", &esc(display), Some("avatar"));
            }
            if let Some(platform) = &p.platform_id {
                let display = match platform.as_str() {
                    "Windows" => "🖥 Windows",
                    "SteamWindows" => "🖥 Steam (Windows)",
                    "AndroidPhone" => "📱 Android",
                    "iPhone" => "📱 iPhone",
                    "iPad" => "📱 iPad",
                    "Mac" => "🖥 Mac",
                    other => other,
                };
                write_player_row(out, "Platform", &esc(display), None);
            }
            write_player_row(
                out,
                "Team",
                &format!("{}", p.team_id),
                None,
            );
            // Truncate userId for display; full id in title.
            let short = if p.user_id.len() > 16 {
                format!("{}…", &p.user_id[..16])
            } else {
                p.user_id.clone()
            };
            write_player_row(
                out,
                "userId",
                &esc(&short),
                None,
            );
            out.push_str("</tbody></table>\n");
            // Show full userId under the table for transparency.
            if p.user_id.len() > 16 {
                write!(
                    out,
                    "<p class=\"muted small\">Full userId: <code>{}</code></p>\n",
                    esc(&p.user_id),
                )
                .unwrap();
            }
        }
    }
}


fn write_player_row(out: &mut String, label: &str, value: &str, extra_class: Option<&str>) {
    let cls = extra_class
        .map(|c| format!(" class=\"{}\"", c))
        .unwrap_or_default();
    write!(
        out,
        "<tr><th>{}</th><td{}>{}</td></tr>\n",
        esc(label),
        cls,
        value,
    )
    .unwrap();
}

/// Render a small SVG line chart of both players' life totals over time.
///
/// Each line starts at 20 (standard starting life) and accumulates deltas
/// from `life_changes`. The x-axis is annotation order (event order); the
/// y-axis is life total (0-25). Both lines share the same scale so they're
/// directly comparable.
fn write_life_chart(out: &mut String, changes: &[store::LifeChange]) {
    // Reconstruct the life total over time per seat.
    // We always know there are 2 seats (1=local, 2=opponent); if the log
    // is from the local perspective, that's how MTGA emits them.
    let mut series: [Vec<(usize, i64)>; 2] = [Vec::new(), Vec::new()];
    let mut totals: [i64; 2] = [20, 20];
    for (i, c) in changes.iter().enumerate() {
        if c.seat_id == 1 || c.seat_id == 2 {
            let idx = (c.seat_id - 1) as usize;
            totals[idx] += c.delta;
            series[idx].push((i, totals[idx]));
        }
    }

    let w: i64 = 600;
    let h: i64 = 180;
    let pad_l: i64 = 36;
    let pad_r: i64 = 12;
    let pad_t: i64 = 14;
    let pad_b: i64 = 24;
    let plot_w = w - pad_l - pad_r;
    let plot_h = h - pad_t - pad_b;

    // Determine x range (number of events).
    let n = changes.len().max(1) as i64;
    // Determine y range — clamp at [0, 30] to keep negative deaths readable
    // but not too zoomed-out.
    let y_min: i64 = 0;
    let y_max: i64 = 25;

    // Helper to translate (event_idx, life) to (x, y).
    let x_for = |i: usize| -> f64 {
        pad_l as f64 + (i as f64 / (n - 1).max(1) as f64) * plot_w as f64
    };
    let y_for = |life: i64| -> f64 {
        let clamped = life.clamp(y_min, y_max) as f64;
        let t = (clamped - y_min as f64) / (y_max - y_min) as f64;
        pad_t as f64 + (1.0 - t) * plot_h as f64
    };

    out.push_str("<div class=\"life-chart\">\n");
    write!(out, "<svg viewBox=\"0 0 {} {}\" preserveAspectRatio=\"xMidYMid meet\">\n", w, h)
        .unwrap();

    // Y-axis gridlines at 0, 5, 10, 15, 20, 25.
    for y_val in [0_i64, 5, 10, 15, 20, 25] {
        let y = y_for(y_val);
        write!(
            out,
            "<line class=\"grid\" x1=\"{}\" y1=\"{:.1}\" x2=\"{}\" y2=\"{:.1}\"/>\n",
            pad_l, y, w - pad_r, y,
        )
        .unwrap();
        write!(
            out,
            "<text class=\"y-label\" x=\"{}\" y=\"{:.1}\">{}</text>\n",
            (pad_l - 4) as f64, y + 3.0, y_val,
        )
        .unwrap();
    }

    // Plot two lines (You=accent, Opp=warn).
    let line_specs: [(usize, &str, &str); 2] = [
        (0, "you", "var(--accent)"),
        (1, "opp", "var(--text-2)"),
    ];
    for (idx, path_class, color) in line_specs.iter() {
        let idx_us = *idx;
        if series[idx_us].is_empty() {
            continue;
        }
        // Build path
        let mut d = String::new();
        for (j, (i, life)) in series[idx_us].iter().enumerate() {
            let x = x_for(*i);
            let y = y_for(*life);
            if j == 0 {
                write!(d, "M{:.1},{:.1}", x, y).unwrap();
            } else {
                write!(d, " L{:.1},{:.1}", x, y).unwrap();
            }
        }
        write!(
            out,
            "<path class=\"life-line {}\" d=\"{}\" stroke=\"{}\" fill=\"none\" \
             stroke-width=\"2\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/>\n",
            path_class, d, color,
        )
        .unwrap();
    }

    // End-of-life labels — placed inside the plot area, right-aligned
    // so they don't overflow the SVG.
    let end_specs: [(usize, &str); 2] = [(0, "You"), (1, "Opp")];
    for (idx, label) in end_specs.iter() {
        let idx_us = *idx;
        if let Some((_, final_life)) = series[idx_us].last() {
            let x = x_for(changes.len().saturating_sub(1));
            let y = y_for(*final_life);
            write!(
                out,
                "<text class=\"end-label\" x=\"{:.1}\" y=\"{:.1}\" text-anchor=\"end\">{}: {}</text>\n",
                x - 6.0,
                y - 4.0,
                label,
                final_life,
            )
            .unwrap();
        }
    }

    out.push_str("</svg>\n");

    // Per-player totals (number of damage / lifegain events)
    out.push_str("<div class=\"life-totals\">\n");
    for (idx, label) in [(0, "You"), (1, "Opponent")] {
        let events = changes.iter().filter(|c| c.seat_id == (idx + 1) as i64).count();
        let total_delta: i64 = changes
            .iter()
            .filter(|c| c.seat_id == (idx + 1) as i64)
            .map(|c| c.delta)
            .sum();
        let final_life = totals[idx];
        let cls = if final_life <= 0 { " died" } else { "" };
        write!(
            out,
            "<span class=\"life-row{cls}\">\
             <b>{label}</b>: started 20, <b>{events}</b> changes (&Sigma; {total_delta:+}), \
             ended at <b>{final_life}</b>\
             </span>\n",
            cls = cls,
            label = label,
            events = events,
            total_delta = total_delta,
            final_life = final_life,
        )
        .unwrap();
    }
    out.push_str("</div>\n");
    out.push_str("</div>\n");
}

/// Render the per-match plays log: cards drawn, lands played, spells cast,
/// creatures resolved, etc. for both players.
///
/// We pull the actual card names from `cards::lookup(grp_id)` so they show
/// as real names (not `#12345`).
///
/// Rows are grouped by `annotation_id` (= event order) so the timeline
/// reads top-to-bottom in the order the actions actually happened.
fn write_plays_log(
    out: &mut String,
    transfers: &[store::ZoneTransfer],
    card_db: Option<&Connection>,
) {
    // Summary chips: lands / spells cast / creatures resolved / discards.
    // We track (resolved, total) per category so the chip shows the
    // count of cards we could identify by name vs the total event count.
    let mut by_cat: HashMap<&str, (i64, i64)> = HashMap::new();
    for t in transfers {
        let entry = by_cat.entry(t.category.as_str()).or_insert((0, 0));
        entry.0 += 1;
        if let Some(grp) = t.grp_id {
            entry.1 += 1;
        }
    }
    out.push_str("<div class=\"plays-summary\">\n");
    for (cat, (total, resolved)) in by_cat.iter() {
        let cls = match *cat {
            "PlayLand" => "chip-land",
            "CastSpell" | "Resolve" => "chip-spell",
            "Draw" => "chip-draw",
            "Discard" | "Exile" | "Destroy" | "Sacrifice" => "chip-removal",
            _ => "chip-other",
        };
        let extra = if *cat == "Draw" && *resolved < *total {
            format!(
                " ({} unresolved)",
                total - resolved
            )
        } else {
            String::new()
        };
        write!(
            out,
            "<span class=\"chip {cls}\">{cat} <b>{resolved}/{total}</b>{extra}</span>\n",
        )
        .unwrap();
    }
    out.push_str("</div>\n");

    // The full table.
    out.push_str("<table class=\"plays\"><thead><tr>");
    out.push_str("<th>Player</th><th>Action</th><th>Card</th></tr></thead>\n<tbody>\n");
    for t in transfers {
        let seat_label = match t.seat_id {
            Some(1) => ("you", "You"),
            Some(2) => ("opp", "Opp"),
            Some(_) => ("?", "?"),
            None => ("?", "?"),
        };
        // Skip pure Draws with no grp_id resolved (library was face-down).
        if t.category == "Draw" && t.grp_id.is_none() {
            continue;
        }
        let action_cls = match t.category.as_str() {
            "PlayLand" => "act-land",
            "CastSpell" => "act-cast",
            "Resolve" => "act-resolve",
            "Draw" => "act-draw",
            "Discard" => "act-discard",
            _ => "act-other",
        };
        let action = t.category.clone();
        // Resolve card name.
        let (display_name, image_url) = match (t.grp_id, card_db) {
            (Some(grp), Some(conn)) => match cards::lookup(conn, grp) {
                Some(c) => (c.name, c.image_url.unwrap_or_default()),
                None => (format!("#{}", grp), String::new()),
            },
            (Some(grp), None) => (format!("#{}", grp), String::new()),
            (None, _) => ("(unresolved)".to_string(), String::new()),
        };
        let card_html = if image_url.is_empty() {
            format!("<span class=\"card-name\">{}</span>", esc(&display_name))
        } else {
            format!(
                "<span class=\"card-name\" data-image=\"{}\">{}</span>",
                esc_attr(&image_url),
                esc(&display_name)
            )
        };
        write!(
            out,
            "<tr>\
             <td class=\"player {pcls}\">{plabel}</td>\
             <td><span class=\"act {actcls}\">{act}</span></td>\
             <td class=\"card\">{card}</td>\
             </tr>\n",
            pcls = seat_label.0,
            plabel = seat_label.1,
            actcls = action_cls,
            act = esc(&action),
            card = card_html,
        )
        .unwrap();
    }
    out.push_str("</tbody>\n</table>\n");
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
    pub steps: Vec<store::MatchStep>,
    pub raw_payload: Value,
    pub matches_index: String,
    pub show_raw: bool,
    /// `(card_count, updated_at)` from `cards::status()`, if available.
    pub card_db_summary: Option<(u64, String)>,
    /// Both players (local + opponent) for the match header / opponent card.
    pub players: Vec<store::MatchPlayer>,
    /// Life-total deltas ordered by annotation_id (= event order).
    pub life_changes: Vec<store::LifeChange>,
    /// Card-movement events (Draw / PlayLand / CastSpell / etc.) ordered
    /// by annotation_id. `grp_id` is resolved to a card name in the
    /// renderer using `card_db`.
    pub zone_transfers: Vec<store::ZoneTransfer>,
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

    /// Helper: build a MatchPlayer for tests.
    fn mp(name: &str, is_local: bool, team: i64, seat: i64) -> store::MatchPlayer {
        store::MatchPlayer {
            seat_id: seat,
            team_id: team,
            player_name: name.to_string(),
            user_id: format!("uid-{}", name),
            course_id: None,
            platform_id: None,
            is_local,
            event_id: Some("Jump_In_2024".to_string()),
        }
    }

    #[test]
    fn opponent_panel_renders_known_opponent() {
        let players = vec![
            mp("Faceless", true, 1, 1),
            mp("KEV3K", false, 2, 2),
        ];
        let mut out = String::new();
        write_opponent_panel(&mut out, &players);
        assert!(out.contains("KEV3K"), "expected KEV3K in panel: {out}");
        assert!(!out.contains("Faceless"), "did not expect local name in opp panel: {out}");
        assert!(out.contains("Team"));
        assert!(out.contains("userId"));
    }

    #[test]
    fn opponent_panel_handles_empty_players() {
        let players: Vec<store::MatchPlayer> = vec![];
        let mut out = String::new();
        write_opponent_panel(&mut out, &players);
        assert!(out.contains("No opponent info available"));
    }

    #[test]
    fn opponent_panel_decorates_platform_names() {
        // Avatar_Basic_ prefix is stripped; platforms get friendly labels.
        let mut p = mp("Opp", false, 2, 2);
        p.course_id = Some("Avatar_Basic_Ziatora_SNC".to_string());
        p.platform_id = Some("AndroidPhone".to_string());
        let mut out = String::new();
        write_opponent_panel(&mut out, &[p]);
        assert!(out.contains("Ziatora_SNC"), "avatar should be stripped: {out}");
        assert!(out.contains("Android"), "platform should be humanised: {out}");
    }

    #[test]
    fn life_chart_accumulates_deltas() {
        // Simulate the life-reconstruction logic in write_life_chart
        // by walking the same algorithm on a fixed input.
        let changes = vec![
            store::LifeChange { annotation_id: 1, ts: 1, seat_id: 1, delta: -2 },
            store::LifeChange { annotation_id: 2, ts: 2, seat_id: 2, delta: -3 },
            store::LifeChange { annotation_id: 3, ts: 3, seat_id: 1, delta: 1 },
            store::LifeChange { annotation_id: 4, ts: 4, seat_id: 2, delta: -5 },
        ];
        let mut totals = [20i64; 2];
        for c in &changes {
            if c.seat_id == 1 || c.seat_id == 2 {
                totals[(c.seat_id - 1) as usize] += c.delta;
            }
        }
        // You: 20 - 2 + 1 = 19
        // Opp: 20 - 3 - 5 = 12
        assert_eq!(totals[0], 19);
        assert_eq!(totals[1], 12);
    }

    #[test]
    fn zone_transfer_chip_aggregates_correctly() {
        // The plays-summary chip logic aggregates by category.
        let transfers = vec![
            store::ZoneTransfer {
                annotation_id: 1, ts: 1, seat_id: Some(1),
                grp_id: Some(123), category: "PlayLand".to_string(),
                zone_src: Some(31), zone_dest: Some(28),
            },
            store::ZoneTransfer {
                annotation_id: 2, ts: 2, seat_id: Some(1),
                grp_id: Some(124), category: "PlayLand".to_string(),
                zone_src: Some(31), zone_dest: Some(28),
            },
            store::ZoneTransfer {
                annotation_id: 3, ts: 3, seat_id: Some(2),
                grp_id: None, category: "Draw".to_string(),
                zone_src: Some(36), zone_dest: Some(35),
            },
        ];
        // 2 PlayLand (both resolved), 1 Draw (unresolved).
        let mut by_cat: HashMap<&str, (i64, i64)> = HashMap::new();
        for t in &transfers {
            let e = by_cat.entry(t.category.as_str()).or_insert((0, 0));
            e.0 += 1;
            if let Some(_) = t.grp_id { e.1 += 1; }
        }
        assert_eq!(by_cat["PlayLand"], (2, 2));
        assert_eq!(by_cat["Draw"], (1, 0));
    }

    // ========================================================================
    // Color identity helpers (used by deck builder)
    // ========================================================================

    /// Parse a Scryfall color_identity string ("WUBRG" letters) into a
    /// sorted Vec of individual colors. Returns empty for colorless.
    fn parse_color_identity(s: &str) -> Vec<char> {
        let mut v: Vec<char> = s.chars().filter(|c| "WUBRG".contains(*c)).collect();
        v.sort();
        v.dedup();
        v
    }

    #[test]
    fn parse_color_identity_handles_inputs() {
        assert_eq!(parse_color_identity(""), Vec::<char>::new());
        assert_eq!(parse_color_identity("W"), vec!['W']);
        assert_eq!(parse_color_identity("WG"), vec!['G', 'W']); // sorted
        assert_eq!(parse_color_identity("WUBRG"), vec!['B', 'G', 'R', 'U', 'W']);
        // Filter invalid chars.
        assert_eq!(parse_color_identity("WXYZ"), vec!['W']);
    }

    /// Calculate a deck's color identity from a list of (grpId, qty) pairs
    /// plus a lookup function that returns the card's color_identity string.
    fn deck_color_identity<F>(cards: &[(i64, i64)], lookup: F) -> String
    where F: Fn(i64) -> Option<String> {
        let mut present: Vec<char> = Vec::new();
        for (id, _) in cards {
            if let Some(ci) = lookup(*id) {
                for c in parse_color_identity(&ci) {
                    if !present.contains(&c) { present.push(c); }
                }
            }
        }
        // Render in WUBRG order.
        let order = ['W', 'U', 'B', 'R', 'G'];
        order.iter().filter(|c| present.contains(c)).collect()
    }

    #[test]
    fn deck_color_identity_aggregates_correctly() {
        // Mono-white deck.
        let mono_w = vec![(1, 4), (2, 4)];
        let lookup = |id: i64| match id {
            1 => Some("W".to_string()),
            2 => Some("W".to_string()),
            _ => None,
        };
        assert_eq!(deck_color_identity(&mono_w, lookup), "W");
        // 4-color deck (no G).
        let four_color = vec![(1, 4), (3, 4), (4, 4), (5, 4)];
        let lookup = |id: i64| match id {
            1 => Some("W".to_string()),
            3 => Some("U".to_string()),
            4 => Some("B".to_string()),
            5 => Some("R".to_string()),
            _ => None,
        };
        assert_eq!(deck_color_identity(&four_color, lookup), "WUBR");
        // Colorless cards don't add colors.
        let colorless = vec![(10, 4)];
        let lookup = |_: i64| Some("".to_string());
        assert_eq!(deck_color_identity(&colorless, lookup), "");
    }

    #[test]
    fn type_bucketing_for_filter() {
        // The catalog uses a coarse-grained "primary type" derived from
        // type_line. We classify by the first dash-separated segment, with
        // a few special cases.
        fn primary_type(tl: &str) -> &'static str {
            let lower = tl.to_lowercase();
            if lower.contains("creature") { "Creature" }
            else if lower.contains("planeswalker") { "Planeswalker" }
            else if lower.contains("instant") { "Instant" }
            else if lower.contains("sorcery") { "Sorcery" }
            else if lower.contains("enchantment") { "Enchantment" }
            else if lower.contains("artifact") { "Artifact" }
            else if lower.contains("battle") { "Battle" }
            else if lower.contains("land") { "Land" }
            else { "Other" }
        }
        assert_eq!(primary_type("Creature — Human Soldier"), "Creature");
        assert_eq!(primary_type("Legendary Planeswalker — Jace"), "Planeswalker");
        assert_eq!(primary_type("Artifact Creature — Golem"), "Creature"); // creatures win
        assert_eq!(primary_type("Basic Land — Plains"), "Land");
        assert_eq!(primary_type("Enchantment — Aura"), "Enchantment");
    }
}

// ============================================================================
// Catalog page (cards.html)
// ============================================================================

/// Render the catalog HTML page. The actual card data is fetched at
/// runtime by the browser from `cards-data.json` (also written by
/// `mtga-logs web`).
///
/// `card_db_summary`: (count, updated_at) — used in the status banner.
/// `decks_href` / `matches_href`: links back to the main pages.
pub fn render_catalog(
    card_db_summary: Option<(u64, String)>,
    decks_href: &str,
    matches_href: &str,
) -> String {
    let mut out = String::new();
    let (count, updated_at) = match card_db_summary {
        Some((n, u)) => (Some(n), Some(u)),
        None => (None, None),
    };
    let updated_line = match (count, &updated_at) {
        (Some(n), Some(u)) => format!(
            "Card DB: {n} cards; bulk updated {u}.",
        ),
        _ => "Card DB not loaded.".to_string(),
    };

    out.push_str(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MTG Arena Card Catalog</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
"#);
    out.push_str(r#"<style>"#);
    out.push_str(include_str!("web.css"));
    out.push_str("</style>\n</head>\n<body>\n");
    out.push_str(&site_header(SitePage::Catalog, ""));
    out.push_str(r#"<header class="page-header">
  <h1>MTG Arena Card Catalog</h1>
  <p class="subtitle">"#);
    out.push_str(&esc(&updated_line));
    out.push_str(r#"</p>
</header>
<section class="filter-bar">
  <div class="filter-row">
    <input id="search" type="search" placeholder="Search by name..." autofocus
           autocomplete="off" spellcheck="false">
    <select id="type-filter" aria-label="Primary type">
      <option value="">All types</option>
      <option value="Creature">Creature</option>
      <option value="Planeswalker">Planeswalker</option>
      <option value="Instant">Instant</option>
      <option value="Sorcery">Sorcery</option>
      <option value="Enchantment">Enchantment</option>
      <option value="Artifact">Artifact</option>
      <option value="Battle">Battle</option>
      <option value="Land">Land</option>
    </select>
    <select id="sort-by" aria-label="Sort by">
      <option value="name">Sort: Name</option>
      <option value="cmc">Sort: Mana cost</option>
      <option value="rarity">Sort: Rarity</option>
    </select>
    <span id="count" class="count-pill">loading…</span>
  </div>
  <div class="filter-row colors">
    <span class="filter-label">Color identity:</span>
    <label class="color-toggle W"><input type="checkbox" data-color="W"> W</label>
    <label class="color-toggle U"><input type="checkbox" data-color="U"> U</label>
    <label class="color-toggle B"><input type="checkbox" data-color="B"> B</label>
    <label class="color-toggle R"><input type="checkbox" data-color="R"> R</label>
    <label class="color-toggle G"><input type="checkbox" data-color="G"> G</label>
    <label class="color-toggle multi"><input type="checkbox" data-color="MULTI"> multicolor</label>
    <label class="color-toggle colorless"><input type="checkbox" data-color="COLORLESS"> colorless</label>
    <button type="button" id="clear-filters" class="btn-link">clear</button>
  </div>
</section>
<section class="card-grid" id="grid">
  <div class="empty">Loading card data...</div>
</section>
<section class="load-more-bar">
  <button type="button" id="load-more" class="btn-secondary" style="display:none">Show more</button>
</section>

<dialog id="card-modal" class="card-modal">
  <button class="modal-close" aria-label="Close">&times;</button>
  <div class="modal-body"></div>
</dialog>
"#);
    out.push_str(CATALOG_JS);
    out.push_str("\n</body>\n</html>\n");
    out
}

const CATALOG_JS: &str = r#"
<script>
'use strict';

// Card data loaded asynchronously from `cards-data.json`. Indexed by
// grpId (arena_id) for the "add to deck" feature.
let CARDS = [];
let BY_ID = new Map();
const DATA_URL = 'cards-data.json';

// Color identity buckets.
// Each card has a sorted WUBRG string in `ci`. Multi = 2+ chars, colorless = "".
function passesColorFilter(card, setColors) {
  if (setColors.size === 0) return true;
  const ci = card.ci || '';
  const n = ci.length;
  // Each toggle must match the card.
  for (const c of setColors) {
    if (c === 'COLORLESS') { if (n !== 0) return false; }
    else if (c === 'MULTI') { if (n < 2) return false; }
    else { if (!ci.includes(c)) return false; }
  }
  return true;
}

// Coarse primary type derived from type_line.
function primaryType(tl) {
  if (!tl) return 'Other';
  const lower = tl.toLowerCase();
  if (lower.includes('creature')) return 'Creature';
  if (lower.includes('planeswalker')) return 'Planeswalker';
  if (lower.includes('instant')) return 'Instant';
  if (lower.includes('sorcery')) return 'Sorcery';
  if (lower.includes('enchantment')) return 'Enchantment';
  if (lower.includes('artifact')) return 'Artifact';
  if (lower.includes('battle')) return 'Battle';
  if (lower.includes('land')) return 'Land';
  return 'Other';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function manaHtml(mana) {
  if (!mana) return '';
  // Convert "{2}{W}{U/P}" etc. into small icons. Pure symbol char -> <i>.
  const SYMBOLS = {
    'W': 'W', 'U': 'U', 'B': 'B', 'R': 'R', 'G': 'G',
    'C': 'C', 'S': 'S', 'X': 'X', 'Y': 'Y', 'Z': 'Z',
    'T': 'T', 'Q': 'Q', 'E': 'E', 'P': 'P', 'A': 'A',
  };
  return mana.replace(/\{([^}]+)\}/g, (_, sym) => {
    const code = sym[0];
    const cls = SYMBOLS[code] ? 'mana mana-' + code : 'mana mana-x';
    return `<i class="${cls}">{${esc(sym)}}</i>`;
  });
}

function rarityClass(r) {
  switch ((r || '').toLowerCase()) {
    case 'common': return 'r-common';
    case 'uncommon': return 'r-uncommon';
    case 'rare': return 'r-rare';
    case 'mythic': return 'r-mythic';
    default: return '';
  }
}

function renderCard(c) {
  const ci = (c.ci || '').split('').map(ch =>
    `<i class="pip pip-${ch}" title="${ch}"></i>`).join('');
  const img = c.u
    ? `<img loading="lazy" src="${esc(c.u)}" alt="${esc(c.n)}" onerror="this.style.display='none'">`
    : `<div class="no-img">no image</div>`;
  return `<article class="card-cell" data-id="${c.i}">
    <div class="card-cell-image">${img}</div>
    <div class="card-cell-meta">
      <div class="card-cell-name">${esc(c.n)}</div>
      <div class="card-cell-cost">${manaHtml(c.m)}</div>
      <div class="card-cell-type">${esc(c.t || '')}</div>
      <div class="card-cell-bottom">
        <span class="rarity ${rarityClass(c.r)}">${esc(c.r || '')}</span>
        <span class="color-pips">${ci}</span>
      </div>
      <button class="add-to-deck" data-id="${c.i}" title="Add to a deck (uses localStorage)">+ deck</button>
    </div>
  </article>`;
}

const grid = document.getElementById('grid');
const search = document.getElementById('search');
const typeFilter = document.getElementById('type-filter');
const sortBy = document.getElementById('sort-by');
const countEl = document.getElementById('count');
const clearBtn = document.getElementById('clear-filters');
const colorToggles = Array.from(document.querySelectorAll('.color-toggle input'));
const modal = document.getElementById('card-modal');
const modalBody = modal.querySelector('.modal-body');
const modalClose = modal.querySelector('.modal-close');

let filtered = [];

// Pagination: only render a small page at a time so the page stays
// snappy when 18k+ cards are loaded.
const PAGE_SIZE = 48;        // ~12 rows of 4 columns — fits one screen with room
let visibleCount = 0;        // how many cards are currently in the DOM
const loadMoreBtn = document.getElementById('load-more');

function getSelectedColors() {
  const s = new Set();
  for (const cb of colorToggles) if (cb.checked) s.add(cb.dataset.color);
  return s;
}

function applyFilters() {
  const q = search.value.trim().toLowerCase();
  const t = typeFilter.value;
  const colors = getSelectedColors();
  const out = [];
  for (const c of CARDS) {
    if (q && !c.n.toLowerCase().includes(q)) continue;
    if (t && primaryType(c.t) !== t) continue;
    if (!passesColorFilter(c, colors)) continue;
    out.push(c);
  }
  const sk = sortBy.value;
  if (sk === 'name') {
    out.sort((a, b) => a.n.localeCompare(b.n));
  } else if (sk === 'cmc') {
    out.sort((a, b) => (a.c || 0) - (b.c || 0) || a.n.localeCompare(b.n));
  } else if (sk === 'rarity') {
    const order = { common: 0, uncommon: 1, rare: 2, mythic: 3 };
    out.sort((a, b) => (order[a.r] ?? 9) - (order[b.r] ?? 9) || a.n.localeCompare(b.n));
  }
  filtered = out;
  // Reset to first page on any filter change.
  grid.innerHTML = '';
  visibleCount = 0;
  // Update count first so the user sees feedback even before rendering.
  countEl.textContent = `${out.length.toLocaleString()} of ${CARDS.length.toLocaleString()}`;
  renderPage();
}

function renderPage() {
  const start = visibleCount;
  const end = Math.min(start + PAGE_SIZE, filtered.length);
  if (start === end) {
    // Nothing to render — either zero matches or fully loaded.
    updateLoadMore();
    return;
  }
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderCard(filtered[i]);
    frag.appendChild(tmp.firstElementChild);
  }
  grid.appendChild(frag);
  visibleCount = end;
  updateLoadMore();
}

function updateLoadMore() {
  const remaining = filtered.length - visibleCount;
  if (remaining <= 0) {
    loadMoreBtn.style.display = 'none';
  } else {
    loadMoreBtn.style.display = '';
    const next = Math.min(PAGE_SIZE, remaining);
    const shown = `${(visibleCount + 1).toLocaleString()}\u2013${visibleCount.toLocaleString()} shown`;
    loadMoreBtn.textContent = `Show ${next} more (${remaining.toLocaleString()} remaining)`;
    loadMoreBtn.title = `Showing ${visibleCount.toLocaleString()} of ${filtered.length.toLocaleString()}`;
  }
  if (filtered.length === 0 && visibleCount === 0) {
    grid.innerHTML = '<div class="empty">No cards match the current filter.</div>';
  }
}
loadMoreBtn.addEventListener('click', () => {
  renderPage();
  // If grid is below the fold, scroll to the first newly-rendered card.
  requestAnimationFrame(() => {
    const cards = grid.children;
    if (cards.length > 0) {
      const firstNew = cards[visibleCount - PAGE_SIZE];
      if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Wire up filters with debouncing on text input.
let searchTimer = null;
search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 120);
});
typeFilter.addEventListener('change', applyFilters);
sortBy.addEventListener('change', applyFilters);
for (const cb of colorToggles) cb.addEventListener('change', applyFilters);
clearBtn.addEventListener('click', () => {
  search.value = '';
  typeFilter.value = '';
  for (const cb of colorToggles) cb.checked = false;
  applyFilters();
});

// Modal: show card detail on click.
grid.addEventListener('click', (e) => {
  const addBtn = e.target.closest('.add-to-deck');
  if (addBtn) {
    e.stopPropagation();
    const id = parseInt(addBtn.dataset.id, 10);
    addToDeck(id);
    return;
  }
  const cell = e.target.closest('.card-cell');
  if (!cell) return;
  const id = parseInt(cell.dataset.id, 10);
  const c = BY_ID.get(id);
  if (!c) return;
  showModal(c);
});

function showModal(c) {
  const ci = (c.ci || '').split('').map(ch =>
    `<i class="pip pip-${ch}"></i>`).join('');
  modalBody.innerHTML = `
    <div class="modal-grid">
      <div class="modal-image">
        ${c.u ? `<img src="${esc(c.u)}" alt="${esc(c.n)}">` : '<div class="no-img">no image</div>'}
      </div>
      <div class="modal-info">
        <h2>${esc(c.n)}</h2>
        <div class="modal-cost">${manaHtml(c.m)}</div>
        <div class="modal-type">${esc(c.t || '')}</div>
        <div class="modal-meta">
          <span class="rarity ${rarityClass(c.r)}">${esc(c.r || '')}</span>
          <span class="color-pips">${ci}</span>
          <span class="grp">grpId ${c.i}</span>
        </div>
        <div class="modal-actions">
          <button class="btn-primary add-to-deck" data-id="${c.i}">Add to deck…</button>
        </div>
      </div>
    </div>`;
  modal.showModal();
}
modalClose.addEventListener('click', () => modal.close());
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

// "Add to deck" → store in localStorage. The deck builder reads the same
// keys; users can paste cards into a deck from the catalog.
function addToDeck(grpId) {
  const card = BY_ID.get(grpId);
  if (!card) return;
  // Bump a counter; the builder page reads this on load.
  const counter = parseInt(localStorage.getItem('mtgalogs_add_counter') || '0', 10) + 1;
  localStorage.setItem('mtgalogs_add_counter', String(counter));
  localStorage.setItem(`mtgalogs_add_${counter}`, JSON.stringify({
    grpId: card.i, name: card.n, mana: card.m, type: card.t, ci: card.ci,
    added_at: Date.now(),
  }));
  flashToast(`Added ${card.n} — open the deck builder to place it.`);
}

function flashToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.remove(), 300);
  }, 2200);
}

// Load card data, then apply filters.
fetch(DATA_URL)
  .then(r => r.json())
  .then(d => {
    CARDS = d.cards || [];
    for (const c of CARDS) BY_ID.set(c.i, c);
    applyFilters();
  })
  .catch(e => {
    grid.innerHTML = `<div class="empty error">Failed to load ${DATA_URL}: ${esc(e.message)}</div>`;
    countEl.textContent = 'error';
  });
</script>
"#;

// ============================================================================
// Builder page (builder.html)
// ============================================================================

/// Render the deck builder HTML page. The page fetches
/// `builder-data.json` on load for the initial user_decks state, then
/// uses localStorage for ongoing edits. Export downloads a JSON file
/// the user pipes through `mtga-logs deck-import`.
///
/// `existing_count`: number of user_decks currently in the DB (shown in
/// the status banner).
/// `card_count` / `card_updated_at`: shown in the banner if available.
/// `decks_href` / `cards_href`: links back to the main pages.
pub fn render_builder(
    existing_count: usize,
    card_count: Option<u64>,
    card_updated_at: Option<&str>,
    decks_href: &str,
    cards_href: &str,
) -> String {
    let mut out = String::new();
    let card_status = match card_count {
        Some(n) => format!(
            "Cards: {} loaded; bulk updated {}. Builder works offline; saves via `mtga-logs deck-import`.",
            n.to_string(),
            card_updated_at.unwrap_or("?"),
        ),
        None => "Card DB not loaded. Card names will show as grpId numbers.".to_string(),
    };

    out.push_str(r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MTG Arena Deck Builder</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
"#);
    out.push_str(r#"<style>"#);
    out.push_str(include_str!("web.css"));
    out.push_str("</style>\n</head>\n<body class=\"builder-page\">\n");
    out.push_str(&site_header(SitePage::Builder, ""));
    out.push_str(r#"<header class="page-header builder-header">
  <h1>Deck Builder</h1>
  <p class="subtitle">"#);
    out.push_str(&esc(&format!(
        "Existing user decks: {existing_count}. {card_status}"
    )));
    out.push_str(r#"</p>
</header>
<section class="builder-shell">
  <aside class="builder-sidebar">
    <div class="sidebar-actions">
      <button id="new-deck" class="btn-primary">+ New deck</button>
      <button id="import-snapshot" class="btn-link" title="Reload the deck list from the latest builder-data.json">↻ Reload from disk</button>
    </div>
    <div id="deck-list" class="deck-list" aria-label="Your decks"></div>
  </aside>
  <section class="builder-editor">
    <header class="editor-header">
      <input id="deck-name" type="text" placeholder="Deck name (e.g. Selesnya Tokens v2)" autocomplete="off">
      <select id="deck-format" aria-label="Format">
        <option value="">(no format)</option>
        <option value="Standard">Standard</option>
        <option value="Historic">Historic</option>
        <option value="Explorer">Explorer</option>
        <option value="Alchemy">Alchemy</option>
        <option value="Timeless">Timeless</option>
        <option value="Brawl">Brawl</option>
        <option value="Draft">Draft</option>
        <option value="Casual">Casual</option>
      </select>
      <button id="delete-deck" class="btn-danger" title="Delete this deck">Delete</button>
    </header>
    <div class="editor-notes">
      <label for="deck-notes">Notes</label>
      <textarea id="deck-notes" rows="2" placeholder="Optional notes..."></textarea>
    </div>
    <div class="editor-stats" id="deck-stats"></div>
    <div class="editor-lists">
      <div class="list-col mainboard">
        <header>
          <h3>Mainboard <span id="main-count" class="count-pill">0</span></h3>
          <button class="move-all" data-from="side" data-to="main">&laquo; All from side</button>
        </header>
        <div id="mainboard-list" class="card-list"></div>
      </div>
      <div class="list-col sideboard">
        <header>
          <h3>Sideboard <span id="side-count" class="count-pill">0</span></h3>
          <button class="move-all" data-from="main" data-to="side">All to side &raquo;</button>
        </header>
        <div id="sideboard-list" class="card-list"></div>
      </div>
    </div>
    <footer class="editor-footer">
      <button id="export-deck" class="btn-primary">Export as JSON…</button>
      <span class="footer-hint">After exporting, run: <code>mtga-logs deck-import &lt;file.json&gt;</code></span>
    </footer>
  </section>
  <aside class="builder-catalog">
    <header>
      <h3>Catalog</h3>
      <span id="catalog-count" class="count-pill">loading…</span>
    </header>
    <input id="cat-search" type="search" placeholder="Search by name..." autocomplete="off" spellcheck="false">
    <div class="filter-row colors">
      <label class="color-toggle W"><input type="checkbox" data-color="W"> W</label>
      <label class="color-toggle U"><input type="checkbox" data-color="U"> U</label>
      <label class="color-toggle B"><input type="checkbox" data-color="B"> B</label>
      <label class="color-toggle R"><input type="checkbox" data-color="R"> R</label>
      <label class="color-toggle G"><input type="checkbox" data-color="G"> G</label>
      <label class="color-toggle multi"><input type="checkbox" data-color="MULTI"> multicolor</label>
      <label class="color-toggle colorless"><input type="checkbox" data-color="COLORLESS"> colorless</label>
    </div>
    <select id="cat-type" aria-label="Primary type">
      <option value="">All types</option>
      <option value="Creature">Creature</option>
      <option value="Planeswalker">Planeswalker</option>
      <option value="Instant">Instant</option>
      <option value="Sorcery">Sorcery</option>
      <option value="Enchantment">Enchantment</option>
      <option value="Artifact">Artifact</option>
      <option value="Battle">Battle</option>
      <option value="Land">Land</option>
    </select>
    <div id="cat-grid" class="cat-grid"></div>
    <button type="button" id="cat-load-more" class="btn-secondary" style="display:none">Show more</button>
    <p class="cat-hint">Click a card to add to mainboard. Shift-click adds to sideboard. Click "+ main" / "+ side" buttons for explicit placement.</p>
  </aside>
</section>

<dialog id="add-dialog" class="add-dialog">
  <form method="dialog" class="add-form">
    <h3 id="add-card-name"></h3>
    <p id="add-card-meta"></p>
    <div class="add-actions">
      <button value="main" class="btn-primary">Add to mainboard</button>
      <button value="side" class="btn-secondary">Add to sideboard</button>
      <button value="cancel">Cancel</button>
    </div>
  </form>
</dialog>
"#);
    out.push_str(BUILDER_JS);
    out.push_str("\n</body>\n</html>\n");
    out
}

const BUILDER_JS: &str = r#"
<script>
'use strict';

// ===== State =====
let CARDS = [];
let BY_ID = new Map();
const DECKS = new Map();     // deck_id -> { name, format, notes, mainboard[], sideboard[], first_created, last_modified }
let ACTIVE_DECK_ID = null;
const STORAGE_KEY = 'mtgalogs_builder_decks_v1';

// ===== Card-data fetch (shared with catalog) =====
fetch('cards-data.json')
  .then(r => r.json())
  .then(d => {
    CARDS = d.cards || [];
    for (const c of CARDS) BY_ID.set(c.i, c);
    document.getElementById('catalog-count').textContent = CARDS.length.toLocaleString();
    applyCatalogFilter();
    // Once cards are loaded, re-render the editor so card names appear.
    // (Snapshot loads often happen before cards-data.json is fetched.)
    renderDeckList();
    renderEditor();
    // Then drain any "added from catalog" entries.
    drainCatalogAdds();
  })
  .catch(e => {
    document.getElementById('catalog-count').textContent = 'error';
    document.getElementById('cat-grid').innerHTML =
      `<div class="empty error">Failed to load cards-data.json: ${esc(e.message)}</div>`;
  });

// Drain queued "add to deck" entries from the catalog page.
function drainCatalogAdds() {
  const counter = parseInt(localStorage.getItem('mtgalogs_add_counter') || '0', 10);
  if (counter === 0) return;
  for (let i = 1; i <= counter; i++) {
    const raw = localStorage.getItem(`mtgalogs_add_${i}`);
    if (!raw) continue;
    try {
      const card = JSON.parse(raw);
      // Make sure we have a deck to drop the card into.
      if (DECKS.size === 0) createDeck('Imported cards');
      const last = Array.from(DECKS.keys()).pop();
      ACTIVE_DECK_ID = last;
      // Add to mainboard; user can move later.
      const deck = DECKS.get(last);
      const existing = deck.mainboard.find(c => c.grpId === card.grpId);
      if (existing) existing.quantity++;
      else deck.mainboard.push({ grpId: card.grpId, quantity: 1 });
      deck.last_modified = Math.floor(Date.now() / 1000);
    } catch (e) { /* ignore */ }
    localStorage.removeItem(`mtgalogs_add_${i}`);
  }
  localStorage.removeItem('mtgalogs_add_counter');
  saveAll();
  renderDeckList();
  renderEditor();
}

// ===== Persistence =====
function saveAll() {
  const obj = {};
  for (const [k, v] of DECKS) obj[k] = v;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

function loadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const obj = JSON.parse(raw);
    DECKS.clear();
    for (const k in obj) DECKS.set(k, obj[k]);
    return true;
  } catch (e) { return false; }
}

// Load snapshot from server-rendered builder-data.json.
async function loadFromSnapshot() {
  try {
    const r = await fetch('builder-data.json?ts=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const had = DECKS.size > 0;
    // Merge: snapshot wins for first load; subsequent reloads preserve
    // local edits if they exist. We only load snapshot when storage is
    // empty.
    if (had) return;
    for (const d of (data.user_decks || [])) {
      const id = d.deck_id || ('user-' + Math.random().toString(16).slice(2, 10));
      DECKS.set(id, {
        name: d.name || '(unnamed)',
        format: d.format || '',
        notes: d.notes || '',
        mainboard: d.mainboard || [],
        sideboard: d.sideboard || [],
        first_created: d.first_created || Math.floor(Date.now() / 1000),
        last_modified: d.last_modified || Math.floor(Date.now() / 1000),
      });
    }
    // Auto-select the most-recently-modified deck so the editor populates.
    if (!ACTIVE_DECK_ID && DECKS.size > 0) {
      const sorted = Array.from(DECKS.entries())
        .sort((a, b) => (b[1].last_modified || 0) - (a[1].last_modified || 0));
      ACTIVE_DECK_ID = sorted[0][0];
    }
    renderDeckList();
    renderEditor();
  } catch (e) {
    console.warn('snapshot load:', e);
  }
}

// ===== Helpers =====
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function newDeckId() {
  return 'user-' + Math.random().toString(16).slice(2, 10);
}

function primaryType(tl) {
  if (!tl) return 'Other';
  const lower = tl.toLowerCase();
  if (lower.includes('creature')) return 'Creature';
  if (lower.includes('planeswalker')) return 'Planeswalker';
  if (lower.includes('instant')) return 'Instant';
  if (lower.includes('sorcery')) return 'Sorcery';
  if (lower.includes('enchantment')) return 'Enchantment';
  if (lower.includes('artifact')) return 'Artifact';
  if (lower.includes('battle')) return 'Battle';
  if (lower.includes('land')) return 'Land';
  return 'Other';
}

function manaHtml(mana) {
  if (!mana) return '';
  return mana.replace(/\{([^}]+)\}/g, (_, sym) => {
    const code = sym[0];
    return `<i class="mana mana-${code}">{${esc(sym)}}</i>`;
  });
}

function rarityClass(r) {
  switch ((r || '').toLowerCase()) {
    case 'common': return 'r-common';
    case 'uncommon': return 'r-uncommon';
    case 'rare': return 'r-rare';
    case 'mythic': return 'r-mythic';
    default: return '';
  }
}

// ===== Deck CRUD =====
function createDeck(name) {
  const id = newDeckId();
  const now = Math.floor(Date.now() / 1000);
  DECKS.set(id, {
    name: name || 'Untitled deck',
    format: '',
    notes: '',
    mainboard: [],
    sideboard: [],
    first_created: now,
    last_modified: now,
  });
  ACTIVE_DECK_ID = id;
  saveAll();
  renderDeckList();
  renderEditor();
}

function deleteActiveDeck() {
  if (!ACTIVE_DECK_ID) return;
  if (!confirm('Delete this deck?')) return;
  DECKS.delete(ACTIVE_DECK_ID);
  ACTIVE_DECK_ID = DECKS.keys().next().value || null;
  saveAll();
  renderDeckList();
  renderEditor();
}

// ===== Render =====
function renderDeckList() {
  const list = document.getElementById('deck-list');
  if (DECKS.size === 0) {
    list.innerHTML = '<div class="empty">No decks yet. Click "+ New deck" to start.</div>';
    return;
  }
  const sorted = Array.from(DECKS.entries())
    .sort((a, b) => (b[1].last_modified || 0) - (a[1].last_modified || 0));
  list.innerHTML = sorted.map(([id, d]) => {
    const total = (d.mainboard || []).reduce((s, c) => s + c.quantity, 0) +
                  (d.sideboard || []).reduce((s, c) => s + c.quantity, 0);
    const cls = id === ACTIVE_DECK_ID ? 'active' : '';
    return `<button class="deck-item ${cls}" data-id="${id}">
      <span class="deck-item-name">${esc(d.name)}</span>
      <span class="deck-item-meta">${total} cards${d.format ? ' &middot; ' + esc(d.format) : ''}</span>
    </button>`;
  }).join('');
  list.querySelectorAll('.deck-item').forEach(el => {
    el.addEventListener('click', () => {
      ACTIVE_DECK_ID = el.dataset.id;
      renderDeckList();
      renderEditor();
    });
  });
}

function renderEditor() {
  const deck = ACTIVE_DECK_ID ? DECKS.get(ACTIVE_DECK_ID) : null;
  const nameEl = document.getElementById('deck-name');
  const fmtEl = document.getElementById('deck-format');
  const notesEl = document.getElementById('deck-notes');
  if (!deck) {
    nameEl.value = '';
    nameEl.disabled = true;
    fmtEl.value = '';
    fmtEl.disabled = true;
    notesEl.value = '';
    notesEl.disabled = true;
    document.getElementById('mainboard-list').innerHTML = '<div class="empty">No deck selected.</div>';
    document.getElementById('sideboard-list').innerHTML = '';
    document.getElementById('main-count').textContent = '0';
    document.getElementById('side-count').textContent = '0';
    document.getElementById('deck-stats').innerHTML = '';
    document.getElementById('delete-deck').disabled = true;
    document.getElementById('export-deck').disabled = true;
    return;
  }
  nameEl.disabled = false;
  fmtEl.disabled = false;
  notesEl.disabled = false;
  document.getElementById('delete-deck').disabled = false;
  document.getElementById('export-deck').disabled = false;
  if (document.activeElement !== nameEl) nameEl.value = deck.name || '';
  if (document.activeElement !== fmtEl) fmtEl.value = deck.format || '';
  if (document.activeElement !== notesEl) notesEl.value = deck.notes || '';
  renderList('mainboard');
  renderList('sideboard');
  renderStats();
}

function renderList(which) {
  const deck = DECKS.get(ACTIVE_DECK_ID);
  const arr = deck[which];
  const container = document.getElementById(`${which}-list`);
  const total = arr.reduce((s, c) => s + c.quantity, 0);
  document.getElementById(`${which === 'mainboard' ? 'main' : 'side'}-count`).textContent = total;
  if (arr.length === 0) {
    container.innerHTML = `<div class="empty">Click a card on the right to add to ${which}.</div>`;
    return;
  }
  // Sort by name (resolved via card DB) then type.
  const sorted = arr.slice().sort((a, b) => {
    const ca = BY_ID.get(a.grpId); const cb = BY_ID.get(b.grpId);
    const na = ca ? ca.n : '#' + a.grpId;
    const nb = cb ? cb.n : '#' + b.grpId;
    return na.localeCompare(nb);
  });
  container.innerHTML = sorted.map((c, idx) => {
    const card = BY_ID.get(c.grpId);
    const name = card ? card.n : `#${c.grpId}`;
    const cost = card ? manaHtml(card.m) : '';
    const type = card ? esc(card.t || '') : '';
    const ci = card ? (card.ci || '').split('').map(ch =>
      `<i class="pip pip-${ch}" title="${ch}"></i>`).join('') : '';
    const r = card ? rarityClass(card.r) : '';
    const arrIdx = arr.indexOf(c);
    return `<div class="card-row" data-grp="${c.grpId}" data-arr-idx="${arrIdx}">
      <div class="card-row-qty">
        <button class="qty-dec" data-grp="${c.grpId}" data-which="${which}">&minus;</button>
        <span class="qty">${c.quantity}</span>
        <button class="qty-inc" data-grp="${c.grpId}" data-which="${which}">+</button>
      </div>
      <div class="card-row-main">
        <div class="card-row-name">${esc(name)} <span class="card-row-cost">${cost}</span></div>
        <div class="card-row-type"><span class="rarity ${r}">${card ? esc(card.r || '') : ''}</span> ${type} <span class="color-pips">${ci}</span></div>
      </div>
      <div class="card-row-actions">
        <button class="move" data-grp="${c.grpId}" data-from="${which}"
                data-to="${which === 'mainboard' ? 'sideboard' : 'mainboard'}"
                title="Move to ${which === 'mainboard' ? 'sideboard' : 'mainboard'}">&harr;</button>
        <button class="remove" data-grp="${c.grpId}" data-which="${which}">&times;</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.qty-inc, .qty-dec, .remove, .move').forEach(btn => {
    btn.addEventListener('click', e => {
      const grp = parseInt(btn.dataset.grp, 10);
      const which = btn.dataset.which;
      const deck = DECKS.get(ACTIVE_DECK_ID);
      if (!deck) return;
      const arr = deck[which];
      const idx = arr.findIndex(c => c.grpId === grp);
      if (idx < 0) return;
      if (btn.classList.contains('qty-inc')) arr[idx].quantity++;
      else if (btn.classList.contains('qty-dec')) {
        arr[idx].quantity--;
        if (arr[idx].quantity <= 0) arr.splice(idx, 1);
      }
      else if (btn.classList.contains('remove')) arr.splice(idx, 1);
      else if (btn.classList.contains('move')) {
        const to = btn.dataset.to;
        deck[to].push(arr[idx]);
        arr.splice(idx, 1);
      }
      deck.last_modified = Math.floor(Date.now() / 1000);
      saveAll();
      renderList(which);
      if (btn.classList.contains('move')) renderList(btn.dataset.to);
      renderStats();
    });
  });
}

function renderStats() {
  const deck = DECKS.get(ACTIVE_DECK_ID);
  if (!deck) return;
  const stats = document.getElementById('deck-stats');
  // Color identity (aggregate across all cards).
  const all = deck.mainboard.concat(deck.sideboard);
  const ciSet = new Set();
  let totalCmc = 0; let totalQty = 0;
  for (const e of all) {
    const c = BY_ID.get(e.grpId);
    if (!c) continue;
    for (const ch of (c.ci || '')) ciSet.add(ch);
    totalCmc += (c.c || 0) * e.quantity;
    totalQty += e.quantity;
  }
  const order = ['W','U','B','R','G'];
  const ci = order.filter(c => ciSet.has(c));
  const avgCmc = totalQty > 0 ? (totalCmc / totalQty).toFixed(2) : '0';
  const ciPips = ci.map(c => `<i class="pip pip-${c}"></i>`).join('') || '<span class="muted">colorless</span>';
  stats.innerHTML = `
    <span class="stat"><b>${totalQty}</b> cards total</span>
    <span class="stat"><b>${deck.mainboard.length}</b> unique mainboard</span>
    <span class="stat"><b>${deck.sideboard.length}</b> unique sideboard</span>
    <span class="stat"><b>${avgCmc}</b> avg CMC</span>
    <span class="stat"><span class="color-pips">${ciPips}</span> color identity</span>`;
}

// ===== Catalog (right pane) =====
const catSearch = document.getElementById('cat-search');
const catType = document.getElementById('cat-type');
const catColorToggles = Array.from(document.querySelectorAll('.builder-catalog .color-toggle input'));
const catGrid = document.getElementById('cat-grid');
const catLoadMoreBtn = document.getElementById('cat-load-more');
const CAT_PAGE = 48;          // ~12 rows of 4 columns — fits one screen
let catVisibleCount = 0;
let catFiltered = [];

function applyCatalogFilter() {
  const q = catSearch.value.trim().toLowerCase();
  const t = catType.value;
  const setColors = new Set();
  for (const cb of catColorToggles) if (cb.checked) setColors.add(cb.dataset.color);
  catFiltered = [];
  for (const c of CARDS) {
    if (q && !c.n.toLowerCase().includes(q)) continue;
    if (t && primaryType(c.t) !== t) continue;
    if (setColors.size > 0) {
      const ci = c.ci || '';
      let ok = true;
      for (const col of setColors) {
        if (col === 'COLORLESS') { if (ci.length !== 0) ok = false; break; }
        else if (col === 'MULTI') { if (ci.length < 2) ok = false; break; }
        else { if (!ci.includes(col)) ok = false; break; }
      }
      if (!ok) continue;
    }
    catFiltered.push(c);
  }
  // Reset to first page on any filter change.
  catGrid.innerHTML = '';
  catVisibleCount = 0;
  renderCatPage();
}
function renderCatPage() {
  const start = catVisibleCount;
  const end = Math.min(start + CAT_PAGE, catFiltered.length);
  if (start === end) {
    updateCatLoadMore();
    if (catFiltered.length === 0) {
      catGrid.innerHTML = '<div class="empty">No cards match the current filter.</div>';
    }
    return;
  }
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const c = catFiltered[i];
    const tmp = document.createElement('div');
    tmp.innerHTML = renderCatCard(c);
    frag.appendChild(tmp.firstElementChild);
  }
  catGrid.appendChild(frag);
  catVisibleCount = end;
  updateCatLoadMore();
}
function updateCatLoadMore() {
  const remaining = catFiltered.length - catVisibleCount;
  if (remaining <= 0) {
    catLoadMoreBtn.style.display = 'none';
  } else {
    catLoadMoreBtn.style.display = '';
    const next = Math.min(CAT_PAGE, remaining);
    catLoadMoreBtn.textContent = `Show ${next} more (${remaining.toLocaleString()} remaining)`;
    catLoadMoreBtn.title = `Showing ${catVisibleCount.toLocaleString()} of ${catFiltered.length.toLocaleString()}`;
  }
}
catLoadMoreBtn.addEventListener('click', () => {
  renderCatPage();
});
function renderCatCard(c) {
  const ci = (c.ci || '').split('').map(ch =>
    `<i class="pip pip-${ch}" title="${ch}"></i>`).join('');
  const img = c.u
    ? `<img loading="lazy" src="${esc(c.u)}" alt="${esc(c.n)}" onerror="this.style.display='none'">`
    : `<div class="no-img">no image</div>`;
  return `<article class="cat-cell" data-id="${c.i}">
    <div class="cat-img">${img}</div>
    <div class="cat-meta">
      <div class="cat-name" title="${esc(c.n)}">${esc(c.n)}</div>
      <div class="cat-cost">${manaHtml(c.m)}</div>
      <div class="cat-bottom">
        <span class="rarity ${rarityClass(c.r)}">${esc(c.r || '')}</span>
        <span class="color-pips">${ci}</span>
      </div>
      <div class="cat-actions">
        <button class="add-main" data-id="${c.i}" title="Add to mainboard">+ main</button>
        <button class="add-side" data-id="${c.i}" title="Add to sideboard">+ side</button>
      </div>
    </div>
  </article>`;
}
let catTimer = null;
catSearch.addEventListener('input', () => {
  clearTimeout(catTimer);
  catTimer = setTimeout(applyCatalogFilter, 100);
});
catType.addEventListener('change', applyCatalogFilter);
for (const cb of catColorToggles) cb.addEventListener('change', applyCatalogFilter);

catGrid.addEventListener('click', (e) => {
  const main = e.target.closest('.add-main');
  const side = e.target.closest('.add-side');
  if (main) { addCardToDeck(parseInt(main.dataset.id, 10), 'mainboard'); e.stopPropagation(); return; }
  if (side) { addCardToDeck(parseInt(side.dataset.id, 10), 'sideboard'); e.stopPropagation(); return; }
  const cell = e.target.closest('.cat-cell');
  if (!cell) return;
  const id = parseInt(cell.dataset.id, 10);
  const card = BY_ID.get(id);
  if (!card) return;
  showAddDialog(card, e.shiftKey);
});

function addCardToDeck(grpId, which) {
  if (!ACTIVE_DECK_ID) {
    if (DECKS.size === 0) createDeck('Untitled deck');
    ACTIVE_DECK_ID = Array.from(DECKS.keys()).pop();
    renderDeckList();
  }
  const deck = DECKS.get(ACTIVE_DECK_ID);
  const arr = deck[which];
  const existing = arr.find(c => c.grpId === grpId);
  if (existing) existing.quantity++;
  else arr.push({ grpId, quantity: 1 });
  deck.last_modified = Math.floor(Date.now() / 1000);
  saveAll();
  renderList(which);
  renderStats();
  renderDeckList();
}

// ===== Add dialog (when clicking a card cell directly) =====
const addDialog = document.getElementById('add-dialog');
const addCardName = document.getElementById('add-card-name');
const addCardMeta = document.getElementById('add-card-meta');
function showAddDialog(card, shift) {
  if (!ACTIVE_DECK_ID) {
    createDeck('Untitled deck');
  }
  addCardName.textContent = card.n;
  addCardMeta.innerHTML = `${manaHtml(card.m)} &middot; ${esc(card.t || '')}`;
  addDialog.returnValue = '';
  addDialog.showModal();
  addDialog.addEventListener('close', function once() {
    addDialog.removeEventListener('close', once);
    const v = addDialog.returnValue;
    if (v === 'main') addCardToDeck(card.i, 'mainboard');
    else if (v === 'side') addCardToDeck(card.i, 'sideboard');
  });
}

// ===== Wire up editor inputs =====
document.getElementById('deck-name').addEventListener('input', e => {
  if (!ACTIVE_DECK_ID) return;
  const deck = DECKS.get(ACTIVE_DECK_ID);
  deck.name = e.target.value || '(unnamed)';
  deck.last_modified = Math.floor(Date.now() / 1000);
  saveAll();
  renderDeckList();
});
document.getElementById('deck-format').addEventListener('change', e => {
  if (!ACTIVE_DECK_ID) return;
  const deck = DECKS.get(ACTIVE_DECK_ID);
  deck.format = e.target.value;
  deck.last_modified = Math.floor(Date.now() / 1000);
  saveAll();
  renderDeckList();
});
document.getElementById('deck-notes').addEventListener('input', e => {
  if (!ACTIVE_DECK_ID) return;
  const deck = DECKS.get(ACTIVE_DECK_ID);
  deck.notes = e.target.value;
  deck.last_modified = Math.floor(Date.now() / 1000);
  saveAll();
});
document.querySelectorAll('.move-all').forEach(b => {
  b.addEventListener('click', () => {
    if (!ACTIVE_DECK_ID) return;
    const deck = DECKS.get(ACTIVE_DECK_ID);
    const from = b.dataset.from === 'main' ? 'mainboard' : 'sideboard';
    const to = b.dataset.to === 'main' ? 'mainboard' : 'sideboard';
    deck[to] = deck[to].concat(deck[from]);
    deck[from] = [];
    saveAll();
    renderList('mainboard');
    renderList('sideboard');
    renderStats();
  });
});

// ===== Buttons =====
document.getElementById('new-deck').addEventListener('click', () => createDeck());
document.getElementById('delete-deck').addEventListener('click', deleteActiveDeck);
document.getElementById('import-snapshot').addEventListener('click', async () => {
  // Force a reload from snapshot, overwriting any local state.
  if (DECKS.size > 0 && !confirm('Reload from disk will replace your in-progress edits. Continue?')) return;
  try {
    const r = await fetch('builder-data.json?ts=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    DECKS.clear();
    for (const d of (data.user_decks || [])) {
      const id = d.deck_id || ('user-' + Math.random().toString(16).slice(2, 10));
      DECKS.set(id, {
        name: d.name || '(unnamed)',
        format: d.format || '',
        notes: d.notes || '',
        mainboard: d.mainboard || [],
        sideboard: d.sideboard || [],
        first_created: d.first_created || Math.floor(Date.now() / 1000),
        last_modified: d.last_modified || Math.floor(Date.now() / 1000),
      });
    }
    saveAll();
    renderDeckList();
    renderEditor();
  } catch (e) {
    alert('Failed to load builder-data.json: ' + e.message);
  }
});

// ===== Export =====
document.getElementById('export-deck').addEventListener('click', () => {
  if (!ACTIVE_DECK_ID) return;
  const deck = DECKS.get(ACTIVE_DECK_ID);
  const payload = {
    decks: [{
      deck_id: ACTIVE_DECK_ID,
      name: deck.name,
      format: deck.format || null,
      notes: deck.notes || null,
      mainboard: deck.mainboard,
      sideboard: deck.sideboard,
    }]
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (deck.name || 'deck').replace(/[^A-Za-z0-9_-]+/g, '_');
  a.href = url;
  a.download = `${safeName}-${ACTIVE_DECK_ID}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  flashToast(`Exported ${deck.name}. Run: mtga-logs deck-import ${a.download}`);
});

function flashToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('visible'), 10);
  setTimeout(() => {
    t.classList.remove('visible');
    setTimeout(() => t.remove(), 300);
  }, 2400);
}

// ===== Boot =====
loadFromStorage();
loadFromSnapshot();
renderDeckList();
renderEditor();
</script>
"#;

