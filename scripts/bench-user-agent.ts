import { cpus } from 'node:os';

import { USER_AGENT_CASES } from '../packages/user-agent/src/fixtures';
import { parseBrowser, parsePlatform } from '../packages/user-agent/src/index';
import { emitPerfMetric, summarizeSamples } from './perf/harness';

const SAMPLES = 15;
const WARMUPS = 3;
const ROUNDS = 1_000;

const operations = {
  identity: (headers: Headers) => {
    const result = parseBrowser(headers);
    return (result.browser?.length ?? 0) + (result.platform?.length ?? 0);
  },
  platform: (headers: Headers) => parsePlatform(headers)?.length ?? 0,
};

if (process.argv.length > 2) {
  throw new Error('usage: bun run scripts/bench-user-agent.ts');
}

const cases = USER_AGENT_CASES.map((sample) => {
  const headers = new Headers(sample.headers);
  const actual = parseBrowser(headers);
  if (
    actual.browser !== sample.browser ||
    actual.platform !== sample.platform ||
    parsePlatform(headers) !== sample.platform
  ) {
    throw new Error(`production identity oracle failed: ${sample.name}`);
  }
  return { ...sample, headers };
});
const groups = [
  {
    name: 'ua',
    inputs: cases
      .filter((sample) => sample.browser !== null && !sample.headers.has('sec-ch-ua'))
      .map((sample) => sample.headers),
  },
  {
    name: 'hints',
    inputs: cases
      .filter((sample) => sample.headers.has('sec-ch-ua'))
      .map((sample) => sample.headers),
  },
  {
    name: 'unknown',
    inputs: cases.filter((sample) => sample.browser === null).map((sample) => sample.headers),
  },
];
process.stdout.write(
  `${JSON.stringify({ bun: Bun.version, os: process.platform, arch: process.arch, cpu: cpus()[0]?.model, samples: SAMPLES, warmups: WARMUPS, rounds: ROUNDS })}\n`,
);
let sink = 0;
for (const operation of ['identity', 'platform'] as const) {
  for (const group of groups) {
    const samples: number[] = [];
    const run = operations[operation];
    for (let sample = -WARMUPS; sample < SAMPLES; sample++) {
      let checksum = 0;
      const start = performance.now();
      for (let round = 0; round < ROUNDS; round++) {
        for (const headers of group.inputs) checksum += run(headers);
      }
      const ns = ((performance.now() - start) * 1e6) / (ROUNDS * group.inputs.length);
      sink += checksum;
      if (sample >= 0) samples.push(ns);
    }
    const summary = summarizeSamples(samples);
    const name = `${operation}.${group.name}.merkur`;
    process.stdout.write(
      `${JSON.stringify({ name, inputs: group.inputs.length, samples, summary })}\n`,
    );
    emitPerfMetric({
      name,
      value: summary.median,
      unit: 'ns/op',
      direction: 'lower',
      sampleSize: SAMPLES,
    });
  }
}
process.stdout.write(`${JSON.stringify({ checksum: sink })}\n`);
