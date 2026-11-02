/**
 * The conformance scenarios as a page runs them: `engines.test.ts` bundles this
 * for the browser and calls what it installs on `globalThis`.
 */
import { incrementConcurrently, runScenarios, type ScenarioResult } from './conformance';

export interface PageConformance {
  run(): Promise<ScenarioResult[]>;
  increment(database: string, times: number): Promise<number | null>;
}

const conformance: PageConformance = {
  run: () =>
    runScenarios({
      indexedDB: typeof indexedDB !== 'undefined',
      webStorage: typeof localStorage !== 'undefined',
    }),
  increment: incrementConcurrently,
};

Object.defineProperty(globalThis, 'storageConformance', { value: conformance });
