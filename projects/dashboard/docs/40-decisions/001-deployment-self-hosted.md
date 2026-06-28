# ADR-001: Self-hosted LAN deployment

**Status**: Accepted
**Date**: 2026-06-28
**Authors**: David

## Context

The dashboard needs to live somewhere. It's a personal app serving one user (David) with sensitive data (bookmarks, browsing history, watch history).

The user has two Windows machines (personal + shop) and an in-house Ubuntu server on the same LAN that already hosts other self-hosted apps.

## Decision Drivers

- Data is personal and sensitive — should not be exposed to the public internet by default
- Should be accessible from both Windows machines without manual file syncing
- Should outlive a single browser session — local-only on one machine is fragile
- The user already runs self-hosted services on Ubuntu — pattern is established

## Decision

**Self-hosted on the Ubuntu server, LAN-accessible.** The dashboard runs on `http://ubuntu-server:<port>` and is reachable from any device on the LAN.

- No cloud hosting (no VPS, no Fly.io, no Railway)
- No public exposure by default (no port forwarding, no public domain)
- LAN access covers both Windows machines via the local network

## Consequences

**Positive:**
- No cloud costs, no vendor lock-in
- Data stays on hardware the user controls
- LAN latency is trivial — extension POSTs feel instant
- One server already hosts everything else — operational simplicity

**Negative:**
- Not reachable from outside the LAN without additional setup (Tailscale, VPN, or port forwarding)
- Server uptime = dashboard uptime (the Ubuntu server must be running)
- Backing up the server = backing up the dashboard (no managed snapshots)