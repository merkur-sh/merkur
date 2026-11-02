import { afterEach, describe, expect, test } from 'bun:test';

import { guarded } from './parse';
import { localValue, sessionValue } from './web-storage';

interface Preferences {
  readonly theme: string;
  readonly size?: number;
  readonly tags: readonly string[];
}

const isString = (value: unknown): value is string => value === String(value);

function isPreferences(value: unknown): value is Preferences {
  return (
    value instanceof Object &&
    'theme' in value &&
    isString(value.theme) &&
    'tags' in value &&
    Array.isArray(value.tags) &&
    value.tags.every(isString)
  );
}

const parsePreferences = guarded(isPreferences);

class MemoryStorage implements Storage {
  readonly entries = new Map<string, string>();
  failWrites = false;
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.entries.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError');
    this.entries.set(key, value);
  }
}

const originals = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
};

function install(name: 'localStorage' | 'sessionStorage', descriptor: PropertyDescriptor): void {
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}

function installMemory(name: 'localStorage' | 'sessionStorage'): MemoryStorage {
  const storage = new MemoryStorage();
  install(name, { value: storage });
  return storage;
}

afterEach(() => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const original = originals[name];
    if (original === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, original);
  }
});

describe('stored values', () => {
  test('a written value reads back as JSON through its parser', () => {
    const storage = installMemory('localStorage');
    const preferences = localValue('prefs', parsePreferences);

    expect(preferences.read()).toBeNull();
    expect(preferences.write({ theme: 'dark', tags: ['a'] })).toBe(true);
    expect(storage.entries.get('prefs')).toBe('{"theme":"dark","tags":["a"]}');
    expect(preferences.read()).toEqual({ theme: 'dark', tags: ['a'] });
    preferences.remove();
    expect(storage.entries.has('prefs')).toBe(false);
  });

  test('local and session values live in their own areas', () => {
    const local = installMemory('localStorage');
    const session = installMemory('sessionStorage');

    sessionValue('id', guarded(isString)).write('tab-1');
    expect(session.entries.get('id')).toBe('"tab-1"');
    expect(local.entries.has('id')).toBe(false);
  });

  test('a value its parser refuses is removed on read', () => {
    const storage = installMemory('localStorage');
    storage.entries.set('prefs', '{"colour":"dark"}');

    expect(localValue('prefs', parsePreferences).read()).toBeNull();
    expect(storage.entries.has('prefs')).toBe(false);
  });

  test('text that is not JSON is removed on read', () => {
    const storage = installMemory('localStorage');
    storage.entries.set('id', 'raw-unquoted');

    expect(localValue('id', guarded(isString)).read()).toBeNull();
    expect(storage.entries.has('id')).toBe(false);
  });

  test('a write the area refuses answers false instead of throwing', () => {
    const storage = installMemory('localStorage');
    storage.failWrites = true;

    expect(localValue('id', guarded(isString)).write('x')).toBe(false);
  });

  test('without an area every call is inert', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const value = localValue('id', guarded(isString));

    expect(value.read()).toBeNull();
    expect(value.write('x')).toBe(false);
    expect(() => value.remove()).not.toThrow();
  });

  test('an area whose property read throws is treated as absent', () => {
    install('localStorage', {
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    const value = localValue('id', guarded(isString));

    expect(value.read()).toBeNull();
    expect(value.write('x')).toBe(false);
  });

  test('the area is looked up on every call, not when the key is declared', () => {
    const value = localValue('id', guarded(isString));
    const storage = installMemory('localStorage');

    expect(value.write('later')).toBe(true);
    expect(storage.entries.get('id')).toBe('"later"');
  });
});

describe('static typing', () => {
  test('only JSON-shaped values can be declared', () => {
    installMemory('localStorage');
    // Interfaces, optional properties, readonly arrays and literals are JSON.
    localValue('prefs', parsePreferences);
    localValue('flag', (value): true | null => (value === true ? true : null));
    localValue('nullable', (value): { readonly id: string | null } | null =>
      value === null ? null : { id: null },
    );

    // @ts-expect-error a Map does not survive JSON
    localValue('map', (_value): Map<string, string> | null => null);
    // @ts-expect-error a Date does not survive JSON
    localValue('date', (_value): { readonly at: Date } | null => null);
    // @ts-expect-error bytes do not survive JSON
    localValue('bytes', (_value): Uint8Array | null => null);
    // @ts-expect-error a required property that may be undefined is dropped by JSON
    sessionValue('gap', (_value): { readonly id: string | undefined } | null => null);

    const preferences = localValue('prefs', parsePreferences);
    // @ts-expect-error a write is checked against the declared type
    preferences.write({ theme: 1, tags: [] });
    expect(preferences.read()).toBeNull();
  });
});
