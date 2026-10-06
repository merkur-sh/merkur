import { cliColor } from './cli-output';
import { CLI_ORB } from './orb';

const ACCOUNT_OPTIONS = `  --state-dir <path>       Directory for this terminal's saved account
  --origin <url>           Server address for first sign-in
  --opaque-server-key <key>
                          Server's pinned key, in base64url
  --username <name>        Account name (otherwise prompted)
  --identity-seal <hardware|software>
                          Custody of this terminal's login key`;

const SESSION_OPTIONS = `${ACCOUNT_OPTIONS}
  --edge-port <port>       Override the relay port
  --relay-only            Use the relay without a direct connection`;

const HELP: Readonly<Record<string, { description: string; usage: string; body: string }>> = {
  login: {
    description: 'Sign in and save this terminal as an account client.',
    usage: 'merkur login [options]',
    body: `Passwords are entered securely in the terminal, never as arguments.
After signing in, run merkur to choose a machine.

OPTIONS
${ACCOUNT_OPTIONS}`,
  },
  logout: {
    description: 'Revoke this terminal client and remove its saved account.',
    usage: 'merkur logout [--state-dir <path>]',
    body: 'Other clients and linked machines remain signed in.',
  },
  machines: {
    description: 'List the machines in your account.',
    usage: 'merkur machines [--state-dir <path>]',
    body: `EXAMPLES
  merkur machines
  merkur connect "Work laptop"

Sign in with merkur login first. Output is a tab-separated list.`,
  },
  connect: {
    description: 'Open a terminal on a machine by ID or exact name.',
    usage: 'merkur connect <machine> [options]',
    body: `EXAMPLES
  merkur connect "Work laptop"
  merkur machines                  Find a machine's name or ID

SHORTCUTS
  Ctrl-\\ then ?                   Open the shortcut guide
  Ctrl-\\ then l                   Return to machines
  Ctrl-\\ then q                   Quit Merkur
  Ctrl-\\ twice                    Send Ctrl-\\ to the machine

OPTIONS
${SESSION_OPTIONS}
  --machine <id>          Alternative to the positional machine name`,
  },
  link: {
    description: 'Make this machine available in your Merkur account.',
    usage: 'merkur link <origin> [--identity-backend software] [--replace-identity]',
    body: `GET STARTED
  Copy the link command from Merkur in your browser.
  It sets MERKUR_LINK_TOKEN, which this command requires.
  Open the printed approval link or scan its QR code to approve.

OPTIONS
  --identity-backend software
                           Explicitly store the identity without hardware
  --replace-identity       Create a new identity when relinking`,
  },
  install: {
    description: 'Install and start the background service for this machine.',
    usage: 'merkur install',
    body: 'Link this machine from your browser before installing the service.',
  },
  start: {
    description: 'Start the background service after stopping it.',
    usage: 'merkur start',
    body: 'This makes the linked machine available again. Use merkur to connect.',
  },
  stop: {
    description: 'Stop the background service on this machine.',
    usage: 'merkur stop',
    body: 'Active terminals on this machine disconnect. Run merkur start to resume service.',
  },
  update: {
    description: 'Install the newest signed Merkur release.',
    usage: 'merkur update',
    body: 'The release signature is verified before installation.',
  },
  open: {
    description: 'Request a URL in the browser or terminal client viewing this session.',
    usage: 'merkur open <http(s)-url>',
    body: `EXAMPLE
  merkur open https://example.com

Run inside a Merkur terminal. The viewer asks you to approve opening the URL.`,
  },
  'shell-integration': {
    description: 'Print the shell snippet for prompt detection and speculative echo.',
    usage: 'merkur shell-integration [bash|zsh|fish]',
    body: `EXAMPLES
  eval "$(merkur shell-integration bash)"
  eval "$(merkur shell-integration zsh)"
  merkur shell-integration fish | source

Add the command for your shell to its startup file.`,
  },
  setup: {
    description: 'Install a signed release archive. Used by the installer script.',
    usage: 'merkur setup <archive> <manifest> <signature> [--link <origin>]',
    body: 'To install and link a machine, use the command from Merkur in your browser.',
  },
  daemon: {
    description: 'Run the daemon in the foreground. Used by the background service.',
    usage: 'merkur daemon',
    body: 'For everyday use, run merkur install, merkur start, or merkur stop.',
  },
  version: {
    description: "Print this build's version.",
    usage: 'merkur version',
    body: 'Also available as merkur --version or merkur -v.',
  },
  'release-key': {
    description: 'Print the fingerprint of the release key this build trusts.',
    usage: 'merkur release-key',
    body: "Compare it with the fingerprint published in Merkur's README.",
  },
  licenses: {
    description: "Print Merkur's license and every dependency's notices.",
    usage: 'merkur licenses',
    body: 'EXAMPLE\n  merkur licenses > merkur-licenses.txt',
  },
  help: {
    description: 'Show the command guide or help for one command.',
    usage: 'merkur help [command]',
    body: 'EXAMPLES\n  merkur help connect\n  merkur connect --help',
  },
};

const OVERVIEW = `MERKUR
Your terminal, from anywhere.

GET STARTED
  merkur                          Choose a machine and open a terminal
  merkur connect "Work laptop"    Go straight to a machine

YOUR ACCOUNT
  login              Sign in securely in the terminal
  logout             Sign this terminal client out
  machines           List machine names, IDs, and availability
  connect <machine>  Connect by ID or exact name

THIS MACHINE
  link <origin>      Link using the command from your browser
  install            Install and start the background service
  start / stop       Start or stop the background service
  update             Install the newest signed release

TOOLS
  open <url>         Request a URL in the connected viewer
  shell-integration  Print integration for bash, zsh, or fish
  version            Print the build version
  release-key        Print the trusted release key fingerprint
  licenses           Print license and dependency notices
  setup              Install an archive (used by the installer)
  daemon             Run in the foreground (used by the service)
  help [command]     Show focused help, options, and examples

IN A SESSION
  Ctrl-\\ then ? opens the shortcut guide. Ctrl-\\ then q quits.

Run merkur help connect for terminal options and first sign-in.
https://github.com/merkur-sh/merkur
`;

/** All public help entry points share the same command guide. */
export function renderCliHelp(topic?: string, color = cliColor(process.stdout)): string | null {
  const entry = topic !== undefined && Object.hasOwn(HELP, topic) ? HELP[topic] : undefined;
  if (topic !== undefined && entry === undefined) return null;
  const text =
    entry === undefined
      ? OVERVIEW
      : `MERKUR / ${topic}\n${entry.description}\n\nUSAGE\n  ${entry.usage}\n\n${entry.body}\n\nRun merkur help for all commands.\n`;
  if (!color) return text;
  const styled = text
    .replace(/^MERKUR.*$/m, '\x1b[1;38;2;183;162;255m$&\x1b[0m')
    .replace(/^[A-Z][A-Z ]+$/gm, '\x1b[1m$&\x1b[0m');
  return topic === undefined ? `${CLI_ORB}\n\n${styled}` : styled;
}
