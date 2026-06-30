// scripts/keygen.ts — one-shot helper for issue #021 follow-up UX.
//
// Prints a fresh 32-byte hex key to stdout for use as
// `EMAIL_TOKEN_ENCRYPTION_KEY`. Equivalent to `openssl rand -hex 32`
// but ships with the dashboard so an operator doesn't need openssl
// (Windows users, restricted shells, etc.).
//
// Usage:
//   pnpm keygen
//   EMAIL_TOKEN_ENCRYPTION_KEY=$(pnpm -s keygen) pnpm start
//
// Output is a single line (no trailing newline noise). On stderr
// we print a short comment so the operator can copy the line
// cleanly via shell.

import { randomBytes } from 'node:crypto'

const KEY_LENGTH = 32 // 32 bytes = 256 bits, matches AES-256-GCM

const key = randomBytes(KEY_LENGTH).toString('hex')
// Validate round-trip — sanity-check that what we print is what
// `parseEncryptionKey` will accept.
if (!/^[0-9a-f]{64}$/.test(key)) {
  // eslint-disable-next-line no-console
  console.error('keygen: generated key failed self-validation')
  process.exit(1)
}
// eslint-disable-next-line no-console
process.stdout.write(key + '\n')