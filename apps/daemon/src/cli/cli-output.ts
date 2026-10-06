import type { Logger } from '../logger';

/**
 * What a person at a terminal sees from the `merkur` subcommands.
 *
 * The commands keep reporting through the structured `Logger` interface — their
 * events are what the tests and the long-running daemon's log assert on — and
 * this logger renders those same events as sentences: informational lines on
 * stdout, `error:` and `warning:` lines on stderr. The daemon runtime itself
 * (`merkur daemon`, run by the service) keeps the JSON logger, because its output
 * goes to a log file and a collector, not to a person.
 */

type Context = Record<string, unknown>;
/** `null` renders nothing: an expected, handled step nobody needs to read. */
type Render = (context: Context) => string | null;

function field(context: Context, key: string): string {
  const value = context[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

const SENTENCES: Readonly<Record<string, Render>> = {
  // setup
  daemon_setup_usage: (c) => `usage: ${field(c, 'usage')}`,
  daemon_setup_unsupported: (c) => `merkur setup: ${field(c, 'reason')}`,
  daemon_setup_installed: (c) => `Installed Merkur ${field(c, 'version')}.`,
  daemon_setup_already_installed: (c) => `Merkur ${field(c, 'version')} is already installed.`,
  daemon_setup_path: (c) =>
    c.changed === true
      ? `Added ${field(c, 'bin')} to PATH in ${field(c, 'startupFile')}; open a new terminal to use \`merkur\`.`
      : `merkur is at ${field(c, 'bin')}.`,
  daemon_setup_release_key: (c) =>
    `Release key fingerprint: ${field(c, 'fingerprint')}\n` +
    "Compare it with the fingerprint published in Merkur's README.",
  daemon_setup_next: (c) => field(c, 'hint'),
  // link
  daemon_link_usage: (c) => `usage: ${field(c, 'usage')}`,
  daemon_link_invalid_server_origin: () => 'That server address is not a valid https origin.',
  daemon_link_invalid_token: () =>
    'MERKUR_LINK_TOKEN is missing, expired, or not a link token. Copy the link command from Merkur in your browser and run it again.',
  daemon_link_identity_backend: (c) =>
    `This machine's identity is held by: ${field(c, 'backend')}.`,
  daemon_link_code: (c) => `\nTo approve this machine, open this link:\n\n  ${field(c, 'url')}\n`,
  daemon_link_success: (c) => `Linked to ${field(c, 'serverOrigin')}.`,
  daemon_link_machine_usage: (c) => field(c, 'message'),
  daemon_link_machine_limit_reached: (c) => field(c, 'message'),
  daemon_link_failed: (c) =>
    `linking failed: ${[field(c, 'error'), field(c, 'details'), field(c, 'status')].filter((part) => part.length > 0).join(', ')}`,
  daemon_link_identity_failed: (c) =>
    `could not create this machine's identity (${field(c, 'reason')}). ${field(c, 'hint')}`,
  daemon_link_identity_choice_conflict: (c) =>
    `this machine is already linked with a hardware identity. ${field(c, 'hint')}`,
  daemon_link_existing_config_unreadable: () =>
    'the existing ~/.merkur/config.json is unreadable. Use --replace-identity to link a new identity.',
  // install / start / stop
  daemon_install_success: () => 'Merkur is running as a service.',
  daemon_install_failed: (c) =>
    `\`${field(c, 'args')}\` failed (exit ${field(c, 'exitCode')}): ${field(c, 'error')}`,
  daemon_install_launchctl_ignored: () => null,
  daemon_install_systemctl_ignored: () => null,
  daemon_install_linger_enabled: () =>
    'Enabled lingering, so Merkur keeps running after you log out.',
  daemon_install_linger_failed: (c) =>
    `could not enable lingering (${field(c, 'error')}). Run \`${field(c, 'hint')}\` so Merkur keeps running after you log out.`,
  daemon_start_success: () => 'Merkur started.',
  daemon_start_failed: (c) =>
    `\`${field(c, 'args')}\` failed (exit ${field(c, 'exitCode')}): ${field(c, 'error')}`,
  daemon_start_launchctl_ignored: () => null,
  daemon_start_systemctl_ignored: () => null,
  daemon_stop_success: () => 'Merkur stopped. Run `merkur start` to start it again.',
  daemon_stop_force_kill: (c) =>
    `Merkur did not stop cleanly; stopping process ${field(c, 'pid')}.`,
  daemon_stop_launchctl_ignored: () => null,
  daemon_stop_systemctl_ignored: () => null,
  daemon_stop_launchctl_failed: (c) => `Could not stop the service: ${field(c, 'error')}`,
  daemon_stop_systemctl_failed: (c) => `Could not stop the service: ${field(c, 'error')}`,
  daemon_command_failed: (c) => field(c, 'error'),
  // update
  daemon_update_unsupported: (c) => `merkur update: ${field(c, 'reason')}`,
  daemon_update_up_to_date: (c) => `Merkur ${field(c, 'version')} is up to date.`,
  daemon_update_started: (c) => `Updating Merkur ${field(c, 'from')} to ${field(c, 'to')}.`,
  daemon_update_success: (c) => `Updated Merkur to ${field(c, 'to')}.`,
  daemon_update_pruned_version: () => null,
};

/** Any event without a sentence yet still reaches the reader, in plain words. */
function fallback(message: string, context: Context): string {
  const details = Object.entries(context)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  const words = message.replace(/^daemon_/, '').replaceAll('_', ' ');
  return details.length > 0 ? `${words}: ${details}` : words;
}

export function renderCliLine(message: string, context: Context = {}): string | null {
  const render = SENTENCES[message];
  return render === undefined ? fallback(message, context) : render(context);
}

export function createCliLogger(
  write: { stdout(text: string): void; stderr(text: string): void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  color: { stdout: boolean; stderr: boolean } = {
    stdout: cliColor(process.stdout),
    stderr: cliColor(process.stderr),
  },
): Logger {
  return {
    info(message, context = {}) {
      const line = renderCliLine(message, context);
      if (line !== null) {
        const marker = color.stdout && message.endsWith('_success') ? '\x1b[1;32m✓\x1b[0m ' : '';
        write.stdout(`${marker}${styleCliText(line, color.stdout)}\n`);
      }
    },
    warn(message, context = {}) {
      const line = renderCliLine(message, context);
      if (line !== null) {
        const label = color.stderr ? '\x1b[1;33mwarning:\x1b[0m' : 'warning:';
        write.stderr(`${label} ${styleCliText(line, color.stderr)}\n`);
      }
    },
    error(message, context = {}) {
      const line = renderCliLine(message, context);
      if (line !== null) {
        const label = color.stderr ? '\x1b[1;31merror:\x1b[0m' : 'error:';
        write.stderr(`${label} ${styleCliText(line, color.stderr)}\n`);
      }
    },
  };
}

/** Styling follows each destination; pipes and NO_COLOR keep plain text. */
export function cliColor(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function styleCliText(text: string, color: boolean): string {
  const clean = Array.from(text)
    .filter(
      (c) =>
        c === '\n' ||
        c === '\t' ||
        (c.charCodeAt(0) >= 32 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159)),
    )
    .join('');
  return color ? clean.replace(/`([^`]+)`/g, '\x1b[1;36m$1\x1b[0m') : clean;
}
