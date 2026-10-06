/**
 * The site build's environment, read the same way by the page build
 * (`vite.config.ts`) and the static server's compile (`server/build.ts`), so
 * the origin a page posts to and the origin its server's CSP admits cannot
 * disagree.
 *
 * - `MERKUR_SITE_ORIGIN`: where the site is served (canonical and Open Graph
 *   URLs); production unless set.
 * - `MERKUR_SITE_API_ORIGIN`: where the app is served (sign-up, sign-in, the
 *   waitlist endpoint, the installer); production unless set.
 * - `MERKUR_SITE_RYBBIT_SITE_ID`: the Rybbit site id, required: a wrong one
 *   sends every visit to someone else's site.
 */
export interface SiteEnvironment {
  readonly siteOrigin: string;
  readonly appOrigin: string;
  readonly rybbitSiteId: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function origin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (
    url.origin !== value ||
    !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
  ) {
    throw new Error(`${name} must be a bare https origin (http only on loopback): ${value}`);
  }
  return value;
}

/** The app's origin: the one the pages post to and the server's CSP names. */
export function readSiteApiOrigin(env: Environment): string {
  return origin('MERKUR_SITE_API_ORIGIN', env.MERKUR_SITE_API_ORIGIN ?? 'https://app.merkur.sh');
}

export function readSiteEnvironment(env: Environment): SiteEnvironment {
  const rybbitSiteId = env.MERKUR_SITE_RYBBIT_SITE_ID ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(rybbitSiteId)) {
    throw new Error(
      'MERKUR_SITE_RYBBIT_SITE_ID is required: the Rybbit site id, letters, digits, - or _',
    );
  }
  return {
    siteOrigin: origin('MERKUR_SITE_ORIGIN', env.MERKUR_SITE_ORIGIN ?? 'https://merkur.sh'),
    appOrigin: readSiteApiOrigin(env),
    rybbitSiteId,
  };
}
