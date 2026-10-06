import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BURST_ARGUMENTS, burstCommand, runBurst } from './burst';

const options = {
  root: '/declared/source',
  cli: '/declared/npm/@playwright/test/cli.js',
  chromium: '/declared/browser/chromium',
  output: '/declared/test-output',
  runtime: '/declared/runtime/bun',
  bunConfig: '/declared/empty-bunfig.toml',
  environment: {
    PATH: '/declared/runtime',
    BUN_OPTIONS: '--preload=/outside',
    NODE_OPTIONS: '--require=/outside',
  },
};

test('burst retains only the original Playwright config selection', () => {
  const invocation = burstCommand(options);
  expect(BURST_ARGUMENTS).toEqual(['test', '-c', 'playwright.burst.config.mjs']);
  expect(invocation.command).toEqual([
    options.runtime,
    '--no-install',
    '--no-env-file',
    `--config=${options.bunConfig}`,
    options.cli,
    ...BURST_ARGUMENTS,
  ]);
  expect(invocation.cwd).toBe(options.root);
});

test('burst propagates the declared browser and owned artifacts without environment preload', () => {
  const invocation = burstCommand(options);
  expect(invocation.environment.MERKUR_PLAYWRIGHT_CHROMIUM).toBe(options.chromium);
  expect(invocation.environment.PW_E2E_OUTPUT_DIR).toBe('/declared/test-output/playwright-burst');
  expect(invocation.environment.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
  expect(invocation.environment.PATH).toBe('/declared/runtime');
  expect(invocation.environment.BUN_OPTIONS).toBeUndefined();
  expect(invocation.environment.NODE_OPTIONS).toBeUndefined();
  expect(options.environment.BUN_OPTIONS).toBe('--preload=/outside');
});

for (const [role, value] of [
  ['chromium', undefined],
  ['chromium', 'chromium'],
  ['output', undefined],
  ['output', 'test-results'],
  ['bunConfig', undefined],
  ['cli', 'playwright/cli.js'],
  ['runtime', 'bun'],
  ['root', '.'],
] as const) {
  test(`burst refuses the undeclared or relative ${role} ${String(value)}`, () => {
    expect(() => burstCommand({ ...options, [role]: value })).toThrow();
  });
}

test('burst factory retains real artifact/tool closure and one existing test rule', () => {
  const source = readFileSync(new URL('./burst.bzl', import.meta.url), 'utf8');
  expect(source).toContain('bun_command_test(');
  expect(source).toContain('//:node_modules/@playwright/test');
  expect(source).toContain('//apps/web:term_wasm_runtime');
  expect(source).toContain('//apps/web:graphics_wasm_runtime');
  expect(source).toContain('tools = {"//tools/bazel/browser:chromium": "chromium"}');
  expect(source.slice(0, source.indexOf('def _burst_config_impl'))).not.toContain('rule(');
  expect(source).not.toContain('cargo');
});

test('real burst dispatch refuses alternate selection before reading or launching prerequisites', async () => {
  await expect(runBurst(['--grep', 'different-suite'])).rejects.toThrow('alternate suite');
});

test('real burst dispatch refuses absent Bazel runtime before browser execution', async () => {
  const previous = process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  delete process.env.MERKUR_BAZEL_RUNFILES_ROOT;
  try {
    await expect(runBurst([])).rejects.toThrow('Bazel runfiles');
  } finally {
    if (previous === undefined) delete process.env.MERKUR_BAZEL_RUNFILES_ROOT;
    else process.env.MERKUR_BAZEL_RUNFILES_ROOT = previous;
  }
});

test('burst uses only the declared config projection and preserves the original as an action input', () => {
  const source = readFileSync(new URL('./burst.bzl', import.meta.url), 'utf8');
  expect(source).toContain('"//:burst_playwright_config"');
  expect(source).toContain('ctx.actions.expand_template(template = ctx.file.original');
  expect(source).toContain('substitutions = {}');
  expect(source).toContain('DefaultInfo(files = depset([original, output]))');
  expect(source).not.toContain('ctx.actions.symlink');
});
