# Hosts

OpenTofu (`infra/`) creates the Hetzner hosts, their firewall and private network, and the
Cloudflare zone. The release installs and restarts the software on them; this directory holds
what it installs and `service-hosts.json`, which names every host, its address, the SSH host
key each deploy pins, and the roles it runs.

| Role | Runs | Installed by |
| --- | --- | --- |
| edge and STUN (a host's `edge` and `stun`) | The relay and the STUN responder (systemd) | The release (`scripts/ci/deploy-service-hosts.sh`) |
| app (the host `app` names) | The server and the website (systemd), sqld and Dragonfly (`app/compose.yaml`) | The release (`scripts/ci/deploy-app-host.sh`); the site by Deploy site |
| analytics | Rybbit (`analytics/compose.yaml`) | By hand: `docker compose up -d` in `/srv/analytics` |
| backups | Each role's nightly encrypted backup (`backup/`), `merkur-backup@app.timer` and `merkur-backup@analytics.timer` | The release, for the app; `systemctl enable --now merkur-backup@analytics.timer` by hand |

One host, nbg-1, runs every role. To move a role to a host of its own, add the host to
`infra/hetzner.tf` and `service-hosts.json`, give it the role, install the role's files below
on it, and point the role's DNS records in `infra/cloudflare.tf` at it. Rybbit on its own host
publishes its backend on its private address (10.10.0.0/24), which becomes the site's and the
server's `RYBBIT_HOST`.

## Once per host

Secrets are written on the host and never leave it; nothing in this repository or the release
carries them.

- Every host keeps logs for 30 days, the period the privacy policy states: `host/journald.conf`
  as `/etc/systemd/journald.conf.d/merkur.conf`, and `host/docker-daemon.json` as
  `/etc/docker/daemon.json`, which sends every container's log to the journal.
- Every host has the `merkur-release-deploy` key in root's `authorized_keys`, its private half
  being the `production` environment's `SERVICE_HOSTS_SSH_KEY`. Its host key goes into
  `service-hosts.json` from the Hetzner console, never from a first connection.
- The edge and STUN host keeps `/etc/merkur/edge.secrets.env` and
  `/etc/merkur/stun.secrets.env` (`apps/edge/README.md`, `apps/stun/README.md`).
- The app host holds three things of its own.
  - `/etc/merkur/server.env` holds the server's configuration (README's Configuration table),
    with `DB_URL=http://127.0.0.1:8880`, `REDIS_URL` on `127.0.0.1:6379`,
    `RYBBIT_HOST=http://127.0.0.1:3001` and `TRUSTED_PROXY_HOPS=1`. `/etc/merkur/data.env`
    holds `SQLD_AUTH_JWT_KEY` and `DRAGONFLY_PASSWORD`. Both are mode 0600.
  - `/var/lib/merkur/sqld`, owned by UID 666, which the sqld image runs as.
  - The site deploy key, restricted to its installer:
    `restrict,command="/usr/local/lib/merkur/install-site" ssh-ed25519 …`.
- Every host with the app or analytics role keeps `/etc/merkur/backup.env`: the backup bucket's
  endpoint and name and the write-only key (`bash scripts/tofu.sh output -raw
  backup_access_key_id`, `… backup_secret_access_key`), as `MERKUR_BACKUP_ENDPOINT`,
  `MERKUR_BACKUP_BUCKET`, `MERKUR_BACKUP_ACCESS_KEY_ID` and `MERKUR_BACKUP_SECRET_ACCESS_KEY`,
  and the `age` package.
- The analytics host keeps `/etc/merkur-analytics/secrets.env`, with the Rybbit, Postgres,
  ClickHouse and Redis credentials `analytics/compose.yaml` names, and its data under
  `/var/lib/merkur-analytics`.
- Every host with the app or analytics role runs Caddy from Debian with `caddy/Caddyfile` as
  `/etc/caddy/Caddyfile` and each of its roles' site files in `/etc/caddy/sites`
  (`app/app.caddy`, `analytics/analytics.caddy`). Caddy obtains `app.merkur.sh`'s certificate
  from Let's Encrypt itself. For the names behind Cloudflare it needs the zone's Origin CA
  certificate and key in `/etc/caddy/origin.pem` and `/etc/caddy/origin.key` (`bash
  scripts/tofu.sh output -raw origin_tls_certificate`, `… origin_tls_key`), and Cloudflare's
  ranges in a drop-in, `/etc/systemd/system/caddy.service.d/cloudflare.conf`:
  `Environment="CLOUDFLARE_RANGES=<bash scripts/tofu.sh output -raw cloudflare_ranges>"`.

Hetzner's daily backups are on for nbg-1.

## Restoring a backup

Backups are `<role>/<UTC time>.tar.gz.age` in the `merkur-backups` bucket. Decrypt one on the
owner's machine, the only place the key is:

```sh
age --decrypt -i <(security find-generic-password -a merkur -s merkur-backup-age-identity -w) \
  app.tar.gz.age | tar -xzf -
```

`app/database.jsonl` restores into an empty database with
`bun run apps/server/scripts/database-backup.ts restore --url <url> --in app/database.jsonl`,
which runs the migrations and checks every table's row count. `analytics/postgres.dump` restores
with `pg_restore`, and each ClickHouse table from its `.sql` schema and `.native` rows.
