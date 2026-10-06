import { realpathSync } from 'node:fs';

/**
 * The browser the runner declares for its execution platform. A run that declares none
 * returns `undefined`, and Playwright launches the browser it installed.
 */
export function declaredBrowserExecutable(kind: 'chromium' | 'headless-shell'): string | undefined {
  const name =
    kind === 'chromium' ? 'MERKUR_CHROMIUM_EXECUTABLE' : 'MERKUR_HEADLESS_SHELL_EXECUTABLE';
  const executable = process.env[name];
  if (executable === undefined) return undefined;
  if (!executable.startsWith('/')) throw new Error(`${name} must be an absolute executable path`);
  return realpathSync(executable);
}
