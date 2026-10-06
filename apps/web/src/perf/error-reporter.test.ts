import { afterEach, describe, expect, test } from 'bun:test';

import {
  BROWSER_ERROR_KINDS,
  BROWSER_ERROR_SOURCES,
  type BrowserErrorReportBody,
} from '@merkur/shared';
import {
  classifyBrowserError,
  createBrowserErrorReporter,
  installGlobalErrorHandlers,
} from './error-reporter';

function harness(): {
  readonly reporter: ReturnType<typeof createBrowserErrorReporter>;
  readonly sent: BrowserErrorReportBody[];
} {
  const sent: BrowserErrorReportBody[] = [];
  const reporter = createBrowserErrorReporter({
    send: (report) => sent.push(report),
    // No real timer: flushing is driven explicitly so the tests are deterministic.
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  });
  return { reporter, sent };
}

describe('classification', () => {
  test.each([
    ['a WASM compile failure', new WebAssembly.CompileError('x'), 'wasm_instantiate'],
    ['a WASM link failure', new WebAssembly.LinkError('x'), 'wasm_instantiate'],
    ['a TypeError', new TypeError('x'), 'type_error'],
    ['a RangeError', new RangeError('x'), 'range_error'],
    ['a ReferenceError', new ReferenceError('x'), 'reference_error'],
    ['a plain Error', new Error('x'), 'other'],
    ['a thrown string', 'boom', 'other'],
    ['a thrown null', null, 'other'],
  ])('classifies %s', (_label, error, expected) => {
    expect(classifyBrowserError(error)).toBe(expected as never);
  });

  test.each([
    ['SecurityError', 'security'],
    ['QuotaExceededError', 'quota'],
    ['AbortError', 'abort'],
    ['NetworkError', 'network'],
  ])('classifies DOMException %s', (name, expected) => {
    expect(classifyBrowserError(new DOMException('x', name))).toBe(expected as never);
  });

  /**
   * The message is the one field that can carry terminal bytes, so classification must never
   * be a function of it. A message that looks like another class must not change the answer.
   */
  test('the message never influences the classification', () => {
    const misleading = new TypeError('SecurityError: QuotaExceededError wasm');
    expect(classifyBrowserError(misleading)).toBe('type_error');
  });

  test('every classification is a member of the closed union', () => {
    for (const error of [new TypeError('x'), new Error('x'), 'boom', 42, undefined]) {
      expect(BROWSER_ERROR_KINDS).toContain(classifyBrowserError(error));
    }
  });
});

describe('accumulation', () => {
  test('nothing is sent until a flush', () => {
    const { reporter, sent } = harness();
    reporter.record('window', new TypeError('x'));
    expect(sent).toEqual([]);
  });

  /**
   * A render loop throwing every frame must become one report with a count, not one report
   * per frame — telemetry must never be the thing that overwhelms the endpoint it reports to.
   */
  test('repeats of one class coalesce into a single counted report', () => {
    const { reporter, sent } = harness();
    for (let index = 0; index < 500; index += 1) {
      reporter.record('window', new TypeError('x'));
    }
    reporter.flush();

    expect(sent).toEqual([{ source: 'window', kind: 'type_error', count: 500 }]);
  });

  /**
   * A request nobody answered throws nothing, so there is no value to classify.
   * It coalesces on exactly the same key as a classified failure — the pair, not
   * the route that recorded it.
   */
  test('an already-classified failure accumulates alongside thrown ones', () => {
    const { reporter, sent } = harness();
    reporter.count('device_events', 'no_response');
    reporter.count('device_events', 'no_response');
    reporter.count('device_events', 'no_frame');
    reporter.record('window', new TypeError('x'));
    reporter.flush();

    expect(sent).toEqual([
      { source: 'device_events', kind: 'no_response', count: 2 },
      { source: 'device_events', kind: 'no_frame', count: 1 },
      { source: 'window', kind: 'type_error', count: 1 },
    ]);
  });

  test('distinct source and kind pairs are reported separately', () => {
    const { reporter, sent } = harness();
    reporter.record('window', new TypeError('x'));
    reporter.record('window', new RangeError('x'));
    reporter.record('session_start', new TypeError('x'));
    reporter.flush();

    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((report) => `${report.source}:${report.kind}`)).size).toBe(3);
  });

  test('a flush clears the accumulation', () => {
    const { reporter, sent } = harness();
    reporter.record('window', new TypeError('x'));
    reporter.flush();
    reporter.flush();

    expect(sent).toHaveLength(1);
  });

  test('an empty flush sends nothing', () => {
    const { reporter, sent } = harness();
    reporter.flush();
    expect(sent).toEqual([]);
  });

  test('stopping discards what was accumulated', () => {
    const { reporter, sent } = harness();
    reporter.record('window', new TypeError('x'));
    reporter.stop();
    reporter.flush();

    expect(sent).toEqual([]);
  });

  test('the count is capped however many failures occurred', () => {
    const { reporter, sent } = harness();
    for (let index = 0; index < 10_050; index += 1) {
      reporter.record('window', new TypeError('x'));
    }
    reporter.flush();

    expect(sent[0]?.count).toBe(10_000);
  });
});

