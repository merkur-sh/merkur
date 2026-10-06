/**
 * The blog's three pages: a post, the index and the authorship policy. Each
 * is the `<main>` of its document; `blogPages()` sets the document around it.
 * Build time only.
 */
import type { JSX } from '@solidjs/web';
import type { Component } from 'solid-js';

import { Glyph, HumanMark, NoAiIcon, POLICY_PATH } from './blocks';

const REPOSITORY = 'https://github.com/merkur-sh/merkur';
export const FEED_PATH = '/blog/feed.xml';

/** A post as the pages around it name it. */
export interface PostView {
  readonly slug: string;
  readonly title: string;
  /** The title's closing phrase, set in the serif italic. */
  readonly accent: string;
  /** The line under the title. */
  readonly dek: string;
  /** What the index and the feed say the post is about. */
  readonly summary: string;
  readonly topic: string;
  /** "September 24, 2026" */
  readonly dateLong: string;
  /** "Sep 24" */
  readonly dateShort: string;
  readonly year: string;
  readonly minutes: number;
  readonly headings: readonly { readonly id: string; readonly text: string }[];
  readonly figures: readonly { readonly number: number; readonly label: string }[];
}

type Content = Component<{ components: Record<string, Component<never>> }>;

/** "3 interactive figures", "1 interactive figure", or "Essay" for a post with none. */
export function figureCount(post: PostView): string {
  const count = post.figures.length;
  if (count === 0) return 'Essay';
  return `${count} interactive ${count === 1 ? 'figure' : 'figures'}`;
}

function Title(props: { readonly post: Pick<PostView, 'title' | 'accent'> }): JSX.Element {
  return (
    <>
      {props.post.title} <span class="serif-i">{props.post.accent}</span>
    </>
  );
}

export function PostPage(props: {
  readonly post: PostView;
  readonly Content: Content;
  readonly components: Record<string, Component<never>>;
  /** The post before this one and the one after, by date. */
  readonly previous: PostView | null;
  readonly next: PostView | null;
}): JSX.Element {
  const Content = props.Content;
  return (
    <main id="main" class="post">
      <div class="post-head">
        <a class="post-back" href="/blog">
          <Glyph>←</Glyph> All posts
        </a>
        <div class="post-intro">
          <div class="post-meta">
            <span class="post-topic">{props.post.topic}</span>
            <span class="post-slash">/</span>
            <span>{figureCount(props.post)}</span>
          </div>
          <h1 class="post-title">
            <Title post={props.post} />
          </h1>
          <p class="post-dek">{props.post.dek}</p>
          <div class="byline">
            <div class="byline-who">
              <span class="byline-name">Dmytro</span>
              <span class="byline-date">
                {props.post.dateLong} · {props.post.minutes} min read
              </span>
            </div>
            <HumanMark />
          </div>
        </div>
      </div>
      <div class="post-main">
        <aside class="post-aside">
          <nav class="toc" aria-label="On this page">
            <span class="aside-title">On this page</span>
            <div class="toc-links">
              <span class="toc-bar" aria-hidden="true" />
              {props.post.headings.map((heading) => (
                <a href={`#${heading.id}`} data-toc>
                  {heading.text}
                </a>
              ))}
            </div>
          </nav>
          {props.post.figures.length > 0 && (
            <nav class="figs" aria-label="Figures">
              <span class="aside-title">Figures</span>
              {props.post.figures.map((figure) => (
                <a class="figs-link" href={`#fig-${figure.number}`}>
                  <span class="figs-number">{figure.number}</span>
                  {figure.label}
                </a>
              ))}
            </nav>
          )}
          <a
            class="aside-source"
            href={REPOSITORY}
            data-rybbit-event="cta_github"
            data-rybbit-prop-section="post"
          >
            Read the code <Glyph>↗</Glyph>
          </a>
        </aside>
        <article class="post-body">
          <Content components={props.components} />
          <nav class="post-turn" aria-label="More posts">
            {props.previous === null ? (
              <span />
            ) : (
              <a class="turn" href={`/blog/${props.previous.slug}`}>
                <span class="turn-way">Previous</span>
                <span class="turn-title">
                  {props.previous.title} {props.previous.accent}
                </span>
              </a>
            )}
            {props.next !== null && (
              <a class="turn" data-turn="next" href={`/blog/${props.next.slug}`}>
                <span class="turn-way">Next</span>
                <span class="turn-title">
                  {props.next.title} {props.next.accent}
                </span>
              </a>
            )}
          </nav>
        </article>
      </div>
    </main>
  );
}

