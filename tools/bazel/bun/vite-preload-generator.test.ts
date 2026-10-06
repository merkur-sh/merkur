import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { preparePreloadGenerator } from './vite-preload-generator';

function originalSource(): Promise<string> {
  const source = process.env.MERKUR_VITE_PRELOAD_SOURCE;
  if (!source || !isAbsolute(source))
    throw new Error('Declared original Vite generator File is required');
  return Bun.file(source).text();
}

test('original Vite Function.toString and configured output survive script-context preparation', async () => {
  const source = await originalSource();
  const prepared = preparePreloadGenerator(source);
  const original = await import(
    `data:text/javascript;base64,${Buffer.from(prepared.originalModule).toString('base64')}`
  );
  const generate: unknown = runInNewContext(prepared.script);
  if (typeof generate !== 'function')
    throw new Error('Original generator did not produce a function');
  const originalPreload = original.preload.toString();
  expect(originalPreload).toContain('import.meta.url');
  expect(() =>
    runInNewContext(
      prepared.originalModule.replace('export { getPreloadCode, preload, detectScriptRel };', ''),
    ),
  ).toThrow('import.meta');
  for (const base of ['/', './', '', '/quote"\\\n', '/é/\u2028/\ud800/']) {
    for (const polyfill of [false, true]) {
      for (const renderBuiltUrl of [false, true]) {
        for (const isRelativeBase of [false, true]) {
          const expected = original.getPreloadCode(
            { config: { base, build: { modulePreload: { polyfill } } } },
            renderBuiltUrl,
            isRelativeBase,
          );
          const actual: unknown = generate(base, polyfill, renderBuiltUrl, isRelativeBase);
          expect(actual).toBe(expected);
          expect(String(actual)).toEndWith(originalPreload);
        }
      }
    }
  }
});

test('generator extraction requires each original declaration and script-compatible generating code', async () => {
  const source = await originalSource();
  const prepared = preparePreloadGenerator(source);
  for (const span of prepared.spans) {
    const missing = source.slice(0, span.start) + source.slice(span.end);
    expect(() => preparePreloadGenerator(missing)).toThrow('missing or ambiguous');
  }
  const generator = prepared.spans.find((span) => span.name === 'getPreloadCode');
  if (!generator) throw new Error('Original getPreloadCode declaration is missing');
  const duplicate = source + '\n' + source.slice(generator.start, generator.end);
  expect(() => preparePreloadGenerator(duplicate)).toThrow();
  const body = source.indexOf('{', generator.start) + 1;
  const changed = source.slice(0, body) + 'environment.meta = import.meta;\n' + source.slice(body);
  expect(() => preparePreloadGenerator(changed)).toThrow('script context');
});

test('AST conversion preserves original generator literals through the configured compiler', async () => {
  const source = await originalSource();
  const prepared = preparePreloadGenerator(source);
  const preload = prepared.spans.find((span) => span.name === 'preload');
  if (!preload) throw new Error('Original preload declaration is missing');
  const at = source.indexOf('{', preload.start) + 1;
  const changed =
    source.slice(0, at) +
    '\n/* import.meta sentinel */\nwindow.marker = "import.meta";\n' +
    source.slice(at);
  const result = preparePreloadGenerator(changed);
  expect(result.originalModule).toContain('/* import.meta sentinel */');
  expect(result.script).toContain('"import.meta"');
  const original = await import(
    `data:text/javascript;base64,${Buffer.from(result.originalModule).toString('base64')}`
  );
  const generate: unknown = runInNewContext(result.script);
  if (typeof generate !== 'function')
    throw new Error('Original generator did not produce a function');
  expect(generate('/assets/', false, false, false)).toBe(
    original.getPreloadCode(
      { config: { base: '/assets/', build: { modulePreload: false } } },
      false,
      false,
    ),
  );
});

test('preparation CLI emits the selected original script without replacing caller outputs', async () => {
  const original = process.env.MERKUR_VITE_PRELOAD_SOURCE;
  if (!original || !isAbsolute(original))
    throw new Error('Declared original Vite File is required');
  const directory = mkdtempSync(join(tmpdir(), 'vite-preload-cli-'));
  const runner = fileURLToPath(new URL('./vite-preload-generator.ts', import.meta.url));
  const config = join(directory, 'bunfig.toml');
  const output = join(directory, 'generator.js');
  const before = readFileSync(original);
  try {
    await Bun.write(config, '');
    const command = [
      process.execPath,
      '--no-install',
      '--no-env-file',
      `--config=${config}`,
      runner,
      original,
      output,
    ];
    const options = { env: { HOME: directory, TMPDIR: directory, PATH: '/__no_ambient_path__' } };
    const built = Bun.spawnSync(command, options);
    expect(built.exitCode).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      preparePreloadGenerator(before.toString('utf8')).script,
    );
    const collision = Bun.spawnSync(command, options);
    expect(collision.exitCode).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      preparePreloadGenerator(before.toString('utf8')).script,
    );
    expect(readFileSync(original).equals(before)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
