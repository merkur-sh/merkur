/**
 * Imported first by `test-preload.ts`, before any module that constructs a registry.
 *
 * `bun test --isolate` gives each test file a fresh global inside one worker process, and a
 * `FinalizationRegistry` made by one file outlives that file: its cleanup callback runs at a
 * later collection, in a global that is gone. wasm-bindgen's glue registers every exported
 * object that way, and the worker then dies in the cleanup call, in the collector's marking or
 * in the Wasm fault handler, which aborts the whole run. No test observes a collection, so a
 * registry here registers nothing; an object a test does not free goes with its file's Wasm
 * instance.
 */
class InertFinalizationRegistry {
  register(): void {}

  unregister(): boolean {
    return false;
  }
}

globalThis.FinalizationRegistry =
  InertFinalizationRegistry as unknown as FinalizationRegistryConstructor;
