import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('missing reports, setup errors, teardown errors and abrupt exits fail closed', async () => {
  const scratch = process.env.TEST_TMPDIR;
  if (scratch === undefined) throw new Error('control requires its isolated Bazel test directory');
  const directory = path.join(scratch, 'launcher-controls');
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'control.test.ts');
  const manifest = path.join(directory, 'runtime-inputs.json');
  await writeFile(path.join(directory, 'control.toml'), '');
  await writeFile(
    manifest,
    JSON.stringify({
      files: {
        'control.test.ts': { runfile: 'control.test.ts', link: false },
        'control.toml': { runfile: 'control.toml', link: false },
      },
      cwd: '',
      config: 'control.toml',
    }),
  );
  const common = "import {test,expect,beforeAll,afterAll} from 'bun:test';\n";
  const variants = [
    ['passing', "test('control',()=>expect(1).toBe(1));", true],
    ['exit before report after prior pass', 'process.exit(0);', false],
    [
      'setup exception',
      "beforeAll(()=>{throw Error('setup control')});test('control',()=>{});",
      false,
    ],
    [
      'teardown exception',
      "afterAll(()=>{throw Error('teardown control')});test('control',()=>{});",
      false,
    ],
    [
      'undeclared dependency',
      "import '@biomejs/cli-darwin-arm64/package.json';test('control',()=>{});",
      false,
    ],
    ['failed assertion', "test('control',()=>expect(1).toBe(2));", false],
    ['abrupt termination', "test('control',()=>process.kill(process.pid,'SIGKILL'));", false],
  ] as const;
  for (const [name, source, accepted] of variants) {
    await writeFile(filename, common + source);
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        '--config=tools/bazel/bun/empty-bunfig.toml',
        'tools/bazel/bun/run-test.ts',
        manifest,
        directory,
        'control.test.ts',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_UNDECLARED_OUTPUTS_DIR: directory,
          XML_OUTPUT_FILE: path.join(directory, 'wrapper.xml'),
          MERKUR_BUN_TEST_CONFIG: 'tools/bazel/bun/empty-bunfig.toml',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({
      name,
      accepted: status === 0,
      output: status === 0 || !accepted ? '' : stdout + stderr,
    }).toEqual({ name, accepted, output: '' });
  }
});

test('the isolated runner does not inherit undeclared Bun option preloads', async () => {
  const scratch = process.env.TEST_TMPDIR;
  if (scratch === undefined) throw new Error('control requires its isolated Bazel test directory');
  const directory = await mkdtemp(path.join(scratch, 'launcher-options-'));
  const marker = path.join(directory, 'undeclared-preload-executed');
  const outside = path.join(directory, 'undeclared.ts');
  const setup = path.join(directory, 'set-options.ts');
  await writeFile(outside, `await Bun.write(${JSON.stringify(marker)}, 'undeclared');\n`);
  // Set the option after the declared parent invocation has parsed its arguments.
  // The child must discard it before Bun can resolve the undeclared preload.
  await writeFile(setup, `process.env.BUN_OPTIONS = ${JSON.stringify(`--preload=${outside}`)};\n`);
  await writeFile(path.join(directory, 'control.toml'), '');
  await writeFile(
    path.join(directory, 'control.test.ts'),
    "import {test,expect} from 'bun:test';test('declared control',()=>expect(6 * 7).toBe(42));\n",
  );
  const manifest = path.join(directory, 'runtime-inputs.json');
  await writeFile(
    manifest,
    JSON.stringify({
      files: {
        'control.test.ts': { runfile: 'control.test.ts', link: false },
        'control.toml': { runfile: 'control.toml', link: false },
      },
      cwd: '',
      config: 'control.toml',
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      '--config=tools/bazel/bun/empty-bunfig.toml',
      `--preload=${setup}`,
      'tools/bazel/bun/run-test.ts',
      manifest,
      directory,
      'control.test.ts',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, TEST_UNDECLARED_OUTPUTS_DIR: directory },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, output: status === 0 ? '' : stdout + stderr }).toEqual({
    status: 0,
    output: '',
  });
  expect(
    await stat(marker).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test('the native SDK loader preserves Apple library bindings through the isolated runner', async () => {
  const scratch = process.env.TEST_TMPDIR;
  const prefix = process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX;
  if (scratch === undefined || prefix === undefined)
    throw new Error('native loader control requires its declared SDK and Bazel scratch directory');
  const directory = await mkdtemp(path.join(scratch, 'launcher-native-loader-'));
  await writeFile(path.join(directory, 'control.toml'), '');
  await writeFile(
    path.join(directory, 'control.test.ts'),
    `import { test, expect } from 'bun:test';
import path from 'node:path';
test('declared shell expands filenames and Git version substitution', () => {
  if (process.platform === 'darwin') {
    expect(process.env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(process.env.DYLD_FALLBACK_LIBRARY_PATH).toBe(path.join(process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX, 'lib'));
  }
  const shell = path.join(process.env.MERKUR_BAZEL_NATIVE_SDK_PREFIX, 'bin', 'sh');
  const result = Bun.spawnSync([shell, '-c', ${JSON.stringify(String.raw`VN=2.56.0; VN=$(expr "$VN" : v*'\(.*\)'); printf '<%s>\n' "$VN"`)}],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('<2.56.0>\\n');
});
`,
  );
  const manifest = path.join(directory, 'runtime-inputs.json');
  await writeFile(
    manifest,
    JSON.stringify({
      files: {
        'control.test.ts': { runfile: 'control.test.ts', link: false },
        'control.toml': { runfile: 'control.toml', link: false },
      },
      cwd: '',
      config: 'control.toml',
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-install',
      '--no-env-file',
      '--config=tools/bazel/bun/empty-bunfig.toml',
      'tools/bazel/bun/run-test.ts',
      manifest,
      directory,
      'control.test.ts',
    ],
    {
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: path.join(prefix, 'lib'),
        TEST_UNDECLARED_OUTPUTS_DIR: directory,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, output: status === 0 ? '' : stdout + stderr }).toEqual({
    status: 0,
    output: '',
  });
});
