import { resolve } from 'node:path'
import { serve } from '@hono/node-server'
import { loadConfig } from './env.js'
import { createApp } from './app.js'
import { JsonTokenStore } from './token-store.js'
import { Database } from './db.js'
import { runMigrations } from './migrations.js'

async function main(): Promise<void> {
  const config = await loadConfig()
  const tokenStore = new JsonTokenStore({ dataDir: config.dataDir })

  const db = new Database(config.dbPath)
  // Migrations live alongside `src/`; resolve relative to cwd which is the
  // server project root when launched via `pnpm start`.
  await runMigrations(db, {
    dir: resolve(process.cwd(), 'migrations'),
  })

  const app = createApp({
    passwordHash: config.passwordHash,
    tokenStore,
    db,
  })

  serve(
    { fetch: app.fetch, port: config.port, hostname: config.hostname },
    (info) => {
      // eslint-disable-next-line no-console
      console.log(`Dashboard listening on http://${info.address}:${info.port}`)
    },
  )
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`Failed to start dashboard server: ${message}`)
  process.exit(1)
})
