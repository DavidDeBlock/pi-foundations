# Deployment Runbook

How to run the dashboard server as a long-lived service on a Linux box
(Ubuntu 22.04+ in our setup). Covers environment variables, a systemd
unit, where logs live, how to back up, and how to upgrade.

The server is deliberately small — one process, one SQLite file, one
token-store file. There is no queue, no cache, no reverse proxy
required (but you can add one if you want TLS — see [§6](#6-tls-optional)).

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

**Never commit the password** to source control. Pass it via systemd's
`EnvironmentFile=` directive (see §3) or your secret manager.

### Minimal environment file

```ini
# /etc/dashboard/dashboard.env — mode 0600, owned by root:dashboard
DASHBOARD_PASSWORD=your-strong-password
PORT=8080
HOSTNAME=0.0.0.0
DASHBOARD_DATA_DIR=/var/lib/dashboard
DASHBOARD_DB_PATH=/var/lib/dashboard/dashboard.db
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

## 4. Logs

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

## 5. Backups

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

## 6. TLS (optional)

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

## 7. Upgrading

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

## 8. Firewall (UFW)

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

## 9. Health checks

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

## 10. Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EADDRINUSE: address already in use 0.0.0.0:8080` | Another process (or a stale `tsx`) holds the port | `sudo lsof -i :8080`; kill the offender or change `PORT` |
| `DASHBOARD_PASSWORD is not set` at boot | The `EnvironmentFile=` line is missing or unreadable | `sudo systemctl show dashboard -p EnvironmentFiles`; check mode 0640 ownership |
| 401 with correct password | Browser cached the old credentials; or the password was rotated | Reload the page; re-type the password |
| `cannot open database file` | The `dashboard` user can't read `/var/lib/dashboard/` | `sudo chown -R dashboard:dashboard /var/lib/dashboard` |
| `EACCES` on `pnpm install` | The `/opt/dashboard` dir isn't owned by `dashboard` | `sudo chown -R dashboard:dashboard /opt/dashboard` |

---

## 11. Quick reference

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