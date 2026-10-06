import { describe, expect, test } from 'bun:test';

import { llmsText } from './llms-txt';

const ORIGINS = { siteOrigin: 'https://merkur.sh', appOrigin: 'https://app.merkur.sh' };

function page(title: string, description: string, body = ''): string {
  return `<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
${body}`;
}

const HOME = page(
  'Merkur: your terminal',
  'A terminal &amp; more, free for five machines.',
  `<details id="a" class="q" data-question>
  <summary><span class="q-text">Can it see my <b>terminal</b>?</span><i class="q-mark" aria-hidden="true">+</i></summary>
  <p>No. It forwards <code>sealed</code> frames.</p>
</details>`,
);

const PAGES = {
  '/': HOME,
  '/security': page('Merkur&#39;s security model', 'Who holds which key.'),
  '/privacy': page('Merkur&#39;s privacy policy', 'What Merkur collects.'),
  '/blog/shipping-screens': page('Shipping screens, not bytes.', 'Rows, not a byte stream.'),
  '/blog': page('Notes [from] the wire.', 'How Merkur is built.'),
};

describe('llms.txt', () => {
  test('says what the pages say: the home page’s summary and questions, then every other page', () => {
    expect(llmsText(ORIGINS, PAGES)).toBe(`# Merkur

> A terminal & more, free for five machines.

- App: https://app.merkur.sh/
- Install on macOS or Linux: \`curl -fsSL merkur.sh/install | sh\`

Questions the home page answers:

- **Can it see my terminal?** No. It forwards sealed frames.

## Pages

- [Merkur's security model](https://merkur.sh/security): Who holds which key.

## Blog

- [Shipping screens, not bytes.](https://merkur.sh/blog/shipping-screens): Rows, not a byte stream.
- [Notes \\[from\\] the wire.](https://merkur.sh/blog): How Merkur is built.

## Source

- [Repository](https://github.com/merkur-sh/merkur): The daemon, the relay, the crypto and the renderer, under AGPL-3.0

## Optional

- [Merkur's privacy policy](https://merkur.sh/privacy): What Merkur collects.
`);
  });

  test('a site with no blog has no blog section', () => {
    const text = llmsText(ORIGINS, { '/': HOME, '/security': PAGES['/security'] });
    expect(text).not.toContain('## Blog');
    expect(text).not.toContain('## Optional');
  });

  test('a page with no title to share or no description stops the build', () => {
    expect(() =>
      llmsText(ORIGINS, { '/': HOME, '/security': '<meta name="description" content="x">' }),
    ).toThrow('/security has no <meta property="og:title">');
    expect(() =>
      llmsText(ORIGINS, { '/': HOME, '/security': '<meta property="og:title" content="x">' }),
    ).toThrow('/security has no <meta name="description">');
  });

  test('a build with no home page, or a home page with no questions, stops', () => {
    expect(() => llmsText(ORIGINS, { '/security': PAGES['/security'] })).toThrow('no home page');
    expect(() => llmsText(ORIGINS, { '/': page('Merkur', 'A terminal.') })).toThrow('no questions');
  });
});
