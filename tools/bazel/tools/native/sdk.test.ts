import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('declared native POSIX shell parses stdin and rejects invalid syntax', () => {
  const positive = Bun.spawnSync(['sh', '-n'], {
    stdin: new TextEncoder().encode('#!/bin/sh\nset -eu\ncase x in x) echo valid;; esac\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(positive.exitCode).toBe(0);
  const negative = Bun.spawnSync(['sh', '-n'], {
    stdin: new TextEncoder().encode('if true; then\n'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(negative.exitCode).not.toBe(0);
});

test('declared native shell executes its own builtins', () => {
  const child = Bun.spawnSync(['sh', '-c', 'echo native-sdk-positive'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  expect(new TextDecoder().decode(child.stdout).trim()).toBe('native-sdk-positive');
});

function command(args: string[], cwd?: string): string {
  const child = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0)
    throw new Error(`${args[0]}: ${new TextDecoder().decode(child.stderr)}`);
  return new TextDecoder().decode(child.stdout);
}

test('declared coreutils and tar/gzip preserve a real ustar fixture', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-sdk-archive-'));
  try {
    command(['mkdir', '-p', path.join(root, 'source'), path.join(root, 'copied')]);
    writeFileSync(path.join(root, 'source', 'fixture'), 'native tar fixture');
    command(['chmod', '+x', path.join(root, 'source', 'fixture')]);
    expect(statSync(path.join(root, 'source', 'fixture')).mode & 0o111).not.toBe(0);
    expect(command(['echo', 'native-coreutils']).trim()).toBe('native-coreutils');
    command([
      'tar',
      '--format=ustar',
      '-czf',
      path.join(root, 'fixture.tar.gz'),
      '-C',
      path.join(root, 'source'),
      'fixture',
    ]);
    command(['gzip', '-t', path.join(root, 'fixture.tar.gz')]);
    command(['tar', '-xzf', path.join(root, 'fixture.tar.gz'), '-C', path.join(root, 'copied')]);
    expect(readFileSync(path.join(root, 'copied', 'fixture'), 'utf8')).toBe('native tar fixture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared Git creates and reads a real commit and ignore rule', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-sdk-git-'));
  try {
    command(['git', 'init', root]);
    command(['git', 'config', 'user.name', 'Native SDK fixture'], root);
    command(['git', 'config', 'user.email', 'fixture@example.invalid'], root);
    writeFileSync(path.join(root, 'source'), 'declared Git fixture');
    writeFileSync(path.join(root, '.gitignore'), 'ignored\n');
    command(['git', 'add', 'source', '.gitignore'], root);
    command(['git', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], root);
    expect(command(['git', 'rev-parse', 'HEAD'], root).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(command(['git', 'show', 'HEAD:source'], root)).toBe('declared Git fixture');
    expect(command(['git', 'check-ignore', 'ignored'], root).trim()).toBe('ignored');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared OpenSSL generates and validates a real native TLS certificate', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-sdk-cert-'));
  try {
    const certificate = path.join(root, 'cert.pem');
    command([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(root, 'key.pem'),
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ]);
    expect(existsSync(certificate)).toBe(true);
    expect(command(['openssl', 'x509', '-in', certificate, '-noout', '-subject'])).toContain(
      'localhost',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declared Redis starts a native authenticated Unix socket and answers real RESP', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-sdk-redis-'));
  const socket = 'redis.sock';
  const child = Bun.spawn(
    [
      'redis-server',
      '--port',
      '0',
      '--unixsocket',
      socket,
      '--unixsocketperm',
      '700',
      '--save',
      '',
      '--appendonly',
      'no',
      '--requirepass',
      'sdk-fixture',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'inherit' },
  );
  try {
    const reader = child.stdout.getReader();
    let output = '';
    let ready = false;
    while (!ready) {
      const piece = await reader.read();
      if (piece.done) break;
      output += new TextDecoder().decode(piece.value);
      ready = output.includes('Ready to accept connections');
    }
    reader.releaseLock();
    if (!ready) throw new Error('Declared Redis ended without its native startup event');
    const script =
      'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(b"*2\\r\\n$4\\r\\nAUTH\\r\\n$11\\r\\nsdk-fixture\\r\\n"); assert s.recv(128)==b"+OK\\r\\n"; s.sendall(b"*1\\r\\n$4\\r\\nPING\\r\\n"); assert s.recv(128)==b"+PONG\\r\\n"; s.close()';
    command(['python3', '-I', '-c', script, socket], root);
    expect(ready).toBe(true);
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
