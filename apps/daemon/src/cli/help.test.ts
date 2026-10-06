import { describe, expect, test } from 'bun:test';
import { renderCliHelp } from './help';

async function invoke(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/../index.ts`, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

describe('command help', () => {
  test('all focused help forms work without opening an account or service', async () => {
    const expected = renderCliHelp('connect', false);
    if (expected === null) throw new Error('connect help is missing');
    for (const args of [
      ['help', 'connect'],
      ['connect', '--help'],
      ['connect', '-h'],
    ]) {
      const result = await invoke(args);
      expect(result).toEqual({ code: 0, out: expected, err: '' });
      expect(result.out).toContain('--identity-seal');
      expect(result.out).toContain('merkur connect "Work laptop"');
      expect(result.out).not.toContain('THIS MACHINE');
    }
  });

  test('invalid service arguments fail before touching the service', async () => {
    const result = await invoke(['stop', '--unexpected']);
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('merkur stop takes no arguments');
    expect(result.err).not.toContain('Merkur stopped');
  });

  test('unknown commands and topics report concise errors, including object keys', async () => {
    for (const args of [['constructor'], ['help', '__proto__']]) {
      const result = await invoke(args);
      expect(result.code).toBe(2);
      expect(result.out).toBe('');
      expect(result.err).toContain('merkur help');
      expect(result.err).not.toContain('GET STARTED');
    }
  });

  test('version flag follows the same public version command', async () => {
    const result = await invoke(['version']);
    expect(await invoke(['--version'])).toEqual(result);
    expect(await invoke(['-v'])).toEqual(result);
  });

  test('plain help is clean for pipes; styled help highlights headings', () => {
    expect(renderCliHelp(undefined, false)).not.toContain('\x1b');
    expect(renderCliHelp(undefined, true)).toContain('\x1b[1;38;2;183;162;255mMERKUR\x1b[0m');
    expect(renderCliHelp(undefined, true)).toContain('▀');
    expect(renderCliHelp(undefined, false)).not.toContain('▀');
    expect(renderCliHelp('connect', true)).not.toContain('▀');
    expect(renderCliHelp('missing', false)).toBeNull();
  });
});
