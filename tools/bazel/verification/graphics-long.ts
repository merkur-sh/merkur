import {
  nativeGraphicsInventory,
  nativeGraphicsMain,
  runNativeGraphics,
  verifyNativeGraphicsRun,
} from './real-helper';

export const graphicsLongFilter = 'display::graphics_convergence::long::';
export const graphicsLongCases = Object.freeze([
  `${graphicsLongFilter}projected_graphics_converge_across_many_seeds`,
  `${graphicsLongFilter}kitty_graphics_converge_across_many_seeds`,
]);
export const graphicsLongArguments = Object.freeze(['--ignored', graphicsLongFilter]);

function casesFor(role: string) {
  if (role === 'lib') return graphicsLongCases;
  // The original main.rs only calls merkur_dataplane::main(); Cargo still runs
  // its empty libtest binary. All long assertions remain mandatory on the Lib.
  if (role === 'bin') return [];
  throw new Error('Long graphics requires its fixed Lib or Bin role');
}

export function graphicsLongInventory(output: string, role: string) {
  return nativeGraphicsInventory(output, casesFor(role));
}

export function verifyGraphicsLongRun(output: string, exitCode: number, role: string) {
  verifyNativeGraphicsRun(output, exitCode, casesFor(role));
}

if (import.meta.main) {
  await nativeGraphicsMain(async (request, runfiles, temporary) => {
    await runNativeGraphics(request, runfiles, temporary, {
      filter: graphicsLongFilter,
      cases: casesFor(process.argv[2] ?? ''),
      args: graphicsLongArguments,
    });
  }, 3);
}
