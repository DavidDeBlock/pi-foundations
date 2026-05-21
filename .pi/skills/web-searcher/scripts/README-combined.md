# Combined Web Search + Browser Tool (Python 3)

**All scripts are Python 3 executables.** Use `python3` explicitly.

This tool combines **Serper API** (Google search) with **Playwright/Bowser** (browser automation).

## 🎯 Use Cases

1. **Search → Browse**: Find information via Google, then visit results that need JavaScript rendering
2. **Anti-Bot Bypass**: Search engines can't access some sites; use browser to bypass restrictions
3. **Dynamic Content**: Some content only loads with JS - search finds it, browser renders it
4. **Form Submission**: Search for forms, browser fills and submits them

## 📋 Commands

### Search Google (Serper API)
```bash
python3 scripts/search-and-browse.py search "top restaurants Gent" --headed
```
- Searches using Serper API
- Shows results in terminal
- Optionally opens top result in browser

### Browse URL Directly
```bash
python3 scripts/search-and-browse.py browse https://example.com --session=my-session --headed
```
- Opens any URL in Playwright with persistent session

### Take Snapshot (Get Element References)
```bash
python3 scripts/search-and-browse.py snapshot --session=my-session
```
- Returns YAML structure of page elements
- Use refs for click/fill/interact commands

### Screenshot Page
```bash
python3 scripts/search-and-browse.py screenshot --session=my-session output.png
```
- Saves viewport screenshot

### Close Session
```bash
python3 scripts/search-and-browse.py close --session=my-session
```
- Closes browser and saves state

## 🔧 Workflow Example (Python 3)

```bash
# 1. Search for information
python3 scripts/search-and-browse.py search "react tutorial" --headed

# 2. Browser opens top result automatically

# 3. Take snapshot to see page structure
python3 scripts/search-and-browse.py snapshot --session=search-session

# 4. Interact with elements (using playwright-cli directly)
./node_modules/.bin/playwright-cli -s=search-session click e10
./node_modules/.bin/playwright-cli -s=search-session fill e21 "search text"

# 5. Take screenshot of results
python3 scripts/search-and-browse.py screenshot --session=search-session result.png

# 6. Close when done
python3 scripts/search-and-browse.py close --session=search-session
```

## 🎨 Key Features

| Feature | Description |
|---------|-------------|
| **Serper API** | Fast Google search with structured results |
| **Persistent Sessions** | Cookies/state preserved across calls (`-s=`) |
| **Headed Mode** | See browser window for debugging |
| **Element Snapshots** | Get refs for automation |
| **Screenshot Capture** | Save visual output |

## 📁 Files

```
.pi/skills/web-searcher/
├── scripts/
│   ├── search-google.py      # Serper API wrapper
│   └── search-and-browse.py  # Combined tool (NEW!)
└── README-combined.md        # This file
```

## 🚀 Quick Start (Python 3)

```bash
cd /mnt/c/Coding/_CURRENT/Core/.pi/skills/web-searcher

# Search and browse in one command
python3 scripts/search-and-browse.py search "your query" --headed
```
