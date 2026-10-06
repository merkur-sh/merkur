/**
 * The home page's structured data, read from the page it describes.
 *
 * A search engine is told what the page already says: the description is the
 * page's own meta description, and each question and answer is one the page
 * sets under Questions, so neither can drift from what a visitor reads. A
 * page asks for it with the comment `STRUCTURED_DATA_MARK` in its head.
 */
export const STRUCTURED_DATA_MARK = '<!--structured-data-->';

export const REPOSITORY = 'https://github.com/merkur-sh/merkur';

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Markup as the text a reader sees: tags out, entities decoded, runs of space closed up. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

export function readQuestions(html: string): { question: string; answer: string }[] {
  return [
    ...html.matchAll(
      /<details\b[^>]*\bdata-question\b[^>]*>\s*<summary>\s*<span\b[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/summary>\s*<p>([\s\S]*?)<\/p>/g,
    ),
  ].map((match) => ({ question: plainText(match[1] ?? ''), answer: plainText(match[2] ?? '') }));
}

export function structuredData(html: string, siteOrigin: string): string {
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1];
  const questions = readQuestions(html);
  if (description === undefined) throw new Error('structured data: the page has no description');
  if (questions.length === 0) throw new Error('structured data: the page sets no questions');
  const home = `${siteOrigin}/`;
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${home}#organization`,
        name: 'Merkur',
        url: home,
        logo: `${siteOrigin}/apple-touch-icon.png`,
        sameAs: [REPOSITORY],
      },
      {
        '@type': 'WebSite',
        '@id': `${home}#website`,
        name: 'Merkur',
        url: home,
        publisher: { '@id': `${home}#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Merkur',
        url: home,
        description: plainText(description),
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        license: 'https://www.gnu.org/licenses/agpl-3.0.html',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        publisher: { '@id': `${home}#organization` },
      },
      {
        '@type': 'FAQPage',
        mainEntity: questions.map(({ question, answer }) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer },
        })),
      },
    ],
  };
  // `<` is escaped so no answer can close the script element it sits in.
  return `<script type="application/ld+json">${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script>`;
}
