# Hosts

OpenTofu (`infra/`) creates the Hetzner hosts, their firewalls and private network, and the
Cloudflare zone. The release installs and restarts the software on them; this directory holds
what it installs and `service-hosts.json`, which names every host, its address and the SSH
host key each deploy pins.

| Host | Runs | Installed by |
| --- | --- | --- |
| `app` (app-1) | The server and the website (systemd), sqld and Dragonfly (`app/compose.yaml`), Caddy | The release (`scripts/ci/deploy-app-host.sh`); the site by Deploy site |
| analytics-1 | Rybbit (`analytics/compose.yaml`), Caddy | By hand: `docker compose up -d` in `/srv/analytics` |
| `hosts` (nbg-1) | The edge relay and the STUN responder (systemd) | The release (`scripts/ci/deploy-service-hosts.sh`) |

## Once per host

Secrets are written on the host and never leave it; nothing in this repository or the release
carries them.

- Every host has the `merkur-release-deploy` key in root's `authorized_keys`, its private half
  being the `production` environment's `SERVICE_HOSTS_SSH_KEY`. Its host key goes into
  `service-hosts.json` from the Hetzner console, never from a first connection.
- app-1 holds three things of its own.
  - `/etc/merkur/server.env` holds the server's configuration (README's Configuration table),
    with `DB_URL=http://127.0.0.1:8880`, `REDIS_URL` on `127.0.0.1:6379` and
    `TRUSTED_PROXY_HOPS=1`. `/etc/merkur/data.env` holds `SQLD_AUTH_JWT_KEY` and
    `DRAGONFLY_PASSWORD`. Both are mode 0600.
  - `/var/lib/merkur/sqld`, owned by UID 666, which the sqld image runs as.
  - The site deploy key, restricted to its installer:
    `restrict,command="/usr/local/lib/merkur/install-site" ssh-ed25519 …`.
- app-1 and analytics-1 run Caddy from Debian, its configuration in `/etc/caddy/Caddyfile`
  (`app/Caddyfile`, `analytics/Caddyfile`). On app-1 Caddy obtains `app.merkur.sh`'s
  certificate from Let's Encrypt itself. For the names behind Cloudflare it needs the zone's
  Origin CA certificate and key in
  `/etc/caddy/origin.pem` and `/etc/caddy/origin.key` (`bash scripts/tofu.sh output -raw
  origin_tls_certificate`, `… origin_tls_key`), and Cloudflare's ranges in a drop-in,
  `/etc/systemd/system/caddy.service.d/cloudflare.conf`:
  `Environment="CLOUDFLARE_RANGES=<bash scripts/tofu.sh output -raw cloudflare_ranges>"`.
- analytics-1 keeps `/etc/merkur-analytics/secrets.env`, with the Rybbit, Postgres, ClickHouse
  and Redis credentials `analytics/compose.yaml` names.
- nbg-1 keeps `/etc/merkur/edge.secrets.env` and `/etc/merkur/stun.secrets.env`
  (`apps/edge/README.md`, `apps/stun/README.md`).

Hetzner's daily backups are on for app-1 and analytics-1.
