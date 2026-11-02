// `fake-indexeddb` ships no types for this subpath, and its root export declares the parameter as
// the class (`typeof FDBDatabase`) rather than a connection.
declare module 'fake-indexeddb/lib/forceCloseDatabase' {
  /** Closes `connection` as an engine closes one itself, with the forced flag: `close` fires. */
  export default function forceCloseDatabase(connection: IDBDatabase): void;
}
