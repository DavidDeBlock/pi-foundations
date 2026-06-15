#!/usr/bin/env node
// browser.mjs — Headless browser automation for the browser-automation skill.
//
// Subcommands:
//   open <url>                    Navigate headless; print title, url, console errors
//   navigate <url>                Alias for open
//   screenshot <url> <file>       Capture viewport screenshot to <file>
//                                 Flags: --full-page, --wait-selector <sel>,
//                                        --wait-timeout <ms>, --wait-images,
//                                        --wait-network-idle, --no-grace
//   extract <url> [selector]      Print cleaned text of <selector> (default: body)
//   search <query...>             Google search via Serper API
//
// All commands run headless. Uses @playwright/test (the only playwright pkg
// installed in this project). Auto-loads .env via Node's --env-file flag.

import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const PROJECT_ROOT = process.cwd();
const CONFIG_PATH = `${PROJECT_ROOT}/.pi/playwright-cli.json`;

function loadConfig() {
  try {
    const { readFileSync } = require('node:fs');
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { viewport: { width: 1440, height: 900 } };
  }
}

function die(msg, code = 1) {
  console.error(`\u274c ${msg}`);
  process.exit(code);
}

function parseFlags(argv) {
  // Tiny flag parser: --key value | --key=value | --flag
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[a.slice(2)] = true;
        } else {
          out[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function withBrowser(fn) {
  const cfg = loadConfig();
  const browser = await chromium.launch({
    headless: true,
    executablePath: cfg.browser?.path, // null = auto-detect
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      viewport: cfg.viewport ?? { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    // Surface page errors and console errors to stderr.
    const consoleErrors = [];
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    return await fn(page, { consoleErrors });
  } finally {
    await browser.close();
  }
}

async function cmdOpen(url) {
  await withBrowser(async (page, { consoleErrors }) => {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = resp?.status() ?? 'no-response';
    const title = await page.title();
    const finalUrl = page.url();
    console.log(`status:  ${status}`);
    console.log(`title:   ${title}`);
    console.log(`url:     ${finalUrl}`);
    if (consoleErrors.length) {
      console.log(`console errors:`);
      for (const e of consoleErrors.slice(0, 5)) console.log(`  - ${e}`);
    }
  });
}

async function cmdScreenshot(url, file, flags) {
  if (!file) die('screenshot requires <url> <file>');
  await withBrowser(async (page) => {
    // Pick load strategy. Default 'load' (window.onload) is far more reliable
    // than 'domcontentloaded' for JS-heavy sites with carousels, fonts, and
    // async widgets. 'networkidle' is the strictest — opt-in via flag.
    const waitUntil = flags['wait-network-idle'] ? 'networkidle' : 'load';
    await page.goto(url, { waitUntil, timeout: 30000 });

    // Optional: wait for a specific element before capturing.
    if (flags['wait-selector']) {
      await page.waitForSelector(flags['wait-selector'], { timeout: 15000 });
    }

    // Optional: wait for all <img> elements to finish loading (handles
    // lazy-loaded carousels and broken src attributes that would otherwise
    // leave blank regions in the screenshot).
    if (flags['wait-images']) {
      await page.waitForFunction(
        () => {
          const imgs = Array.from(document.images);
          return imgs.length === 0 || imgs.every((img) => img.complete && img.naturalHeight !== 0);
        },
        { timeout: 15000 },
      );
    }

    // Final grace: explicit --wait-timeout overrides the default. The default
    // grace of 1500ms gives late-running scripts, animations, and post-load
    // widgets a chance to settle before we snap. --no-grace skips it.
    if (flags['wait-timeout']) {
      await page.waitForTimeout(Number(flags['wait-timeout']));
    } else if (!flags['no-grace']) {
      await page.waitForTimeout(1500);
    }

    const opts = { path: file };
    if (flags['full-page']) opts.fullPage = true;
    await page.screenshot(opts);
    console.log(`\u2705 saved ${file}`);
  });
}

async function cmdExtract(url, selector) {
  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const text = await page.locator(selector || 'body').innerText({ timeout: 10000 });
    console.log(text);
  });
}

async function cmdSearch(queryParts) {
  const query = queryParts.join(' ').trim();
  if (!query) die('search requires a query');
  const key = process.env.SERPER_API_KEY;
  if (!key) die('SERPER_API_KEY not set (check .env)');

  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query }),
  });
  if (!resp.ok) die(`Serper API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();

  const organic = data.organic ?? [];
  console.log(`\ud83d\udd0d ${query} (${organic.length} results)\n`);
  for (const r of organic.slice(0, 10)) {
    console.log(`\u2022 ${r.title}`);
    console.log(`  ${r.link}`);
    if (r.snippet) console.log(`  ${r.snippet}`);
    console.log();
  }
  if (data.answerBox) {
    console.log(`\u2728 Answer box: ${data.answerBox.answer ?? data.answerBox.snippet ?? ''}`);
  }
}

// --- dispatch ---
const [, , cmd, ...rest] = process.argv;
const flags = parseFlags(rest);

switch (cmd) {
  case 'open':
  case 'navigate': {
    const url = flags._[0];
    if (!url) die(`${cmd} requires <url>`);
    if (!/^https?:\/\//.test(url)) die(`url must start with http(s)://  (got: ${url})`);
    await cmdOpen(url);
    break;
  }
  case 'screenshot': {
    const [url, file] = flags._;
    if (!url) die('screenshot requires <url> [file]');
    await cmdScreenshot(url, file, flags);
    break;
  }
  case 'extract': {
    const [url, selector] = flags._;
    if (!url) die('extract requires <url> [selector]');
    await cmdExtract(url, selector);
    break;
  }
  case 'search': {
    await cmdSearch(flags._);
    break;
  }
  default:
    die(
      `unknown command: ${cmd ?? '(none)'}\n` +
        `usage: browser.mjs <open|navigate|screenshot|extract|search> ...`,
    );
}
