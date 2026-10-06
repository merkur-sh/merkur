const port = Number(process.env.PW_E2E_PROBE_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PW_E2E_PROBE_PORT must be an integer from 1 to 65535');
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: () =>
    new Response('<!doctype html><title>Merkur edge probe</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
});

process.stderr.write(`[e2e] edge probe origin ready at http://127.0.0.1:${port}\n`);
