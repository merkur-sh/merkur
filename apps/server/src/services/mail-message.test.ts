import { describe, expect, test } from 'bun:test';

import { MAIL_LOCKUP, type MailContent, renderMail } from './mail-message';

const ORIGIN = 'https://app.merkur.sh';

const codeMail: MailContent = {
  subject: '482915 is your Merkur code',
  preview: 'Enter it on app.merkur.sh to finish creating your account.',
  title: 'Finish creating your account.',
  deck: 'Enter this code on app.merkur.sh.',
  code: { label: 'Sign-up code', value: '482915', expiry: 'It expires in 10 minutes.' },
  paragraphs: [],
  footnote: 'If you did not try to sign up, ignore this email.',
  reason: 'You got this because this address was entered on app.merkur.sh.',
};

const noticeMail: MailContent = {
  subject: 'Your Merkur password was reset',
  preview: 'Every browser was signed out.',
  title: 'Your password was reset.',
  deck: 'With a code mailed to this address.',
  paragraphs: ['Every browser was signed out.', 'Link your machines again.'],
  action: { label: 'Open Merkur', href: ORIGIN },
  notice: { tone: 'bad', text: 'If it was not you, someone can read this mailbox.' },
  reason: 'You got this because this is the address of a Merkur account on app.merkur.sh.',
};

describe('renderMail', () => {
  test('sets the code as one unbroken run of digits, the way code extraction reads it', () => {
    const { html, text } = renderMail(codeMail, ORIGIN);
    expect(html).toMatch(/<div class="mail-code"[^>]*>482915<\/div>/);
    expect(text).toContain('\n482915\n');
  });

  test('loads nothing remote: the only image is the lockup carried inline', () => {
    const { html } = renderMail(noticeMail, ORIGIN);
    const sources = [...html.matchAll(/\ssrc="([^"]*)"/g)].map((match) => match[1]);
    expect(sources).toEqual([`cid:${MAIL_LOCKUP.contentId}`]);
    expect(html).not.toMatch(/url\(|<link\b|@import|@font-face/);
  });

  test('carries the lockup as a PNG', () => {
    const bytes = Buffer.from(MAIL_LOCKUP.content, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('escapes every value it writes into the markup', () => {
    const { html } = renderMail(
      { ...noticeMail, title: '<script>x</script>', action: { label: 'Go', href: '"x' } },
      ORIGIN,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('href="&quot;x"');
  });

  test('says in the text part everything the card says', () => {
    const { text } = renderMail(noticeMail, ORIGIN);
    for (const part of [
      noticeMail.title,
      noticeMail.deck,
      ...noticeMail.paragraphs,
      noticeMail.notice?.text,
      `Open Merkur: ${ORIGIN}`,
      noticeMail.reason,
    ]) {
      expect(text).toContain(part ?? 'missing');
    }
  });

  test('stays far under the size at which Gmail clips a message', () => {
    expect(new TextEncoder().encode(renderMail(noticeMail, ORIGIN).html).byteLength).toBeLessThan(
      32 * 1024,
    );
  });
});
