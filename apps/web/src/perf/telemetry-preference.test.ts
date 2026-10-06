import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  initializeTelemetryPreference,
  loadTelemetryEnabled,
  saveTelemetryEnabled,
} from './telemetry-preference';
import { isTerminalPerfRecording, uninstallTerminalPerfRecorder } from './terminal-latency';

const STORAGE_KEY = 'merkur:telemetry-enabled';
const storageEntries = new Map<string, string>();

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageEntries.delete(key);
      },
    },
  });
});

beforeEach(() => {
  storageEntries.clear();
  uninstallTerminalPerfRecorder();
});

describe('telemetry preference', () => {
  test('is off when nothing was ever stored', () => {
    expect(loadTelemetryEnabled()).toBe(false);
    expect(initializeTelemetryPreference()).toBe(false);
    expect(isTerminalPerfRecording()).toBe(false);
  });

  test('only the exact stored value enables it', () => {
    for (const stored of ['false', '1', 'yes', 'TRUE', '']) {
      storageEntries.set(STORAGE_KEY, stored);
      expect(loadTelemetryEnabled()).toBe(false);
    }
    storageEntries.set(STORAGE_KEY, 'true');
    expect(loadTelemetryEnabled()).toBe(true);
  });

  test('a throwing localStorage leaves reporting off rather than propagating', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem(): string | null {
          throw new Error('storage is blocked');
        },
        setItem(): void {},
        removeItem(): void {},
      },
    });

    expect(loadTelemetryEnabled()).toBe(false);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string): string | null => storageEntries.get(key) ?? null,
        setItem: (key: string, value: string): void => void storageEntries.set(key, value),
        removeItem: (key: string): void => void storageEntries.delete(key),
      },
    });
  });

  test('enabling persists the choice and installs the perf recorder', () => {
    saveTelemetryEnabled(true);

    expect(storageEntries.get(STORAGE_KEY)).toBe('true');
    expect(loadTelemetryEnabled()).toBe(true);
    // This is the value both workers latch into their own `perfEnabled`.
    expect(isTerminalPerfRecording()).toBe(true);
  });

  test('disabling clears the key and uninstalls the recorder', () => {
    saveTelemetryEnabled(true);
    saveTelemetryEnabled(false);

    expect(storageEntries.has(STORAGE_KEY)).toBe(false);
    expect(loadTelemetryEnabled()).toBe(false);
    expect(isTerminalPerfRecording()).toBe(false);
  });

  test('initializing from a stored opt-in installs the recorder before any worker starts', () => {
    storageEntries.set(STORAGE_KEY, 'true');

    expect(initializeTelemetryPreference()).toBe(true);
    expect(isTerminalPerfRecording()).toBe(true);
  });
});
