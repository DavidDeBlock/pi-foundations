---
name: debugger
description: Headless browser debugging with console log capture, error tracking, and network monitoring. USE WHEN console errors, JavaScript exceptions, network request analysis, DOM inspection, trace capture
---

# Debugger Skill

## Mission
Headless browser debugging with console log capture, error tracking, and network monitoring using Playwright.

---

## Primary Responsibility
Browser debugging session management with comprehensive event capture.

---

## Focus
- console debugging
- error tracking
- network analysis
- DOM inspection
- debug workflows
- event listeners
- trace capture

---

## 🎯 When to Use

Use this skill for:
- **Console debugging** - Capture all console.log, warn, error messages from web pages
- **Error tracking** - Identify JavaScript errors and unhandled exceptions
- **Network analysis** - Monitor XHR/fetch requests and responses
- **DOM inspection** - Query elements at specific points in page lifecycle
- **Debug workflows** - Step through complex user interactions with visibility

---

## 📋 Debugger Commands

### Basic Debugging:
```bash
# Open URL with console monitoring enabled
debugger open "https://example.com"

# Navigate to page while capturing logs
debugger navigate "https://example.com/page"

# Close debug session
debugger close
```

### Console Log Capture:
```bash
# Extract all console logs from a page
debugger logs --page="https://example.com"

# Filter by log type (info, warn, error)
debugger logs --page="url" --type=error

# Save logs to file
debugger logs --page="url" --output=/path/to/logs.json
```

### Error Tracking:
```bash
# Capture all JavaScript errors from page
debugger errors --page="https://example.com"

# Track unhandled promise rejections
debugger errors --page="url" --include-rejections=true
```

### Network Monitoring:
```bash
# Monitor network requests
debugger network --page="https://example.com"

# Filter by request type (xhr, fetch, all)
debugger network --page="url" --type=xhr

# Export to JSON file
debugger network --page="url" --output=/path/to/network.json
```

### DOM Inspection:
```bash
# Query element and return text/content
debugger query --selector=".element-class" --page="https://example.com"

# Get element attributes
debugger query --selector="#my-id" --attribute="data-testid"

# Check if element exists
debugger exists --selector=".loading-spinner" --page="url"
```

### Screenshots:
```bash
# Full page screenshot
debugger screenshot --page="https://example.com"

# Specific element screenshot
debugger screenshot --selector=".error-container" --page="url"

# Save to custom path
debugger screenshot --page="url" --output=/path/to/screenshot.png
```

### Advanced Debugging:
```bash
# Enable tracing with console + network + screenshots
debugger trace --page="https://example.com" --output=trace.zip

# Set breakpoints (pause at specific selectors)
debugger pause --selector=".critical-element" --page="url"

# Execute custom JavaScript in page context
debugger eval --script="document.title" --page="url"
```

---

## 🔄 Execution Flow

1. **Initialize browser** - Launch headless Chromium with console monitoring
2. **Enable event listeners** - Attach handlers for console, errors, network
3. **Navigate to target** - Load the page while capturing all events
4. **Extract data** - Collect logs, errors, network requests into structured format
5. **Clean & summarize** - Format output for easy analysis
6. **Cleanup** - Close browser and release resources

---

## 📊 Output Formats

### Console Logs:
```json
{
  "timestamp": "2024-01-13T01:30:00Z",
  "type": "error",
  "text": "Failed to load resource: net::ERR_FAILED",
  "url": "https://example.com/api/data",
  "stackTrace": null
}
```

### Errors:
```json
{
  "timestamp": "2024-01-13T01:30:05Z",
  "message": "Cannot read property 'map' of undefined",
  "fileName": "https://example.com/js/app.js",
  "lineNumber": 142,
  "columnNumber": 28,
  "stackTrace": "Error: ...\n at processData (app.js:142)"
}
```

### Network Requests:
```json
{
  "timestamp": "2024-01-13T01:30:02Z",
  "method": "GET",
  "url": "https://api.example.com/users",
  "status": 200,
  "responseTime": 245,
  "size": 1024,
  "requestHeaders": {...},
  "responseHeaders": {...}
}
```

---

## ⚠️ Best Practices

- **Use headless mode** - Always run in headless for automation
- **Set reasonable timeouts** - Default 30s, adjust for slow pages
- **Filter output** - Use `--type` flags to reduce noise
- **Save to files** - Large sessions should export to JSON
- **Clean up** - Always close browser after debugging session
- **Respect rate limits** - Don't spam requests in network monitoring

---

## 🔧 Technical Implementation

### Console Event Capture:
```javascript
const logs = [];
page.on('console', msg => {
  logs.push({
    type: msg.type(),
    text: msg.text(),
    url: msg.location().url,
    timestamp: new Date().toISOString()
  });
});
```

### Error Tracking:
```javascript
const errors = [];
page.on('pageerror', error => {
  errors.push({
    message: error.message,
    stackTrace: error.stack,
    timestamp: new Date().toISOString()
  });
});
```

### Network Monitoring:
```javascript
const requests = [];
page.on('request', req => {
  const startTime = Date.now();
  page.once('response', async res => {
    requests.push({
      url: req.url(),
      method: req.method(),
      status: res.status(),
      responseTime: Date.now() - startTime,
      timestamp: new Date().toISOString()
    });
  });
});
```

---

## 📚 Integration with Other Skills

### With Browser Automation:
- Use `browser-automation` for general browsing
- Switch to `debugger` when console inspection needed
- Combine workflows: browse → debug → screenshot

### With Archivist:
- Save debug logs as documentation
- Track recurring errors over time
- Build error knowledge base

---

## 🎨 Output Style

When presenting debugging results:
1. **Summary** - Key findings with severity level
2. **Console Logs** - Grouped by type (error, warn, info)
3. **JavaScript Errors** - Full stack traces
4. **Network Issues** - Failed requests and slow endpoints
5. **Recommendations** - Actionable fixes

---

## 🔍 Example Session

```bash
# Debug a problematic page
debugger open "https://example.com/broken-page"

# Capture all errors
debugger errors --page="https://example.com/broken-page"

# Check console logs
debugger logs --page="https://example.com/broken-page" --type=error

# Take screenshot of error state
debugger screenshot --selector=".error-container" --page="url"

# Export all data
debugger trace --page="url" --output=session.zip
```

---

## 🚧 Limitations

- **CSP restrictions** - Some sites block console access
- **Iframe limitations** - Cross-origin iframes may not be accessible
- **Performance impact** - Heavy logging can slow page load
- **Timeout constraints** - Long-running pages need extended timeouts
