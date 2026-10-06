/**
 * What a post's Markdown is turned into before MDX compiles it, and what the
 * page around the post needs to know about it.
 *
 * - A section heading gets the address its text spells, and is listed for
 *   "On this page".
 * - A `<Figure>` gets its number, in the order the post sets them, and is
 *   listed for "Figures".
 * - A fenced block becomes a `<CodeBlock>` that carries its language and the
 *   words after it (`file=`, `mark=`), which Markdown would otherwise drop.
 * - A footnote becomes a margin note: its mark stays in the sentence and the
 *   note is set straight after the block that names it, not at the end.
 * - The words are counted, for the reading time.
 */

/** A node of the Markdown tree; only what this module reads is typed. */
export interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  identifier?: string;
  name?: string | null;
  attributes?: { type: string; name?: string; value?: unknown }[];
  data?: { hProperties?: Record<string, string> };
}

export interface PostOutline {
  readonly headings: readonly { readonly id: string; readonly text: string }[];
  readonly figures: readonly {
    readonly number: number;
    readonly island: string;
    readonly label: string;
  }[];
  /** The languages its fenced blocks are written in. */
  readonly languages: readonly string[];
  readonly words: number;
}

function plainText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  return (node.children ?? []).map(plainText).join('');
}

/** The address a heading's text spells: its letters and digits, hyphenated. */
export function headingId(text: string): string {
  const id = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (id === '') throw new Error(`blog: the heading "${text}" spells no address`);
  return id;
}

function attribute(name: string, value: string): { type: string; name: string; value: string } {
  return { type: 'mdxJsxAttribute', name, value };
}

function stringAttribute(node: MarkdownNode, name: string, file: string): string {
  const found = node.attributes?.find((entry) => entry.name === name);
  if (found === undefined || typeof found.value !== 'string' || found.value === '') {
    throw new Error(`blog: a <${node.name}> in ${file} has no ${name}="…"`);
  }
  return found.value;
}

/** Every node under `node`, itself first, with the list it sits in. */
function* walk(
  node: MarkdownNode,
): Generator<{ node: MarkdownNode; siblings: MarkdownNode[]; index: number }> {
  const children = node.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (child === undefined) continue;
    yield { node: child, siblings: children, index };
    yield* walk(child);
  }
}

/** Rewrites `tree` in place and returns what the page around the post lists. */
export function outlinePost(tree: MarkdownNode, file: string): PostOutline {
  const headings: { id: string; text: string }[] = [];
  const figures: { number: number; island: string; label: string }[] = [];
  const languages = new Set<string>();
  let words = 0;

  const definitions = new Map<string, MarkdownNode>();
  tree.children = (tree.children ?? []).filter((node) => {
    if (node.type !== 'footnoteDefinition') return true;
    definitions.set(node.identifier ?? '', node);
    return false;
  });
  const numbered = new Map<string, number>();

  for (const { node, siblings, index } of walk(tree)) {
    if (node.type === 'heading' && node.depth === 2) {
      const text = plainText(node);
      const id = headingId(text);
      if (headings.some((heading) => heading.id === id)) {
        throw new Error(`blog: ${file} has two sections that spell #${id}`);
      }
      headings.push({ id, text });
      node.data = { hProperties: { id } };
    } else if (node.type === 'mdxJsxFlowElement' && node.name === 'Figure') {
      const number = figures.length + 1;
      figures.push({
        number,
        island: stringAttribute(node, 'island', file),
        label: stringAttribute(node, 'label', file),
      });
      node.attributes = [...(node.attributes ?? []), attribute('number', String(number))];
    } else if (node.type === 'code') {
      if (node.lang === null || node.lang === undefined) {
        throw new Error(`blog: a fenced block in ${file} names no language`);
      }
      languages.add(node.lang);
      siblings[index] = {
        type: 'mdxJsxFlowElement',
        name: 'CodeBlock',
        attributes: [
          attribute('lang', node.lang),
          attribute('meta', node.meta ?? ''),
          attribute('value', node.value ?? ''),
        ],
        children: [],
      };
    } else if (node.type === 'footnoteReference') {
      const identifier = node.identifier ?? '';
      if (!definitions.has(identifier)) {
        throw new Error(`blog: ${file} marks note ${identifier} and never writes it`);
      }
      if (numbered.has(identifier)) {
        throw new Error(`blog: ${file} marks note ${identifier} twice`);
      }
      numbered.set(identifier, numbered.size + 1);
      siblings[index] = {
        type: 'mdxJsxTextElement',
        name: 'NoteMark',
        attributes: [attribute('number', String(numbered.size))],
        children: [],
      };
    }
  }
  for (const identifier of definitions.keys()) {
    if (!numbered.has(identifier)) {
      throw new Error(`blog: ${file} writes note ${identifier} and never marks it`);
    }
  }

  // Each note follows the top-level block its mark is in.
  const placed: MarkdownNode[] = [];
  for (const block of tree.children) {
    placed.push(block);
    const marks = [{ node: block }, ...walk(block)].filter(
      ({ node }) => node.type === 'mdxJsxTextElement' && node.name === 'NoteMark',
    );
    for (const { node } of marks) {
      const number = stringAttribute(node, 'number', file);
      const identifier = [...numbered].find(([, value]) => String(value) === number)?.[0] ?? '';
      placed.push({
        type: 'mdxJsxFlowElement',
        name: 'Note',
        attributes: [attribute('number', number)],
        children: definitions.get(identifier)?.children ?? [],
      });
    }
  }
  tree.children = placed;

  for (const { node } of walk(tree)) {
    if (node.type !== 'text') continue;
    words += (node.value ?? '').split(/\s+/).filter((word) => word !== '').length;
  }

  return { headings, figures, languages: [...languages].sort(), words };
}

/** The remark plugin: `outlinePost` over every post, its findings handed to `record`. */
export function remarkPost(record: (file: string, outline: PostOutline) => void) {
  return () =>
    (tree: MarkdownNode, file: { path?: string }): void => {
      const path = file.path ?? '';
      record(path, outlinePost(tree, path));
    };
}
