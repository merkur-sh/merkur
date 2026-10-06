import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  type LedgerSnapshot,
  ledgerBytes,
  parseLedger,
  type RevocationLedger,
  type RevocationStore,
} from './revocation';
import { timed } from './stages';

export interface LedgerGitResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type LedgerGit = (args: readonly string[], input?: Uint8Array) => LedgerGitResult;

const REF = 'refs/heads/merkur-verification-revocations';
const EMPTY_REVISION = '';
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** A dedicated bare client uses origin's atomic ref transaction as the shared ledger. */
export class GitRevocationStore implements RevocationStore {
  private readonly git: LedgerGit;

  constructor(git: LedgerGit) {
    this.git = (args, input) => timed(`ledger ${args[0]}`, () => git(args, input));
    if (this.command(['rev-parse', '--is-bare-repository']) !== 'true\n')
      throw new Error('The revocation client must be a dedicated bare repository');
    const remote = this.command(['remote', 'get-url', 'origin']).trim();
    if (remote === '' || remote.startsWith('-') || remote.includes('\n'))
      throw new Error('An explicit authoritative ledger origin is required');
  }

  private command(args: readonly string[], input?: Uint8Array): string {
    const result = this.git(args, input);
    if (result.exitCode !== 0) throw new Error(`Declared ledger Git failed: ${args[0]}`);
    return result.stdout;
  }

  read(): LedgerSnapshot {
    const advertised = this.git(['ls-remote', '--exit-code', 'origin', REF]);
    if (advertised.exitCode === 2 && advertised.stdout === '')
      return { revision: EMPTY_REVISION, ledger: parseLedger({}) };
    const rows = advertised.stdout.trim().split('\n');
    const row = rows[0]?.split('\t');
    const revision = row?.[0];
    if (
      advertised.exitCode !== 0 ||
      rows.length !== 1 ||
      row?.[1] !== REF ||
      revision === undefined ||
      !OID.test(revision)
    )
      throw new Error('Cannot establish the current authoritative revocation ref');
    // A commit is named by its content: one this client already holds, which every revision it
    // pushed is, needs no transfer. Whatever it lacks beneath that commit fails the reads below.
    if (this.git(['cat-file', '-e', `${revision}^{commit}`]).exitCode !== 0)
      this.command(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', REF]);
    const tree = this.command(['ls-tree', revision]);
    if (!/^100644 blob [a-f0-9]{40}(?:[a-f0-9]{24})?\tledger\.json\n$/.test(tree))
      throw new Error('The revocation commit must contain exactly its regular ledger blob');
    const parents = this.command(['rev-list', '--parents', '-n', '1', revision]).trim().split(' ');
    if (parents[0] !== revision || parents.length > 2 || parents.some((id) => !OID.test(id)))
      throw new Error('The revocation ref must contain a linear commit history');
    const bytes = this.command(['show', `${revision}:ledger.json`]);
    const ledger = parseLedger(JSON.parse(bytes));
    if (ledgerBytes(ledger) !== bytes) throw new Error('The authoritative ledger is not canonical');
    return Object.freeze({ revision, ledger });
  }

  compareExchange(previous: LedgerSnapshot, ledger: RevocationLedger): LedgerSnapshot | null {
    if (previous.revision !== EMPTY_REVISION && !OID.test(previous.revision))
      throw new Error('Invalid expected ledger revision');
    const bytes = ledgerBytes(ledger);
    const blob = this.command(['hash-object', '-w', '--stdin'], Buffer.from(bytes)).trim();
    if (!OID.test(blob)) throw new Error('Declared Git did not produce a ledger blob identity');
    const tree = this.command(['mktree'], Buffer.from(`100644 blob ${blob}\tledger.json\n`)).trim();
    if (!OID.test(tree)) throw new Error('Declared Git did not produce a ledger tree identity');
    const revision = this.command([
      'commit-tree',
      tree,
      ...(previous.revision === EMPTY_REVISION ? [] : ['-p', previous.revision]),
      '-m',
      'Advance verification test epochs',
    ]).trim();
    if (!OID.test(revision))
      throw new Error('Declared Git did not produce a ledger commit identity');
    const pushed = this.git([
      'push',
      '--porcelain',
      `--force-with-lease=${REF}:${previous.revision}`,
      'origin',
      `${revision}:${REF}`,
    ]);
    // Confirm persistence through the authority even after an uncertain transport result.
    const current = this.read();
    if (current.revision === revision) return current;
    if (current.revision !== EMPTY_REVISION) {
      const ancestry = this.git(['merge-base', '--is-ancestor', revision, current.revision]);
      if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1)
        throw new Error('Cannot confirm the persisted ledger update ancestry');
      if (ancestry.exitCode === 0) return Object.freeze({ revision, ledger: parseLedger(ledger) });
    }
    if (current.revision !== previous.revision) return null;
    if (pushed.exitCode !== 0)
      throw new Error('The ledger update was not confirmed by its authority');
    throw new Error('A successful ledger push did not persist the expected revision');
  }
}

export function trustedLedgerOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== value ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.includes(' ')
  )
    throw new Error(
      'Ledger authority requires an explicit canonical HTTPS origin without credentials',
    );
  return value;
}

