import { afterEach, describe, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';

import { removeUndeclaredStorage, STORAGE_NAMES } from './storage-names';

const originals = new Map(
  (['localStorage', 'indexedDB'] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

class MemoryStorage implements Storage {
  readonly entries = new Map<string, string>();
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
    this.entries.set(key, value);
  }
}

function createDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('removeUndeclaredStorage', () => {
  test('removes what earlier builds left and keeps every declared and foreign name', async () => {
    const storage = new MemoryStorage();
    const factory = new IDBFactory();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
    // Names earlier builds wrote and none reads any more.
    const left = [
      'merkur:telemetry-enabled',
      'merkur:refresh-credential-retired',
      'merkur:refresh-credential-generation',
      'merkur.terminal.typingOffsets',
      'merkur.terminal.typingDiagnostics',
      'merkur.transport.autotuner:device-1:8:200',
    ];
    const kept = [STORAGE_NAMES.appearance, STORAGE_NAMES.device_list, 'rybbit-visitor-id'];
    for (const key of [...left, ...kept]) storage.setItem(key, '"stored"');
    for (const name of ['merkur_session', STORAGE_NAMES.delegation_vault, 'workbox-expiration']) {
      await createDatabase(factory, name);
    }

    await removeUndeclaredStorage();

    expect(Array.from(storage.entries.keys())).toEqual(kept);
    const databases = (await factory.databases()).map(({ name }) => name).sort();
    expect(databases).toEqual([STORAGE_NAMES.delegation_vault, 'workbox-expiration']);
  });
});
