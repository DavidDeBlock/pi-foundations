#!/usr/bin/env bash
# Browser Automation Wrapper for Playwright
# Usage: browser.sh <command> [args...]
# Commands: open, navigate, search, extract, screenshot

set -e

PLAYWRIGHT_PATH="/home/david/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/test/node_modules/playwright"

run_script() {
  node --input-type=module << 'NODESCRIPT' "$@"
import { chromium } from '$PLAYWRIGHT_PATH';

const args = process.argv.slice(2);
const command = args[0];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (command === 'open' || command === 'navigate') {
      const url = args[1];
      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      console.log('Title:', await page.title());
      console.log('URL:', page.url());
    } 
    else if (command === 'screenshot') {
      const url = args[1];
      const outputPath = args[2] || '/tmp/screenshot.png';
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.screenshot({ path: outputPath, fullPage: true });
      console.log(`Screenshot saved to ${outputPath}`);
    }
    else if (command === 'extract') {
      const url = args[1];
      const selector = args[2] || 'body';
      await page.goto(url, { waitUntil: 'networkidle' });
      const content = await page.textContent(selector);
      console.log(content);
    }
    else if (command === 'search') {
      // Uses Serper API via curl
      const query = args.slice(1).join(' ');
      const apiKey = process.env.SERPER_API_KEY;
      if (!apiKey) throw new Error('SERPER_API_KEY not set');
      
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query })
      });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
    }
    else {
      console.error('Unknown command:', command);
      process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
NODESCRIPT
}

run_script "$@"
