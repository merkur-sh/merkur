import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { Option, Schema } from 'effect';
import { daemonProfileSocketPath, daemonProfilesPath } from '../config';
import type { DataplaneProfileSession } from '../services/dataplane-client';
import {
  type ProfileReply,
  ProfileReplySchema,
  type ProfileRequest,
} from '../services/profile-socket';

const USAGE = `usage: merkur profile sessions
       merkur profile record [--session <id>|current] [--seconds <n>] [--cpu]
`;

/**
 * `merkur profile`: record what the running dataplane does for one live session.
 *
 * `record` starts the native trace observation of a session (the one typed into most
 * recently unless `--session` names another), waits, has the dataplane write the capture,
 * and ends the observation. With `--cpu` it also attaches samply to the dataplane for the
 * same window (`MERKUR_SAMPLY` names the binary; `samply` on PATH otherwise). Everything
 * lands in one directory under ~/.merkur/profiles, which `bun run profile:*` reads.
 */
export async function runProfileCommand(args: readonly string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'sessions' && rest.length === 0) return listSessions();
  if (subcommand === 'record') {
    const options = parseRecordOptions(rest);
    if (options === null) {
      process.stderr.write(USAGE);
      return 2;
    }
    return record(options);
  }
  process.stderr.write(USAGE);
  return 2;
}

interface RecordOptions {
  readonly session: string;
  readonly seconds: number;
  readonly cpu: boolean;
}

export function parseRecordOptions(args: readonly string[]): RecordOptions | null {
  let session = 'current';
  let seconds = 10;
  let cpu = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--cpu') cpu = true;
    else if (arg === '--session' || arg === '--seconds') {
      const value = args[index + 1];
      if (value === undefined) return null;
      index += 1;
      if (arg === '--session') session = value;
      else {
        seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) return null;
      }
    } else return null;
  }
  return { session, seconds, cpu };
}

/** The session `current` names: the one whose input is most recent. */
export function pickSession(
  sessions: readonly DataplaneProfileSession[],
  wanted: string,
): DataplaneProfileSession | null {
  if (wanted !== 'current') return sessions.find((session) => session.sessionId === wanted) ?? null;
  let best: DataplaneProfileSession | null = null;
  for (const session of sessions) {
    if (session.inputMsAgo === null) continue;
    if (best === null || session.inputMsAgo < (best.inputMsAgo ?? Number.POSITIVE_INFINITY))
      best = session;
  }
  return best;
}

async function listSessions(): Promise<number> {
  const reply = await request({ op: 'sessions' });
  if (!reply.ok || !('sessions' in reply)) return fail(reply);
  if (reply.sessions.length === 0) {
    process.stdout.write('No authenticated sessions.\n');
    return 0;
  }
  for (const session of reply.sessions) {
    const input =
      session.inputMsAgo === null ? 'no input yet' : `input ${session.inputMsAgo} ms ago`;
    process.stdout.write(`${session.sessionId}  peer ${session.peerId}  ${input}\n`);
  }
  return 0;
}

async function record(options: RecordOptions): Promise<number> {
  const listed = await request({ op: 'sessions' });
  if (!listed.ok || !('sessions' in listed)) return fail(listed);
  const session = pickSession(listed.sessions, options.session);
  if (session === null) {
    process.stderr.write(
      options.session === 'current'
        ? 'merkur profile: no session has had input yet; name one with --session\n'
        : `merkur profile: no authenticated session ${options.session}\n`,
    );
    return 1;
  }
  const bundle = path.join(daemonProfilesPath(), new Date().toISOString().replaceAll(':', '-'));
  await mkdir(bundle, { recursive: true, mode: 0o700 });

  let samply: Bun.Subprocess | null = null;
  if (options.cpu) {
    if (listed.dataplanePid === null) {
      process.stderr.write('merkur profile: the dataplane is not running\n');
      return 1;
    }
    samply = Bun.spawn(
      [
        process.env.MERKUR_SAMPLY ?? 'samply',
        'record',
        '--save-only',
        '--presymbolicate',
        '-o',
        path.join(bundle, 'cpu.json.gz'),
        '-p',
        String(listed.dataplanePid),
      ],
      { stdout: 'ignore', stderr: 'inherit' },
    );
  }

  const started = await request({ op: 'start', sessionId: session.sessionId });
  if (!started.ok) {
    samply?.kill('SIGINT');
    return fail(started);
  }
  process.stderr.write(`Recording session ${session.sessionId} for ${options.seconds} s…\n`);
  await Bun.sleep(options.seconds * 1000);
  const captured = await request({ op: 'capture' });
  const ended = await request({ op: 'end' });
  // samply saves its profile when interrupted while its target still runs.
  samply?.kill('SIGINT');
  const samplyExit = samply === null ? 0 : await samply.exited;
  if (!captured.ok || !('path' in captured)) return fail(captured);
  const spans = path.join(bundle, 'spans.mtrace');
  await rename(captured.path, spans);
  if (!ended.ok) return fail(ended);
  process.stdout.write(`${bundle}\n`);
  if (samplyExit !== 0) {
    process.stderr.write(
      `merkur profile: samply exited ${samplyExit}; the CPU profile is absent\n`,
    );
    return 1;
  }
  return 0;
}

function fail(reply: ProfileReply): number {
  process.stderr.write(
    `merkur profile: ${!reply.ok ? reply.reason : 'unexpected reply from the daemon'}\n`,
  );
  return 1;
}

/** One request over the daemon's profile socket, answered by one JSON line. */
async function request(value: ProfileRequest): Promise<ProfileReply> {
  const { promise, resolve } = Promise.withResolvers<ProfileReply>();
  let buffer = '';
  try {
    await Bun.connect({
      unix: daemonProfileSocketPath(),
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify(value)}\n`);
        },
        data(_socket, chunk) {
          buffer += chunk.toString('utf8');
        },
        close() {
          resolve(decodeReply(buffer));
        },
        error() {
          resolve({ ok: false, reason: 'daemon_unreachable' });
        },
      },
    });
  } catch {
    return { ok: false, reason: 'daemon_unreachable: is the Merkur daemon running?' };
  }
  return promise;
}

const decodeReplyLine = Schema.decodeUnknownOption(Schema.fromJsonString(ProfileReplySchema), {
  onExcessProperty: 'error',
});

/** One reply line, in exactly one of its shapes. */
export function decodeReply(line: string): ProfileReply {
  return Option.getOrElse(decodeReplyLine(line), () => ({
    ok: false as const,
    reason: 'malformed_reply',
  }));
}
