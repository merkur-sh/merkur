import { describe, expect, test } from 'bun:test';
import { structuredData } from './structured-data';

const PAGE = `<meta name="description" content="A terminal &amp; more.">
<details id="a" class="q" data-question>
  <summary><span class="q-text">Can it see my <b>terminal</b>?</span><i class="q-mark" aria-hidden="true">+</i></summary>
  <p>No. It forwards <code>sealed</code> frames &lt;only&gt;.</p>
</details>`;

describe('structured data', () => {
  test('describes the page with the page’s own description, questions and answers', () => {
    const script = structuredData(PAGE, 'https://merkur.sh');
    expect(script.startsWith('<script type="application/ld+json">')).toBe(true);
    const graph = JSON.parse(script.slice(script.indexOf('>') + 1, script.lastIndexOf('<'))) as {
      '@graph': Record<string, unknown>[];
    };
    const app = graph['@graph'].find((node) => node['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({ url: 'https://merkur.sh/', description: 'A terminal & more.' });
    const faq = graph['@graph'].find((node) => node['@type'] === 'FAQPage');
    expect(faq).toMatchObject({
      mainEntity: [
        {
          name: 'Can it see my terminal?',
          acceptedAnswer: { text: 'No. It forwards sealed frames <only>.' },
        },
      ],
    });
  });

  test('nothing in an answer can close the script it is written into', () => {
    const body = structuredData(PAGE, 'https://merkur.sh').slice(35, -9);
    expect(body).not.toContain('<');
  });

  test('a page with no description or no questions stops the build', () => {
    expect(() => structuredData('<p>nothing</p>', 'https://merkur.sh')).toThrow('no description');
    expect(() =>
      structuredData('<meta name="description" content="x">', 'https://merkur.sh'),
    ).toThrow('no questions');
  });
});
