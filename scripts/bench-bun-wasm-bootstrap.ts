/** Fresh-process Bun loader measurements. Constructor probes run separately from timings. */
import { fullGC, heapStats } from 'bun:jsc';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { e2eWasm } from '../packages/shared/src/e2e-wasm-runtime';
import { emitPerfMetric, perfEnvInteger, summarizeSamples } from './perf/harness';

const mode = process.argv[process.argv.indexOf('--child') + 1];

if (process.argv.includes('--child')) {
  let copies = 0;
  let copiedBytes = 0;
  let modules = 0;
  let moduleBytes = 0;
  let moduleHash = '';
  const Uint8ArrayConstructor = Uint8Array;
  const ModuleConstructor = WebAssembly.Module;
  if (mode === 'probe') {
    globalThis.Uint8Array = new Proxy(Uint8ArrayConstructor, {
      construct(target, args) {
        if (Buffer.isBuffer(args[0])) {
          copies += 1;
          copiedBytes += args[0].byteLength;
        }
        return Reflect.construct(target, args);
      },
    });
    WebAssembly.Module = new Proxy(ModuleConstructor, {
      construct(target, args) {
        const bytes = args[0];
        assert(ArrayBuffer.isView(bytes));
        modules += 1;
        moduleBytes += bytes.byteLength;
        moduleHash = createHash('sha256')
          .update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
          .digest('hex');
        return Reflect.construct(target, args);
      },
    });
  }
  await import('../packages/shared/src/e2e-wasm-bun');
  assert.equal(modules, 0, 'import alone must not compile');
  const startedAt = performance.now();
  if (mode !== 'import') e2eWasm();
  const initMs = performance.now() - startedAt;
  globalThis.Uint8Array = Uint8ArrayConstructor;
  WebAssembly.Module = ModuleConstructor;
  let verificationMs = 0;
  let fingerprint = '';
  if (mode !== 'import') {
    const wasm = e2eWasm();
    assert.equal(e2eWasm(), wasm);
    const message = Buffer.from('Merkur Bun loader verification');
    assert.deepEqual(
      Buffer.from(wasm.sha512(message)),
      createHash('sha512').update(message).digest(),
    );
    const key = wasm.MlDsa87SigningKey.fromSeed(new Uint8Array(32).fill(7));
    try {
      const context = Buffer.from('merkur-loader-test');
      const publicKey = key.publicKey;
      const signature = key.sign(context, message, new Uint8Array(32).fill(9));
      fingerprint = createHash('sha256').update(publicKey).update(signature).digest('hex');
      const repetitions = mode === 'steady' ? 100 : 1;
      const verifyStarted = performance.now();
      for (let index = 0; index < repetitions; index += 1) {
        assert(wasm.mlDsa87Verify(publicKey, context, message, signature));
        assert(!wasm.mlDsa87Verify(publicKey, context, Buffer.from('altered'), signature));
      }
      verificationMs = (performance.now() - verifyStarted) / repetitions;
    } finally {
      key.free();
    }
  }
  fullGC();
  process.stdout.write(
    `${JSON.stringify({
      mode,
      copies,
      copiedBytes,
      modules,
      moduleBytes,
      moduleHash,
      fingerprint,
      initMs,
      verificationMs,
      retainedHeapBytes: heapStats().heapSize,
    })}\n`,
  );
} else {
  const samples = perfEnvInteger('BENCH_SAMPLES', 30);
  const executable = process.env.BENCH_EXECUTABLE;
  const childCommand =
    executable === undefined ? [process.execPath, import.meta.path] : [executable];
  const baseline = process.env.BENCH_BASELINE_EXECUTABLE;
  const arms: Record<string, string[]> =
    baseline === undefined
      ? { current: childCommand }
      : { baseline: [baseline], current: childCommand };
  const control = process.env.BENCH_CONTROL_EXECUTABLE;
  if (control !== undefined) arms.control = [control];
  for (const workload of ['probe', 'import', 'init', 'steady']) {
    const observationsByArm = new Map<string, Array<Record<string, number | string>>>();
    for (let sample = 0; sample < (workload === 'probe' ? 1 : samples); sample += 1) {
      const order = Object.entries(arms);
      if (sample % 2 !== 0) order.reverse();
      for (const [arm, command] of order) {
        const observations = observationsByArm.get(arm) ?? [];
        observationsByArm.set(arm, observations);
        const timedCommand = [...command, '--child', workload];
        if (process.platform === 'darwin') timedCommand.unshift('/usr/bin/time', '-l');
        const child = Bun.spawn(timedCommand, {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        assert.equal(exitCode, 0, stderr);
        // SAFETY: The measured child emits the numeric/string record exercised by the parser test.
        const observation = JSON.parse(stdout) as Record<string, number | string>;
        if (process.platform === 'darwin')
          for (const [key, label] of [
            ['instructions', 'instructions retired'],
            ['peakRssBytes', 'maximum resident set size'],
            ['peakFootprintBytes', 'peak memory footprint'],
          ]) {
            assert(key !== undefined && label !== undefined);
            const match = stderr.match(new RegExp(`(\\d+)\\s+${label}`));
            assert(match?.[1] !== undefined, stderr);
            observation[key] = Number(match[1]);
          }
        observations.push(observation);
      }
    }
    const reference = observationsByArm.values().next().value?.[0];
    assert(reference !== undefined);
    for (const [arm, observations] of observationsByArm) {
      const first = observations[0];
      assert(first !== undefined);
      for (const row of observations) assert.equal(row.fingerprint, reference.fingerprint);
      if (workload === 'probe') assert.equal(first.moduleHash, reference.moduleHash);
      const summaries: Record<string, ReturnType<typeof summarizeSamples>> = {};
      for (const key of [
        'instructions',
        'peakRssBytes',
        'peakFootprintBytes',
        'initMs',
        'verificationMs',
        'retainedHeapBytes',
      ]) {
        if (first[key] === undefined) continue;
        summaries[key] = summarizeSamples(observations.map((row) => Number(row[key])));
      }
      if (workload === 'probe') {
        for (const key of ['copies', 'copiedBytes']) {
          emitPerfMetric({
            name: `bun-wasm-${arm}-${key}`,
            value: Number(first[key]),
            unit: key === 'copies' ? 'copies/init' : 'bytes/init',
            direction: 'lower',
            sampleSize: 1,
          });
        }
      } else {
        for (const [key, summary] of Object.entries(summaries)) {
          emitPerfMetric({
            name: `bun-wasm-${arm}-${workload}-${key}`,
            value: summary.median,
            unit:
              key === 'verificationMs'
                ? 'ms/verification-pair'
                : key.endsWith('Ms')
                  ? 'ms/process'
                  : key.endsWith('Bytes')
                    ? 'bytes/process'
                    : 'instructions/process',
            direction: 'lower',
            sampleSize: observations.length,
          });
        }
      }
      const output = { workload, arm, samples: observations.length };
      if (workload === 'probe') Object.assign(output, first);
      Object.assign(output, summaries);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  }
}
