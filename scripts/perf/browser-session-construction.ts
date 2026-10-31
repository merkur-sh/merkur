import {
  createUserDelegationCertificate,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  serializeUserDelegationCertificate,
  USER_DELEGATION_LIFETIME_MS,
  type UserDelegationCertificate,
} from '@merkur/shared/user-authorization';
import * as vault from '../../apps/web/src/auth/delegation-vault';
import * as wasm from '../../packages/e2e-wasm/pkg/e2e_wasm.js';
import { installE2eWasm } from '../../packages/shared/src/e2e-wasm-runtime';

const { loadBrowserDelegation, saveBrowserDelegation } = vault;

interface Credential {
  readonly rootPublicKey: Uint8Array;
  readonly certificate: UserDelegationCertificate;
  readonly delegateSeed?: Uint8Array;
  readonly delegateKey?: wasm.MlDsa87SigningKey;
}

const sessionVault: {
  readonly loadBrowserSessionDelegation?: (userId: string) => Promise<Credential | null>;
} = vault;
const loadSession: (userId: string, session: true) => Promise<Credential | null> =
  sessionVault.loadBrowserSessionDelegation ?? loadBrowserDelegation;

const KINDS = [
  'session',
  'metadata',
  'cancel',
  'other-account',
  'wrong-seed',
  'empty',
  'orphan',
] as const;
type Kind = (typeof KINDS)[number];
type Fixture = Awaited<ReturnType<typeof prepareVault>>;
interface Counters {
  expansions: number;
  reads: number;
  constructors: number;
}
const EXPECTED: Record<Kind, string> = {
  session: 'ok',
  metadata: 'ok',
  cancel: 'ok',
  'other-account': 'absent',
  'wrong-seed': 'Error: Browser delegate seed does not match its certificate',
  empty: 'absent',
  orphan: 'absent',
};
export type BrowserSessionConstructionResult = Awaited<ReturnType<typeof run>>;

async function prepareVault() {
  const initialized = wasm.initSync({ module: await (await fetch('/wasm')).arrayBuffer() });
  installE2eWasm(wasm);
  const root = wasm.MlDsa87SigningKey.fromSeed(new Uint8Array(32).fill(1));
  const delegateSeed = new Uint8Array(32).fill(2);
  const delegate = wasm.MlDsa87SigningKey.fromSeed(delegateSeed);
  const publicKey = root.publicKey;
  const certificate = createUserDelegationCertificate(
    {
      userId: 'user',
      rootKeyCommitment: deriveUserRootKeyCommitment(publicKey),
      delegationId: 'delegation',
      delegatePublicKey: encodeUserAuthorizationBytes(delegate.publicKey),
      scopes: ['terminal-session', 'session-revoke'],
      serverOrigin: location.origin,
      rootEpoch: 1,
      issuedAt: 1_800_000_000_000,
      expiresAt: 1_800_000_000_000 + USER_DELEGATION_LIFETIME_MS,
    },
    root,
    new Uint8Array(32).fill(3),
  );
  root.free();
  delegate.free();
  await saveBrowserDelegation('user', publicKey, certificate, delegateSeed);
  delegateSeed.fill(0);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('merkur-auth', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = db.transaction('browser-delegation', 'readonly').objectStore('browser-delegation');
  const [key, stored] = await Promise.all([
    request(read.get('wrapping-key')),
    request(read.get('active-delegation')),
  ]);
  // SAFETY: saveBrowserDelegation wrote this record, and this fixture is the
  // only writer before the readonly snapshot above.
  const record = stored as {
    rootPublicKey: string;
    certificate: UserDelegationCertificate;
    nonce: string;
    ciphertext: string;
  };
  const aad = new TextEncoder().encode(
    JSON.stringify({
      rootPublicKey: record.rootPublicKey,
      certificate: serializeUserDelegationCertificate(certificate),
    }),
  );
  const nonce = Uint8Array.from(
    atob(record.nonce.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  );
  const wrongSeed = new Uint8Array(32).fill(4);
  const wrongCiphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key,
      wrongSeed,
    ),
  );
  wrongSeed.fill(0);
  const wrongRecord = { ...record, ciphertext: encodeUserAuthorizationBytes(wrongCiphertext) };
  wrongCiphertext.fill(0);
  aad.fill(0);
  nonce.fill(0);

  return { initialized, publicKey, db, key, record, wrongRecord };
}

