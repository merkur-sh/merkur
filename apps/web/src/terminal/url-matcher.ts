import { LinkifyIt } from 'linkify-it';
import type { UrlMatcher } from './link-detection';

/**
 * Scheme links only. Terminal output is file names and version numbers, so a
 * schemaless match (`main.py` is a Paraguayan domain) would underline half of
 * every `ls`. `ftp:`, protocol-relative `//` and `mailto:` are removed because
 * nothing but `http:`/`https:` opens anyway.
 */
export function createUrlMatcher(): UrlMatcher {
  const linkify = new LinkifyIt({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false })
    .add('ftp:', null)
    .add('//', null)
    .add('mailto:', null);
  return (text) => linkify.match(text) ?? [];
}
