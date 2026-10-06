import { resolve4, resolve6, resolveMx } from 'node:dns/promises';

import { disposableEmailBlocklistSet } from 'disposable-email-domains-js';
import fakefilter from 'fakefilter/dist/json/data.json';
import type { Kysely } from 'kysely';

import type { DatabaseSchema } from '../db/types';

/**
 * Two maintained lists, merged once into one set. `disposable-email-domains`
 * is curated by submission with an allowlist; FakeFilter crawls the services it
 * watches and publishes their new domains daily, which a submitted list reaches
 * late. Both keep major mailboxes and forwarding relays (DuckDuckGo, SimpleLogin,
 * Firefox Relay) off; the larger aggregated lists do not.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  ...disposableEmailBlocklistSet(),
  ...Object.keys(fakefilter.domains),
]);

/** Google documents both domains as one mailbox that ignores dots in the local part. */
const GMAIL_DOMAIN = 'gmail.com';
const GMAIL_ALIAS_DOMAIN = 'googlemail.com';

/**
 * The mailbox an address delivers to, for deciding who may open an account.
 *
 * Drops a `+tag` (RFC 5233 subaddressing) and, on Gmail, the dots and the
 * googlemail alias, so `a.b+x@googlemail.com` and `ab@gmail.com` compare equal.
 * Never used as the account name: `normalizeAccountIdentifier` stays exact, so
 * two people are never merged into one account. Here a wrong merge only refuses
 * a sign-up that looks like a suspended account's address.
 *
 * Takes an address `normalizeAccountIdentifier` already accepted.
 */
export function canonicalMailbox(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = address.slice(at + 1);
  const tagged = address.slice(0, at);
  const plus = tagged.indexOf('+');
  const local = plus > 0 ? tagged.slice(0, plus) : tagged;
  if (domain === GMAIL_DOMAIN || domain === GMAIL_ALIAS_DOMAIN) {
    return `${local.replaceAll('.', '')}@${GMAIL_DOMAIN}`;
  }
  return `${local}@${domain}`;
}

/**
 * Whether the address is at a disposable-mail domain or any subdomain of one.
 * Takes an address `normalizeAccountIdentifier` already accepted.
 */
export function isDisposableAddress(address: string): boolean {
  let domain = address.slice(address.lastIndexOf('@') + 1);
  for (;;) {
    if (DISPOSABLE_DOMAINS.has(domain)) return true;
    const dot = domain.indexOf('.');
    if (dot < 0) return false;
    domain = domain.slice(dot + 1);
  }
}

/**
 * Whether a suspended account's address reaches the same mailbox.
 *
 * Suspension is the ban: an operator sets `users.suspended_at`, and sign-up
 * and the Boxes waitlist refuse every address `canonicalMailbox` folds onto one
 * a suspended account names. Suspended accounts are few and both refusals rare,
 * so they are folded here rather than stored folded in a column that would go
 * stale whenever the folding rules change.
 *
 * Takes an address `normalizeAccountIdentifier` already accepted.
 */
export async function suspendedMailboxTaken(
  db: Kysely<DatabaseSchema>,
  address: string,
): Promise<boolean> {
  const mailbox = canonicalMailbox(address);
  const suspended = await db
    .selectFrom('users')
    .select('username')
    .where('suspended_at', 'is not', null)
    .execute();
  return suspended.some((row) => canonicalMailbox(row.username) === mailbox);
}

/** The DNS questions `domainTakesMail` asks, in the shape `node:dns/promises` answers them. */
export interface MailResolver {
  readonly resolveMx: (name: string) => Promise<readonly { readonly exchange: string }[]>;
  readonly resolve4: (name: string) => Promise<readonly string[]>;
  readonly resolve6: (name: string) => Promise<readonly string[]>;
}

/** The resolver the server process is configured with. */
export const SYSTEM_MAIL_RESOLVER: MailResolver = { resolveMx, resolve4, resolve6 };

/**
 * What a query is refused with when the name holds no record of the type asked
 * for, or does not exist. Bun reports both as `ENOTFOUND`; c-ares names the
 * first `ENODATA`.
 */
const NO_RECORD_CODES: ReadonlySet<unknown> = new Set(['ENOTFOUND', 'ENODATA']);

async function records<Row>(answer: Promise<readonly Row[]>): Promise<readonly Row[]> {
  try {
    return await answer;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (NO_RECORD_CODES.has(code)) return [];
    // The resolver's own message names the domain, which is half of an address
    // and must not reach a log. Only its code is passed on.
    throw new Error(`mail lookup got no answer: ${typeof code === 'string' ? code : 'unknown'}`);
  }
}

/**
 * Whether the address's domain has anywhere for mail to go, read from the DNS
 * as a sending server reads it (RFC 5321 section 5.1): its MX records, or with
 * none of those its own address records. A domain whose only MX is the null MX
 * (RFC 7505) says it takes no mail, and a domain with neither MX nor address,
 * which a name that does not exist is, has nowhere to deliver.
 *
 * It is the check for an address no code is mailed to, and it settles the
 * domain, never the mailbox: only a delivered message proves that one.
 *
 * Rejects when the resolver gives no answer (a timeout, a refused or failed
 * query). That says nothing about the domain, so a caller must not read it as
 * either verdict. The rejection carries the resolver's code and never the name
 * that was asked for.
 *
 * Takes an address `normalizeAccountIdentifier` already accepted.
 */
export async function domainTakesMail(resolver: MailResolver, address: string): Promise<boolean> {
  // Absolute, so the resolver never tries its search list on the name.
  const name = `${address.slice(address.lastIndexOf('@') + 1)}.`;
  const exchanges = await records(resolver.resolveMx(name));
  if (exchanges.length > 0) {
    return exchanges.some(({ exchange }) => exchange !== '' && exchange !== '.');
  }
  const [v4, v6] = await Promise.all([
    records(resolver.resolve4(name)),
    records(resolver.resolve6(name)),
  ]);
  return v4.length > 0 || v6.length > 0;
}