export function IndexPage(props: {
  readonly title: string;
  readonly accent: string;
  /** The introduction: the index page's own MDX. */
  readonly Content: Content;
  readonly components: Record<string, Component<never>>;
  /** Newest first. */
  readonly posts: readonly PostView[];
  /** The newest post's cover, when it has one. */
  readonly Cover: Component | null;
}): JSX.Element {
  const Content = props.Content;
  const Cover = props.Cover;
  const [latest, ...rest] = props.posts;
  const years = [...new Set(rest.map((post) => post.year))];
  return (
    <main id="main" class="index">
      <div class="index-head">
        <div class="index-intro">
          <h1 class="index-title">
            <Title post={props} />
          </h1>
          <div class="index-about">
            <Content components={props.components} />
          </div>
          <HumanMark />
        </div>
        <nav class="index-links" aria-label="About this blog">
          <a href={FEED_PATH}>
            RSS feed
            <span class="index-links-way">
              <Glyph>→</Glyph>
            </span>
          </a>
          <a href={REPOSITORY}>
            Source on GitHub
            <span class="index-links-way">
              <Glyph>↗</Glyph>
            </span>
          </a>
          <a href={POLICY_PATH}>
            How this blog is written
            <span class="index-links-way">
              <Glyph>→</Glyph>
            </span>
          </a>
        </nav>
      </div>
      {latest !== undefined && (
        <a
          class="latest"
          href={`/blog/${latest.slug}`}
          data-covered={Cover === null ? undefined : ''}
          data-reveal
        >
          {Cover !== null && (
            <div class="stage latest-cover">
              <Cover />
            </div>
          )}
          <div class="latest-text">
            <div class="post-meta">
              <span class="post-topic">Latest</span>
              <span class="post-slash">/</span>
              <span>{latest.dateLong}</span>
            </div>
            <span class="latest-title">
              <Title post={latest} />
            </span>
            <span class="latest-summary">{latest.summary}</span>
            <span class="latest-facts">
              {figureCount(latest)} · {latest.minutes} min read
            </span>
            <span class="latest-go">
              Read the post <Glyph>→</Glyph>
            </span>
          </div>
        </a>
      )}
      {years.map((year, index) => (
        <section class="year">
          <div class="year-head">
            {index === 0 ? <h2 class="year-title">All posts</h2> : <span />}
            <span class="year-number">{year}</span>
          </div>
          <div class="year-posts">
            {rest
              .filter((post) => post.year === year)
              .map((post) => (
                <a class="row" href={`/blog/${post.slug}`} data-reveal>
                  <span class="row-date">{post.dateShort}</span>
                  <span class="row-text">
                    <span class="row-title">
                      {post.title} {post.accent}
                    </span>
                    <span class="row-summary">{post.summary}</span>
                  </span>
                  <span class="row-facts">
                    <span class="row-topic">{post.topic}</span>
                    <span>{figureCount(post)}</span>
                  </span>
                </a>
              ))}
          </div>
        </section>
      ))}
    </main>
  );
}

/** The blocks only the authorship policy sets. */
export function policyComponents(
  title: Pick<PostView, 'title' | 'accent'>,
): Record<string, Component<never>> {
  const PolicyHead: Component<{ children: JSX.Element }> = (props) => (
    <div class="policy-head">
      <div class="policy-lead">
        <h1 class="policy-title">
          <Title post={title} />
        </h1>
        {props.children}
      </div>
      <div class="policy-tile">
        <NoAiIcon size="tile" />
      </div>
    </div>
  );
  const PolicyProof: Component<{ children: JSX.Element }> = (props) => (
    <div class="policy-proof">{props.children}</div>
  );
  const Tell: Component<{ children: JSX.Element }> = (props) => (
    <div class="policy-tell">{props.children}</div>
  );
  const Example: Component<{ caption: JSX.Element; children: JSX.Element }> = (props) => (
    <figure class="policy-example" data-reveal>
      <div class="stage">
        <div class="policy-sheet">{props.children}</div>
      </div>
      <figcaption class="policy-caption">{props.caption}</figcaption>
    </figure>
  );
  return { PolicyHead, PolicyProof, Tell, Example, HumanMark } as Record<string, Component<never>>;
}

export function PolicyPage(props: {
  readonly Content: Content;
  readonly components: Record<string, Component<never>>;
}): JSX.Element {
  const Content = props.Content;
  return (
    <main id="main" class="policy">
      <a class="post-back" href="/blog">
        <Glyph>←</Glyph> Blog
      </a>
      <Content components={props.components} />
    </main>
  );
}
