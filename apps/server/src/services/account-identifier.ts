import { domainToASCII } from 'node:url';

import type { AuthIdentity } from '../config';

const IDENTIFIER_MAX_CHARS = 254;
const USERNAME_MIN_CHARS = 3;
const EMAIL_LOCAL_MAX_CHARS = 64;
/** RFC 5322 dot-atom text: no quoted strings, no comments, no leading, trailing or doubled dot. */
const EMAIL_LOCAL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOP_LEVEL_LABEL_PATTERN = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;

/**
 * The one spelling of an account name: the key the users table, the auth flow,
 * the synthetic account material and the per-name rate limit all agree on.
 * Returns `null` when the value cannot name an account in this mode.
 *
 * Email addresses are syntax-checked only. Whether the mailbox exists is
 * settled by the code sent to it, not by a DNS lookup. Nothing is stripped
 * beyond case and surrounding space: dropping `+tags` or dots is a guess about
 * one provider's routing, and a wrong guess would merge two people's accounts.
 * Which addresses may open an account at all is `email-admission.ts`.
 */
export function normalizeAccountIdentifier(identity: AuthIdentity, value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (identity === 'username') {
    return normalized.length >= USERNAME_MIN_CHARS && normalized.length <= IDENTIFIER_MAX_CHARS
      ? normalized
      : null;
  }
  return normalizeEmailAddress(normalized);
}

function normalizeEmailAddress(value: string): string | null {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, at);
  if (local.length > EMAIL_LOCAL_MAX_CHARS || !EMAIL_LOCAL_PATTERN.test(local)) return null;
  // A Unicode domain is stored in its ASCII form, so the two spellings of one
  // domain are one account and the address is one Resend can deliver to.
  const domain = domainToASCII(value.slice(at + 1));
  const labels = domain.split('.');
  const topLevel = labels.at(-1);
  if (
    labels.length < 2 ||
    topLevel === undefined ||
    !TOP_LEVEL_LABEL_PATTERN.test(topLevel) ||
    !labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return null;
  }
  const address = `${local}@${domain}`;
  return address.length <= IDENTIFIER_MAX_CHARS ? address : null;
}
