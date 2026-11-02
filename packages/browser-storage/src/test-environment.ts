/**
 * What Bun lacks for these tests: web storage and, through `fake-indexeddb`,
 * IndexedDB. Each is installed on `globalThis` where the package looks for
 * it, and `restoreGlobals` puts back whatever was there before.
 */
import { IDBFactory } from 'fake-indexeddb';

/** Characters a fake area holds, like an engine's per-origin limit. */
const QUOTA_CHARACTERS = 5_000_000;

export class MemoryStorage implements Storage {
  readonly entries = new Map<string, string>();
  /** Set to make every `setItem` refuse with this. */
  refuseWrites: object | null = null;
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
    if (this.refuseWrites !== null) throw this.refuseWrites;
    let used = key.length + value.length;
    for (const [other, stored] of this.entries) {
      if (other !== key) used += other.length + stored.length;
    }
    if (used > QUOTA_CHARACTERS) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    this.entries.set(key, value);
  }
}

type Installed = 'indexedDB' | 'localStorage' | 'sessionStorage';

const originals = new Map<Installed, PropertyDescriptor | undefined>();

function install(name: Installed, descriptor: PropertyDescriptor): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}

export function installIndexedDb(): IDBFactory {
  const factory = new IDBFactory();
  install('indexedDB', { value: factory });
  return factory;
}

export function installStorage(name: 'localStorage' | 'sessionStorage'): MemoryStorage {
  const storage = new MemoryStorage();
  install(name, { value: storage });
  return storage;
}

export function installStorageGetter(
  name: 'localStorage' | 'sessionStorage',
  get: () => Storage,
): void {
  install(name, { get });
}

export function removeGlobal(name: Installed): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Reflect.deleteProperty(globalThis, name);
}

export function restoreGlobals(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  originals.clear();
}
