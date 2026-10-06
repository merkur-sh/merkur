/**
 * What a post's MDX is set in: one component for every tag Markdown writes and
 * one for every block the post conventions name. They run at build time only;
 * nothing here reaches a browser.
 *
 * A block marked `data-reveal` rises as it is scrolled to, which is the home
 * page's doing (`src/motion/reveal.ts`): every page of the site runs it.
 */
import type { JSX } from '@solidjs/web';
import type { Component } from 'solid-js';

import { readCodeMeta } from '../code-meta';
import { NOAI_ICON_PATH } from '../noai-icon';

/** One line of a fenced block: its pieces, each in a colour of the terminal palette. */
export type CodeLine = readonly { readonly text: string; readonly tone: string }[];

/** What the blocks of one post are rendered with. */
export interface PostContext {
  readonly slug: string;
  /** The post's figures by file name, compiled to strings. */
  readonly figures: Readonly<Record<string, Component>>;
  /** A fenced block's lines, and the name its language goes by. */
  highlight(code: string, lang: string): { readonly name: string; readonly lines: CodeLine[] };
}

/** The address of the authorship policy; every mark links to it. */
export const POLICY_PATH = '/blog/authorship';

/**
 * The tags MDX writes for plain Markdown. It asks the components map for
 * each, and Solid wants a function there. Each is written out rather than
 * drawn through `Dynamic`, which marks its element for hydration.
 */
