// `merkur install`, `merkur start`, and `merkur stop` all address the same
// service. Keep the identifiers in one place so they cannot drift apart.
export const DAEMON_LAUNCHD_LABEL = 'dev.merkur.daemon';
export const DAEMON_SYSTEMD_UNIT_NAME = 'merkur-daemon.service';
