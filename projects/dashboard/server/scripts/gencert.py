#!/usr/bin/env python3
"""Generate a local CA + leaf cert + key pair for HTTPS dev.

A companion to DASHBOARD_TLS_CERT / DASHBOARD_TLS_KEY (see env.example
+ /settings/email). Run it via trustme:

  pipx run --spec trustme python3 scripts/gencert.py 192.168.0.136.nip.io 192.168.0.136

Or with a system-wide trustme install:

  pip install trustme
  python3 scripts/gencert.py 192.168.0.136.nip.io 192.168.0.136

The script writes three files to the cwd:

  ca.pem       — the trustme-issued CA cert. Install this on your
                 machine so the browser trusts the leaf cert. One-time
                 per machine.
  server.pem   — the leaf cert. Point DASHBOARD_TLS_CERT at this.
  server.key   — the matching private key. Point DASHBOARD_TLS_KEY at
                 this. KEEP PRIVATE — anyone with this key can MITM
                 your local dashboard.

All hostnames you pass become Subject Alternative Names on the leaf
cert, so the same server.pem works for both the LAN IP and the
nip.io-style alias.

Why a file, not `python3 -c "..."`?  Multi-line inline Python scripts
are fragile — pasted leading whitespace makes the Python parser
unhappy, and double-quoting conflicts with shell quoting. Putting the
script on disk sidesteps both.
"""

import sys

import trustme


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(f"usage: {argv[0]} <hostname> [<hostname> ...]", file=sys.stderr)
        print("writes ca.pem, server.pem, server.key to the cwd", file=sys.stderr)
        return 2

    hostnames = argv[1:]
    ca = trustme.CA()
    cert = ca.issue_cert(*hostnames)
    ca.cert_pem.write_to_path("ca.pem")
    # cert_chain_pems[0] is the leaf (the CA chain is appended after).
    cert.cert_chain_pems[0].write_to_path("server.pem")
    cert.private_key_pem.write_to_path("server.key")

    print(f"Generated ca.pem, server.pem, server.key for: {', '.join(hostnames)}")
    print()
    print("Trust the CA on this machine (one-time):")
    print("  Linux:    sudo trust anchor ca.pem")
    print("  macOS:    open Keychain Access -> add ca.pem as a trusted cert")
    print("  Windows:  certutil -addstore -f \"Root\" ca.pem")
    print()
    print("Then point the dashboard at the leaf cert:")
    print("  export DASHBOARD_TLS_CERT=$(pwd)/server.pem")
    print("  export DASHBOARD_TLS_KEY=$(pwd)/server.key")
    print("  pnpm start")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))