# @merkur/quicksilver

Quicksilver, Merkur's design system, as the one package every Merkur surface builds its
styles from, so two surfaces cannot drift apart: the tokens, a UnoCSS preset, the motion
curves, the UI faces with their licences, the orb still, and the Vite plugins that ship
them.

| Import                       | What it holds                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@merkur/quicksilver/tokens` | Colours and their CSS variables, the three font stacks and `@font-face` blocks, the desk field, the `frame` breakpoint.                             |
| `@merkur/quicksilver/preset` | `presetQuicksilver()`: the theme, the base preflight (faces, variables, a full-viewport document), the shared shortcuts and rules, unmerged selectors. |
| `@merkur/quicksilver/motion` | `OUT_EASE`, `TRAVEL_EASE` and `cssEase`: one set of curves for CSS transitions and Motion animations. Browser-safe.                                  |
| `@merkur/quicksilver/assets` | `ORB_STILL_DATA_URI`, the orb at rest as a data URI.                                                                                                |
| `@merkur/quicksilver/vite`   | `quicksilverFonts()` and `inlineStylesheet()`.                                                                                                      |

A surface lists the preset after `presetUno()`, never inside it: UnoCSS numbers rules in the
order presets resolve, and that order is the order the stylesheet emits them.

```ts
presets: [presetUno(), presetQuicksilver()],
```

What stays in a surface is what only that surface has. For the web app that is its
preflight after the base one (the desk, the boot splash, the element resets, row rules and
view transitions), its screen shortcuts and its view-transition rules, in
`apps/web/uno.config.ts`.

## Fonts

Every file in `packages/quicksilver/fonts` ships at `/fonts/<file>`: `quicksilverFonts()`
serves the directory in development and emits it into the bundle at build time, and stops
on any file that is not a `.woff2` face or a `.txt` licence. The URLs are the ones the
service-worker precache, its routing and the server's cache rules already expect.

The six `.woff2` files are the UI faces, unrelated to the terminal's `.ttf` faces in
`apps/web/public/fonts`: the terminal renders its grid through fontdue and a WASM glyph
atlas, so it needs whole `.ttf` binaries, while the UI needs a CSS `@font-face` and pays for
every byte on first paint. They are Google Fonts' own variable-weight subsets, fetched
verbatim from fonts.gstatic.com and committed rather than linked. Linking would put a
render-blocking request to a third party in front of the first paint of an app whose entire
point is that it opens instantly, and would leave an offline PWA without its typeface.
`packages/quicksilver/FONTS.json` records the source URL, sha256 and unicode-range of each
file; the ranges are reproduced in the `@font-face` blocks in
`packages/quicksilver/src/tokens.ts`, and `packages/quicksilver/src/preset.test.ts` pins both.

The full text of the SIL Open Font License 1.1 ships beside the faces, copied verbatim from
each family's upstream repository: `OFL-Geist.txt`, `OFL-JetBrainsMono.txt` and
`OFL-InstrumentSerif.txt`.

**Geist** (`Geist-latin.woff2`, `Geist-latin-ext.woff2`). Copyright (c) 2023 Vercel, in
collaboration with basement.studio. This Font Software is licensed under the SIL Open Font
License, Version 1.1. This license is available with a FAQ at: https://scripts.sil.org/OFL

**JetBrains Mono** (`JetBrainsMono-latin.woff2`, `JetBrainsMono-latin-ext.woff2`). Copyright
2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). This
Font Software is licensed under the SIL Open Font License, Version 1.1. This license is
available with a FAQ at: https://scripts.sil.org/OFL

**Instrument Serif** (`InstrumentSerif-latin.woff2`, `InstrumentSerif-latin-ext.woff2`).
Copyright 2022 The Instrument Serif Project Authors
(https://github.com/Instrument/instrument-serif). This Font Software is licensed under the
SIL Open Font License, Version 1.1. This license is available with a FAQ at:
https://scripts.sil.org/OFL. Fetched the same way as the two faces above and used for the
wordmark (splash, sign-in card, machine list header) and for the first sentence of an empty
state or the title of the connecting card. Every other piece of UI text stays in Geist or
JetBrains Mono.

## The orb still

`packages/quicksilver/assets/orb-still.webp` is one frame of the live orb shader,
written by `scripts/capture-orb-still.ts`; `src/assets.ts` says why it is a WebP with alpha
and why it is inlined.
