/**
 * A stand-in for Rybbit Cloud behind the site's `/analytics/*` proxy.
 *
 * It answers the two upstream paths the proxy forwards and records every
 * request it receives, so `site.e2e.ts` can check what the proxy sent on:
 * the visitor address in `X-Forwarded-For`, no cookie, the browser's own
 * headers. Its responses carry the fields the proxy must never relay
 * (`Set-Cookie`, CORS, HSTS), so a relayed one shows up in the page's
 * responses. Its own tracking config fails with a 500, as Rybbit's can: the
 * site answers that path itself, so a page that ever read Rybbit's would fall
 * back to recording what the policy says it never does.
 *
 * `script.js` does what Rybbit's script does at load, in miniature: it takes
 * its API base from its own `src`, keeps its random `rybbit-visitor-id` in
 * local storage, reads the site's tracking config, and posts one pageview. As
 * the real script does, it records the address's query string and links
 * followed off the site unless the config it got says not to, and when the
 * config does not arrive it keeps those defaults.
 */
export const RECORDED_PATH = '/__recorded';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Fields a proxy must not relay; every response below carries them. */
export const UPSTREAM_ONLY_HEADERS: Readonly<Record<string, string>> = {
  'set-cookie': 'rybbit-upstream=1; Path=/; HttpOnly',
  'access-control-allow-origin': '*',
  'strict-transport-security': 'max-age=1',
};

/**
 * Rybbit's own declarative events work as here: one bubbling click listener on
 * the document walks up from the target to the first `data-rybbit-event` and
 * sends its name with every `data-rybbit-prop-*` as a property.
 */
const SCRIPT = `(() => {
  const script = document.currentScript;
  const api = script.src.slice(0, script.src.lastIndexOf('/script.js'));
  const siteId = script.dataset.siteId;
  if (localStorage.getItem('rybbit-visitor-id') === null) {
    localStorage.setItem('rybbit-visitor-id', crypto.randomUUID());
  }
  const config = { trackQuerystring: true, trackOutbound: true };
  const send = (payload) =>
    fetch(api + '/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        site_id: siteId,
        pathname: location.pathname,
        querystring: config.trackQuerystring ? location.search : '',
        ...payload,
      }),
    });
  fetch(api + '/site/tracking-config/' + siteId)
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}))
    .then((site) => {
      config.trackQuerystring = site.trackUrlParams ?? config.trackQuerystring;
      config.trackOutbound = site.trackOutbound ?? config.trackOutbound;
      send({ type: 'pageview' });
    });
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (config.trackOutbound && link && link.host !== location.host) {
      send({ type: 'outbound', properties: JSON.stringify({ url: link.href, text: link.textContent }) });
    }
  }, true);
  document.addEventListener('click', (event) => {
    for (let element = event.target; element && element !== document.documentElement; element = element.parentElement) {
      if (!element.hasAttribute('data-rybbit-event')) continue;
      const name = element.getAttribute('data-rybbit-event');
      if (name) {
        const properties = {};
        for (const attribute of element.attributes) {
          if (attribute.name.startsWith('data-rybbit-prop-')) {
            properties[attribute.name.slice('data-rybbit-prop-'.length)] = attribute.value;
          }
        }
        send({ type: 'custom_event', event_name: name, properties: JSON.stringify(properties) });
      }
      break;
    }
  });
})();
`;

export function startFakeRybbit(port: number): Bun.Server<undefined> {
  const recorded: RecordedRequest[] = [];
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === RECORDED_PATH) return Response.json(recorded);
      recorded.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      const reply = (body: string | null, contentType: string): Response =>
        new Response(body, {
          headers: { ...UPSTREAM_ONLY_HEADERS, 'content-type': contentType },
        });
      if (url.pathname === '/api/script.js') return reply(SCRIPT, 'application/javascript');
      if (url.pathname.startsWith('/api/site/tracking-config/'))
        return new Response('upstream broke', { status: 500 });
      if (url.pathname === '/api/track' && request.method === 'POST')
        return reply('{"success":true}', 'application/json');
      return new Response(null, { status: 404 });
    },
  });
}
