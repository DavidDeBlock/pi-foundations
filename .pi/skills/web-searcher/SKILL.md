---
name: web-searcher
description: Searches the web with Serper API for documentation, API references, and technical research. USE WHEN looking up external docs, finding API references, researching libraries/frameworks, verifying information
---

# Web Searcher

## Mission

Search the web for information, documentation, and research using Serper API.

---

## Primary Responsibility

External knowledge retrieval and documentation lookup.

---

## Focus

- Documentation search
- API reference lookup
- Company/research queries
- GitHub repository discovery
- Technical problem solving

---

## Allowed Actions

- Search web with Serper API
- Open URLs with Playwright when needed
- Extract content from web pages
- Summarize findings
- Provide citations and sources

---

## Forbidden Actions

- Making up information
- Ignoring source credibility
- Overlooking relevant results
- Skipping verification steps

---

## Required Inputs

- Search query or topic
- Specific URLs to explore (optional)
- Context about what's needed

---

## Expected Outputs

- Search results summary
- Relevant documentation links
- Key findings and insights
- Source citations
- Recommendations for next steps

---

## Default Workflow

1. Understand the search need
2. Formulate effective queries
3. Execute searches via Serper API
4. Analyze results for relevance
5. Open specific pages with Playwright if needed
6. Extract and summarize key information
7. Provide clear citations and next steps

---

## Search Rules

- Use precise, targeted queries
- Verify multiple sources when possible
- Prioritize official documentation
- Check dates for relevance
- Distinguish between primary and secondary sources

---

## Output Format

A good search result should contain:

- summary of findings
- key information extracted
- source links with descriptions
- credibility assessment
- recommendations based on findings

---

## Checklist

Before finishing, verify:

- Are the results relevant to the query?
- Is the information current and accurate?
- Are sources properly cited?
- Is there enough context for decision-making?
- Are there any gaps that need follow-up?

---

## Definition of Done

Search is done when the user has sufficient information to make informed decisions or solve their problem.

---

## Script Usage

All scripts are located in `.pi/skills/web-searcher/scripts/`. Use Python 3 explicitly.

### Main Scripts

#### `search.py` — Serper API Web Search
```bash
python3 scripts/search.py "your search query"
```
- Searches Google via Serper API
- Returns structured JSON with title, link, snippet
- Includes source trust analysis and confidence scoring
- Supports optional result count parameter

#### `search-github.py` — GitHub Repository Search
```bash
python3 scripts/search-github.py "query" [max_results]
```
- Searches GitHub repositories by keyword/topic/language
- Returns repo metadata (stars, forks, language, topics)
- Default: 10 results, max: 100

#### `github-content.py` — GitHub Content Access
```bash
# List directory structure
python3 scripts/github-content.py tree <owner>/<repo>[@branch] [path]

# Read file contents
python3 scripts/github-content.py read <owner>/<repo>[@branch] <file-path>

# Get README with metadata
python3 scripts/github-content.py readme <owner>/<repo>[@branch]
```
- Access public GitHub repo contents via API
- Supports branch specification with `@` syntax
- Includes exponential backoff for rate limits

#### `scrape-skeleton-docs.py` — Documentation Scraping
```bash
python3 scripts/scrape-skeleton-docs.py
```
- Scrapes skeleton.dev documentation pages
- Saves HTML to library/docs/skeleton/website/
- Pre-configured list of docs pages

### Wrapper Script

#### `search_wrapper.sh` — Unified CLI Interface
```bash
# Source the wrapper (automatically done by /skill:web-searcher)
source scripts/search_wrapper.sh

# Google search via Serper API
python3 scripts/search.py "Herbalife products"

# GitHub repository search
python3 scripts/search-github.py "playwright" 5

# GitHub content access
python3 scripts/github-content.py tree badlogic/pi-mono packages/coding-agent
python3 scripts/github-content.py read badlogic/pi-mono README.md
python3 scripts/github-content.py readme badlogic/pi-mono main
```

### Environment Variables

Required:
- `SERPER_API_KEY` — Serper API key for Google search

Optional:
- `GITHUB_TOKEN` — GitHub token for higher rate limits (5000 req/hr vs 60 req/hr)

### Output Format

All scripts output structured data suitable for programmatic consumption:
- JSON format for search results
- Human-readable formatted text for CLI usage
- Metadata headers for documentation extraction

---

## Handoff

Typical handoffs:

- back to `archivist` for internal documentation lookup
- back to `browser-automation` for complex web interactions
- back to main flow with research findings