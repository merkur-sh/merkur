/**
 * `/llms.txt`: the site as a language model is meant to read it, in Markdown:
 * what Merkur is, the questions the home page answers, and every other page
 * at its address.
 *
 * It is read from the built pages. The summary is the home page's own
 * description, each question and answer is one that page sets, and a page is
 * listed under the title it is shared with (`og:title`) beside its own
 * description, so the file cannot say what a visitor does not read.
 */
import type { SiteEnvironment } from './site-environment';
import { plainText, REPOSITORY, readQuestions } from './structured-data';

export const LLMS_FILE = 'llms.txt';

const HOME = '/';
const BLOG = '/blog';
/** The pages a reader short of room may leave out: the format's `Optional` section. */
const OPTIONAL: ReadonlySet<string> = new Set(['/privacy', '/terms']);

type Section = 'Pages' | 'Blog' | 'Optional';

function sectionOf(route: string): Section {
  if (route === BLOG || route.startsWith(`${BLOG}/`)) return 'Blog';
  if (OPTIONAL.has(route)) return 'Optional';
  return 'Pages';
}

/** What a page's `<meta>` says, as text; a page without it stops the build. */
function meta(html: string, name: string, route: string): string {
  const content = new RegExp(`<meta ${name} content="([^"]*)">`).exec(html)?.[1];
  if (content === undefined || content === '') {
    throw new Error(`llms.txt: ${route} has no <meta ${name}>`);
  }
  return plainText(content);
}

function list(title: string, lines: readonly string[]): string {
  return `## ${title}\n\n${lines.join('\n')}`;
}

export function llmsText(
  environment: Pick<SiteEnvironment, 'siteOrigin' | 'appOrigin'>,
  /** Every page's built document, by the address it is served at. */
  pages: Readonly<Record<string, string>>,
): string {
  const home = pages[HOME];
  if (home === undefined) throw new Error('llms.txt: the site has no home page');
  const questions = readQuestions(home);
  if (questions.length === 0) throw new Error('llms.txt: the home page sets no questions');

  const sections: Record<Section, string[]> = { Pages: [], Blog: [], Optional: [] };
  for (const [route, html] of Object.entries(pages)) {
    // The home page is the summary and the questions above the lists.
    if (route === HOME) continue;
    // A bracket in a title would close the link it is the text of.
    const title = meta(html, 'property="og:title"', route).replace(/[[\]]/g, '\\$&');
    sections[sectionOf(route)].push(
      `- [${title}](${environment.siteOrigin}${route}): ${meta(html, 'name="description"', route)}`,
    );
  }

  const blocks = [
    '# Merkur',
    `> ${meta(home, 'name="description"', HOME)}`,
    [
      `- App: ${environment.appOrigin}/`,
      `- Install on macOS or Linux: \`curl -fsSL ${new URL(environment.siteOrigin).host}/install | sh\``,
    ].join('\n'),
    'Questions the home page answers:',
    questions.map(({ question, answer }) => `- **${question}** ${answer}`).join('\n'),
  ];
  if (sections.Pages.length > 0) blocks.push(list('Pages', sections.Pages));
  if (sections.Blog.length > 0) blocks.push(list('Blog', sections.Blog));
  blocks.push(
    list('Source', [
      `- [Repository](${REPOSITORY}): The daemon, the relay, the crypto and the renderer, under AGPL-3.0`,
    ]),
  );
  if (sections.Optional.length > 0) blocks.push(list('Optional', sections.Optional));
  return `${blocks.join('\n\n')}\n`;
}
