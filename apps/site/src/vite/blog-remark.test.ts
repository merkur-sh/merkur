import { describe, expect, test } from 'bun:test';

import { readCodeMeta } from '../blog/code-meta';
import { blogFeed } from './blog-feed';
import { headingId, type MarkdownNode, outlinePost } from './blog-remark';

const text = (value: string): MarkdownNode => ({ type: 'text', value });
const paragraph = (...children: MarkdownNode[]): MarkdownNode => ({ type: 'paragraph', children });
const mark = (identifier: string): MarkdownNode => ({ type: 'footnoteReference', identifier });
const note = (identifier: string, value: string): MarkdownNode => ({
  type: 'footnoteDefinition',
  identifier,
  children: [paragraph(text(value))],
});
const figure = (island: string, label: string): MarkdownNode => ({
  type: 'mdxJsxFlowElement',
  name: 'Figure',
  attributes: [
    { type: 'mdxJsxAttribute', name: 'island', value: island },
    { type: 'mdxJsxAttribute', name: 'label', value: label },
  ],
  children: [paragraph(text('A caption.'))],
});
const names = (tree: MarkdownNode): (string | null | undefined)[] =>
  (tree.children ?? []).map((node) => node.name ?? node.type);

describe('a post’s outline', () => {
  test('a section gets the address its text spells and is listed', () => {
    const heading: MarkdownNode = {
      type: 'heading',
      depth: 2,
      children: [text('The replay '), { type: 'inlineCode', value: 'problem' }],
    };
    const outline = outlinePost({ type: 'root', children: [heading] }, 'post.mdx');
    expect(outline.headings).toEqual([{ id: 'the-replay-problem', text: 'The replay problem' }]);
    expect(heading.data?.hProperties?.id).toBe('the-replay-problem');
    expect(headingId('What it costs')).toBe('what-it-costs');
  });

  test('two sections that spell one address stop the build', () => {
    const heading = (): MarkdownNode => ({ type: 'heading', depth: 2, children: [text('Costs')] });
    expect(() =>
      outlinePost({ type: 'root', children: [heading(), heading()] }, 'post.mdx'),
    ).toThrow('two sections that spell #costs');
  });

  test('figures are numbered in the order the post sets them', () => {
    const first = figure('reconnect', 'Coming back');
    const second = figure('rows', 'A terminal');
    const outline = outlinePost({ type: 'root', children: [first, second] }, 'post.mdx');
    expect(outline.figures).toEqual([
      { number: 1, island: 'reconnect', label: 'Coming back' },
      { number: 2, island: 'rows', label: 'A terminal' },
    ]);
    expect(second.attributes?.at(-1)).toEqual({
      type: 'mdxJsxAttribute',
      name: 'number',
      value: '2',
    });
  });

  test('a figure with no label stops the build', () => {
    const bare: MarkdownNode = { type: 'mdxJsxFlowElement', name: 'Figure', attributes: [] };
    expect(() => outlinePost({ type: 'root', children: [bare] }, 'post.mdx')).toThrow(
      'a <Figure> in post.mdx has no island="…"',
    );
  });

  test('a note follows the block that marks it, numbered by its mark', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        paragraph(text('First.'), mark('b')),
        note('a', 'About the second.'),
        paragraph(text('Second.'), mark('a')),
        note('b', 'About the first.'),
      ],
    };
    outlinePost(tree, 'post.mdx');
    expect(names(tree)).toEqual(['paragraph', 'Note', 'paragraph', 'Note']);
    const [, firstNote, , secondNote] = tree.children ?? [];
    expect(firstNote?.attributes).toEqual([
      { type: 'mdxJsxAttribute', name: 'number', value: '1' },
    ]);
    expect(firstNote?.children?.[0]?.children?.[0]?.value).toBe('About the first.');
    expect(secondNote?.children?.[0]?.children?.[0]?.value).toBe('About the second.');
  });

  test('a note nobody marks, and a mark with no note, stop the build', () => {
    expect(() =>
      outlinePost({ type: 'root', children: [note('a', 'Alone.')] }, 'post.mdx'),
    ).toThrow('writes note a and never marks it');
    expect(() =>
      outlinePost({ type: 'root', children: [paragraph(mark('a'))] }, 'post.mdx'),
    ).toThrow('marks note a and never writes it');
  });

  test('a fenced block keeps its language and the words after it', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'code', lang: 'rust', meta: 'file=diff.rs mark=2', value: 'fn a() {}' }],
    };
    const outline = outlinePost(tree, 'post.mdx');
    expect(outline.languages).toEqual(['rust']);
    expect(tree.children?.[0]).toEqual({
      type: 'mdxJsxFlowElement',
      name: 'CodeBlock',
      attributes: [
        { type: 'mdxJsxAttribute', name: 'lang', value: 'rust' },
        { type: 'mdxJsxAttribute', name: 'meta', value: 'file=diff.rs mark=2' },
        { type: 'mdxJsxAttribute', name: 'value', value: 'fn a() {}' },
      ],
      children: [],
    });
    expect(() =>
      outlinePost({ type: 'root', children: [{ type: 'code', value: 'x' }] }, 'post.mdx'),
    ).toThrow('names no language');
  });

  test('the words are counted, a note’s among them and code left out', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        paragraph(text('One two  three.'), mark('a')),
        note('a', 'Four five.'),
        { type: 'code', lang: 'sh', meta: 'file=a.sh', value: 'not counted at all' },
      ],
    };
    expect(outlinePost(tree, 'post.mdx').words).toBe(5);
  });
});

describe('a fenced block’s words', () => {
  test('name the file and the line the prose points at', () => {
    expect(readCodeMeta('file=screen/diff.rs mark=5')).toEqual({ file: 'screen/diff.rs', mark: 5 });
    expect(readCodeMeta('file=a.ts')).toEqual({ file: 'a.ts', mark: null });
  });

  test('anything else stops the build', () => {
    expect(() => readCodeMeta('mark=5')).toThrow('names no file=<name>');
    expect(() => readCodeMeta('file=a.ts {5}')).toThrow('says "{5}"');
    expect(() => readCodeMeta('file=a.ts mark=five')).toThrow('says "mark=five"');
  });
});

describe('the feed', () => {
  const entry = {
    slug: 'shipping-screens',
    title: 'Shipping screens, not bytes.',
    summary: 'Screens & bytes.',
    date: '2026-09-24',
    content: '<p>One <a href="/blog/shipping-screens#fig-1">figure</a>.</p>',
  };

  test('carries every post whole, escaped, with its address on the site’s origin', () => {
    const xml = blogFeed('https://merkur.sh', { title: 'Merkur · Notes.', entries: [entry] });
    expect(xml).toContain('<link rel="self" href="https://merkur.sh/blog/feed.xml"/>');
    expect(xml).toContain('<id>https://merkur.sh/blog/shipping-screens</id>');
    expect(xml).toContain('<updated>2026-09-24T00:00:00Z</updated>');
    expect(xml).toContain('<summary>Screens &amp; bytes.</summary>');
    expect(xml).toContain(
      '<content type="html" xml:base="https://merkur.sh/">&lt;p&gt;One &lt;a href=&quot;/blog/shipping-screens#fig-1&quot;&gt;figure&lt;/a&gt;.&lt;/p&gt;</content>',
    );
  });

  test('a feed with no post is never written', () => {
    expect(() => blogFeed('https://merkur.sh', { title: 'Notes', entries: [] })).toThrow(
      'a feed with no post',
    );
  });
});
