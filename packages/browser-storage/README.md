# Browser storage

`@merkur/browser-storage` is the web app's one way to read and write `localStorage`,
`sessionStorage` and IndexedDB. Every value a browser hands back passes through a parser before
the caller sees it, because it may have been written by another build, another tab, or by hand.
Every failure it recovers from is counted, so a storage problem in the field is visible rather
than a silent `null`.

## Web storage

`localValue(key, parse)` and `sessionValue(key, parse)` declare one key holding one JSON value.

| Call | Does |
| --- | --- |
| `read()` | The parsed value, or `null`. A value that does not parse, or text that is not JSON, is removed. |
| `write(value)` | `true` once stored. A refusal (quota, private mode, blocked storage, a worker) answers `false`. |
| `remove()` | Removes the key. |

The parser's input is `Json`, what `JSON.parse` returns. Its result type must survive a JSON
round trip: a parser of a `Map`, a `Date`, a typed array, or a required property that may be
`undefined` does not compile. The storage area is looked up on every call, so a module can
declare its keys at load in a worker, where there is none.

A key has one writer. Firefox gives each tab its own snapshot of `localStorage` and delivers
another tab's writes asynchronously, so even a read taken under a Web Lock can miss the write the
previous holder made: two tabs taking turns under one lock lost an update in Firefox. A value
several tabs change belongs in IndexedDB.

## IndexedDB

`defineDatabase(name, version, stores)` declares a database. Each store is
`keyedStore<Key, Value>(parse)`: out-of-line keys of one type and whole values read through
`parse`, whose input is `Cloned`, a structured clone.

| Call | Does |
| --- | --- |
| `openDatabase(definition, { signal })` | Opens. An abort rejects, and a connection that arrives later is closed. |
| `withDatabase(definition, use)` | Opens, runs `use`, and closes however it ends. |
| `database.read(stores, body)` | One read-only transaction; resolves with `body`'s result once it completes. |
| `database.write(stores, body, { durability })` | One read-write transaction; a body that throws aborts it, and none of its writes land. `'strict'` resolves only once the write is on disk. |

A read-only transaction's stores have `get` only. In a read-write transaction a value that does
not parse reads as `null` and is deleted.

Read-write transactions over one store run one at a time across every tab of the origin, so a
read, a change and a write in one transaction is the way to change a value several tabs share.

The version is the schema's identity. Opening a database stored under an older version deletes
every store and creates the declared ones empty; nothing reads a record in an older layout. A
connection closes itself when another tab opens a newer version, so it never blocks one.

A transaction body awaits only its own requests. IndexedDB commits a transaction with no request
in flight at the end of a task, so awaiting other work inside a body (`crypto.subtle`, a fetch, a
timer) loses the transaction: the next request throws `TransactionInactiveError`, or
`InvalidStateError` once the commit has finished, and whether the body's earlier writes landed
depends on how far the engine had got. Do that work between transactions.

Values are parsed, but the type parameters of `keyedStore` are trusted for keys: a store's keys are
only ever written through its own typed `put`.

Every rejection the package produces for a storage failure is a `DOMException`, so a caller tells a
storage failure from a bug by type.

`guarded(isValue)` turns a type guard, such as one `compileCheck` builds from a TypeBox schema,
into a parser for either kind of storage.

## Failures

`observeStorageFailures(listener)` hears every failure in its realm, by the key or database it
happened to: `quota`, `refused` (any other refusal, including Gecko's own internal failures, which
it throws as a legacy `Exception` rather than a `DOMException`), `unparseable`, `aborted` (a
transaction the engine aborted; one the body abandoned is the caller's error), `open_failed` and
`open_abandoned`. `reportStorageFailure` reports one into the realm, which is how a worker's
failures reach the page that counts them.

## Tests

`conformance.ts` holds the behaviour every engine must share. `conformance.test.ts` runs it in Bun
against `fake-indexeddb`; `engines.test.ts` runs it in Chromium, WebKit and Firefox, in a page and
in a dedicated worker, and races two tabs' read-write transactions on one record.
