# Deployment Runbook

How to run the dashboard server as a long-lived service on a Linux box
(Ubuntu 22.04+ in our setup). Covers environment variables, a systemd
unit, where logs live, how to back up, and how to upgrade.

The server is deliberately small — one process, one SQLite file, one
token-store file. There is no queue, no cache, no reverse proxy
required (but you can add one if you want TLS — see [§7](#7-tls-optional)).

---

## 1. Prerequisites

- Linux box with Node 22+ (Ubuntu 22.04 ships Node 18; use `nvm` or
  NodeSource's setup script).
- `pnpm` (`npm i -g pnpm`).
- A non-root user to run the server as. We use `dashboard` in the
  examples below.
- Ports: `8080/tcp` (HTTP). `139/445/tcp` (Samba) and `22/tcp` (SSH)
  only if you also use those services.
- A way to remember a password. Use a password manager; you'll paste
  it into the browser once and the browser caches it.

```bash
# Verify versions
node --version    # v22.x.x
pnpm --version    # 10.x.x
```

---

## 2. Environment variables

The server reads these at boot. There are no other config knobs — there
is no config file by design.

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_PASSWORD` | _(required)_ | The HTTP Basic password the human uses. Bcrypt-hashed in memory at startup; never logged. |
| `PORT` | `8080` | TCP port to listen on. |
| `HOSTNAME` | `0.0.0.0` | Bind address. `0.0.0.0` is fine for a LAN box; switch to `127.0.0.1` if fronted by a reverse proxy on the same host. |
| `DASHBOARD_DATA_DIR` | `./data` | Holds the JSON token store + the SQLite file. Override this in production to keep state out of the project tree. |
| `DASHBOARD_DB_PATH` | `./data/dashboard.db` | SQLite file path. Lives under `DASHBOARD_DATA_DIR` by default. |
| `EMAIL_TOKEN_ENCRYPTION_KEY` | _(required)_ | 64-char hex (32 bytes). AES-256-GCM key for at-rest encryption of OAuth tokens. Generate with `openssl rand -hex 32`. Missing → boot fails. |
| `GOOGLE_OAUTH_CLIENT_ID` | _(required)_ | OAuth client id from the Google Cloud Console. Missing → boot fails. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | _(required)_ | OAuth client secret from the Google Cloud Console. Missing → boot fails. |
| `EMAIL_OAUTH_REDIRECT_URI` | _(required)_ | Full callback URL. **Two rules from Google's Web-app client:** the host must be loopback (`localhost`/`127.0.0.1`) or a publicly resolvable domain (no bare private IPs), and the scheme must be `https://` unless the host is loopback. So same-machine testing uses `http://localhost:8080/api/email/oauth/callback`; LAN testing needs `https://192.168.0.136.nip.io:8080/...` (HTTPS required). See the redirect-URI-rules section below for tunnel (`ngrok` / `cloudflared`) and `trustme`/`mkcert` options. Must match the value registered in the Cloud Console byte-for-byte. |
| `DASHBOARD_TLS_CERT` | _(optional)_ | Absolute path to a PEM-encoded TLS certificate. Required for non-loopback redirect URIs (HTTPS). Pairs with `DASHBOARD_TLS_KEY`. Both vars must be set together; setting only one is a startup error. Generate cert + key with `trustme` (Python) or `mkcert` (Go binary). |
| `DASHBOARD_TLS_KEY` | _(optional)_ | Absolute path to a PEM-encoded TLS private key. Pairs with `DASHBOARD_TLS_CERT`. |
| `LLM_API_KEY` | _(optional)_ | Server-side MiniMax API key. Enables YouTube Insight Cards; never expose this value to browser code. |
| `LLM_BASE_URL` | `https://api.minimax.io/v1` | OpenAI-compatible text API base URL. |
| `LLM_MODEL` | `MiniMax-M2.7` | Model used for transcript summaries. |

**Never commit the password** or the encryption key to source control.
Pass them via systemd's `EnvironmentFile=` directive (see §3) or your
secret manager.

### Minimal environment file

```ini
# /etc/dashboard/dashboard.env — mode 0600, owned by root:dashboard
DASHBOARD_PASSWORD=your-strong-password
PORT=8080
HOSTNAME=0.0.0.0
DASHBOARD_DATA_DIR=/var/lib/dashboard
DASHBOARD_DB_PATH=/var/lib/dashboard/dashboard.db

# Email (issue #020) — required for OAuth/Gmail to work. The encryption
# key encrypts OAuth tokens at rest; losing it locks you out of stored
# credentials. Treat it like the password.
EMAIL_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
EMAIL_OAUTH_REDIRECT_URI=http://localhost:8080/api/email/oauth/callback

# Optional: MiniMax-powered YouTube Insight Cards
LLM_API_KEY=your-minimax-api-key
LLM_BASE_URL=https://api.minimax.io/v1
LLM_MODEL=MiniMax-M2.7

# Optional: enable HTTPS for non-loopback redirect URIs (LAN testing, etc.)
# DASHBOARD_TLS_CERT=/etc/dashboard/certs/server.pem
# DASHBOARD_TLS_KEY=/etc/dashboard/certs/server.key
```

```bash
sudo mkdir -p /etc/dashboard
sudo touch /etc/dashboard/dashboard.env
sudo chmod 0640 /etc/dashboard/dashboard.env
sudo chown root:dashboard /etc/dashboard/dashboard.env
sudoedit /etc/dashboard/dashboard.env
```

---

## 3. systemd unit

A single unit file. Place it at `/etc/systemd/system/dashboard.service`.

```ini
# /etc/systemd/system/dashboard.service
[Unit]
Description=Dashboard server (Hono on Node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dashboard
Group=dashboard

# ── Environment ──────────────────────────────────────────────────────
EnvironmentFile=/etc/dashboard/dashboard.env

# ── Working directory + exec ─────────────────────────────────────────
WorkingDirectory=/opt/dashboard/server
ExecStart=/usr/bin/pnpm start

# ── Hardening ────────────────────────────────────────────────────────
# No new privileges (drops any ambient caps); protect /tmp and /home.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# Only the data dir needs to be writable.
ReadWritePaths=/var/lib/dashboard

# Auto-restart on crash, but not on graceful exit.
Restart=on-failure
RestartSec=5s

# Send SIGTERM and give it 10s to drain in-flight requests before SIGKILL.
KillSignal=SIGTERM
TimeoutStopSec=10s

# Console logs go to journald.
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dashboard

[Install]
WantedBy=multi-user.target
```

### First-time setup

```bash
# 1. Create the user
sudo useradd --system --shell /usr/sbin/nologin --home /opt/dashboard dashboard

# 2. Lay out the data dir
sudo mkdir -p /var/lib/dashboard
sudo chown -R dashboard:dashboard /var/lib/dashboard

# 3. Deploy the server code
sudo mkdir -p /opt/dashboard
sudo chown -R dashboard:dashboard /opt/dashboard
sudo -u dashboard git clone <repo-url> /opt/dashboard
sudo -u dashboard bash -c 'cd /opt/dashboard/server && pnpm install --prod'

# 4. Install the unit
sudo install -m 0644 docs/deployment/dashboard.service /etc/systemd/system/dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard.service

# 5. Confirm it's listening
sudo systemctl status dashboard.service
sudo journalctl -u dashboard.service -n 50 --no-pager
curl -fsS -u "you:$DASHBOARD_PASSWORD" http://127.0.0.1:8080/health
```

The server prints `Dashboard listening on http://0.0.0.0:8080` to the
journal once it's ready. `curl http://<host>:8080/health` returns
`{"status":"ok"}` (with auth).

---

## 4. Gmail setup (one-time)

If you plan to mirror Gmail into the dashboard (issue #020), complete
this once per dashboard host before users can click "Connect Gmail" at
`/settings/email`. The setup steps are also documented inline on the
page itself.

1. **Create or pick a Google Cloud project.** Open the
   [Google Cloud Console](https://console.cloud.google.com/).

2. **Enable the Gmail API.** Navigate to
   *APIs & Services → Library*, search for **Gmail API**, and click
   *Enable*.

3. **Configure the OAuth consent screen.** Navigate to
   *APIs & Services → OAuth consent screen*. Choose *External* (or
   *Internal* if you're on a Google Workspace org). For *Scopes*, add
   exactly `https://www.googleapis.com/auth/gmail.readonly` — do NOT
   add `gmail.modify`, `gmail.send`, or `gmail.compose`. The dashboard
   is read-only by design.

4. **Create OAuth credentials.** Navigate to
   *APIs & Services → Credentials → Create credentials → OAuth client
   ID*. Choose **Web application**. Under *Authorized redirect URIs*,
   add the URL the dashboard serves. **Pick the right one:**

   * **Same-machine testing (no TLS, no extra tools):** use
     `http://localhost:8080/api/email/oauth/callback` (or
     `http://127.0.0.1:8080/...`). Google still allows `http` for
     loopback. Limitation: can't test from a phone or another laptop.

   * **Tunnel (one line, no cert management):** run a public HTTPS
     tunnel in front of the dashboard. Free options:
     ```bash
     ngrok http 8080
     # or
     cloudflared tunnel --url http://localhost:8080
     ```
     Copy the resulting `https://<random>.ngrok-free.app` /
     `https://<random>.trycloudflare.com` URL into both the Cloud
     Console and `EMAIL_OAUTH_REDIRECT_URI`. URL changes every
     restart on free tiers, so update the env var accordingly.

   * **LAN with TLS (no external dependency):** if you want
     `https://192.168.0.136.nip.io:8080/...` without a tunnel, run
     the dashboard over HTTPS directly. You need a cert trusted
     by your browser. Pick whichever generator fits your tooling:

   * **`pnpm certgen` (recommended)** — pure Node, no Python, no
     separate installs, single command:
     ```bash
     pnpm certgen 192.168.0.136.nip.io 192.168.0.136

     # Trust the CA on this machine (pick the one for your OS)
     # Debian/Ubuntu (no p11-kit needed):
     sudo cp ca.pem /usr/local/share/ca-certificates/dashboard-ca.crt
     sudo update-ca-certificates
     # Fedora / Arch (p11-kit):
     # sudo trust anchor ca.pem
     # macOS:
     # sudo security add-trusted-cert -d -r trustRoot \
     #   -k /Library/Keychains/System.keychain ca.pem
     # Windows (admin PowerShell):
     # certutil -addstore -f "Root" ca.pem
     ```

   * **[`mkcert`](https://github.com/FiloSottile/mkcert) (no Python):**
     single Go binary. `brew install mkcert && mkcert -install && mkcert 192.168.0.136.nip.io`
     produces equivalent `cert.pem` + `key.pem` files.

   * **`pip install trustme` (Python fallback)** — only if (a) and (b)
     don't work for you:
     ```bash
     pip install trustme
     python3 scripts/gencert.py 192.168.0.136.nip.io 192.168.0.136
     ```

   Then point the dashboard at the cert + key (no reverse proxy needed):
   ```bash
   echo "DASHBOARD_TLS_CERT=$(pwd)/server.pem" >> .env
   echo "DASHBOARD_TLS_KEY=$(pwd)/server.key"  >> .env
   pnpm start
   # → Dashboard listening on https://192.168.0.136:8080
   ```
   Register `https://192.168.0.136.nip.io:8080/api/email/oauth/callback`
   in the Cloud Console once the server is up.

   * **Production:** any real domain, e.g.
     `https://mail.example.com/api/email/oauth/callback`.

   The value MUST match the `EMAIL_OAUTH_REDIRECT_URI` env var
   byte-for-byte — host, port, scheme, trailing slash all count.
   Google rejects mismatches silently at consent time.

5. **Copy the client id + secret** into `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET`. If you lost the secret, click the
   *Reset secret* button on the credentials page to issue a new one.

6. **Generate an encryption key** for OAuth tokens at rest:

   ```bash
   openssl rand -hex 32
   ```

   Paste the result into `EMAIL_TOKEN_ENCRYPTION_KEY` (64 hex characters,
   no spaces). Treat this key like the dashboard password — losing it
   locks you out of stored OAuth credentials; rotating it requires
   reconnecting every Gmail account.

7. **Set `EMAIL_OAUTH_REDIRECT_URI`** to the *exact* URL from step 4
   (including scheme + port + path).

8. **Restart the dashboard.** The server refuses to start if any of
   the four email env vars is missing or malformed; the boot error
   message names the missing variable.

```ini
# /etc/dashboard/dashboard.env (append)
EMAIL_TOKEN_ENCRYPTION_KEY=<64 hex chars from step 6>
GOOGLE_OAUTH_CLIENT_ID=<from step 5>
GOOGLE_OAUTH_CLIENT_SECRET=<from step 5>
EMAIL_OAUTH_REDIRECT_URI=<exact URL from step 4>
```

After restart, visit `/settings/email` and click **Connect Gmail** —
the consent screen will list exactly one scope (`gmail.readonly`).
After consent, your email address appears in the connected account
list and the dashboard is ready to run the initial sync (issue #021,
separate PR).

### Manual smoke test for the OAuth round-trip

The acceptance criteria for issue #020 include "manual smoke test
(documented in slice): OAuth round-trip against a real Gmail account
works end-to-end." After the setup above, run:

1. Open `http://<host>:8080/settings/email` in a browser.
2. Click **Connect Gmail**. Confirm the consent screen lists *only*
   `gmail.readonly`. (If it lists more, your OAuth client's scope
   config drifted — re-check step 3.)
3. Grant access. You should land back on `/settings/email?status=connected`
   with your Gmail address visible.
4. Click **Disconnect**. Confirm the row disappears.

If any step fails, check `journalctl -u dashboard.service` for the
server-side error. Token exchange failures usually mean the redirect
URI mismatch; profile failures usually mean the Gmail API isn't enabled
on the project.

## 5. Logs

`StandardOutput=journal` and `StandardError=journal` route everything
to systemd's journal.

```bash
# Tail the live log
sudo journalctl -u dashboard.service -f

# Show the last 200 lines
sudo journalctl -u dashboard.service -n 200 --no-pager

# Logs since 10 minutes ago
sudo journalctl -u dashboard.service --since "10 minutes ago"
```

By default journald retains logs in `/var/log/journal/` (persistent
when that directory exists) or `/run/log/journal/` (volatile). To
prevent runaway growth:

```ini
# /etc/systemd/journald.conf.d/dashboard.conf
[Journal]
SystemMaxUse=500M
```

Then `sudo systemctl restart systemd-journald`.

The server itself does not write to any file inside `DASHBOARD_DATA_DIR`.

---

## 6. Backups

**The SQLite file is the source of truth.** Back it up; the rest is
cheap to regenerate.

### What to back up

| File | Why | Frequency |
|------|-----|-----------|
| `/var/lib/dashboard/dashboard.db` | All folders, bookmarks, tags | Daily |
| `/var/lib/dashboard/tokens.json` | API token hashes (rotate by re-creating if lost) | Weekly |
| `/etc/dashboard/dashboard.env` | The password (mode 0600) | On change |

The DB file is small (we measured 90 KB for 1,000 bookmarks, 1 MB for
~10,000). A weekly snapshot is plenty.

### Snapshot script

The repo ships a backup script at `scripts/backup.sh`. Drop it in
place and cron it:

```bash
sudo install -m 0755 scripts/backup.sh /opt/dashboard/scripts/backup.sh
sudo tee /etc/cron.d/dashboard-backup > /dev/null <<'CRON'
15 3 * * * dashboard /opt/dashboard/scripts/backup.sh
CRON
```

The script itself is small (about 25 lines); it calls
`sqlite3 .backup` to get a consistent snapshot and rotates
old snapshots after 30 days:

```bash
#!/usr/bin/env bash
# /opt/dashboard/scripts/backup.sh
set -euo pipefail
BACKUP_DIR=${BACKUP_DIR:-/var/backups/dashboard}
DB=${DB:-/var/lib/dashboard/dashboard.db}
RETAIN_DAYS=${RETAIN_DAYS:-30}
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/dashboard-$STAMP.db"
sqlite3 "$DB" ".backup '$DEST'"
find "$BACKUP_DIR" -name 'dashboard-*.db' -mtime "+$RETAIN_DAYS" -delete
echo "Wrote $DEST"
```

### Restore

```bash
# 1. Stop the server so it doesn't hold the file open with a stale view.
sudo systemctl stop dashboard.service

# 2. Replace the SQLite file.
sudo cp /var/backups/dashboard/dashboard-20260101-031500.db \
        /var/lib/dashboard/dashboard.db
sudo chown dashboard:dashboard /var/lib/dashboard/dashboard.db

# 3. Restart.
sudo systemctl start dashboard.service
```

The schema migrations apply on boot; restoring an older DB file
naturally re-applies any newer migrations on next start.

### Off-site backups

The script above writes to a local directory. Push them off-site with
whatever you already use — `restic` + Backblaze B2, `borg` + a friend's
box, `rclone` + your cloud of choice. None of that is specific to the
dashboard.

---

## 7. TLS (optional)

The dashboard is LAN-only in our setup (ADR-001), so HTTP is fine for
`192.168.0.0/24`. If you want TLS:

- **Easiest**: front the server with `caddy` or `nginx` and terminate
  TLS there. The dashboard keeps `HOSTNAME=127.0.0.1` and binds to
  loopback. `caddy` is one line: `reverse_proxy 127.0.0.1:8080`.
- **Self-signed**: works but Chrome will warn on every visit; you'll
  need to whitelist the cert in `chrome://settings/security`.
- **Let's Encrypt**: works only if the host has a public DNS name and
  reachable port 80/443. Not the typical use case for this server.

The extension also talks plain HTTP to `http://192.168.0.136:8080`.
Mixed content rules don't apply because the extension runs from
`chrome://` (not a secure origin), so it can POST to `http://` URLs
without complaint.

---

## 8. Upgrading

There is no installer — the deployment is just `git pull && pnpm
install --prod`. The server reads the code at boot, so a clean
restart picks up new behavior.

```bash
sudo -u dashboard bash -c 'cd /opt/dashboard && git pull && pnpm --dir server install --prod'
sudo systemctl restart dashboard.service
```

Schema changes land as numbered SQL files under `migrations/`. They
apply automatically on boot; no separate `migrate` step. To preview
what will run before restarting:

```bash
sqlite3 /var/lib/dashboard/dashboard.db "SELECT id, name, applied_at FROM migrations ORDER BY id;"
```

If you restore an older DB from backup, the next boot will re-apply
any newer migrations automatically. The runner is idempotent (it
records each applied migration by name in the `migrations` table).

---

## 9. Firewall (UFW)

```bash
# Allow LAN access to the dashboard
sudo ufw allow from 192.168.0.0/24 to any port 8080 proto tcp

# Reject everything else
sudo ufw default deny incoming
sudo ufw enable
```

For non-UFW setups, replace with the equivalent `iptables` or
`firewalld` rule. The key constraint: only the LAN should be able to
reach port 8080.

---

## 10. Health checks

The server exposes `/health` (auth required) returning
`{"status":"ok"}`. Wire it to your monitoring:

```bash
# One-liner from cron
curl -fsS -u "you:$DASHBOARD_PASSWORD" http://127.0.0.1:8080/health
```

systemd's `WatchdogSec` is **not** used because the server doesn't
respond to `sd_notify(WATCHDOG=1)` pings. Use external monitoring
instead (a 30s `curl` from cron, or whatever observability tool you
already run).

---

## 11. Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE: address already in use 0.0.0.0:8080` | Another process (or a stale `tsx`) holds the port | `sudo lsof -i :8080`; kill the offender or change `PORT` |
| `DASHBOARD_PASSWORD is not set` at boot | The `EnvironmentFile=` line is missing or unreadable | `sudo systemctl show dashboard -p EnvironmentFiles`; check mode 0640 ownership |
| 401 with correct password | Browser cached the old credentials; or the password was rotated | Reload the page; re-type the password |
| `cannot open database file` | The `dashboard` user can't read `/var/lib/dashboard/` | `sudo chown -R dashboard:dashboard /var/lib/dashboard` |
| `EACCES` on `pnpm install` | The `/opt/dashboard` dir isn't owned by `dashboard` | `sudo chown -R dashboard:dashboard /opt/dashboard` |

---

## 12. Quick reference

```bash
# Status
sudo systemctl status dashboard.service

# Tail logs
sudo journalctl -u dashboard.service -f

# Restart (picks up new code)
sudo systemctl restart dashboard.service

# Rotate the password
sudoedit /etc/dashboard/dashboard.env
sudo systemctl restart dashboard.service
# Then: in the browser, reload the page; the browser will prompt for the new password.

# Take a manual backup
sudo -u dashboard sqlite3 /var/lib/dashboard/dashboard.db ".backup '/var/backups/dashboard/manual-$(date +%Y%m%d).db'"

# Tail DB queries (debug only — turns on SQLite tracing)
sudo systemctl edit dashboard
# add: Environment=DEBUG_SQL=1
sudo systemctl restart dashboard.service
```
