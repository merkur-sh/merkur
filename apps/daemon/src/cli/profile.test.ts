import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProfileReply } from '../services/profile-socket';
import { decodeProfileRequest } from '../services/profile-socket';
import { decodeReply, parseRecordOptions, pickSession } from './profile';

describe('merkur profile', () => {
  const sessions = [
    { sessionId: 'idle', peerId: 'peer-a', inputMsAgo: null },
    { sessionId: 'older', peerId: 'peer-b', inputMsAgo: 9_000 },
    { sessionId: 'typing', peerId: 'peer-c', inputMsAgo: 40 },
  ];

  test('current is the session typed into most recently; an id names exactly one', () => {
    expect(pickSession(sessions, 'current')?.sessionId).toBe('typing');
    expect(pickSession(sessions, 'idle')?.sessionId).toBe('idle');
    expect(pickSession(sessions, 'absent')).toBeNull();
    expect(
      pickSession([{ sessionId: 'idle', peerId: 'peer-a', inputMsAgo: null }], 'current'),
    ).toBeNull();
  });

  test('record options are exact', () => {
    expect(parseRecordOptions([])).toEqual({ session: 'current', seconds: 10, cpu: false });
    expect(parseRecordOptions(['--session', 'typing', '--seconds', '2.5', '--cpu'])).toEqual({
      session: 'typing',
      seconds: 2.5,
      cpu: true,
    });
    expect(parseRecordOptions(['--seconds'])).toBeNull();
    expect(parseRecordOptions(['--seconds', '0'])).toBeNull();
    expect(parseRecordOptions(['--verbose'])).toBeNull();
  });

  test('replies decode only in their exact shapes', () => {
    expect(decodeReply('{"ok":true}')).toEqual({ ok: true });
    expect(decodeReply('{"ok":true,"observationId":"a"}')).toEqual({
      ok: true,
      observationId: 'a',
    });
    expect(decodeReply('{"ok":true,"path":"/p/a.mtrace"}')).toEqual({
      ok: true,
      path: '/p/a.mtrace',
    });
    expect(
      decodeReply(
        '{"ok":true,"sessions":[{"sessionId":"s","peerId":"p","inputMsAgo":null}],"dataplanePid":42}',
      ),
    ).toEqual({
      ok: true,
      sessions: [{ sessionId: 's', peerId: 'p', inputMsAgo: null }],
      dataplanePid: 42,
    });
    expect(decodeReply('{"ok":false,"reason":"unknown_session"}')).toEqual({
      ok: false,
      reason: 'unknown_session',
    });
    expect(decodeReply('{"ok":true,"path":7}')).toEqual({ ok: false, reason: 'malformed_reply' });
    expect(decodeReply('not json')).toEqual({ ok: false, reason: 'malformed_reply' });
  });

  test('the socket admits only its profile requests, as exact JSON lines', () => {
    expect(decodeProfileRequest('{"op":"sessions"}')).toEqual({ op: 'sessions' });
    expect(decodeProfileRequest('{"op":"start","sessionId":"s","observationId":"a"}')).toEqual({
      op: 'start',
      sessionId: 's',
      observationId: 'a',
    });
    expect(decodeProfileRequest('{"op":"capture","observationId":"a"}')).toEqual({
      op: 'capture',
      observationId: 'a',
    });
    expect(decodeProfileRequest('{"op":"capture-browser"}')).toEqual({ op: 'capture-browser' });
    expect(decodeProfileRequest('{"op":"capture"}')).toBeNull();
    expect(decodeProfileRequest('{"op":"end","observationId":"a"}')).toEqual({
      op: 'end',
      observationId: 'a',
    });
    expect(decodeProfileRequest('{"op":"end"}')).toBeNull();
    expect(decodeProfileRequest('{"op":"start"}')).toBeNull();
    expect(decodeProfileRequest('{"op":"start","sessionId":""}')).toBeNull();
    expect(decodeProfileRequest('{"op":"capture","path":"/etc/passwd"}')).toBeNull();
    expect(decodeProfileRequest('{"op":"shell"}')).toBeNull();
    expect(decodeProfileRequest('not json')).toBeNull();
  });
});

