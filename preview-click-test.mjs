// One-off verification: start the dashboard server, open /preview/v2
// in headless Chromium, click the new Today compartment + its 3 inner
// sub-tabs, and confirm the right sub-panel becomes visible.

import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8765
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'testpw'

async function waitForServer(maxMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BASE}/health`, {
        headers: { authorization: `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}` },
      })
      if (r.status === 200) return
    } catch { /* not up yet */ }
    await sleep(150)
  }
  throw new Error('server did not come up')
}

async function main() {
  const env = {
    ...process.env,
    DASHBOARD_PASSWORD: PASSWORD,
    PORT: String(PORT),
    HOSTNAME: '127.0.0.1',
    DB_PATH: '/tmp/preview-click-test.db',
    DATA_DIR: '/tmp/preview-click-test-data',
  }
  const cwd = '/home/david/projects/pi-foundations/projects/dashboard/server'
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  try {
    await waitForServer()

    const browser = await chromium.launch({ headless: true })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const authHeader = `Basic ${Buffer.from(`david:${PASSWORD}`).toString('base64')}`
    await ctx.setExtraHTTPHeaders({ authorization: authHeader })
    const page = await ctx.newPage()
    const pageErrors = []
    page.on('pageerror', e => pageErrors.push(e.message))

    await page.goto(`${BASE}/preview/v2`, { waitUntil: 'load' })
    await sleep(300)

    async function visibleCompartment() {
      return page.evaluate(() => {
        const ps = document.querySelectorAll('[data-panel]')
        for (const p of ps) if (!p.hasAttribute('hidden')) return p.getAttribute('data-panel')
        return null
      })
    }
    async function visibleTodaySub() {
      return page.evaluate(() => {
        const ps = document.querySelectorAll('[data-today-subpanel]')
        for (const p of ps) if (!p.hasAttribute('hidden')) return p.getAttribute('data-today-subpanel')
        return null
      })
    }

    // Test 1: click Today compartment (sidebar)
    await page.click('[data-compartment="today"]')
    await sleep(150)
    const r1 = await visibleCompartment()
    const r1sub = await visibleTodaySub()

    // Test 2: click "This week" inner subtab
    await page.click('[data-today-subtab="this-week"]')
    await sleep(150)
    const r2 = await visibleTodaySub()

    // Test 3: click "All tasks" inner subtab
    await page.click('[data-today-subtab="all-tasks"]')
    await sleep(150)
    const r3 = await visibleTodaySub()

    // Test 4: click "Today" inner subtab (back to default)
    await page.click('[data-today-subtab="today"]')
    await sleep(150)
    const r4 = await visibleTodaySub()

    // Test 5: navigate away then back to Today — should reset to 'today' sub-view
    await page.click('[data-compartment="email"]')
    await sleep(150)
    await page.click('[data-compartment="today"]')
    await sleep(150)
    const r5compartment = await visibleCompartment()
    const r5sub = await visibleTodaySub()

    await browser.close()

    let failures = 0
    function check(label, ok, detail) {
      console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
      if (!ok) failures++
    }

    check('Click Today compartment shows today panel', r1 === 'today', `got ${r1}`)
    check('Today sub-view is the default on entry',     r1sub === 'today', `got ${r1sub}`)
    check('Click "This week" subtab shows this-week',   r2 === 'this-week', `got ${r2}`)
    check('Click "All tasks" subtab shows all-tasks',   r3 === 'all-tasks', `got ${r3}`)
    check('Click "Today" subtab shows today',           r4 === 'today', `got ${r4}`)
    check('Re-entering Today resets to today sub-view', r5compartment === 'today' && r5sub === 'today', `compartment=${r5compartment}, sub=${r5sub}`)

    if (pageErrors.length) {
      console.log('\n=== Page errors ===')
      for (const e of pageErrors) console.log(' -', e)
      failures++
    }

    if (failures === 0) {
      console.log('\nALL GREEN')
      process.exit(0)
    } else {
      console.log(`\n${failures} FAILURES`)
      process.exit(1)
    }
  } finally {
    child.kill('SIGTERM')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(2)
})