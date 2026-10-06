import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeTpm } from '../../../scripts/test-tpm-sim';
import { invokeFixtureCommand, runAndRetireFixture } from './real-helper';
import { runTpmFixture, tpmFixtureInputs, tpmSimulatorCases } from './tpm-runtime';

const originalCase = tpmSimulatorCases[0];
const image = `sha256:${'a'.repeat(64)}`;
const listing = `${originalCase}: test\n1 test, 0 benchmarks\n`;
const passing = `running 1 test\ntest ${originalCase} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;\n`;
const target =
  process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tpm source control '));
  mkdirSync(path.join(root, '_main'));
  writeFileSync(path.join(root, '_main/identity'), image);
  const docker = path.join(root, 'docker');
  writeFileSync(docker, 'declared lifecycle control only', { mode: 0o700 });
  return {
    root,
    docker,
    input: tpmFixtureInputs({
      image: '_main/image',
      identity: '_main/identity',
      harness: '_main/harness',
      docker_host: 'unix:///declared/docker.sock',
      target,
    }),
  };
}

describe('original TPM fixture source lifecycle controls', () => {
  test('fixed declared commands run native inventory, genuine readiness boundary and unchanged native filter', async () => {
    const f = fixture();
    const calls: { args: string[]; env: Record<string, string>; signal?: AbortSignal }[] = [];
    let ready = 0;
    try {
      await runTpmFixture(
        f.input,
        f.root,
        f.docker,
        f.root,
        new AbortController().signal,
        async (args, options) => {
          calls.push({ args, ...options });
          const stdout =
            args[0] === f.docker
              ? args[1] === 'image'
                ? image
                : args[1] === 'port'
                  ? '127.0.0.1:49152'
                  : ''
              : args.includes('--list')
                ? listing
                : passing;
          return { stdout, stderr: '', exitCode: 0 };
        },
        async (port) => {
          expect(port).toBe(49152);
          ready++;
        },
      );
      expect(ready).toBe(1);
      expect(calls.map((c) => c.args[1])).toEqual([
        'tpm_sim',
        'load',
        'image',
        'run',
        'port',
        'tpm_sim',
        'rm',
      ]);
      const startup = calls.find((c) => c.args[1] === 'run');
      expect(startup?.args.slice(-8)).toEqual([
        'socket',
        '--tpm2',
        '--tpmstate',
        'dir=/tmp/tpm',
        '--server',
        'type=tcp,bindaddr=0.0.0.0,port=2321',
        '--flags',
        'not-need-init,startup-clear',
      ]);
      expect(startup?.args).toContain('/usr/bin/swtpm');
      expect(startup?.args).toContain('/tmp/tpm');
      const native = calls[5];
      expect(native?.args.slice(1)).toEqual(['tpm_sim']);
      expect(native?.env.MERKUR_TPM_SIM_ADDR).toBe('127.0.0.1:49152');
      expect(native?.env.PATH).toBe('');
      expect(calls.at(-1)?.signal).toBeUndefined();
      expect(calls.at(-1)?.args[3]).toBe(startup?.args[5]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each(['native failure', 'cleanup failure', 'cancellation'])(
    '%s never becomes a pass and cleanup is uncancelled',
    async (mode) => {
      const f = fixture();
      const lifetime = new AbortController();
      let cleaned = false;
      try {
        await expect(
          runTpmFixture(
            f.input,
            f.root,
            f.docker,
            f.root,
            lifetime.signal,
            async (args, options) => {
              if (args[1] === 'rm') {
                cleaned = true;
                expect(options.signal).toBeUndefined();
                return {
                  stdout: '',
                  stderr: 'owned cleanup17',
                  exitCode: mode === 'cleanup failure' ? 17 : 0,
                };
              }
              if (args[0] === f.docker)
                return {
                  stdout: args[1] === 'image' ? image : args[1] === 'port' ? '127.0.0.1:49152' : '',
                  stderr: '',
                  exitCode: 0,
                };
              if (args.includes('--list')) return { stdout: listing, stderr: '', exitCode: 0 };
              if (mode === 'cancellation') lifetime.abort(new Error('original cancellation'));
              return { stdout: passing, stderr: '', exitCode: mode === 'native failure' ? 17 : 0 };
            },
            async () => {},
          ),
        ).rejects.toThrow('Original TPM fixture refused');
        expect(cleaned).toBe(true);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  test('no-feature harness cannot start Docker or invoke readiness', async () => {
    const f = fixture();
    let called = 0;
    try {
      await expect(
        runTpmFixture(
          f.input,
          f.root,
          f.docker,
          f.root,
          new AbortController().signal,
          async () => {
            called++;
            return { stdout: '0 tests, 0 benchmarks\n', stderr: '', exitCode: 0 };
          },
          async () => {
            throw new Error('must not probe');
          },
        ),
      ).rejects.toThrow('inventory');
      expect(called).toBe(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('foreign image identity refuses fixture and cleans only its generated name', async () => {
    const f = fixture();
    let started = false;
    let removed = '';
    try {
      await expect(
        runTpmFixture(
          f.input,
          f.root,
          f.docker,
          f.root,
          new AbortController().signal,
          async (args) => {
            if (args[1] === 'run') started = true;
            if (args[1] === 'rm') removed = args[3] ?? '';
            return {
              stdout:
                args[0] !== f.docker
                  ? listing
                  : args[1] === 'image'
                    ? `sha256:${'b'.repeat(64)}`
                    : '',
              stderr: '',
              exitCode: 0,
            };
          },
          async () => {},
        ),
      ).rejects.toThrow('Original TPM fixture refused');
      expect(started).toBe(false);
      expect(removed).toMatch(/^merkur-tpm-test-[a-f0-9-]+$/);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('inputs reject escapes, implicit Docker and foreign native context', () => {
    const f = fixture();
    try {
      for (const input of [
        { ...f.input, harness: '../ambient' },
        { ...f.input, docker_host: '' },
        { ...f.input, target: 'foreign' },
        { ...f.input, extra: true },
      ])
        expect(() => tpmFixtureInputs(input)).toThrow();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each([true, false])(
    'original full GetRandom protocol response accepted=%s',
    async (valid) => {
      const requests: Buffer[] = [];
      const server = Bun.listen({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          data(socket, data) {
            requests.push(Buffer.from(data));
            socket.write(
              Buffer.from(
                valid ? '80010000000d00000000000142' : '80010000000d00000001000142',
                'hex',
              ),
            );
          },
          error() {},
        },
      });
      try {
        if (valid) await probeTpm(server.port);
        else await expect(probeTpm(server.port)).rejects.toThrow();
        expect(Buffer.concat(requests).toString('hex')).toBe('80010000000c0000017b0001');
      } finally {
        server.stop(true);
      }
    },
  );
});

describe('shared original fixture process and retirement', () => {
  test('original declared engine preserves captured stdout, stderr and nonzero exit', async () => {
    const config = process.env.MERKUR_BUN_TEST_CONFIG;
    if (config === undefined)
      throw new Error('Declared neutral Bun control configuration required');
    const result = await invokeFixtureCommand(
      [
        process.execPath,
        '--no-install',
        '--no-env-file',
        `--config=${config}`,
        '--eval',
        'process.stdout.write("original stdout"); process.stderr.write("original stderr"); process.exitCode = 17;',
      ],
      { env: { PATH: '' } },
    );
    expect(result).toEqual({ stdout: 'original stdout', stderr: 'original stderr', exitCode: 17 });
  });
  test('run and retirement failures are both retained without a success verdict', async () => {
    const execution = new Error('original execution17');
    const retirement = new Error('original retirement17');
    let retired = false;
    let failure: unknown;
    try {
      await runAndRetireFixture(
        async () => {
          throw execution;
        },
        () => {
          retired = true;
          throw retirement;
        },
        'refused',
      );
    } catch (error) {
      failure = error;
    }
    expect(retired).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('Expected both owned failures');
    expect(failure.errors).toEqual([execution, retirement]);
  });
});