const PLAIN = {
  a: (props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
  blockquote: (props: JSX.BlockquoteHTMLAttributes<HTMLElement>) => (
    <blockquote class="pull" data-reveal>
      {props.children}
    </blockquote>
  ),
  br: () => <br />,
  code: (props: JSX.HTMLAttributes<HTMLElement>) => <code {...props} />,
  del: (props: JSX.ModHTMLAttributes<HTMLModElement>) => <del {...props} />,
  em: (props: JSX.HTMLAttributes<HTMLElement>) => <em {...props} />,
  h2: (props: JSX.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 id={props.id} data-section>
      <a class="section-link" href={`#${props.id}`} aria-label="Link to this section">
        #
      </a>
      {props.children}
    </h2>
  ),
  h3: (props: JSX.HTMLAttributes<HTMLHeadingElement>) => <h3 {...props} />,
  hr: () => <hr />,
  li: (props: JSX.LiHTMLAttributes<HTMLLIElement>) => <li {...props} />,
  ol: (props: JSX.OlHTMLAttributes<HTMLOListElement>) => <ol {...props} />,
  p: (props: JSX.HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  strong: (props: JSX.HTMLAttributes<HTMLElement>) => <strong {...props} />,
  ul: (props: JSX.HTMLAttributes<HTMLUListElement>) => <ul {...props} />,
};

/**
 * An arrow or a terminal mark: a character the UI faces have no glyph for,
 * set in the terminal's own face (`.tg`, `font-coverage.ts`). A post writes
 * `<Glyph>↗</Glyph>` too.
 */
export function Glyph(props: { readonly children: string }): JSX.Element {
  return <span class="tg">{props.children}</span>;
}

/**
 * The liquid-metal "no AI" icon: a still the render worker draws over
 * (`gfx/client.ts`), as it does the landing page's icons.
 */
export function NoAiIcon(props: { readonly size: 'mark' | 'heading' | 'tile' }): JSX.Element {
  return (
    <span class="liq noai" data-liquid-icon="noai" data-size={props.size} aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={NOAI_ICON_PATH} />
      </svg>
    </span>
  );
}

/** The mark every byline carries: it links to the authorship policy. */
export function HumanMark(): JSX.Element {
  return (
    <a class="human-mark" href={POLICY_PATH}>
      <NoAiIcon size="mark" />
      Every word <span class="human-mark-by">by human</span>
    </a>
  );
}

interface FigureProps {
  /** The figure's file under the post's `figures/`, without its extension. */
  readonly island: string;
  /** What the page's list of figures calls it. */
  readonly label: string;
  /** Set by `outlinePost`: its place among the post's figures. */
  readonly number: string;
  /** The setup line: what is on stage, in plain words. */
  readonly setup: JSX.Element;
  /** The caption: every assumption and number the figure rests on. */
  readonly children: JSX.Element;
}

interface CodeBlockProps {
  readonly lang: string;
  /** The words after the language: `file=<name>` and `mark=<line>`. */
  readonly meta: string;
  readonly value: string;
}

const TONES = ['sent', 'moved', 'lost', 'rebuilt', 'waiting'] as const;

export function postComponents(context: PostContext): Record<string, Component<never>> {
  const Figure: Component<FigureProps> = (props) => {
    const Island = context.figures[props.island];
    if (Island === undefined) {
      throw new Error(`blog: ${context.slug} names figure ${props.island}, which it does not have`);
    }
    return (
      <figure class="fig" id={`fig-${props.number}`} data-reveal>
        <p class="fig-setup">
          <span class="fig-number">Figure {props.number}</span>
          <span>{props.setup}</span>
        </p>
        <div class="fig-stage" data-island={`${context.slug}/${props.island}`} inert>
          <Island />
        </div>
        <figcaption class="fig-caption">{props.children}</figcaption>
      </figure>
    );
  };

  const CodeBlock: Component<CodeBlockProps> = (props) => {
    const { file, mark } = readCodeMeta(props.meta);
    const { name, lines } = context.highlight(props.value, props.lang);
    if (mark !== null && (mark < 1 || mark > lines.length)) {
      throw new Error(`blog: ${file} marks line ${mark} of ${lines.length}`);
    }
    return (
      <div class="code" data-reveal>
        <div class="code-head">
          <span class="code-file">{file}</span>
          <span class="code-lang">{name}</span>
          <button type="button" class="code-copy" data-code-copy>
            Copy
          </button>
        </div>
        {/* It scrolls sideways, so the keyboard has to be able to reach it. */}
        <pre class="code-body" tabindex="0">
          {lines.map((line, index) => (
            <span class="code-line" data-marked={index + 1 === mark ? '' : undefined}>
              {line.map((piece) => (
                <span class={`tk-${piece.tone}`}>{piece.text}</span>
              ))}
            </span>
          ))}
        </pre>
      </div>
    );
  };

  const NoteMark: Component<{ number: string }> = (props) => (
    <sup class="note-mark">{props.number}</sup>
  );

  const Note: Component<{ number: string; children: JSX.Element }> = (props) => (
    <aside class="note">
      <span class="note-number">{props.number}</span>
      <div class="note-text">{props.children}</div>
    </aside>
  );

  const Tangent: Component<{ title: string; children: JSX.Element }> = (props) => (
    <details class="tangent">
      <summary>
        <span class="tangent-title">{props.title}</span>
        <span class="tangent-toggle" aria-hidden="true" />
      </summary>
      <div class="tangent-body">{props.children}</div>
    </details>
  );

  const TradeOffs: Component<{ children: JSX.Element }> = (props) => (
    <div class="trades" data-reveal>
      {props.children}
    </div>
  );
  const side =
    (kind: 'gain' | 'cost'): Component<{ title: string; children: JSX.Element }> =>
    (props) => (
      <div class="trade" data-trade={kind}>
        <span class="trade-title">{props.title}</span>
        <ul class="trade-list">{props.children}</ul>
      </div>
    );
  const item =
    (sign: string): Component<{ children: JSX.Element }> =>
    (props) => (
      <li class="trade-item">
        <span class="trade-sign" aria-hidden="true">
          {sign}
        </span>
        <span>{props.children}</span>
      </li>
    );

  const Swatch: Component<{ tone: string; children: JSX.Element }> = (props) => {
    if (!(TONES as readonly string[]).includes(props.tone)) {
      throw new Error(`blog: no swatch tone ${props.tone}; there are ${TONES.join(', ')}`);
    }
    return (
      <span class="swatch" data-tone={props.tone}>
        <span class="swatch-chip" />
        {props.children}
      </span>
    );
  };

  const Colophon: Component<{ children: JSX.Element }> = (props) => (
    <section class="colophon" data-reveal>
      <div class="colophon-head">
        <span class="colophon-title">
          <NoAiIcon size="heading" />
          How this post was made
        </span>
        <a class="colophon-policy" href={POLICY_PATH}>
          Authorship policy <Glyph>→</Glyph>
        </a>
      </div>
      {props.children}
    </section>
  );

  const Made: Component<{ part: string; children: JSX.Element }> = (props) => (
    <div class="made">
      <span class="made-part">{props.part}</span>
      <div class="made-text">{props.children}</div>
    </div>
  );

  const EndMatter: Component<{ children: JSX.Element }> = (props) => (
    <div class="endmatter">{props.children}</div>
  );

  return {
    ...PLAIN,
    Glyph,
    Figure,
    CodeBlock,
    NoteMark,
    Note,
    Tangent,
    TradeOffs,
    Gains: side('gain'),
    Costs: side('cost'),
    Gain: item('+'),
    Cost: item('−'),
    Swatch,
    Colophon,
    Made,
    EndMatter,
  } as Record<string, Component<never>>;
}
