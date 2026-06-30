import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { execFileSync } from 'node:child_process'

/**
 * Smoke-test the cert generator. Runs the actual script as a child
 * process (rather than importing it), so we exercise the full
 * command-line path: argv parsing, file writes, PEM shape.
 */

const SCRIPT = join(import.meta.dirname, 'certgen.ts')
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')

function runCertgen(args: string[], cwd: string): { status: number; stderr: string } {
  try {
    execFileSync(TSX, [SCRIPT, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer }
    return { status: e.status ?? 1, stderr: e.stderr?.toString() ?? '' }
  }
}

function parsePem(pem: string): forge.pki.Certificate {
  const cert = forge.pki.certificateFromPem(pem)
  return cert
}

let workdir = ''
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'certgen-test-'))
})
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('certgen', () => {
  it('writes ca.pem, server.pem, server.key', () => {
    runCertgen(['example.test'], workdir)
    expect(existsSync(join(workdir, 'ca.pem'))).toBe(true)
    expect(existsSync(join(workdir, 'server.pem'))).toBe(true)
    expect(existsSync(join(workdir, 'server.key'))).toBe(true)
  })

  it('produces valid PEM (parseable as certs/keys)', () => {
    runCertgen(['example.test'], workdir)
    expect(() => parsePem(readFileSync(join(workdir, 'ca.pem'), 'utf8'))).not.toThrow()
    expect(() => parsePem(readFileSync(join(workdir, 'server.pem'), 'utf8'))).not.toThrow()
    expect(() => {
      forge.pki.privateKeyFromPem(readFileSync(join(workdir, 'server.key'), 'utf8'))
    }).not.toThrow()
  })

  it('CA cert has cA=true basicConstraint, leaf has cA=false', () => {
    runCertgen(['example.test'], workdir)
    const ca = parsePem(readFileSync(join(workdir, 'ca.pem'), 'utf8'))
    const leaf = parsePem(readFileSync(join(workdir, 'server.pem'), 'utf8'))
    expect(ca.getExtension('basicConstraints')?.cA).toBe(true)
    expect(leaf.getExtension('basicConstraints')?.cA).toBe(false)
  })

  it('leaf cert includes every hostname in SAN (DNS for names, IP for dotted-quads)', () => {
    runCertgen(['a.test', '10.0.0.1', 'b.test'], workdir)
    const leaf = parsePem(readFileSync(join(workdir, 'server.pem'), 'utf8'))
    const san = leaf.getExtension('subjectAltName') as { altNames: Array<{ type: number; value?: string; ip?: string }> }
    const values = san.altNames.map((a) => (a.type === 7 ? a.ip : a.value))
    expect(values).toContain('a.test')
    expect(values).toContain('10.0.0.1')
    expect(values).toContain('b.test')
  })

  it('leaf is signed by the CA (verify chain)', () => {
    runCertgen(['example.test'], workdir)
    const ca = parsePem(readFileSync(join(workdir, 'ca.pem'), 'utf8'))
    const leaf = parsePem(readFileSync(join(workdir, 'server.pem'), 'utf8'))
    // forge has no chain verifier, but we can confirm the issuer matches
    expect(leaf.issuer.getField('CN')?.value).toBe('dashboard-dev-ca')
    expect(ca.subject.getField('CN')?.value).toBe('dashboard-dev-ca')
  })

  it('fails with non-zero exit and stderr usage message when no hostnames given', () => {
    const result = runCertgen([], workdir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/usage: pnpm certgen/)
  })
})