export function ledgerCredentialHelperCommand(file: string): string {
  return file.replace(/[^A-Za-z0-9_./-]/g, (character) => `\\${character}`);
}

/** Parses only the captured provisioning File, as returned by Git's no-includes stdin parser. */
export function ledgerProvisioningConfiguration(configuration: string): {
  readonly origin: string;
  readonly helper: string;
  readonly objectFormat: 'sha1' | 'sha256';
} {
  const rows = configuration.split('\0');
  if (rows.pop() !== '') throw new Error('Captured ledger configuration is incomplete');
  const values = new Map<string, string[]>();
  for (const row of rows) {
    const separator = row.indexOf('\n');
    if (separator <= 0) throw new Error('Captured ledger configuration has a valueless entry');
    const key = row.slice(0, separator);
    const value = row.slice(separator + 1);
    const previous = values.get(key) ?? [];
    previous.push(value);
    values.set(key, previous);
  }
  function one(key: string): string | undefined {
    const selected = values.get(key);
    if (selected === undefined) return undefined;
    if (selected.length !== 1)
      throw new Error('Captured ledger configuration has duplicate entries');
    return selected[0];
  }
  const originValue = one('remote.origin.url');
  if (originValue === undefined)
    throw new Error('Captured ledger configuration has no raw authority');
  const origin = trustedLedgerOrigin(originValue);
  const helpers = values.get('credential.helper');
  if (helpers?.length !== 2 || helpers[0] !== '' || helpers[1] === undefined)
    throw new Error('Captured ledger requires its declared bootstrap credential helper');
  const helper = helpers[1].replace(/\\(.)/g, '$1');
  if (
    !path.isAbsolute(helper) ||
    path.resolve(helper) !== helper ||
    [...helper].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    helpers[1] !== ledgerCredentialHelperCommand(helper) ||
    realpathSync(helper) !== helper ||
    !lstatSync(helper).isFile() ||
    (lstatSync(helper).mode & 0o111) === 0
  )
    throw new Error('Captured ledger helper must be its original absolute executable File');
  const format = one('extensions.objectformat') ?? 'sha1';
  if (
    (format !== 'sha1' && format !== 'sha256') ||
    one('core.repositoryformatversion') !== (format === 'sha256' ? '1' : '0') ||
    one('core.bare') !== 'true'
  )
    throw new Error('Captured ledger requires its supported bare Git object format');
  const fixed = new Map([
    ['core.fsync', 'all'],
    ['core.fsyncmethod', 'fsync'],
    ['credential.usehttppath', 'true'],
    ['credential.interactive', 'false'],
    ['http.followredirects', 'false'],
    ['http.sslverify', 'true'],
    ['http.sslbackend', 'openssl'],
    [`http.${origin}.sslverify`, 'true'],
    [`http.${origin}.followredirects`, 'false'],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
  ]);
  const structural = new Set([
    'core.repositoryformatversion',
    'core.bare',
    'credential.helper',
    'remote.origin.url',
    'extensions.objectformat',
  ]);
  for (const [key] of values) {
    if (structural.has(key)) continue;
    const value = one(key);
    if (fixed.has(key)) {
      if (value !== fixed.get(key))
        throw new Error('Captured ledger bootstrap configuration changed');
    } else if (['core.filemode', 'core.ignorecase', 'core.precomposeunicode'].includes(key)) {
      if (value !== 'true' && value !== 'false')
        throw new Error('Invalid captured Git filesystem setting');
    } else if (key === 'http.sslcainfo') {
      if (value === undefined || !path.isAbsolute(value))
        throw new Error('Invalid captured SDK CA binding');
    } else {
      throw new Error('Captured ledger contains undeclared configuration');
    }
  }
  return Object.freeze({ origin, helper, objectFormat: format });
}

/** Exact URL settings take precedence over a dedicated client's URL-scoped HTTP configuration. */
export function ledgerGitTransportFlags(origin: string): readonly string[] {
  origin = trustedLedgerOrigin(origin);
  return Object.freeze([
    '-c',
    'http.sslBackend=openssl',
    '-c',
    `http.${origin}.sslVerify=true`,
    '-c',
    `http.${origin}.followRedirects=false`,
  ]);
}

/** Transport receives the captured authority URL, never a mutable client remote URL list. */
export function ledgerGitTransportArguments(
  origin: string,
  args: readonly string[],
): readonly string[] {
  const flags = ledgerGitTransportFlags(origin);
  const transport = args[0] === 'ls-remote' || args[0] === 'fetch' || args[0] === 'push';
  return Object.freeze([
    ...flags,
    ...(transport ? args.map((argument) => (argument === 'origin' ? origin : argument)) : args),
  ]);
}

/** Fixed author identity for the dedicated client; source repository metadata is never written. */
export function ledgerGitEnvironment(): Readonly<Record<string, string>> {
  return {
    GIT_AUTHOR_NAME: 'Merkur verification',
    GIT_AUTHOR_EMAIL: 'verification@merkur.invalid',
    GIT_COMMITTER_NAME: 'Merkur verification',
    GIT_COMMITTER_EMAIL: 'verification@merkur.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
}
