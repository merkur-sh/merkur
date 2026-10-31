import { expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import { runTuiCommand } from './tui';

test('replaces the CLI with its native sibling and preserves every argument and the environment', async () => {
  const replaced = new Error('process image replaced');
  const exec = spyOn(process, 'execve').mockImplementation(() => {
    throw replaced;
  });
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('the TUI must own the CLI process');
  });
  const executable = path.resolve(import.meta.dir, '../../dist/merkur-tui');
  try {
    for (const args of [
      [],
      ['login', '--username', 'a name'],
      ['logout'],
      ['machines', '--state-dir', '/tmp/state with spaces'],
      ['connect', "it's a machine", '--relay-only'],
    ]) {
      await expect(Promise.resolve().then(() => runTuiCommand(args))).rejects.toBe(replaced);
      expect(exec).toHaveBeenLastCalledWith(executable, [executable, ...args], process.env);
    }
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    exec.mockRestore();
    spawn.mockRestore();
  }
});

test('propagates an executable replacement error without starting another process', async () => {
  const missing = Object.assign(new Error('no native sibling'), { code: 'ENOENT' });
  const exec = spyOn(process, 'execve').mockImplementation(() => {
    throw missing;
  });
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('replacement failure must reach the CLI boundary');
  });
  try {
    await expect(Promise.resolve().then(() => runTuiCommand([]))).rejects.toBe(missing);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    exec.mockRestore();
    spawn.mockRestore();
  }
});
