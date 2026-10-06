import type { BrowserClient } from '@merkur/shared';
import { parseBrowser } from '@merkur/user-agent';

/**
 * Names the browser a delegation is being issued to, from the headers of the
 * issuing request.
 *
 * Merkur's parser returns only fixed browser/OS labels, or null. Client Hints
 * select each field's source when present; absent hints use the User-Agent.
 * Malformed, ambiguous, unsupported, and oversized hints produce no name.
 *
 * These are display metadata, never authenticated device identity. The parser
 * stays server-side rather than entering the web bundle through shared.
 */
export function parseBrowserClient(headers: Headers, installed: boolean): BrowserClient {
  if (headers.get('merkur-client') === 'tui') {
    const platform = headers.get('merkur-client-platform');
    return {
      browser: 'Merkur TUI',
      platform: platform === 'macOS' || platform === 'Linux' ? platform : null,
      installed: false,
    };
  }
  const parsed = parseBrowser(headers);
  return {
    browser: parsed.browser,
    platform: parsed.platform,
    installed,
  };
}
