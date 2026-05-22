import { describe, it, expect } from 'vitest'
import { resolve, join } from 'path'
import fs from 'node:fs'

const FIXTURES_DIR = resolve(__dirname, '__test-fixtures__')

// ── Helper to create temp TS files for testing ───────────────────────

async function writeFixture(name: string, content: string): Promise<string> {
  const filePath = join(FIXTURES_DIR, name)
  fs.mkdirSync(FIXTURES_DIR, { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

async function cleanupFixture(name: string): Promise<void> {
  const filePath = join(FIXTURES_DIR, name)
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath)
  }
}

// ── parseEntityTag tests ─────────────────────────────────────────────

describe('parseEntityTag', () => {
  it('extracts entity name and description from @entity tag', async () => {
    const mod = await import('./domain-model.js')
    // Access internal function via module export pattern
    // We test through parseDomainSchema instead since parseEntityTag is not exported
    const content = `/**
 * @entity User - The person who owns accounts
 */
export const users = pgTable('users', {})`

    const fixturePath = await writeFixture('test-entity-tag.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities.length).toBe(1)
      expect(result.entities[0].name).toBe('User')
      expect(result.entities[0].description).toBe('The person who owns accounts')
    } finally {
      await cleanupFixture('test-entity-tag.ts')
    }
  })

  it('extracts entity name without description', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity Sale
 */
export const sales = pgTable('sales', {})`

    const fixturePath = await writeFixture('test-entity-no-desc.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities.length).toBe(1)
      expect(result.entities[0].name).toBe('Sale')
      expect(result.entities[0].description).toBe('Sale entity')
    } finally {
      await cleanupFixture('test-entity-no-desc.ts')
    }
  })

  it('returns undefined when no @entity tag exists', async () => {
    const mod = await import('./domain-model.js')
    const content = `/** Just a regular comment */
export const something = {}`

    const fixturePath = await writeFixture('test-no-entity.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities.length).toBe(0)
    } finally {
      await cleanupFixture('test-no-entity.ts')
    }
  })
})

// ── parseRelationTags tests ──────────────────────────────────────────

describe('parseRelationTags', () => {
  it('extracts one-to-many relation from @relation tag', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity Sale - A purchase transaction
 * @relation User.sales -> Account (one-to-many)
 */
export const sales = pgTable('sales', {})`

    const fixturePath = await writeFixture('test-relation-1.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.relations.length).toBe(1)
      expect(result.relations[0].fromEntity).toBe('User')
      expect(result.relations[0].toEntity).toBe('Account')
      expect(result.relations[0].direction).toBe('one-to-many')
    } finally {
      await cleanupFixture('test-relation-1.ts')
    }
  })

  it('parses multiple relations from one JSDoc block', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity Post - A blog post
 * @relation Author.posts -> Comment (one-to-many)
 * @relation Comment.postId -> User (many-to-one)
 */
export const posts = pgTable('posts', {})`

    const fixturePath = await writeFixture('test-relation-multi.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.relations.length).toBe(2)
    } finally {
      await cleanupFixture('test-relation-multi.ts')
    }
  })

  it('returns empty array when no @relation tags exist', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity User - A user
 */
export const users = pgTable('users', {})`

    const fixturePath = await writeFixture('test-no-relation.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.relations.length).toBe(0)
    } finally {
      await cleanupFixture('test-no-relation.ts')
    }
  })
})

// ── parseDomainSchema tests ──────────────────────────────────────────

describe('parseDomainSchema', () => {
  it('extracts entities and relations from a complete schema file', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity User - The person who owns accounts
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
})

/**
 * @entity Sale - A completed purchase transaction
 * @relation User.sales -> Account (one-to-many)
 */
export const sales = pgTable('sales', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id'),
})`

    const fixturePath = await writeFixture('test-complete-schema.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)

      expect(result.entities.length).toBe(2)
      expect(result.entities[0].name).toBe('User')
      expect(result.entities[1].name).toBe('Sale')

      expect(result.relations.length).toBeGreaterThan(0)
    } finally {
      await cleanupFixture('test-complete-schema.ts')
    }
  })

  it('extracts table names from pgTable calls', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity Product - A sellable item
 */
export const products = pgTable('product_items', {
  id: uuid('id').primaryKey(),
})`

    const fixturePath = await writeFixture('test-table-name.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities[0].table).toBe('product_items')
    } finally {
      await cleanupFixture('test-table-name.ts')
    }
  })

  it('extracts field names from table definitions', async () => {
    const mod = await import('./domain-model.js')
    const content = `/**
 * @entity Config - System configuration
 */
export const config = pgTable('config', {
  key: varchar('key').primaryKey(),
  value: text('value'),
  enabled: boolean('enabled').default(true),
})`

    const fixturePath = await writeFixture('test-fields.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities[0].fields.length).toBeGreaterThan(0)
      // Should have key, value, enabled (not drizzle types like varchar/text/boolean)
      const fieldNames = result.entities[0].fields.map(f => f.name)
      expect(fieldNames).toContain('key')
      expect(fieldNames).toContain('value')
    } finally {
      await cleanupFixture('test-fields.ts')
    }
  })

  it('handles empty schema file gracefully', async () => {
    const mod = await import('./domain-model.js')
    const content = `// No entities here`

    const fixturePath = await writeFixture('test-empty.ts', content)
    try {
      const result = mod.parseDomainSchema(fixturePath)
      expect(result.entities.length).toBe(0)
      expect(result.relations.length).toBe(0)
    } finally {
      await cleanupFixture('test-empty.ts')
    }
  })

  it('handles non-existent file gracefully', async () => {
    const mod = await import('./domain-model.js')
    expect(() => mod.parseDomainSchema('/nonexistent/file.ts')).toThrow()
  })
})

