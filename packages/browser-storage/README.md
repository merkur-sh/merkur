# Browser storage

`@merkur/browser-storage` is the web app's one way to read and write `localStorage`,
`sessionStorage` and IndexedDB. Every value a browser hands back passes through a parser before
the caller sees it, because it may have been written by another build, another tab, or by hand.

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

## IndexedDB

`defineDatabase(name, version, stores)` declares a database. Each store is
`keyedStore<Key, Value>(parse)`: out-of-line keys of one type and whole values read through
`parse`, whose input is `Cloned`, a structured clone.

| Call | Does |
| --- | --- |
| `openDatabase(definition, { signal })` | Opens. An abort rejects, and a connection that arrives later is closed. |
| `withDatabase(definition, use)` | Opens, runs `use`, and closes however it ends. |
| `database.read(stores, body)` | One read-only transaction; resolves with `body`'s result once it completes. |
| `database.write(stores, body)` | One read-write transaction; a body that throws aborts it, and none of its writes land. |

A read-only transaction's stores have `get` only. In a read-write transaction a value that does
not parse reads as `null` and is deleted.

The version is the schema's identity. Opening a database stored under an older version deletes
every store and creates the declared ones empty; nothing reads a record in an older layout. A
connection closes itself when another tab opens a newer version, so it never blocks one.

A transaction body awaits only its own requests. IndexedDB commits a transaction with no request
in flight at the end of a task, so awaiting other work inside a body (`crypto.subtle`, a fetch, a
timer) lets it commit, and the next request throws `TransactionInactiveError`. Do that work
between transactions.

Values are parsed, but the type parameters of `keyedStore` are trusted for keys: a store's keys are
only ever written through its own typed `put`.

`guarded(isValue)` turns a type guard, such as one `compileCheck` builds from a TypeBox schema,
into a parser for either kind of storage.
