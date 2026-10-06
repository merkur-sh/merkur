/**
 * The desk: the field every slab rests on.
 *
 * With the slab and what surrounds it painted the same flat `ground`, the slab
 * had only its outline to say where it stopped. The field is a lit violet
 * surface carrying a dot grid, and the slab is not, so the slab reads as a
 * smooth black object resting on a bench mat rather than a rectangle drawn on
 * nothing. Where the field shows, and what paints it, belongs to each surface
 * that uses it; this is only the texture.
 *
 * The texture was a paper grain — a two-sided fractal-noise tile modelled on
 * Zen's workspace background — and it was replaced on 2026-09-14. At 2x the
 * grain read as high-frequency, high-contrast noise across two thirds of a
 * desktop window, which argued against the precision the app is about, and
 * it was the loudest surface on screen. A dot grid is the texture of a
 * machined surface rather than of paper: one white dot every 12 CSS px, at
 * 8% alpha, which is quiet enough to sit under the machine list for hours and
 * still says "surface" where flat `ground` would say "nothing". It is drawn
 * by a radial gradient, so it costs one tiled 12px cell rasterised once at the
 * display's density; nothing on the page changes per frame because of it.
 *
 * The field runs at -45° from `FIELD_DARK` to `FIELD_LIT`, the lit corner
 * top-right. That spans about L* 6 to 10, the band between `sunken` and
 * `panel`, so a slab at `ground` stays the darkest object on screen and is the
 * one smooth thing in view. The lit end was lowered with the grain's removal:
 * the grain's light grains had been carrying some of the lift, and without
 * them the old `FIELD_LIT` made the field brighter than a panel.
 */
export const FIELD_DOT_PITCH = '12px';
const FIELD_DOTS = 'radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1.6px)';

