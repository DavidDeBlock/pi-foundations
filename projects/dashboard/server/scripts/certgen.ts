/**
 * Generate a local CA + leaf cert + key pair for HTTPS dev.
 *
 * Why this script exists:
 *   - Lets the operator skip Python + pipx + trustme entirely.
 *   - No shell quoting (no inline `-c "..."` Python, no `\`
 *     line-continuation that zsh sometimes drops during paste).
 *   - Produces the same `ca.pem`, `server.pem`, `server.key` files as
 *     trustme or mkcert, so the dashboard doesn't care which tool made
 *     them.
 *
 * Usage:
 *   pnpm certgen <hostname> [<hostname> ...]
 *
 * Example:
 *   pnpm certgen 192.168.0.136.nip.io 192.168.0.136
 *
 * Writes to the cwd:
 *   ca.pem     — the CA cert. Install in OS trust store once per machine.
 *   server.pem — the leaf cert. Point DASHBOARD_TLS_CERT at this.
 *   server.key — the matching private key. KEEP PRIVATE.
 */

import { writeFileSync } from 'node:fs'
import forge from 'node-forge'

const argv = process.argv.slice(2)

if (argv.length === 0) {
  console.error('usage: pnpm certgen <hostname> [<hostname> ...]')
  console.error('')
  console.error('Writes ca.pem, server.pem, server.key to the cwd.')
  console.error('Examples of valid hostnames:')
  console.error('  pnpm certgen 192.168.0.136.nip.io 192.168.0.136')
  console.error('  pnpm certgen localhost 127.0.0.1')
  process.exit(2)
}

// One-year validity is plenty for dev. Re-run the script when it expires.
const oneYearFromNow = new Date()
oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1)

// CA
const caKeys = forge.pki.rsa.generateKeyPair(2048)
const caCert = forge.pki.createCertificate()
caCert.publicKey = caKeys.publicKey
caCert.serialNumber = '01'
caCert.validity.notBefore = new Date()
caCert.validity.notAfter = oneYearFromNow
const caSubject = [{ name: 'commonName', value: 'dashboard-dev-ca' }]
caCert.setSubject(caSubject)
caCert.setIssuer(caSubject)
caCert.setExtensions([
  { name: 'basicConstraints', cA: true, critical: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
])
caCert.sign(caKeys.privateKey, forge.md.sha256.create())

// Leaf
const leafKeys = forge.pki.rsa.generateKeyPair(2048)
const leafCert = forge.pki.createCertificate()
leafCert.publicKey = leafKeys.publicKey
leafCert.serialNumber = '02'
leafCert.validity.notBefore = new Date()
leafCert.validity.notAfter = oneYearFromNow
leafCert.setSubject([{ name: 'commonName', value: argv[0]! }])
leafCert.setIssuer(caSubject)
leafCert.setExtensions([
  { name: 'basicConstraints', cA: false },
  { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
  {
    name: 'subjectAltName',
    altNames: argv.map((h) =>
      /^\d+\.\d+\.\d+\.\d+$/.test(h)
        ? { type: 7, ip: h } // 7 = IP
        : { type: 2, value: h }, // 2 = DNS
    ),
  },
])
leafCert.sign(caKeys.privateKey, forge.md.sha256.create())

writeFileSync('ca.pem', forge.pki.certificateToPem(caCert))
writeFileSync('server.pem', forge.pki.certificateToPem(leafCert))
writeFileSync('server.key', forge.pki.privateKeyToPem(leafKeys.privateKey))

console.log(`Generated ca.pem, server.pem, server.key for: ${argv.join(', ')}`)
console.log('')
console.log('Trust the CA on this machine (one-time):')
console.log('  Debian/Ubuntu (no p11-kit needed):')
console.log('    sudo cp ca.pem /usr/local/share/ca-certificates/dashboard-ca.crt')
console.log('    sudo update-ca-certificates')
console.log('  Fedora / Arch (p11-kit):')
console.log('    sudo trust anchor ca.pem')
console.log('  macOS:')
console.log('    sudo security add-trusted-cert -d -r trustRoot \\\\')
console.log('      -k /Library/Keychains/System.keychain ca.pem')
console.log('  Windows (admin PowerShell):')
console.log('    certutil -addstore -f "Root" ca.pem')
console.log('')
console.log('Then point the dashboard at the leaf cert:')
console.log('  echo "DASHBOARD_TLS_CERT=$(pwd)/server.pem" >> .env')
console.log('  echo "DASHBOARD_TLS_KEY=$(pwd)/server.key"  >> .env')
console.log('  pnpm start')
console.log('# -> Dashboard listening on https://' + argv[0] + ':8080')