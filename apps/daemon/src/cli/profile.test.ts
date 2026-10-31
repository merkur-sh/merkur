import { describe, expect, test } from 'bun:test';
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
