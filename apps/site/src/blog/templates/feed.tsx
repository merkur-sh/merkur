/**
 * A post as a feed reader sets it: the same MDX, in plain elements. A reader
 * runs no script and has none of the blog's styles, so a figure is its setup
 * line, its caption and a link to where it runs.
 */
import type { JSX } from '@solidjs/web';
import type { Component } from 'solid-js';

import { readCodeMeta } from '../code-meta';
import type { PostContext } from './blocks';

type Children = { readonly children: JSX.Element };

export function feedComponents(context: PostContext): Record<string, Component<never>> {
  const plain = {
    a: (props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
    blockquote: (props: Children) => <blockquote>{props.children}</blockquote>,
    br: () => <br />,
    code: (props: Children) => <code>{props.children}</code>,
    del: (props: Children) => <del>{props.children}</del>,
    em: (props: Children) => <em>{props.children}</em>,
    h2: (props: Children) => <h2>{props.children}</h2>,
    h3: (props: Children) => <h3>{props.children}</h3>,
    hr: () => <hr />,
    li: (props: Children) => <li>{props.children}</li>,
    ol: (props: Children) => <ol>{props.children}</ol>,
    p: (props: Children) => <p>{props.children}</p>,
    strong: (props: Children) => <strong>{props.children}</strong>,
    ul: (props: Children) => <ul>{props.children}</ul>,
  };
  const titled = (props: { title: string } & Children): JSX.Element => (
    <>
      <p>
        <strong>{props.title}</strong>
      </p>
      {props.children}
    </>
  );
  const list = (props: { title: string } & Children): JSX.Element => (
    <>
      <p>
        <strong>{props.title}</strong>
      </p>
      <ul>{props.children}</ul>
    </>
  );
  const through = (props: Children): JSX.Element => <>{props.children}</>;
  return {
    ...plain,
    Glyph: through,
    Swatch: through,
    TradeOffs: through,
    EndMatter: through,
    Tangent: titled,
    Gains: list,
    Costs: list,
    Gain: plain.li,
    Cost: plain.li,
    Figure: (props: { number: string; setup: JSX.Element } & Children) => (
      <>
        <p>
          <strong>Figure {props.number}.</strong> {props.setup}
        </p>
        {props.children}
        <p>
          <a href={`/blog/${context.slug}#fig-${props.number}`}>
            Figure {props.number} runs on the page.
          </a>
        </p>
      </>
    ),
    CodeBlock: (props: { meta: string; value: string }) => (
      <>
        <p>
          <code>{readCodeMeta(props.meta).file}</code>
        </p>
        <pre>
          <code>{props.value}</code>
        </pre>
      </>
    ),
    NoteMark: (props: { number: string }) => <sup>{props.number}</sup>,
    Note: (props: { number: string } & Children) => (
      <aside>
        <sup>{props.number}</sup> {props.children}
      </aside>
    ),
    Colophon: (props: Children) => (
      <>
        <h2>How this post was made</h2>
        {props.children}
      </>
    ),
    Made: (props: { part: string } & Children) => (
      <>
        <p>
          <strong>{props.part}</strong>
        </p>
        {props.children}
      </>
    ),
  } as Record<string, Component<never>>;
}
