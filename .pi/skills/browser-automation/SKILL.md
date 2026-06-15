---
name: browser-automation
description: Headless browser automation using Playwright for browsing, scraping, screenshots, and UI testing USE WHEN web research, documentation lookup, screenshots, form interactions, dynamic content rendering
---

# Browser Automation Skill

## Mission
Headless browser automation using Playwright (programmatic API) for background browser tasks.

---

## Primary Responsibility
Browser automation and headless browsing operations.

---

## Focus
- headless browsing
- parallel sessions
- UI testing
- screenshots
- web scraping
- JavaScript rendering
- form interactions

---

## 🎯 When to Use

Use this skill for:
- **Web research** - Browse and extract information from websites
- **Documentation lookup** - Access online docs, APIs, frameworks
- **Screenshots** - Capture page visuals
- **Form interactions** - Fill forms, click buttons, navigate
- **Dynamic content** - JavaScript-heavy sites that need rendering
- **Parallel sessions** - Multiple browser tabs for comparison

---

## 🔍 Search Strategy

### For Research Tasks:
1. Use targeted searches with specific queries
2. Navigate to authoritative sources (.gov, .edu, official sites)
3. Extract and summarize key information
4. Cross-reference across multiple pages
5. Note dates and source credibility

### Source Hierarchy (Most to Least Trustworthy):
1. **Official company/organization websites**
2. **Regulatory bodies** (FTC, FDA, SEC, etc.)
3. **Academic/scientific sources** (.edu, PubMed)
4. **Reputable news organizations** (Reuters, AP, WSJ)
5. **Wikipedia** (for overview only - verify claims elsewhere)

---

## 📋 Browser Commands

All commands use the project-local wrapper script:
`.pi/scripts/browser-automation.sh`

### Basic Navigation:
```bash
# Open a page
.pi/scripts/browser-automation.sh open "https://example.com"

# Navigate to URL
.pi/scripts/browser-automation.sh navigate "https://example.com/page"
```

### Search & Extract:
```bash
# Google search via Serper API (uses web-searcher scripts)
.pi/scripts/browser-automation.sh search "Herbalife business model 2024"

# Extract text from page
.pi/scripts/browser-automation.sh extract "https://example.com" ".main-content"
```

### Screenshots:
```bash
# Viewport screenshot (waits for window.load + 1.5s grace by default)
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png

# Full-page screenshot
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --full-page

# Wait for a specific selector before capturing
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --wait-selector ".main-content"

# Wait for all <img> elements to finish loading (handles lazy-loaded carousels)
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --wait-images

# Wait for network to be fully idle (strictest — use for heavy SPAs)
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --wait-network-idle

# Wait a fixed time (ms) before capturing (overrides default grace)
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --wait-timeout 2000

# Skip the default grace period (fast path, content may not be settled)
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png --no-grace
```

**Wait strategy precedence** (in order):
1. `--wait-selector` — wait for a CSS element
2. `--wait-images` — wait for all `<img>` to be `complete` with non-zero `naturalHeight`
3. `--wait-timeout <ms>` — fixed delay (overrides the 1500ms default grace)
4. Default — 1500ms grace after `window.load` event

**Load strategy**: `waitUntil: 'load'` is the default (waits for `window.onload`). Use `--wait-network-idle` for sites with late-running XHR/fetch activity.

### Parallel Sessions:
> Note: For parallel/multi-tab workflows, run multiple instances sequentially or use the web-searcher skill for rapid multi-source lookups.

---

## 🔄 Execution Flow

1. **Initialize browser** - Launch headless Chrome/Chromium
2. **Navigate to source** - Go to authoritative URL
3. **Extract content** - Get text, data, or screenshots
4. **Clean & summarize** - Remove noise, extract key points
5. **Verify sources** - Check credibility and recency

---

## ⚠️ Best Practices

- Always note the date of information
- Cross-reference claims with multiple sources
- Distinguish between marketing claims and verified facts
- Be aware of potential bias in sources
- Use official/regulatory sources for legal/financial info
- For scientific claims, prioritize peer-reviewed journals

---

## 📊 Output Format

When presenting research findings:
1. **Executive Summary** - Key takeaways with confidence level
2. **Detailed Findings** - Organized by topic with source citations
3. **Source Links** - URLs and access dates
4. **Confidence Assessment** - How well-supported are the claims
5. **Gaps/Questions** - Areas needing more research

---

## 🔧 Technical Notes

- **Implementation:** Node.js ESM script (`.pi/scripts/browser.mjs`) wrapped by `.pi/scripts/browser-automation.sh`
- **Engine:** Playwright via `@playwright/test` (Chromium) — runs headless by default
- **Module Resolution:** Imports `chromium` from `@playwright/test` (the only Playwright package in this project; `playwright` is not installed separately)
- **Config:** Reads chromium path and viewport from `.pi/playwright-cli.json`. Falls back to Playwright auto-detect if the path is empty.
- **Env Loading:** Node 22's `--env-file=.env` flag auto-loads the project `.env` (provides `SERPER_API_KEY` to the `search` subcommand)
- **Subcommands:** `open`/`navigate` (page info + console errors), `screenshot` (`--full-page`, `--wait-selector`, `--wait-images`, `--wait-network-idle`, `--wait-timeout`, `--no-grace` — default waits for `window.load` + 1500ms grace), `extract` (selector → cleaned text), `search` (Serper API)
- **Capabilities:** Headless browsing, screenshots, text extraction, Serper web search integration

---

## 🔄 Handoff

### Typical Handoffs:

```
browser → web-searcher (for initial search results)
        → archivist (to cross-reference with project docs)
        → back to user (with findings/screenshots)
```

**When complete:**
- Results are extracted and summarized
- Screenshots saved if requested
- Source URLs documented
- Confidence level assessed

**Pass context when:**
- Need to browse multiple pages for comparison
- Research requires cross-referencing with project documentation
- User needs visual evidence (screenshots)
- External site blocked - need alternative sources
