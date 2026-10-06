/**
 * What a browser session is called in the sessions list.
 *
 * The list exists so someone can look at the browsers holding a delegation for
 * their account and decide which ones to revoke, and "Added 3 Jul 2026" is not
 * enough to make that decision — a date does not tell you whether that row is
 * the laptop you still use or the phone you sold.
 *
 * Derived on the server from the `User-Agent` of the request that issued the
 * delegation, and stored on the delegation row. It cannot be derived later: the
 * record outlives the request, and asking the browser afterwards would let a
 * browser rename any session it can reach, including someone else's.
 *
 * Only the shape lives here, because `@merkur/shared` is imported by the web
 * app and the parser is a quarter-megabyte of browser tables that the browser
 * has no use for. The parse itself is `apps/server/src/http/browser-client.ts`.
 *
 * Both names are nullable and stay nullable. A header no parser recognizes, one
 * stripped by a privacy extension, or a client that sends none at all produces
 * no name, and the list says so — a wrong name here is worse than no name,
 * because it is what someone reads before deciding to revoke.
 */
export interface BrowserClient {
  /** Browser family, e.g. `Chrome`. Null when the header named none. */
  readonly browser: string | null;
  /** Operating system, e.g. `macOS`. Null when the header named none. */
  readonly platform: string | null;
  /**
   * Whether the session was created from an installed PWA rather than a tab.
   *
   * The only field the browser reports rather than the server deriving: display
   * mode reaches no `User-Agent` on any engine. It is a presentation detail
   * with no authority attached — a client that lies about it mislabels its own
   * row and nothing else.
   */
  readonly installed: boolean;
}

/**
 * How much of a name the sessions list will store or render.
 *
 * Both names originate in an attacker-controlled header, and a row is a row: a
 * browser that calls itself four hundred characters gets the first thirty-two
 * and no more say in the layout than any other.
 */
export const BROWSER_CLIENT_NAME_MAX_LENGTH = 32;
