/**
 * `bun run bench:relay-keystroke-packets [--out <dir>] [--no-netlog] [--direct]`
 *
 * Runs the relay packet census (`relay-keystroke-packets.e2e.ts`) through the
 * local edge harness at the `fast` 50 ms profile unless `EDGE_NETWORK_PROFILE`
 * says otherwise, then prints packets per keystroke on each leg, net of the
 * idle rate, and which messages shared a packet. Chromium's net log is on by
 * default because the browser leg's packet composition comes only from it;
 * `--no-netlog` is the control arm, since logging perturbs Chromium's network
 * thread. `--direct` measures the direct path (`FORCE_EDGE=0`): its packets
 * never cross the delay proxy, so both of its browser-leg figures come from the
 * net log, which that arm therefore requires. Set `EDGE_PORT=14433` when a
 * daemon already holds the default port.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseNetlogPackets, summarizeWindow } from './analyze-quic-netlog';

const ROOT = path.resolve(import.meta.dir, '..');
const RELAY_ARMS = ['profiling-off', 'profiling-on'] as const;
const DIRECT_ARMS = ['direct-profiling-off', 'direct-profiling-on'] as const;

interface Counts {
  readonly up: number;
  readonly down: number;
}

interface CensusReport {
  readonly arm: string;
  readonly windows: ReadonlyArray<{
    readonly name: string;
    readonly keys: number;
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly browser: Counts;
    readonly daemon: Counts;
  }>;
  readonly daemonLeg: {
    readonly inputAckDatagrams: number;
    readonly inputAckWithDisplay: number;
    readonly inputAckQueuedToPacketizedUs: {
      readonly count: number;
      readonly p50: number;
      readonly p95: number;
      readonly max: number;
    } | null;
    readonly compositions: Readonly<Record<string, number>>;
  } | null;
}

function parseArgs(argv: readonly string[]): { out: string; netlog: boolean; direct: boolean } {
  let out: string | null = null;
  let netlog = true;
  let direct = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-netlog') netlog = false;
    else if (arg === '--direct') direct = true;
    else if (arg === '--out' && argv[index + 1] !== undefined) {
      out = path.resolve(argv[index + 1] ?? '');
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (direct && !netlog) throw new Error('--direct counts the browser leg from the net log');
  return {
    out: out ?? mkdtempSync(path.join(os.tmpdir(), 'merkur-relay-packets-')),
    netlog,
    direct,
  };
}

interface WindowCounts {
  readonly name: string;
  readonly keys: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly counts: Counts;
}

/** Packets per key in a typing window, net of the 30 s idle window's rate. */
function perKey(windows: readonly WindowCounts[], name: string) {
  const idle = windows.find((window) => window.name === 'idle-30s');
  const typing = windows.find((window) => window.name === name);
  if (idle === undefined || typing === undefined || typing.keys === 0) return null;
  const idleMs = idle.endedAtMs - idle.startedAtMs;
  const typingMs = typing.endedAtMs - typing.startedAtMs;
  const net = (key: 'up' | 'down') =>
    (typing.counts[key] - (idle.counts[key] * typingMs) / idleMs) / typing.keys;
  return { up: net('up'), down: net('down') };
}

/** The proxy's per-window counts for one leg. */
function proxyWindows(report: CensusReport, leg: 'browser' | 'daemon'): WindowCounts[] {
  return report.windows.map((window) => ({ ...window, counts: window[leg] }));
}

