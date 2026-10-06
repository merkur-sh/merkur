/**
 * The blog's pages as static markup. `blogPages()` loads this module through
 * its own Vite server, where Solid compiles for strings, and never into a
 * page.
 */
import { type JSX, renderToString } from '@solidjs/web';
import type { Component } from 'solid-js';

import { type PostContext, postComponents } from './templates/blocks';
import { feedComponents } from './templates/feed';
import {
  IndexPage,
  PolicyPage,
  PostPage,
  type PostView,
  policyComponents,
} from './templates/pages';

/** A page's MDX, compiled: its content and what its front matter says. */
export interface PageModule {
  readonly default: Component<{ components: Record<string, Component<never>> }>;
}

function markup(page: () => JSX.Element): string {
  return renderToString(page, { noScripts: true });
}

export function renderPost(
  module: PageModule,
  post: PostView,
  context: PostContext,
  previous: PostView | null,
  next: PostView | null,
): string {
  return markup(() => (
    <PostPage
      post={post}
      Content={module.default}
      components={postComponents(context)}
      previous={previous}
      next={next}
    />
  ));
}

/** A post's content for the feed: plain elements, no page around it. */
export function renderFeedContent(module: PageModule, context: PostContext): string {
  const Content = module.default;
  return markup(() => <Content components={feedComponents(context)} />);
}

export function renderIndex(
  module: PageModule,
  title: Pick<PostView, 'title' | 'accent'>,
  posts: readonly PostView[],
  Cover: Component | null,
  context: PostContext,
): string {
  return markup(() => (
    <IndexPage
      title={title.title}
      accent={title.accent}
      Content={module.default}
      components={postComponents(context)}
      posts={posts}
      Cover={Cover}
    />
  ));
}

export function renderPolicy(
  module: PageModule,
  title: Pick<PostView, 'title' | 'accent'>,
  context: PostContext,
): string {
  return markup(() => (
    <PolicyPage
      Content={module.default}
      components={{ ...postComponents(context), ...policyComponents(title) }}
    />
  ));
}
