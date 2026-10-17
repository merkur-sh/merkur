#!/usr/bin/env bash
# The nightly off-site backup of one role's data, run by merkur-backup@<role>.timer:
#
#   merkur-backup app        the Merkur database, a logical dump the release's own tool takes
#   merkur-backup analytics  Rybbit's Postgres and ClickHouse
#
# The archive is encrypted on this host to the owner's age key (recipient.txt), whose private
# half never reaches a host, and uploaded to the R2 bucket infra/backups.tf declares, which
# locks every object for 30 days and expires it after 35. /etc/merkur/backup.env holds the
# bucket's endpoint and this host's write-only key.
set -euo pipefail
role="${1:?usage: merkur-backup <app|analytics>}"
lib=/usr/local/lib/merkur
# shellcheck source=/dev/null
. /etc/merkur/backup.env
: "${MERKUR_BACKUP_ENDPOINT:?}" "${MERKUR_BACKUP_BUCKET:?}"
: "${MERKUR_BACKUP_ACCESS_KEY_ID:?}" "${MERKUR_BACKUP_SECRET_ACCESS_KEY:?}"

work=$(mktemp -d /var/tmp/merkur-backup.XXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir "$work/$role"

case "$role" in
  app)
    # server.env is a systemd environment file, not shell: read the two values it needs.
    url=$(sed -n 's/^DB_URL=//p' /etc/merkur/server.env)
    DB_AUTH_TOKEN=$(sed -n 's/^DB_AUTH_TOKEN=//p' /etc/merkur/server.env) BUN_BE_BUN=1 \
      "$lib/server/current/server/server" "$lib/server/current/tools/database-backup.js" \
      dump --url "$url" --out "$work/app/database.jsonl" > /dev/null
    ;;
  analytics)
    cd /srv/analytics
    docker compose exec -T postgres pg_dump --username rybbit --format custom analytics \
      > "$work/analytics/postgres.dump"
    # The query reaches clickhouse-client as an argument; the password is the container's own.
    # shellcheck disable=SC2016
    clickhouse() {
      docker compose exec -T clickhouse sh -c 'clickhouse-client --password "$CLICKHOUSE_PASSWORD" --query "$1"' sh "$1"
    }
    for table in $(clickhouse 'SHOW TABLES FROM analytics'); do
      clickhouse "SHOW CREATE TABLE analytics.$table FORMAT TSVRaw" > "$work/analytics/$table.sql"
      clickhouse "SELECT * FROM analytics.$table FORMAT Native" > "$work/analytics/$table.native"
    done
    ;;
  *)
    echo "unknown role: $role" >&2
    exit 1
    ;;
esac

archive="$work/backup.tar.gz.age"
tar -C "$work" -czf - "$role" | age --encrypt --recipients-file "$lib/backup-recipient.txt" > "$archive"
key="$role/$(date -u +%Y-%m-%dT%H-%M-%SZ).tar.gz.age"
curl --fail --silent --show-error --aws-sigv4 'aws:amz:auto:s3' \
  --user "$MERKUR_BACKUP_ACCESS_KEY_ID:$MERKUR_BACKUP_SECRET_ACCESS_KEY" \
  --upload-file "$archive" "$MERKUR_BACKUP_ENDPOINT/$MERKUR_BACKUP_BUCKET/$key"
echo "backup uploaded: $key ($(stat -c %s "$archive") bytes)"
