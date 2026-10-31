import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./createAppController.ts', import.meta.url), 'utf8');
const start = source.indexOf('  async function loadDevices(');
const end = source.indexOf('\n  }\n', start);
if (start < 0 || end < start) throw new Error('missing loadDevices');
const program = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end + 4));

for (const outcome of ['success', 'failure', 'returned to devices'] as const) {
  test(`pending device navigation survives ${outcome}`, async () => {
    let release: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const started = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    let route = 'devices',
      revision = 0,
      reconnected = false;
    const context = {
      deviceListLifetime: 0,
      pendingDaemonLinkCode: null,
      deviceList: { start: () => started },
      connectionAttempts: { hasActive: () => false },
      nav: {
        enterShell() {
          route = 'devices';
          revision++;
        },
        revision: () => revision,
        route: () => ({ k: route }),
        overlays: () => [],
      },
      reconnectLastDevice() {
        reconnected = true;
      },
    };
    runInNewContext(program, context);
    // SAFETY: loadDevices is the extracted async production function installed above.
    const pending = runInNewContext('loadDevices("token", "user")', context) as Promise<void>;
    route = 'settings';
    revision++;
    if (outcome === 'returned to devices') {
      route = 'devices';
      revision++;
    }
    if (outcome === 'failure') reject(new Error('stream failed'));
    else release();
    if (outcome === 'failure') await expect(pending).rejects.toThrow('stream failed');
    else await pending;
    expect(route).toBe(outcome === 'returned to devices' ? 'devices' : 'settings');
    expect(reconnected).toBe(false);
  });
}