test.each(['start', 'capture'] as const)(
  'Ctrl-C during the %s reply ends its observation before exit',
  async (phase) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'merkur-profile-interrupt-'));
    const directory = path.join(home, '.merkur');
    await mkdir(directory);
    const reached = Promise.withResolvers<void>();
    const operations: string[] = [];
    let held: Bun.Socket<{ buffer: string }> | undefined;
    let heldReply: ProfileReply = { ok: false, reason: 'not_reached' };
    let observationId: string | undefined;
    const listener = Bun.listen<{ buffer: string }>({
      unix: path.join(directory, 'profile.sock'),
      socket: {
        open(socket) {
          socket.data = { buffer: '' };
        },
        data(socket, chunk) {
          socket.data.buffer += chunk.toString();
          if (!socket.data.buffer.includes('\n')) return;
          const request = decodeProfileRequest(socket.data.buffer.trim());
          if (request === null) throw new Error('invalid test request');
          operations.push(request.op);
          let reply: ProfileReply;
          if (request.op === 'sessions') {
            reply = {
              ok: true,
              sessions: [{ sessionId: 's', peerId: 'p', inputMsAgo: 0 }],
              dataplanePid: 42,
            };
          } else if (request.op === 'start') {
            observationId = request.observationId;
            reply = { ok: true, observationId };
          } else if (request.op === 'capture') {
            expect(request.observationId).toBe(observationId);
            reply = { ok: false, reason: 'controlled_capture_failure' };
          } else if (request.op === 'end') {
            expect(request.observationId).toBe(observationId);
            reply = { ok: true };
          } else {
            throw new Error('unexpected browser capture');
          }
          if (request.op === phase) {
            held = socket;
            heldReply = reply;
            reached.resolve();
          } else {
            socket.end(`${JSON.stringify(reply)}\n`);
          }
        },
      },
    });
    const script = `
    const on = process.on;
    process.on = function(event, callback) {
      return on.call(this, event, event === 'SIGINT' ? (...args) => {
        callback(...args);
        process.stdout.write('interrupted\\n');
      } : callback);
    };
    const { runProfileCommand } = await import(${JSON.stringify(new URL('./profile.ts', import.meta.url).href)});
    process.exit(await runProfileCommand(['record', '--seconds', '0.001']));
  `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, MERKUR_DAEMON_HOME: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      await reached.promise;
      child.kill('SIGINT');
      // The instrumented handler reports actual signal delivery; an unhandled signal exits.
      await Promise.race([child.exited, child.stdout.getReader().read()]);
      held?.end(`${JSON.stringify(heldReply)}\n`);
      await child.exited;
      expect(operations).toContain('end');
      expect(await child.exited).toBe(1);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
      listener.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  },
);

test('a rejected start stops samply and awaits its actual exit', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'merkur-profile-cpu-'));
  await mkdir(path.join(home, '.merkur'));
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let sampler: Bun.Socket | undefined;
  const samplerListener = Bun.listen({
    unix: path.join(home, 'sampler.sock'),
    socket: {
      data(socket, chunk) {
        sampler = socket;
        if (chunk.toString() === 'ready') ready.resolve();
        else if (chunk.toString() === 'stopped') stopped.resolve();
      },
    },
  });
  const executable = path.join(home, 'samply');
  await writeFile(
    executable,
    `#!${process.execPath}
    let socket;
    process.on('SIGINT', () => socket.write('stopped'));
    socket = await Bun.connect({ unix: ${JSON.stringify(path.join(home, 'sampler.sock'))}, socket: {
      open(socket) { socket.write('ready'); },
      data() { process.exit(0); }
    }});
  `,
    { mode: 0o700 },
  );
  let ended = false;
  const listener = Bun.listen<{ buffer: string }>({
    unix: path.join(home, '.merkur', 'profile.sock'),
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes('\n')) return;
        const request = decodeProfileRequest(socket.data.buffer.trim());
        if (request?.op === 'sessions') {
          socket.end(
            `${JSON.stringify({ ok: true, sessions: [{ sessionId: 's', peerId: 'p', inputMsAgo: 0 }], dataplanePid: 42 })}\n`,
          );
        } else if (request?.op === 'start') {
          void ready.promise.then(() =>
            socket.end(`${JSON.stringify({ ok: false, reason: 'controlled_start_failure' })}\n`),
          );
        } else if (request?.op === 'end') {
          ended = true;
          socket.end('{"ok":true}\n');
        } else {
          throw new Error('unexpected profile request');
        }
      },
    },
  });
  const script = `const { runProfileCommand } = await import(${JSON.stringify(new URL('./profile.ts', import.meta.url).href)}); process.exit(await runProfileCommand(['record', '--cpu']));`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, MERKUR_DAEMON_HOME: home, MERKUR_SAMPLY: executable },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    await stopped.promise;
    expect(ended).toBe(true);
    expect(child.exitCode).toBeNull();
    sampler?.write('exit');
    expect(await child.exited).toBe(1);
  } finally {
    sampler?.write('exit');
    child.kill('SIGKILL');
    await child.exited;
    listener.stop(true);
    samplerListener.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});
