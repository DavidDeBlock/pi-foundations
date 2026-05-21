---
name: browser-automation
description: Headless browser automation using Playwright for browsing, scraping, screenshots, and UI testing USE WHEN web research, documentation lookup, screenshots, form interactions, dynamic content rendering
---

# Browser Automation Skill

## Mission
Headless browser automation using Playwright CLI for background browser tasks.

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
# Full page screenshot to /tmp/screenshot.png
.pi/scripts/browser-automation.sh screenshot "https://example.com" /tmp/page.png
```

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

- **Implementation:** Node.js ESM script (`browser.mjs`) wrapped by `.pi/scripts/browser-automation.sh`
- **Engine:** Playwright (Chromium) — runs headless by default
- **Module Resolution:** Explicitly imports `playwright/index.js` to avoid CJS/ESM conflicts in global node_modules
- **Env Loading:** Auto-parses project `.env` for API keys (`SERPER_API_KEY`, etc.)
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
