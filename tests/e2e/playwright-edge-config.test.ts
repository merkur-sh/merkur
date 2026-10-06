import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { runTestProcess } from '../../scripts/test-process';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function readBrowserConfiguration(browser: string, headed: boolean, netlog?: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, PW_E2E_BROWSER: browser };
  delete environment.HEADED;
  delete environment.PW_E2E_NETLOG;
  if (headed) environment.HEADED = '1';
  if (netlog !== undefined) environment.PW_E2E_NETLOG = netlog;
  const { exitCode, stdout, stderr } = await runTestProcess(
    [
      'node',
      '--input-type=module',
      '-e',
      "const {default: config} = await import('./playwright.edge.config.mjs'); console.log(JSON.stringify(config.use));",
    ],
    { cwd: root, env: environment },
  );
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout) as {
    browserName: string;
    channel?: string;
    headless: boolean;
    launchOptions: { args: string[] };
  };
}

describe('transport benchmark browser selection', () => {
  for (const headed of [false, true]) {
    test(`full Chromium is selected when headed=${headed}`, async () => {
      const config = await readBrowserConfiguration('chromium', headed);
      expect(config.browserName).toBe('chromium');
      expect(config.channel).toBe('chromium');
      expect(config.headless).toBe(!headed);
      expect(config.launchOptions.args).toEqual([
        '--enable-experimental-web-platform-features',
        '--enable-gpu',
      ]);
    });

    test(`an opted-in run adds only Chromium's net log when headed=${headed}`, async () => {
      const config = await readBrowserConfiguration('chromium', headed, '/tmp/merkur-netlog.json');
      expect(config.launchOptions.args).toEqual([
        '--enable-experimental-web-platform-features',
        '--enable-gpu',
        '--log-net-log=/tmp/merkur-netlog.json',
      ]);
      const firefox = await readBrowserConfiguration('firefox', headed, '/tmp/merkur-netlog.json');
      expect(firefox.launchOptions.args).toEqual([]);
    });

    test(`Firefox keeps its own executable selection when headed=${headed}`, async () => {
      const config = await readBrowserConfiguration('firefox', headed);
      expect(config.browserName).toBe('firefox');
      expect(config.channel).toBeUndefined();
      expect(config.headless).toBe(!headed);
      expect(config.launchOptions.args).toEqual([]);
    });
  }
});
