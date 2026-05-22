/**
 * Test domain schema — simple e-commerce model.
 */

import { pgTable, uuid, varchar, decimal, timestamp } from 'drizzle-orm/pg-core'

/**
 * @entity User - The person who owns accounts and makes purchases
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})

/**
 * @entity Sale - A completed purchase transaction
 * @relation Sale.user -> User (many-to-one)
 */
export const sales = pgTable('sales', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  total: decimal('total', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).default('pending'),
})

/**
 * @entity LineItem - An individual product within a sale
 * @relation LineItem.sale -> Sale (many-to-one)
 */
export const lineItems = pgTable('line_items', {
  id: uuid('id').primaryKey(),
  saleId: uuid('sale_id').references(() => sales.id),
  productName: varchar('product_name', { length: 200 }).notNull(),
  quantity: integer('quantity').default(1).notNull(),
})
