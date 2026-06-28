#!/usr/bin/env bash
# backup.sh — cron-friendly snapshot of the dashboard SQLite file.
#
# Runs `sqlite3 .backup` to get a consistent snapshot even while the
# server is writing, then prunes anything older than 30 days.
#
# Install:
#   sudo install -m 0755 scripts/backup.sh /opt/dashboard/scripts/backup.sh
#   sudo tee /etc/cron.d/dashboard-backup > /dev/null <<'CRON'
#   15 3 * * * dashboard /opt/dashboard/scripts/backup.sh
#   CRON

set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/var/backups/dashboard}
DB=${DB:-/var/lib/dashboard/dashboard.db}
RETAIN_DAYS=${RETAIN_DAYS:-30}

mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/dashboard-$STAMP.db"

# .backup runs sqlite3's online backup API and produces a consistent
# snapshot even if writers are active. This is the right primitive
# for "snapshot the live DB without taking it offline".
sqlite3 "$DB" ".backup '$DEST'"

# Retain the last N days of snapshots.
find "$BACKUP_DIR" -name 'dashboard-*.db' -mtime "+$RETAIN_DAYS" -delete

echo "Wrote $DEST"