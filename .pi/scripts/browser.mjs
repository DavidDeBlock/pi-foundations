import fs from 'fs';
import path from 'path';

// Load .env file if it exists
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
}

import pkg from '/home/david/.nvm/versions/node/v24.14.1/lib/node_modules/@playwright/test/node_modules/playwright/index.js';
const { chromium } = pkg;

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.error('Usage: browser.mjs <open|navigate|screenshot|extract|search> [args...]');
  process.exit(1);
}

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
      // Uses Serper API via curl/fetch
      const query = args.slice(1).join(' ');
      const apiKey = process.env.SERPER_API_KEY;
      if (!apiKey) throw new Error('SERPER_API_KEY not set');
      
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey
        },
        body: JSON.stringify({ q: query })
      });
      
      if (!res.ok) throw new Error(`Serper API error: ${res.status}`);
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