describe('the wire body', () => {
  /**
   * The whole reason this surface can exist: the body is two closed unions and a number, so
   * terminal content cannot be carried even by a modified client.
   */
  test('carries no free-text field', () => {
    const { reporter, sent } = harness();
    reporter.record('window', new TypeError('a secret token leaked into a message'));
    reporter.flush();

    const report = sent[0];
    expect(Object.keys(report ?? {}).sort()).toEqual(['count', 'kind', 'source']);
    expect(BROWSER_ERROR_SOURCES).toContain(report?.source as never);
    expect(BROWSER_ERROR_KINDS).toContain(report?.kind as never);
    expect(typeof report?.count).toBe('number');
    expect(JSON.stringify(report)).not.toContain('secret');
  });
});

/**
 * The coalescing window is a hole exactly where it matters most if nothing flushes on the
 * way out: a user who hits a fatal error and closes the tab does so well inside the
 * interval, so the one report worth having would be the one always lost.
 */
describe('flush on page hide', () => {
  /**
   * A minimal `document` stand-in: this runs outside a DOM, and the reporter reads the
   * global defensively precisely so it can.
   */
  const listeners = new Map<string, () => void>();
  let hidden = false;
  const stubDocument = {
    get visibilityState() {
      return hidden ? 'hidden' : 'visible';
    },
    addEventListener: (name: string, handler: () => void) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };

  /**
   * Removed after every case. A stub `document` left on `globalThis` is not confined to this
   * file — `bun test` shares a process across files, so a lingering
   * `visibilityState: 'hidden'` silently changed the behaviour of an unrelated suite whose
   * subject reads it. Installing a global without removing it is a test that breaks other
   * tests.
   */
  const hadDocument = Object.hasOwn(globalThis, 'document');
  afterEach(() => {
    hidden = false;
    listeners.clear();
    if (!hadDocument) {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });

  test('hiding the page flushes what is pending', () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: stubDocument,
    });
    const sent: BrowserErrorReportBody[] = [];
    const reporter = createBrowserErrorReporter({
      send: (report) => sent.push(report),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    });
    const remove = installGlobalErrorHandlers(reporter);

    reporter.record('window', new TypeError('x'));
    expect(sent).toEqual([]);

    hidden = true;
    listeners.get('visibilitychange')?.();

    expect(sent).toEqual([{ source: 'window', kind: 'type_error', count: 1 }]);
    remove();
  });

  test('the listeners are removed on teardown', () => {
    const sent: BrowserErrorReportBody[] = [];
    const reporter = createBrowserErrorReporter({
      send: (report) => sent.push(report),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    });
    installGlobalErrorHandlers(reporter)();

    globalThis.dispatchEvent(new ErrorEvent('error', { message: 'x' }));
    reporter.flush();

    expect(sent).toEqual([]);
  });
});