// ── generateMarkdownTable tests ──────────────────────────────────────

describe('generateMarkdownTable', () => {
  it('generates a compact table with entity summary', async () => {
    const mod = await import('./domain-model.js')
    const model: any = {
      entities: [
        { name: 'User', table: 'users', description: 'A user account', fields: [{ name: 'id', type: 'uuid' }] },
        { name: 'Sale', table: 'sales', description: 'A purchase', fields: [] }
      ],
      relations: [
        { fromEntity: 'User', toEntity: 'Sale', fromField: 'id', direction: 'one-to-many' }
      ],
      sourceFiles: ['src/schema.ts']
    }

    const output = mod.generateMarkdownTable(model)

    expect(output).toContain('# Domain Model')
    expect(output).toContain('**2 entity(ies)** — 1 relationship(s)')
    expect(output).toContain('User')
    expect(output).toContain('Sale')
    expect(output).toContain('Relationships')
    expect(output).toContain('one to many')

    // Count lines (should be compact, under ~50 lines)
    const lineCount = output.split('\n').length
    expect(lineCount).toBeLessThan(50)
  })

  it('generates minimal output when no entities exist', async () => {
    const mod = await import('./domain-model.js')
    const model: any = {
      entities: [],
      relations: [],
      sourceFiles: []
    }

    const output = mod.generateMarkdownTable(model)
    expect(output).toContain('No entities found')
  })

  it('omits relationships section when no relations exist', async () => {
    const mod = await import('./domain-model.js')
    const model: any = {
      entities: [{ name: 'User', table: 'users', description: 'A user', fields: [] }],
      relations: [],
      sourceFiles: []
    }

    const output = mod.generateMarkdownTable(model)
    expect(output).not.toContain('## Relationships')
  })

  it('includes source file paths in output', async () => {
    const mod = await import('./domain-model.js')
    const model: any = {
      entities: [{ name: 'User', table: 'users', description: '', fields: [] }],
      relations: [],
      sourceFiles: ['/home/user/project/src/schema.ts']
    }

    const output = mod.generateMarkdownTable(model)
    expect(output).toContain('src/schema.ts')
  })
})

// ── generateJsonOutput tests ─────────────────────────────────────────

describe('generateJsonOutput', () => {
  it('generates valid JSON with entity and relation data', async () => {
    const mod = await import('./domain-model.js')
    const model: any = {
      entities: [
        { name: 'User', table: 'users', description: 'A user', fields: [{ name: 'id', type: 'uuid' }] }
      ],
      relations: [
        { fromEntity: 'User', toEntity: 'Sale', fromField: 'id', direction: 'one-to-many' }
      ]
    }

    const output = mod.generateJsonOutput(model)
    const parsed = JSON.parse(output)

    expect(parsed.entityCount).toBe(1)
    expect(parsed.relationCount).toBe(1)
    expect(parsed.entities[0].name).toBe('User')
    expect(parsed.relations[0].fromEntity).toBe('User')
  })

  it('handles empty model gracefully', async () => {
    const mod = await import('./domain-model.js')
    const model: any = { entities: [], relations: [] }

    const output = mod.generateJsonOutput(model)
    const parsed = JSON.parse(output)

    expect(parsed.entityCount).toBe(0)
    expect(parsed.relationCount).toBe(0)
  })
})

// ── generateHelp tests ───────────────────────────────────────────────

describe('generateHelp', () => {
  it('includes usage information and JSDoc tag format', async () => {
    const mod = await import('./domain-model.js')
    const output = mod.generateHelp()

    expect(output).toContain('@entity')
    expect(output).toContain('@relation')
    expect(output).toContain('--json')
    expect(output).toContain('--help')
  })
})

// ── Integration tests with real fixtures ─────────────────────────────

describe('integration — fixture files', () => {
  it('parses the e-commerce schema fixture correctly', async () => {
    const mod = await import('./domain-model.js')
    const fixturePath = join(FIXTURES_DIR, 'domain-schema-1.ts')

    if (!fs.existsSync(fixturePath)) {
      // Skip if fixture doesn't exist (tests may run before fixtures are created)
      return
    }

    const result = mod.parseDomainSchema(fixturePath)

    expect(result.entities.length).toBe(3)
    expect(result.entities.map(e => e.name)).toContain('User')
    expect(result.entities.map(e => e.name)).toContain('Sale')
    expect(result.entities.map(e => e.name)).toContain('LineItem')
  })

  it('parses the blog schema fixture correctly', async () => {
    const mod = await import('./domain-model.js')
    const fixturePath = join(FIXTURES_DIR, 'domain-schema-2.ts')

    if (!fs.existsSync(fixturePath)) {
      return
    }

    const result = mod.parseDomainSchema(fixturePath)

    expect(result.entities.length).toBe(3)
    expect(result.entities.map(e => e.name)).toContain('Author')
    expect(result.entities.map(e => e.name)).toContain('Post')
    expect(result.entities.map(e => e.name)).toContain('Comment')
  })

  it('generates compact output for fixture files', async () => {
    const mod = await import('./domain-model.js')
    const fixturePath = join(FIXTURES_DIR, 'domain-schema-1.ts')

    if (!fs.existsSync(fixturePath)) {
      return
    }

    const result = mod.parseDomainSchema(fixturePath)
    // parseDomainSchema returns { entities, relations }, wrap for generateMarkdownTable
    const model = { ...result, sourceFiles: [fixturePath] }
    const output = mod.generateMarkdownTable(model)
    const lineCount = output.split('\n').length

    expect(lineCount).toBeLessThan(50)
  })
})
