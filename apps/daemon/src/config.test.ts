import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { Effect } from 'effect';

import { runTestProcess } from '../../../scripts/test-process';
import { loginShellFromPasswordEntry, readLoginShellEffect } from './config';

describe('login shell', () => {
  test('is the last field of the one entry the platform query prints', () => {
    expect(
      loginShellFromPasswordEntry(
        'darwin',
        'ada:********:501:20::0:0:Ada:/Users/ada:/opt/homebrew/bin/fish\n',
      ),
    ).toBe('/opt/homebrew/bin/fish');
    expect(loginShellFromPasswordEntry('linux', 'dev:x:1000:1000::/home/dev:/usr/bin/fish\n')).toBe(
      '/usr/bin/fish',
    );
  });

  test('refuses an entry of the other format, several entries, or no absolute shell', () => {
    for (const [platform, output] of [
      ['linux', 'ada:********:501:20::0:0:Ada:/Users/ada:/bin/zsh\n'],
      ['darwin', 'dev:x:1000:1000::/home/dev:/bin/bash\n'],
      ['linux', 'a:x:1:1::/a:/bin/sh\nb:x:1:1::/b:/bin/sh\n'],
      ['linux', 'dev:x:1000:1000::/home/dev:\n'],
      ['linux', 'dev:x:1000:1000::/home/dev:fish\n'],
      ['linux', ''],
      ['win32', 'dev:x:1000:1000::/home/dev:/bin/sh\n'],
    ] as const) {
      expect(() => loginShellFromPasswordEntry(platform, output)).toThrow();
    }
  });

  // Bun's `os.userInfo().shell` is the `$SHELL` the process started with, so a
  // lookup that regressed to it would hand back whatever shell ran the command.
  // A child is the only way to set that: assigning `process.env` later does not
  // reach the environment `os.userInfo()` reads.
  test('reads the password database, not the $SHELL the process inherited', async () => {
    const script =
      `import { Effect } from 'effect';` +
      `import { readLoginShellEffect } from ${JSON.stringify(path.join(import.meta.dir, 'config.ts'))};` +
      `process.stdout.write(await Effect.runPromise(readLoginShellEffect()));`;
    const child = await runTestProcess([process.execPath, '-e', script], {
      cwd: import.meta.dir,
      env: { ...process.env, SHELL: '/nonexistent/inherited-shell' },
    });
    expect(child.stderr).toBe('');
    const shell = child.stdout;
    expect(shell).not.toBe('/nonexistent/inherited-shell');
    expect(path.isAbsolute(shell)).toBe(true);
    expect(await Effect.runPromise(readLoginShellEffect())).toBe(shell);
  });
});
