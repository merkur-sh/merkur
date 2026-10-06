/**
 * `/blog/feed.xml`: the blog as an Atom feed, every post whole.
 *
 * A post's content is its own MDX set in plain elements
 * (`src/blog/templates/feed.tsx`); its links are written from the site's root
 * and `xml:base` says where that is.
 */
import { escapeHtml } from './html';

export const FEED_FILE = 'blog/feed.xml';

export interface FeedEntry {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** The day it was published, as `2026-09-24`. */
  readonly date: string;
  /** The post's content, as markup. */
  readonly content: string;
}

export interface Feed {
  readonly title: string;
  /** Newest first. */
  readonly entries: readonly FeedEntry[];
}

export function blogFeed(siteOrigin: string, feed: Feed): string {
  const newest = feed.entries[0];
  if (newest === undefined) throw new Error('blog feed: a feed with no post');
  const instant = (date: string): string => `${date}T00:00:00Z`;
  const entries = feed.entries.map((entry) => {
    const address = `${siteOrigin}/blog/${entry.slug}`;
    return `  <entry>
    <title>${escapeHtml(entry.title)}</title>
    <id>${address}</id>
    <link href="${address}"/>
    <published>${instant(entry.date)}</published>
    <updated>${instant(entry.date)}</updated>
    <summary>${escapeHtml(entry.summary)}</summary>
    <content type="html" xml:base="${siteOrigin}/">${escapeHtml(entry.content)}</content>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(feed.title)}</title>
  <id>${siteOrigin}/blog</id>
  <link href="${siteOrigin}/blog"/>
  <link rel="self" href="${siteOrigin}/${FEED_FILE}"/>
  <updated>${instant(newest.date)}</updated>
  <author><name>Dmytro</name></author>
${entries.join('\n')}
</feed>
`;
}