/** `amount` of `over` mixed into `base`, in sRGB — Zen's `blendColors`. */
function mixHex(base: string, over: string, amount: number): string {
  const channel = (offset: number): string => {
    const b = Number.parseInt(base.slice(offset, offset + 2), 16);
    const o = Number.parseInt(over.slice(offset, offset + 2), 16);
    return Math.round(b + (o - b) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/**
 * The accent as tuned, in sRGB hex. `COLORS.accent` is the same hue and
 * lightness declared in OKLCH with more chroma (see the note on the accent
 * steps); this is the form `mixHex` can read when it derives the desk field.
 */
const ACCENT_SRGB = '#7f5af0';

/**
 * Quicksilver's three faces, self-hosted.
 *
 * Geist carries the UI and JetBrains Mono carries everything that is structure
 * rather than prose — metadata, numbers, eyebrows, key caps — which is the same
 * family the terminal grid renders in, so a machine's name and its output are
 * visibly the same product. Instrument Serif sets the wordmark — on the
 * splash, the sign-in card and the machine list header — and the one sentence
 * that names a moment: the lead of an empty state and the title of the
 * connecting card. A name and a first sentence get the serif; body copy,
 * controls and metadata never do, so the brand is in the room without ever
 * being in the way of reading.
 *
 * Committed rather than linked to fonts.googleapis.com. A third-party
 * stylesheet is a render-blocking request in front of the first paint of an app
 * whose whole claim is that it opens instantly, and an installed PWA offline
 * would have no typeface at all. `FONTS.json` beside this package's `fonts/`
 * records each file's source URL and sha256.
 *
 * The two ranges are Google's own split: `latin` is what almost every session
 * needs and `latin-ext` is fetched only when a machine or account name actually
 * contains one of its codepoints, which is what `unicode-range` is for.
 */
const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

export const UI_STACK =
  "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
export const MONO_STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const DISPLAY_STACK = "'Instrument Serif', Georgia, 'Times New Roman', serif";

/**
 * `swap`, not `optional`: the fallback stack is metrically unlike Geist, so a
 * face that never arrives leaves the app permanently in the wrong typeface
 * rather than for the 30 ms the file takes off a warm cache. The shift it costs
 * is bounded by the boot splash, which paints before either face is needed.
 *
 * `weight` is the range the file carries: the two UI faces are variable and
 * span 100–900, the wordmark face is a single regular cut.
 *
 * The URL is `/fonts/<file>` on every surface: `quicksilverFonts()` serves and
 * emits this package's `fonts/` at exactly that path.
 */
function fontFace(family: string, file: string, range: string, weight = '100 900'): string {
  return `
        @font-face {
          font-family: '${family}';
          font-style: normal;
          font-weight: ${weight};
          font-display: swap;
          src: url('/fonts/${file}') format('woff2');
          unicode-range: ${range};
        }`;
}

export const FONT_FACES = [
  fontFace('Geist', 'Geist-latin-ext.woff2', LATIN_EXT),
  fontFace('Geist', 'Geist-latin.woff2', LATIN),
  fontFace('JetBrains Mono', 'JetBrainsMono-latin-ext.woff2', LATIN_EXT),
  fontFace('JetBrains Mono', 'JetBrainsMono-latin.woff2', LATIN),
  fontFace('Instrument Serif', 'InstrumentSerif-latin-ext.woff2', LATIN_EXT, '400'),
  fontFace('Instrument Serif', 'InstrumentSerif-latin.woff2', LATIN, '400'),
].join('\n');

/**
 * Quicksilver, Merkur's design system, as a token layer.
 *
 * Six neutral steps on a UNIFORM lightness axis — ΔL* ≈ 3.4 between every
 * adjacent pair, each with a faint violet bias at OKLCH hue 285° so the greys
 * read as chosen rather than defaulted. A step under ~2.5 L* on a large flat
 * field sits at the just-noticeable difference, and the darkest three are
 * exactly where a page ground, a panel and a sunken field live, so the ramp is
 * solved arithmetically rather than placed by eye.
 *
 * Text steps each state the surface they are legible on. `meta` is solved
 * against its WORST case: it clears 4.5:1 on the accent-tinted cursor row, not
 * merely on a panel.
 *
 * Lines are alpha, so one value is correct on every surface.
 *
 * Single-theme by design. Every surface declares `color-scheme: dark` and has
 * no light mode, so there is no second palette to keep honest.
 */
export const COLORS = {
  // Surfaces
  ground: '#08080c', // page ground                     L*  2.3
  sunken: '#121217', // inputs, wells, hint bar          L*  5.6
  panel: '#19191f', // panels, cards, dialogs            L*  9.0
  raised: '#202027', // raised panel, control at rest    L* 12.5
  lifted: '#27272e', // control hover                    L* 15.9
  pressed: '#2e2e36', // control active                  L* 19.2

  // Text
  ink: '#f8f8fc', // primary — 16.5:1 on panel
  body: '#b9b9c0', // secondary, body copy — 9.0:1 on panel
  meta: '#9899a1', // metadata, captions — 4.6:1 on the cursor row
  faint: '#686871', // placeholders and eyebrows only — never carries information
  disabled: '#3b3b43', // WCAG 1.4.3 exempts disabled controls

  // Lines
  line1: 'rgba(255,255,255,0.06)', // dividers, internal rules
  line2: 'rgba(255,255,255,0.10)', // control and panel outlines
  line3: 'rgba(255,255,255,0.16)', // hover, emphasis

  /**
   * Focus. 2px, not 1.5px: WCAG 2.2 SC 2.4.13 wants an indicator with at least
   * the area of a 2px-thick perimeter, and 1.5px has 75% of it. Outline is not
   * layout, so the extra half-pixel costs nothing. Three intents carry a
   * coloured edge, so three tokens; everything else is neutral.
   */
  ring: 'rgba(255,255,255,0.46)',
  ringaccent: 'oklch(66.8% 0.197 293.1)',
  ringbad: '#ff8f96',

  /**
   * Anodized violet, and hover DEEPENS. A filled control that lightens on hover
   * drops its white label under AA at the exact moment the pointer is aimed at
   * it; one that deepens raises it. There is deliberately no lighter step for
   * fills — `accentlt` is for small marks and the accent focus ring only.
   *
   * The four solid steps are declared in OKLCH with their chroma pushed 16%
   * (12% for `accentlt`) past the sRGB values they were tuned as, which puts
   * them just outside sRGB and well inside Display P3. One declaration, and
   * the browser gamut-maps it: a P3 display shows the whole chroma and an
   * sRGB display clips to its boundary, a step more saturated than the old
   * hex. Lightness is untouched, so the contrast figures below still hold
   * (white on `accent` rises from 4.54:1 to 4.65:1). The alpha tints stay as
   * sRGB `rgba()`, because a tint at 15% has no chroma to gain, and
   * `ACCENT_SRGB` above keeps the hex form for the one derivation that needs
   * to mix channels.
   */
  accent: 'oklch(58.7% 0.248 289.5)', // rest, fills, the cursor  #fff on it: 4.65:1
  accentlo: 'oklch(53.2% 0.247 288.1)', // hover                  #fff on it: 5.91:1
  accentdn: 'oklch(47.9% 0.241 286.6)', // active                 #fff on it: 7.44:1
  accentlt: 'oklch(66.8% 0.197 293.1)', // small marks — 5.0:1 on raised
  accentink: '#dcd0ff', // text on a tinted fill — 12.1:1 on panel
  accentsoft: 'rgba(127,90,240,0.15)',
  accentline: 'rgba(127,90,240,0.62)',

  // Semantic — held near the accent's chroma so nothing outshouts it, each
  // raised until its glyph clears 4.5:1 on the row surface.
  ok: '#3fca7f',
  okink: '#a8f0c8',
  oksoft: 'rgba(63,202,127,0.14)',
  okline: 'rgba(63,202,127,0.30)',
  warn: '#e0a44f',
  warnink: '#f5d5a4',
  warnsoft: 'rgba(224,164,79,0.14)',
  warnline: 'rgba(224,164,79,0.30)',
  bad: '#ff6b74',
  badink: '#ffc4c8',
  badsoft: 'rgba(255,107,116,0.14)',
  badline: 'rgba(255,107,116,0.30)',
} as const;

/**
 * The tokens preflight CSS and the keyboard package need by name. Emitted from
 * the same object the utilities are generated from, so a colour cannot be
 * correct as a class and stale as a variable.
 */
export const CSS_VARIABLES = Object.entries(COLORS)
  .map(([name, value]) => `          --${name}: ${value};`)
  .join('\n');

/**
 * The two ends of the field. Lift and hue are separate levers: the lift comes
 * from mixing the neutral `raised` step into `ground`, the cast from a few
 * percent of `accent` on top. Taking both from the accent — 7% to 21% was
 * tried — gave the same depth but made the field the most saturated area in
 * the product, and the accent's job is to be the only saturated thing. Derived
 * rather than picked so the desk follows the tokens if they ever move.
 */
const FIELD_DARK = mixHex(mixHex(COLORS.ground, COLORS.raised, 0.25), ACCENT_SRGB, 0.04); // #13111c
const FIELD_LIT = mixHex(mixHex(COLORS.ground, COLORS.raised, 0.45), ACCENT_SRGB, 0.07); // #1a1827
export const DESK_FIELD = `${FIELD_DOTS}, linear-gradient(-45deg, ${FIELD_DARK} 0%, ${FIELD_LIT} 100%)`;

/**
 * The width at which the app stops filling the window and becomes a column
 * with a window around it. One value for the `frame:` variant and for every
 * preflight rule that decides where the desk shows.
 */
export const FRAME_BREAKPOINT = '461px';
