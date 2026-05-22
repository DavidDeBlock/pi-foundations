/**
 * Test domain schema — blog/content model.
 */

import { pgTable, uuid, varchar, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * @entity Author - A content creator in the system
 */
export const authors = pgTable('authors', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  bio: text('bio'),
})

/**
 * @entity Post - A blog post or article
 * @relation Post.author -> Author (many-to-one)
 */
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey(),
  authorId: uuid('author_id').references(() => authors.id),
  title: varchar('title', { length: 300 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  publishedAt: timestamp('published_at'),
})

/**
 * @entity Comment - A reader comment on a post
 * @relation Comment.post -> Post (many-to-one)
 */
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  postId: uuid('post_id').references(() => posts.id),
  body: text('body').notNull(),
})
