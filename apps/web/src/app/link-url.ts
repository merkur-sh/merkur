/** The path `merkur link` prints: `<origin>/link#<claim-id>.<secret>`. */
export const DAEMON_LINK_PATH = '/link';

/**
 * Takes the daemon link code out of a `/link#<code>` address, once.
 *
 * The code is a secret the daemon printed for this browser, which is why it
 * travels in the fragment: a browser never sends a fragment to the server, so
 * it cannot land in an access log. It is also why the address is rewritten to
 * `/` before anything else runs — left in place it would sit in history, be
 * reloaded into a second approval, and be copied along with the URL.
 */
export function takeDaemonLinkCode(
  location: Pick<Location, 'pathname' | 'hash'>,
  history: Pick<History, 'replaceState'>,
): string | null {
  if (location.pathname !== DAEMON_LINK_PATH) return null;
  const code = decodeURIComponent(location.hash.slice(1)).trim();
  history.replaceState(null, '', '/');
  return code.length > 0 ? code : null;
}
