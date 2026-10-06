import { expect, test } from 'bun:test';
import { runTestProcess } from '../test-process';

test('historical workers bundle deleted WebGL source exclusively from Git archives', async () => {
  // Isolate Bun build-plugin/tsconfig state from subsequent runtime test imports.
  const run = await runTestProcess(
    [
      'bun',
      '-e',
      `
    import { historicalWebGlPlugin } from "./scripts/perf/historical-webgl";
    const rows = [];
    for (const [file, twoCredit] of [["immutable-image-worker", false], ["webgpu-terminal-worker", true], ["webgl-fence-cadence-worker", true]]) {
      const closure = {};
      const result = await Bun.build({ entrypoints: ["scripts/perf/" + file + ".ts"], target: "browser", format: "esm", plugins: [historicalWebGlPlugin(process.cwd(), twoCredit, closure)] });
      if (!result.success) throw new Error(String(result.logs));
      const source = await result.outputs[0].text();
      rows.push({ renderer: closure["apps/web/src/renderer-webgl2.ts"], atlas: closure["apps/web/src/atlas-texture-upload.ts"], virtual: source.includes("merkur-historical-webgl"), production: source.includes("WebGPU is required for terminal rendering") });
    }
    process.stdout.write(JSON.stringify(rows));
  `,
    ],
    { cwd: new URL('../..', import.meta.url).pathname },
  );
  expect(run.exitCode, run.stderr).toBe(0);
  const rows: { renderer: string; atlas: string; virtual: boolean; production: boolean }[] =
    JSON.parse(run.stdout);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.renderer).toHaveLength(64);
    expect(row.atlas).toHaveLength(64);
    expect(row.virtual).toBe(false);
    expect(row.production).toBe(false);
  }
});
