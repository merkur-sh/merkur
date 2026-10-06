# The blog

What is in this directory is published at `merkur.sh/blog`. The blog promises its readers
that every word is written by a person (`authorship.mdx`), so agents do not write or edit
the `.mdx` files here, and a hook refuses them. The code beside a post (its figures, its
cover) is theirs to write.

The header links to the blog while a post is here; with none, the site has no blog.

## Files

```
index.mdx                         the index: its title and introduction
authorship.mdx                    the authorship policy
posts/<slug>/post.mdx             a post, published at /blog/<slug>
posts/<slug>/figures/<name>.tsx   a figure of that post
posts/<slug>/cover.tsx            the picture the index shows while the post is the newest
```

`index.mdx` and `authorship.mdx` must exist once a post is published. `../fixtures/blog`
holds the test harness's two posts, which never ship: `posts/every-block/post.mdx` shows
every block in use, with three figures and a cover, and `posts/typing-ahead/post.mdx` has
no figure.

## A post

```mdx
---
title: Shipping screens,
accent: not bytes.
dek: The line under the title.
summary: One sentence for the index, the feed and search engines.
date: "2026-09-24"
topic: Protocol
draft: true
---

The opening paragraph is set larger.

## A section

Prose, with a note.[^why]

[^why]: A margin note: under 40 words, never needed to follow the argument.
```

`accent` is the title's closing phrase, set in the serif italic. `draft: true` keeps the post
out of a build; the dev server shows it. Sections are `##`; each gets an address from its
text and a line in "On this page". The reading time is counted from the words.

## Blocks

| Block | Writes |
| --- | --- |
| `<Figure island="rows" label="A terminal you can type in" setup="What is on stage.">Caption.</Figure>` | A numbered figure: `figures/rows.tsx` on the stage, the setup line above, the caption below. `label` is its name in the list of figures. `setup` takes `{<>…<code>ls</code>…</>}` when it needs markup |
| a fenced block: ` ```rust file=screen/diff.rs mark=5 ` | Code with its file name, its language, a Copy button and line 5 marked |
| `> A sentence.` | A pull quote |
| `<Swatch tone="sent">purple</Swatch>` | An inline legend. Tones: `sent`, `moved`, `lost`, `rebuilt`, `waiting` |
| `<Tangent title="A brief tangent: why not TCP?">…</Tangent>` | A detour, folded away |
| `<TradeOffs><Gains title="What you get"><Gain>…</Gain></Gains><Costs title="What it costs"><Cost>…</Cost></Costs></TradeOffs>` | Two lists, marked + and − |
| `<Colophon><Made part="Words">…</Made><Made part="Figures">…</Made><Made part="Code">…</Made></Colophon>` | "How this post was made" |
| `<EndMatter>…</EndMatter>` | Where to respond, the code referenced, revisions |
| `<Glyph>↗</Glyph>` | An arrow or a terminal mark. The text faces have no glyph for these, and the build stops on one written bare |

MDX reads `<` and `{` as markup: write them inside backticks.

## Writing

```
bun run --cwd apps/site dev
```

serves the blog at `http://127.0.0.1:3200/blog` and renders it again on every reload. After
the copy changes, the faces are cut to it:

```
MERKUR_SITE_RYBBIT_SITE_ID=placeholder MERKUR_SITE_BLOG_FIXTURES=1 bun run --cwd apps/site build
bun run --cwd apps/site subset-fonts
```

then build again and commit the faces with the post.