export async function run() {
  const fixture = await prepareVault();
  const counters: Counters = { expansions: 0, reads: 0, constructors: 0 };
  const owners = new Set<wasm.MlDsa87SigningKey>();
  const expand = wasm.MlDsa87SigningKey.fromSeed;
  const free = wasm.MlDsa87SigningKey.prototype.free;
  wasm.MlDsa87SigningKey.fromSeed = (seed) => {
    counters.expansions += 1;
    const owner = expand(seed);
    owners.add(owner);
    return owner;
  };
  wasm.MlDsa87SigningKey.prototype.free = function (this: wasm.MlDsa87SigningKey) {
    owners.delete(this);
    free.call(this);
  };
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, key) {
    counters.reads += 1;
    return get.call(this, key);
  };
  try {
    const rows = [];
    for (const kind of KINDS) rows.push(await runCase(kind, fixture, counters, owners));
    return rows;
  } finally {
    wasm.MlDsa87SigningKey.fromSeed = expand;
    wasm.MlDsa87SigningKey.prototype.free = free;
    IDBObjectStore.prototype.get = get;
    fixture.db.close();
    fixture.publicKey.fill(0);
  }
}

async function resetVault(kind: Kind, fixture: Fixture): Promise<void> {
  const tx = fixture.db.transaction('browser-delegation', 'readwrite');
  const store = tx.objectStore('browser-delegation');
  store.clear();
  if (kind !== 'empty' && kind !== 'orphan') store.put(fixture.key, 'wrapping-key');
  if (kind !== 'empty')
    store.put(kind === 'wrong-seed' ? fixture.wrongRecord : fixture.record, 'active-delegation');
  await complete(tx);
}

function loadForKind(kind: Kind): Promise<Credential | null> {
  if (kind === 'metadata') return loadBrowserDelegation('user');
  if (kind === 'other-account') return loadBrowserDelegation('other');
  return loadSession('user', true);
}

function constructSession(credential: Credential, counters: Counters): void {
  const material = credential.delegateKey ?? credential.delegateSeed;
  if (material === undefined) throw new Error('missing signing material');
  // The seed-taking constructor expands internally; the signer-taking one consumes.
  if (material instanceof Uint8Array) counters.expansions += 1;
  const session: wasm.ClientSession = Reflect.construct(wasm.ClientSession, [
    JSON.stringify(credential.certificate),
    credential.rootPublicKey,
    location.origin,
    'browser',
    false,
    material,
  ]);
  counters.constructors += 1;
  session.free();
}

async function measure(kind: Kind, counters: Counters) {
  counters.reads = 0;
  counters.expansions = 0;
  counters.constructors = 0;
  let credential: Credential | null = null;
  let outcome = 'ok';
  const started = performance.now();
  try {
    credential = await loadForKind(kind);
    if (credential === null) outcome = 'absent';
    if (credential !== null && kind === 'session') constructSession(credential, counters);
  } catch (error) {
    outcome = String(error);
  } finally {
    credential?.delegateSeed?.fill(0);
    credential?.rootPublicKey.fill(0);
    credential?.delegateKey?.free();
  }
  return { elapsed: performance.now() - started, outcome, ...counters };
}

async function runCase(
  kind: Kind,
  fixture: Fixture,
  counters: Counters,
  owners: Set<wasm.MlDsa87SigningKey>,
) {
  const timings: number[] = [];
  let last: Awaited<ReturnType<typeof measure>> | undefined;
  for (let sample = 0; sample < 31; sample += 1) {
    await resetVault(kind, fixture);
    last = await measure(kind, counters);
    timings.push(last.elapsed);
    if (last.outcome !== EXPECTED[kind]) throw new Error(`${kind}: ${last.outcome}`);
    if (owners.size !== 0) throw new Error('signer owner retained');
  }
  if (last === undefined) throw new Error('missing samples');
  const { elapsed: _elapsed, ...metrics } = last;
  timings.sort((a, b) => a - b);
  return {
    kind,
    ...metrics,
    liveSignerOwners: owners.size,
    wasmBytes: fixture.initialized.memory.buffer.byteLength,
    medianMs: timings[15],
    p95Ms: timings[29],
  };
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
