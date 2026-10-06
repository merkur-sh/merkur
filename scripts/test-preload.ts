import './test-inert-finalization';
import '@merkur/shared/e2e-wasm-bun';
import { MerkurJsonLogger } from '@merkur/logger';
import { References } from 'effect';

// Unit tests exercise service code without providing `MerkurLoggerLayer`, so
// Effect logging falls through to its built-in console logger. That logger
// writes straight to the console and never consults `LOG_LEVEL`, which is why
// deliberate failure-path logging still flooded `LOG_LEVEL=silent` runs and
// buried real failures in thousands of lines of expected noise.
//
// Effect 4 exposes no process-global logger switch, and a preload has no fiber
// to provide a layer to. A `Context.Reference`'s default is an ordinary
// property, though, so retargeting it here gives every fiber that has not been
// given an explicit logger the same one the server runtime installs: it honours
// `LOG_LEVEL` through the shared sink and emits the production JSON shape.
//
// Tests that provide their own logger layer still win — this only replaces the
// fallback.
const currentLoggers: { defaultValue: () => ReadonlySet<typeof MerkurJsonLogger> } =
  References.CurrentLoggers;
currentLoggers.defaultValue = () => new Set([MerkurJsonLogger]);

// A synchronous spawn can lose its child's exit and take every later one in the worker with
// it (oven-sh/bun#34069), so the call fails here, by name, instead of hanging another test.
// `node:child_process`'s synchronous calls arrive through this property too.
Object.assign(Bun, {
  spawnSync(): never {
    throw new Error(
      'a test worker spawned synchronously: use runTestProcess (scripts/test-process.ts) or an awaited Bun.spawn',
    );
  },
});