async function main(): Promise<void> {
  const { out, netlog, direct } = parseArgs(process.argv.slice(2));
  const arms = direct ? DIRECT_ARMS : RELAY_ARMS;
  mkdirSync(out, { recursive: true });
  const netlogPath = path.join(out, 'netlog.json');
  const logPath = path.join(out, 'harness.log');
  process.stdout.write(`${direct ? 'direct' : 'relay'} packet census: artifacts in ${out}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EDGE_NETWORK_PROFILE: process.env.EDGE_NETWORK_PROFILE ?? 'fast',
    FORCE_EDGE: direct ? '0' : '1',
    MERKUR_E2E_FINAL_TRANSPORT_CAPTURE: '1',
    RELAY_PACKETS_REPORT_DIR: out,
    PW_E2E_OUTPUT_DIR: path.join(out, 'playwright'),
  };
  if (netlog) env.PW_E2E_NETLOG = netlogPath;
  else delete env.PW_E2E_NETLOG;
  const log = createWriteStream(logPath);
  const harness = spawn(
    'bun',
    ['run', 'scripts/run-edge-harness.ts', 'relay-keystroke-packets.e2e.ts', '--workers=1'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  harness.stdout.pipe(log);
  harness.stderr.pipe(log);
  const code = await new Promise<number>((resolve) => harness.once('exit', (c) => resolve(c ?? 1)));
  if (code !== 0) {
    process.stderr.write(`census harness exited ${code}; see ${logPath}\n`);
    process.exit(code);
  }

  const reports: CensusReport[] = [];
  for (const arm of arms) {
    const file = path.join(out, `relay-keystroke-packets-${arm}.json`);
    if (existsSync(file)) reports.push(JSON.parse(await readFile(file, 'utf8')) as CensusReport);
  }
  const packets =
    netlog && existsSync(netlogPath)
      ? parseNetlogPackets(await readFile(netlogPath, 'utf8'))
      : null;
  const summary = reports.map((report) => {
    const browserLeg =
      packets === null ? null : report.windows.map((window) => summarizeWindow(packets, window));
    // Direct packets never cross the proxy: the net log counts that browser leg,
    // and the daemon leg has no packet total, only the native trace's composition.
    const browserWindows: WindowCounts[] = direct
      ? (browserLeg ?? []).map((window, index) => ({
          ...(report.windows[index] as CensusReport['windows'][number]),
          counts: { up: window.up.packets, down: window.down.packets },
        }))
      : proxyWindows(report, 'browser');
    const daemonWindows = direct ? [] : proxyWindows(report, 'daemon');
    return {
      arm: report.arm,
      browserPerKey: {
        oneKeyPerSecond: perKey(browserWindows, 'keys-1ps'),
        sixKeysPerSecond: perKey(browserWindows, 'keys-6ps'),
      },
      daemonPerKey: {
        oneKeyPerSecond: perKey(daemonWindows, 'keys-1ps'),
        sixKeysPerSecond: perKey(daemonWindows, 'keys-6ps'),
      },
      daemonLeg: report.daemonLeg,
      browserLeg,
    };
  });
  writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const fixed = (value: number | undefined) => (value === undefined ? '—' : value.toFixed(2));
  for (const arm of summary) {
    const six = arm.browserPerKey.sixKeysPerSecond;
    const one = arm.browserPerKey.oneKeyPerSecond;
    const daemon = arm.daemonPerKey.sixKeysPerSecond;
    process.stdout.write(
      `\n${arm.arm}: browser leg packets per key, net of idle\n` +
        `  6 keys/s: up ${fixed(six?.up)}  down ${fixed(six?.down)}\n` +
        `  1 key/s:  up ${fixed(one?.up)}  down ${fixed(one?.down)}\n` +
        `  daemon leg at 6 keys/s: up ${fixed(daemon?.up)}  down ${fixed(daemon?.down)}\n`,
    );
    if (arm.daemonLeg !== null) {
      process.stdout.write(
        `  daemon input ACK datagrams sharing a packet with display: ${arm.daemonLeg.inputAckWithDisplay}/${arm.daemonLeg.inputAckDatagrams}\n`,
      );
      const residence = arm.daemonLeg.inputAckQueuedToPacketizedUs;
      if (residence !== null) {
        process.stdout.write(
          `  daemon input ACK queued to packetized: p50 ${residence.p50} µs  p95 ${residence.p95} µs  max ${residence.max} µs (${residence.count})\n`,
        );
      }
    }
    const sixWindow = arm.browserLeg?.find((window) => window.name === 'keys-6ps');
    if (sixWindow !== undefined) {
      for (const direction of ['up', 'down'] as const) {
        const top = sixWindow[direction].signatures
          .slice(0, 8)
          .map(([signature, count]) => `${count}× ${signature}`)
          .join(' | ');
        process.stdout.write(`  6 keys/s ${direction}: ${top}\n`);
      }
      const cycles = sixWindow.keystrokeCycles;
      if (cycles !== null) {
        const late = cycles.lateLabels
          .map(([label, perKey]) => `${label} ${perKey.toFixed(2)}`)
          .join(', ');
        process.stdout.write(
          `  6 keys/s after the display ACK: ${cycles.loneAcksPerKey.toFixed(2)} lone ACKs, ` +
            `${cycles.lateDownstreamPerKey.toFixed(2)} late packets per key (${late})\n`,
        );
      }
    }
  }
  process.stdout.write(`\nfull summary: ${path.join(out, 'summary.json')}\n`);
}

await main();
