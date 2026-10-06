import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MODULE = path.join(import.meta.dir, 'host-harness-lock.ts');

function holder(lockPath: string, label: string) {
  return Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { acquireHostHarnessLock } from ${JSON.stringify(MODULE)};
       await acquireHostHarnessLock(${JSON.stringify(label)}, ${JSON.stringify(lockPath)});
       process.stdout.write('held\\n');
       setInterval(() => {}, 1_000);`,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += new TextDecoder().decode(chunk);
    const newline = text.indexOf('\n');
    if (newline >= 0) return text.slice(0, newline);
  }
  return text;
}

test('a second harness waits for the first, which releases even when killed', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-harness-lock-'));
  const lockPath = path.join(directory, 'harness.lock');
  const first = holder(lockPath, 'first');
  expect(await firstLine(first.stdout)).toBe('held');
  const second = holder(lockPath, 'second');
  try {
    // The second names who holds the host before it waits.
    expect(await firstLine(second.stderr)).toContain('first');
    expect(second.exitCode).toBeNull();
    first.kill('SIGKILL');
    await first.exited;
    expect(await firstLine(second.stdout)).toBe('held');
    expect(readFileSync(lockPath, 'utf8')).toContain('second');
  } finally {
    first.kill('SIGKILL');
    second.kill('SIGKILL');
    await Promise.all([first.exited, second.exited]);
    rmSync(directory, { recursive: true, force: true });
  }
});
