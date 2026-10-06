import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { linkTestExecutable } from './test-executables';

const ENTRYPOINT = path.resolve(import.meta.dir, '../apps/edge/entrypoint.sh');

/**
 * Runs the real entrypoint with `ip`, `tc`, `chown` and `setpriv` replaced by
 * stubs that record their argv, so the exact commands the image would run are
 * asserted without root or a network namespace.
 */
async function run(rate: string | undefined, iface = 'eth0', failure = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-entrypoint-'));
  dirs.push(dir);
  const log = path.join(dir, 'calls.log');
  const declaredShell = Bun.which('sh');
  if (declaredShell === null)
    throw new Error('Entry point qualification requires its declared shell');
  const shell = declaredShell;
  // One file under four names: macOS assesses each new executable file once, and a declared
  // test starts with an empty store, so a stub per name and per failure costs an assessment each.
  for (const name of ['ip', 'tc', 'chown', 'setpriv'])
    linkTestExecutable(
      dir,
      name,
      `#!${shell}\nname="\${0##*/}"\necho "$name $*" >> "$STUB_CALLS_LOG"\n[ "$name" != "$STUB_FAILS" ]\n`,
    );
  const env: Record<string, string> = {
    PATH: `${dir}:${process.env.PATH ?? ''}`,
    STUB_CALLS_LOG: log,
    STUB_FAILS: failure,
  };
  for (const name of [
    'TEST_SRCDIR',
    'RUNFILES_DIR',
    'MERKUR_BAZEL_RUNFILES_ROOT',
    'MERKUR_BAZEL_SCRATCH_ROOT',
    'DYLD_LIBRARY_PATH',
    'DYLD_FALLBACK_LIBRARY_PATH',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (iface !== '') env.MERKUR_EDGE_EGRESS_INTERFACE = iface;
  if (rate !== undefined) env.MERKUR_EDGE_EGRESS_RATE_MBIT = rate;
  const child = Bun.spawn([shell, ENTRYPOINT, '/usr/local/bin/merkur-edge'], {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    calls = [];
  }
  return { status, stderr, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('edge entrypoint', () => {
  test('caps egress on the configured interface, then drops every privilege', async () => {
    const { status, calls } = await run('200');
    expect(status).toBe(0);
    expect(calls).toEqual([
      'ip link show dev eth0',
      'tc qdisc replace dev eth0 root handle 1: htb default 1',
      'tc class replace dev eth0 parent 1: classid 1:1 htb rate 200mbit ceil 200mbit burst 250000 cburst 250000 quantum 1514',
      'tc qdisc replace dev eth0 parent 1:1 handle 10: fq_codel',
      'chown -R -P --no-dereference 10001:10001 /data',
      'setpriv --reuid=10001 --regid=10001 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs /usr/local/bin/merkur-edge',
    ]);
  });

  test('refuses to start uncapped', async () => {
    for (const rate of [undefined, '', '0', '010', '-5', '1.5', '200mbit']) {
      const { status, stderr, calls } = await run(rate);
      expect(status).toBe(1);
      expect(stderr).toContain('MERKUR_EDGE_EGRESS_RATE_MBIT');
      expect(calls.some((call) => call.startsWith('tc ') || call.startsWith('setpriv'))).toBe(
        false,
      );
    }
  });

  test('fails closed on interface lookup or shaping errors', async () => {
    for (const failure of ['ip', 'tc']) {
      const { status, calls } = await run('200', 'eth0', failure);
      expect(status).toBe(1);
      expect(calls.some((call) => call.startsWith('setpriv'))).toBe(false);
    }
  });

  test('refuses to start when it cannot find the metered interface', async () => {
    const { status, stderr, calls } = await run('200', '');
    // POSIX shells choose their own status for a failed ${name:?} expansion.
    expect(status).not.toBe(0);
    expect(stderr).toContain('MERKUR_EDGE_EGRESS_INTERFACE is required');
    expect(calls).toEqual([]);
  });
});
