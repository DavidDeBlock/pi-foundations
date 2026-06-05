import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'

const sqlite = new Database('./data/database.db')
const db = drizzle(sqlite)

// @ts-ignore - using raw tables for simple queries
const addressStreets = (await import('../server/src/db/schema/address.js')).addressStreets
const postalCodes = (await import('../server/src/db/schema/address.js')).postalCodes
const addressSyncMetadata = (await import('../server/src/db/schema/address.js')).addressSyncMetadata

const streets = await db.select({ count: db.$count(addressStreets) }).from(addressStreets)
console.log('address_streets:', streets[0])

const pcs = await db.select({ count: db.$count(postalCodes) }).from(postalCodes)
console.log('postal_codes:', pcs[0])

const meta = await db.select().from(addressSyncMetadata).all()
console.log('sync_metadata:', JSON.stringify(meta, null, 2))
