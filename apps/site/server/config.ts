/**
 * The static server's whole configuration, parsed once at startup.
 *
 * Nothing has a default. `PORT` comes from the platform, `RYBBIT_HOST` names
 * the analytics upstream, and `TRUSTED_PROXY_HOPS` states the proxy topology
 * the same way the application server does (`docs/security.md`). The API
 * origin is not runtime configuration at all: the page's CSP must name the
 * origin the page was built against, so `build.ts` defines it into the
 * executable from the same `MERKUR_SITE_API_ORIGIN` the page build reads.
 */
export interface SiteServerConfig {
  readonly distDirectory: string;
  readonly port: number;
  readonly rybbitHost: string;
  readonly trustedProxyHops: number;
  readonly apiOrigin: string;
}

export interface SiteServerConfigInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** `process.env.MERKUR_SITE_API_ORIGIN`, which the compiled executable carries as a literal. */
  readonly apiOrigin: string | undefined;
  /** Positional arguments after the executable: exactly the `dist` directory. */
  readonly args: readonly string[];
}

export class SiteConfigError extends Error {
  override readonly name = 'SiteConfigError';
}

const MAX_PORT = 65_535;
const PORT_PATTERN = /^[1-9]\d{0,4}$/;
/** The application server's bound (`packages/config/src/server-config.ts`). */
const MAX_TRUSTED_PROXY_HOPS = 8;
const HOPS_PATTERN = /^\d$/;

export function parseSiteServerConfig(input: SiteServerConfigInput): SiteServerConfig {
  const [distDirectory, ...extra] = input.args;
  if (distDirectory === undefined || distDirectory.length === 0 || extra.length > 0) {
    throw new SiteConfigError('usage: site-server <dist directory>');
  }
  return {
    distDirectory,
    port: parsePort(input.environment.PORT),
    rybbitHost: parseOrigin(input.environment.RYBBIT_HOST, 'RYBBIT_HOST'),
    trustedProxyHops: parseTrustedProxyHops(input.environment.TRUSTED_PROXY_HOPS),
    apiOrigin: parseOrigin(input.apiOrigin, 'MERKUR_SITE_API_ORIGIN'),
  };
}

/** An `http(s)` origin spelled exactly as `URL.origin` spells it: no path, no trailing slash. */
export function parseOrigin(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) {
    throw new SiteConfigError(`${field} is required`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiteConfigError(`${field} must be an origin such as https://example.com`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new SiteConfigError(
      `${field} must be an origin such as https://example.com, with no path or trailing slash`,
    );
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || !PORT_PATTERN.test(value) || Number(value) > MAX_PORT) {
    throw new SiteConfigError(`PORT must be an integer from 1 to ${MAX_PORT}`);
  }
  return Number(value);
}

function parseTrustedProxyHops(value: string | undefined): number {
  if (value === undefined || !HOPS_PATTERN.test(value) || Number(value) > MAX_TRUSTED_PROXY_HOPS) {
    throw new SiteConfigError(
      `TRUSTED_PROXY_HOPS must be an integer from 0 to ${MAX_TRUSTED_PROXY_HOPS}`,
    );
  }
  return Number(value);
}
