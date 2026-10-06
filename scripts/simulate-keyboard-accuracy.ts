import {
  KEYBOARD_GESTURE_FAMILIES,
  type KeyboardAccuracyBreakdown,
  type KeyboardAccuracySimulationOptions,
  runKeyboardAccuracySimulation,
} from './keyboard-accuracy-simulator';

const arguments_ = parseArguments(process.argv.slice(2));
const startedAt = performance.now();
const report = runKeyboardAccuracySimulation(arguments_.options);
const elapsedMs = performance.now() - startedAt;

if (arguments_.json) {
  process.stdout.write(`${JSON.stringify({ ...report, elapsedMs }, null, 2)}\n`);
} else {
  printReport(report, elapsedMs);
}

interface ParsedArguments {
  readonly options: KeyboardAccuracySimulationOptions;
  readonly json: boolean;
}

function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let seed: number | undefined;
  let samplesPerKey: number | undefined;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (argument === '--seed' || argument === '--samples') {
      if (value === undefined) throw new Error(`${argument} requires a value`);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${argument} requires a positive integer`);
      }
      if (argument === '--seed') seed = parsed;
      else samplesPerKey = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { options: { seed, samplesPerKey }, json };
}

function printReport(
  report: ReturnType<typeof runKeyboardAccuracySimulation>,
  elapsedMs: number,
): void {
  const gesturesPerSecond = Math.round((report.samples / elapsedMs) * 1_000);
  process.stdout.write(
    `Merkur keyboard synthetic accuracy\n` +
      `seed=${report.seed} samples=${report.samples.toLocaleString('en-US')} ` +
      `samples/key=${report.samplesPerKey} families=${KEYBOARD_GESTURE_FAMILIES.length} ` +
      `tap-drift=${report.tapDrift} release-weight=${report.releaseWeight} ` +
      `elapsed=${elapsedMs.toFixed(1)}ms (${gesturesPerSecond.toLocaleString('en-US')} gestures/s)\n` +
      `engine=${percent(report.engineAccuracy)} hard-atlas=${percent(report.hardAtlasAccuracy)} ` +
      `delta=${signedPercent(report.engineDelta)} rejected=${report.rejected} ` +
      `checksum=${report.checksum.toString(16).padStart(8, '0')}\n\n`,
  );
  printBreakdown('By gesture family', report.byFamily);
  printBreakdown('By orientation/layer', report.byScenario);
  process.stdout.write('Top engine confusions\n');
  for (const confusion of report.confusions.slice(0, 12)) {
    process.stdout.write(
      `  ${confusion.intended.padEnd(18)} -> ${confusion.predicted.padEnd(18)} ${confusion.count}\n`,
    );
  }
  const worstKeys = [...report.byKey]
    .sort(
      (left, right) => left.engineAccuracy - right.engineAccuracy || right.samples - left.samples,
    )
    .slice(0, 12);
  printBreakdown('Lowest-accuracy keys', worstKeys);
  process.stdout.write(
    '\nSynthetic scores compare algorithms under declared stress models; they are not a claim about real-user accuracy.\n',
  );
}

function printBreakdown(title: string, results: readonly KeyboardAccuracyBreakdown[]): void {
  process.stdout.write(`${title}\n`);
  for (const result of results) {
    process.stdout.write(
      `  ${result.name.padEnd(27)} engine=${percent(result.engineAccuracy)} ` +
        `atlas=${percent(result.hardAtlasAccuracy)} delta=${signedPercent(result.engineDelta)} ` +
        `n=${result.samples.toLocaleString('en-US')}\n`,
    );
  }
  process.stdout.write('\n');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function signedPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(2)}pp`;
}
