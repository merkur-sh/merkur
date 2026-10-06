import { describe, expect, test } from 'bun:test';
import fakefilter from 'fakefilter/dist/json/data.json';

import {
  canonicalMailbox,
  domainTakesMail,
  isDisposableAddress,
  type MailResolver,
} from './email-admission';

describe('canonicalMailbox', () => {
  test('drops a subaddress tag on any domain', () => {
    expect(canonicalMailbox('someone+merkur@example.com')).toBe('someone@example.com');
    expect(canonicalMailbox('someone+a+b@example.com')).toBe('someone@example.com');
  });

  test('keeps dots everywhere but Gmail', () => {
    expect(canonicalMailbox('first.last@example.com')).toBe('first.last@example.com');
    expect(canonicalMailbox('f.i.r.s.t+x@gmail.com')).toBe('first@gmail.com');
    expect(canonicalMailbox('first.last@googlemail.com')).toBe('firstlast@gmail.com');
  });

  test('leaves a leading plus alone, since there is no mailbox before it', () => {
    expect(canonicalMailbox('+tag@example.com')).toBe('+tag@example.com');
  });
});

describe('isDisposableAddress', () => {
  test('matches a listed domain and its subdomains, not a lookalike', () => {
    expect(isDisposableAddress('someone@mailinator.com')).toBe(true);
    expect(isDisposableAddress('someone@inbox.mailinator.com')).toBe(true);
    expect(isDisposableAddress('someone@mailinator.com.example.org')).toBe(false);
    expect(isDisposableAddress('someone@gmail.com')).toBe(false);
  });

  test('includes the domains FakeFilter crawled, not only the submitted list', () => {
    const crawled = Object.keys(fakefilter.domains)[0];
    if (crawled === undefined) throw new Error('the FakeFilter dataset is empty');
    expect(isDisposableAddress(`someone@${crawled}`)).toBe(true);
  });

  test('leaves forwarding relays alone: they deliver to a real mailbox', () => {
    for (const relay of ['duck.com', 'simplelogin.com', 'mozmail.com', 'passmail.net']) {
      expect(isDisposableAddress(`someone@${relay}`)).toBe(false);
    }
  });
});

/** What one query comes back with: its records, or the code it is refused with. */
type Answer<Row> = readonly Row[] | string;

/** A resolver that answers each record type as told and keeps what it was asked. */
function resolverAnswering(answers: {
  readonly mx: Answer<{ readonly exchange: string }>;
  readonly a?: Answer<string>;
  readonly aaaa?: Answer<string>;
}): MailResolver & { readonly asked: string[] } {
  const asked: string[] = [];
  const answer = async <Row>(type: string, name: string, rows: Answer<Row>) => {
    asked.push(`${type} ${name}`);
    // Worded as the real resolver words it, the name it was asked for included.
    if (typeof rows === 'string')
      throw Object.assign(new Error(`query${type} ${rows} ${name}`), { code: rows });
    return rows;
  };
  return {
    asked,
    resolveMx: (name) => answer('MX', name, answers.mx),
    resolve4: (name) => answer('A', name, answers.a ?? 'ENOTFOUND'),
    resolve6: (name) => answer('AAAA', name, answers.aaaa ?? 'ENOTFOUND'),
  };
}

describe('domainTakesMail', () => {
  test('takes a domain that names a mail exchanger, asking for the absolute name and nothing more', async () => {
    const resolver = resolverAnswering({ mx: [{ exchange: 'mx.example.net' }] });

    expect(await domainTakesMail(resolver, 'someone@example.net')).toBe(true);
    expect(resolver.asked).toEqual(['MX example.net.']);
  });

  test('refuses a domain whose only exchanger is the null MX', async () => {
    for (const exchange of ['', '.']) {
      const resolver = resolverAnswering({ mx: [{ exchange }], a: ['192.0.2.1'] });

      expect(await domainTakesMail(resolver, 'someone@example.net')).toBe(false);
      expect(resolver.asked).toEqual(['MX example.net.']);
    }
  });

  test('with no MX, takes a domain that has an address of either family', async () => {
    for (const addresses of [{ a: ['192.0.2.1'] }, { aaaa: ['2001:db8::1'] }]) {
      for (const none of ['ENOTFOUND', 'ENODATA']) {
        const resolver = resolverAnswering({ mx: none, ...addresses });

        expect(await domainTakesMail(resolver, 'someone@example.net')).toBe(true);
        expect(resolver.asked).toEqual(['MX example.net.', 'A example.net.', 'AAAA example.net.']);
      }
    }
  });

  test('refuses a name with neither MX nor address, which a name that does not exist is', async () => {
    expect(
      await domainTakesMail(resolverAnswering({ mx: 'ENOTFOUND' }), 'someone@example.net'),
    ).toBe(false);
    expect(
      await domainTakesMail(resolverAnswering({ mx: [], a: [], aaaa: [] }), 'someone@example.net'),
    ).toBe(false);
  });

  test('rejects, with neither verdict, when the resolver gives no answer', async () => {
    for (const resolver of [
      resolverAnswering({ mx: 'ETIMEOUT' }),
      resolverAnswering({ mx: 'ESERVFAIL', a: ['192.0.2.1'] }),
      resolverAnswering({ mx: 'ENOTFOUND', a: 'ECONNREFUSED', aaaa: ['2001:db8::1'] }),
      resolverAnswering({ mx: 'ENOTFOUND', a: ['192.0.2.1'], aaaa: 'ETIMEOUT' }),
    ]) {
      await expect(domainTakesMail(resolver, 'someone@example.net')).rejects.toThrow();
    }
  });

  test('passes on the code of a query that got no answer, and never the domain', async () => {
    const failure = await domainTakesMail(
      resolverAnswering({ mx: 'ETIMEOUT' }),
      'someone@example.net',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('ETIMEOUT');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('example');
  });
});
