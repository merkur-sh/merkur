import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeNativeTrace } from './mtrace';
import { TraceMergeError, writePerfettoTrace } from './perfetto';
import { ProtoWriter } from './protobuf';
import { type CpuProfile, decodeSamplyProfile } from './samply';

const CAPTURE = decodeNativeTrace(
  readFileSync(path.join(import.meta.dir, '../../merkur-trace/testdata/capture.mtrace')),
);

interface Field {
  readonly field: number;
  readonly value: bigint | Uint8Array;
}

/** Reads one message's fields; enough of the wire format to check what the writer wrote. */
function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let index = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = bytes[index] ?? 0;
      index += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7n;
    }
  };
  while (index < bytes.length) {
    const key = Number(varint());
    if ((key & 7) === 0) out.push({ field: key >> 3, value: varint() });
    else {
      const length = Number(varint());
      out.push({ field: key >> 3, value: bytes.subarray(index, index + length) });
      index += length;
    }
  }
  return out;
}

function one(message: Uint8Array, field: number): bigint | Uint8Array | undefined {
  return fields(message).find((entry) => entry.field === field)?.value;
}

function nested(message: Uint8Array, field: number): Uint8Array {
  const value = one(message, field);
  if (!(value instanceof Uint8Array)) throw new Error(`no message field ${field}`);
  return value;
}

const CPU: CpuProfile = {
  clock: 'mach-uptime-raw',
  frames: [
    { name: 'main', library: 'merkur-dataplane', address: 0x10 },
    { name: 'pack', library: 'merkur-dataplane', address: 0x20 },
  ],
  threads: [
    {
      pid: CAPTURE.pid,
      tid: 1_001,
      name: 'merkur-display-prepare',
      samples: [{ atNs: CAPTURE.originAnchorNs + 1_500n, stack: [0, 1] }],
    },
  ],
};

describe('ProtoWriter', () => {
  test('writes varints and length-delimited fields exactly', () => {
    expect([...new ProtoWriter().uint(1, 300).finish()]).toEqual([0x08, 0xac, 0x02]);
    expect([...new ProtoWriter().string(2, 'ab').finish()]).toEqual([0x12, 0x02, 0x61, 0x62]);
    expect([...new ProtoWriter().message(3, (m) => m.uint(1, 1)).finish()]).toEqual([
      0x1a, 0x02, 0x08, 0x01,
    ]);
    expect(() => new ProtoWriter().uint(1, -1)).toThrow(RangeError);
  });
});

describe('writePerfettoTrace', () => {
  test('puts every span and sample on the anchor clock, under the capture process', () => {
    const packets = fields(writePerfettoTrace(CAPTURE, CPU))
      .filter((entry) => entry.field === 1)
      .map((entry) => entry.value)
      .filter((value): value is Uint8Array => value instanceof Uint8Array);
    const events = packets.filter((packet) => one(packet, 11) !== undefined);
    expect(events.map((packet) => one(packet, 8))).toEqual(
      CAPTURE.spans.map((span) => CAPTURE.originAnchorNs + BigInt(span.atNs)),
    );
    const names = events.map((packet) => one(nested(packet, 11), 23));
    expect(
      names.map((name) => (name instanceof Uint8Array ? new TextDecoder().decode(name) : name)),
    ).toEqual(['display.flush', undefined, 'channel.hop']);
    const threads = packets
      .map((packet) => one(packet, 60))
      .filter((track): track is Uint8Array => track instanceof Uint8Array)
      .map((track) => one(track, 4))
      .filter((thread): thread is Uint8Array => thread instanceof Uint8Array)
      .map((thread) => [one(thread, 1), one(thread, 2)]);
    expect(threads).toEqual([
      [BigInt(CAPTURE.pid), 1_001n],
      [BigInt(CAPTURE.pid), 1_002n],
    ]);
    const samples = packets.filter((packet) => one(packet, 66) !== undefined);
    expect(samples).toHaveLength(1);
    const sample = samples[0] ?? new Uint8Array();
    expect(one(sample, 8)).toBe(CAPTURE.originAnchorNs + 1_500n);
    expect([1, 2, 3].map((field) => one(nested(sample, 66), field))).toEqual([
      0n,
      BigInt(CAPTURE.pid),
      1_001n,
    ]);
  });

  test('refuses a CPU profile of another clock or another process', () => {
    expect(() => writePerfettoTrace(CAPTURE, { ...CPU, clock: 'linux-monotonic' })).toThrow(
      TraceMergeError,
    );
    const elsewhere = { ...CPU, threads: CPU.threads.map((thread) => ({ ...thread, pid: 1 })) };
    expect(() => writePerfettoTrace(CAPTURE, elsewhere)).toThrow('no thread of process');
  });
});

describe('decodeSamplyProfile', () => {
  const profile = {
    meta: { startTimeAsMachAbsoluteTimeNanoseconds: 1_000_000 },
    libs: [{ name: 'merkur-dataplane' }],
    shared: {
      stringArray: ['main', 'pack'],
      stackTable: { frame: [0, 1], prefixOffset: [0, 1] },
      frameTable: { func: [0, 1], address: [16, 32], lib: [0, 0] },
      funcTable: { name: [0, 1] },
    },
    threads: [
      {
        name: 'merkur-display-prepare',
        pid: '42',
        tid: '1001',
        samples: { stack: [1, 1, null], timeDeltas: [0.5, 1, 1], threadCPUDelta: [10, 0, 10] },
      },
    ],
  };

  test('roots each stack, keeps on-CPU samples, and stamps them on the anchor clock', () => {
    const cpu = decodeSamplyProfile(gzipSync(JSON.stringify(profile)));
    expect(cpu.clock).toBe('mach-uptime-raw');
    expect(cpu.frames.map((frame) => frame.name)).toEqual(['main', 'pack']);
    expect(cpu.threads).toEqual([
      {
        pid: 42,
        tid: 1001,
        name: 'merkur-display-prepare',
        samples: [{ atNs: 1_500_000n, stack: [0, 1] }],
      },
    ]);
  });

  test('refuses a profile without an anchor-clock zero', () => {
    const unanchored = { ...profile, meta: {} };
    expect(() => decodeSamplyProfile(gzipSync(JSON.stringify(unanchored)))).toThrow('zero');
  });
});
