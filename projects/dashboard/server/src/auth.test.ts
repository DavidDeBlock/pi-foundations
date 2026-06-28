import { describe, expect, it } from 'vitest'
import { parseBasicAuth, parseBearerAuth } from './auth.js'

describe('parseBasicAuth', () => {
  it('parses a valid Basic header', () => {
    const encoded = Buffer.from('alice:secret').toString('base64')
    expect(parseBasicAuth(`Basic ${encoded}`)).toEqual({
      username: 'alice',
      password: 'secret',
    })
  })

  it('returns null when the header is missing', () => {
    expect(parseBasicAuth(undefined)).toBeNull()
  })

  it('returns null for non-Basic schemes', () => {
    expect(parseBasicAuth('Bearer xyz')).toBeNull()
  })

  it('returns null when the payload is missing the colon separator', () => {
    const header = `Basic ${Buffer.from('nocolon').toString('base64')}`
    expect(parseBasicAuth(header)).toBeNull()
  })

  it('tolerates colons inside the password', () => {
    const encoded = Buffer.from('alice:a:b:c').toString('base64')
    expect(parseBasicAuth(`Basic ${encoded}`)).toEqual({
      username: 'alice',
      password: 'a:b:c',
    })
  })
})

describe('parseBearerAuth', () => {
  it('parses a valid Bearer header', () => {
    expect(parseBearerAuth('Bearer abc123')).toBe('abc123')
  })

  it('returns null when the header is missing', () => {
    expect(parseBearerAuth(undefined)).toBeNull()
  })

  it('returns null for non-Bearer schemes', () => {
    expect(parseBearerAuth('Basic abc==')).toBeNull()
  })

  it('returns null when the token is missing', () => {
    expect(parseBearerAuth('Bearer ')).toBeNull()
    expect(parseBearerAuth('Bearer')).toBeNull()
  })

  it('captures the token including special characters', () => {
    // Tokens are base64url — no padding, but may contain - or _.
    expect(parseBearerAuth('Bearer abc-def_ghi')).toBe('abc-def_ghi')
  })
})
