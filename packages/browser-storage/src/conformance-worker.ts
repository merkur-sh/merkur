/**
 * The conformance scenarios as a dedicated worker runs them: `engines.test.ts`
 * starts this bundle as a module worker, which answers its first message with
 * the results.
 */
import { runScenarios } from './conformance';

addEventListener(
  'message',
  () => {
    void runScenarios({
      indexedDB: typeof indexedDB !== 'undefined',
      webStorage: typeof localStorage !== 'undefined',
    }).then((results) => postMessage(results));
  },
  { once: true },
);
