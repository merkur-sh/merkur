import type { Preset } from 'unocss';

import { cssEase, OUT_EASE, TRAVEL_EASE } from './motion';
import {
  COLORS,
  CSS_VARIABLES,
  DISPLAY_STACK,
  FONT_FACES,
  FRAME_BREAKPOINT,
  MONO_STACK,
  UI_STACK,
} from './tokens';

export interface QuicksilverPresetOptions {
  /**
   * The `@font-face` blocks the base preflight opens with; `FONT_FACES`
   * unless a surface ships its own cut of the same three faces. The website
   * does: every byte before its first paint counts, so it serves each face
   * subset to the characters its pages set, and says so here instead of
   * declaring a second, competing face under the same family name.
   */
  readonly faces?: string;
}

/**
 * Quicksilver as a UnoCSS preset: the theme, the base every surface starts
 * from, and the shared vocabulary of controls and surfaces.
 *
 * Listed after `presetUno()`, never nesting it: UnoCSS resolves a nested
 * preset after its parent, and the order presets resolve in is the order
 * their rules are numbered and therefore emitted.
 */
export function presetQuicksilver(options: QuicksilverPresetOptions = {}): Preset {
  const faces = options.faces ?? FONT_FACES;
  return {
    name: '@merkur/quicksilver',
    theme: {
      colors: { ...COLORS },
      /*
       * The preset defaults, plus one of our own: `frame` is the width at which
       * the app stops filling the window and becomes a column with a window
       * around it. Spread rather than replaced, because `sm:` is already used.
       */
      breakpoints: {
        frame: FRAME_BREAKPOINT,
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
        '2xl': '1536px',
      },
      fontFamily: {
        sans: UI_STACK,
        mono: MONO_STACK,
        display: DISPLAY_STACK,
      },
      /**
       * Five steps, and a rule: the radius states what kind of object this is.
       * `xs` chips, keys, tags; `sm` buttons, inputs, rows, menu items; `md`
       * panels and cards; `lg` dialogs, overlays and sheets; `xl` the two slabs
       * that sit on the desk, the app frame and the sign-in card. From `md` up
       * the corner is a superellipse (`corner-smooth`), which is what makes a
       * card read as machined rather than drawn; engines without `corner-shape`
       * draw the same radius as a circular arc.
       */
      borderRadius: {
        xs: '4px',
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '20px',
      },
      boxShadow: {
        // The lit top edge every raised control carries. On its own it is what
        // separates a control from the panel behind it without a border.
        lift: 'inset 0 1px 0 rgba(255,255,255,0.065)',
        raise: 'inset 0 1px 0 rgba(255,255,255,0.065), 0 1px 2px rgba(0,0,0,0.45)',
        float:
          'inset 0 1px 0 rgba(255,255,255,0.065), 0 2px 4px rgba(0,0,0,0.45), 0 8px 20px -10px rgba(0,0,0,0.80)',
        over: 'inset 0 1px 0 rgba(255,255,255,0.065), 0 4px 8px rgba(0,0,0,0.50), 0 24px 60px -20px rgba(0,0,0,0.95)',
        // "This row is chosen". A tint alone cannot carry it — even at 26% the
        // fill is 1.34:1 against the row's own surface. The 1px accent ring is
        // doing the work at 2.2:1, the fill gives it an interior, and the lit top
        // edge gives it a body.
        cursor: 'inset 0 0 0 1px rgba(127,90,240,0.62), inset 0 1px 0 rgba(255,255,255,0.09)',
        // The one control on a screen that is allowed to emit light: the primary
        // action on the sign-in card. `raise` plus a wide, soft accent halo at
        // rest — painted once, never animated, so it costs a paint and no frames.
        glow: 'inset 0 1px 0 rgba(255,255,255,0.065), 0 1px 2px rgba(0,0,0,0.45), 0 0 28px -4px rgba(127,90,240,0.7)',
      },
      // Tool-grade, not app-grade. `tint` is what a colour-only change costs and
      // is deliberately the shortest; `base` is a control that changes shape;
      // `slow` is reserved for entrances that move real layout.
      duration: {
        tint: '70ms',
        fast: '80ms',
        base: '120ms',
        slow: '180ms',
      },
      /**
       * One curve was doing four jobs. `DEFAULT` is what every bare
       * `transition-*` picks up, and almost every bare transition in this app is
       * a hover tint — a colour change has no momentum, so it takes plain `ease`
       * and none of the drawer curve's settling tail. Seeded from `motion.ts` so
       * CSS transitions and Motion-driven animations share one set of curves.
       */
      easing: {
        DEFAULT: 'ease',
        tint: 'ease',
        out: cssEase(OUT_EASE),
        travel: cssEase(TRAVEL_EASE),
      },
    },
    preflights: [
      {
        /*
         * The base every surface starts from: the three faces, every token as
         * a variable, the terminal surface's ground and the inset around its
         * grid, and a document that fills the viewport. UnoCSS emits a
         * preset's preflight wholly before the config's, so whatever a surface
         * adds follows this.
         */
        getCSS: () => `${faces}

        :root {
          color-scheme: dark;
${CSS_VARIABLES}
          --ui: ${UI_STACK};
          --mono: ${MONO_STACK};
          --display: ${DISPLAY_STACK};
          --terminal-edge-inset: 6px;
          --terminal-bg: #1e1e2e;
        }

        html,
        body {
          width: 100%;
          min-height: 100%;
        }
      `,
      },
    ],
    shortcuts: {
      /**
       * Keyboard focus. One rule everywhere: 2px solid at 2px offset, on
       * :focus-visible only, in the control's own hue. Never a border change — a
       * border shift moves layout and reads as a hover, not as "the keyboard is
       * here". Named `focusable`, not `focus-ring`: the latter parses as the
       * built-in `focus:ring` utility and silently wins over the shortcut.
       */
      focusable:
        'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-color-ring',
      'focusable-inset':
        'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-color-ring',

      /**
       * Buttons. Every variant is one intent applied to `btn`; never restyle from
       * scratch. Press registers on pointer DOWN with zero ramp and eases back
       * out on release — a button that eases INTO its pressed state feels like it
       * lags the finger. Hover DEEPENS a filled control, so the label's contrast
       * rises as the pointer arrives.
       */
      /**
       * The chrome every button wears, and deliberately NOT its box: no display
       * mode, no padding, no size.
       *
       * A variant must never have to *override* a declaration its base already
       * set. Utilities inside a shortcut are not applied in source order —
       * UnoCSS sorts them by rule, then the minifier folds longhands into
       * shorthands — so `p-0` after `px-[13px]` merged into `padding: 0 13px`
       * and every icon button ended up with 26px of horizontal padding inside a
       * 30px box, crushing its glyph to a 2px sliver. `grid` after `inline-flex`
       * lost the same way. Nothing catches it: the classes are all real, the CSS
       * is valid, and every gate stays green. So the base carries only what no
       * variant contradicts, and each variant states its own box.
       *
       * `preset.test.ts` asserts the emitted declarations, because reading the
       * shortcut string cannot tell you which utility won.
       */
      'btn-chrome':
        'relative shrink-0 rounded-sm border border-solid border-transparent text-[13px] frame:text-[14px] font-medium tracking-[-0.008em] whitespace-nowrap select-none cursor-pointer tap-transparent transition-[background-color,border-color,color,transform] duration-tint active:duration-0 active:scale-[0.97] disabled:(cursor-not-allowed opacity-45) motion-reduce:transition-none focusable',
      // `after:` carries 44px of hit area whatever the control renders at. The
      // pseudo-element is inert to layout, so a row of buttons keeps its gaps.
      btn: 'btn-chrome inline-flex items-center justify-center gap-[7px] h-8 px-[13px] after:(content-empty absolute inset-x-0 top-1/2 h-11 -translate-y-1/2)',
      'btn-sm': 'h-[26px] px-[10px] text-[12px] frame:text-[13px]',
      'btn-lg': 'h-[38px] px-[18px] text-[14px] frame:text-[16px]',
      'btn-primary':
        'btn bg-accent text-white shadow-raise hover:bg-accentlo active:bg-accentdn focus-visible:outline-color-ringaccent',
      'btn-secondary':
        'btn bg-raised border-line2 text-ink shadow-lift hover:(bg-lifted border-line3) active:bg-pressed',
      'btn-ghost':
        'btn bg-transparent border-line2 text-body hover:(bg-raised border-line3 text-ink) active:bg-lifted',
      'btn-quiet': 'btn bg-transparent text-meta hover:(bg-raised text-ink)',
      'btn-tinted':
        'btn bg-accentsoft border-accentline text-accentink hover:bg-[rgba(127,90,240,0.22)] focus-visible:outline-color-ringaccent',
      'btn-danger':
        'btn bg-badsoft border-badline text-badink hover:bg-[rgba(255,107,116,0.20)] focus-visible:outline-color-ringbad',
      // Built from `btn-chrome`, not from `btn`: a square control has no text
      // padding to unset, and trying to unset it is what broke it.
      'btn-icon':
        'btn-chrome grid place-items-center w-8 h-8 bg-transparent border-line2 text-meta hover:(bg-raised border-line3 text-ink) after:(content-empty absolute left-1/2 top-1/2 h-11 w-11 -translate-x-1/2 -translate-y-1/2)',

      // Fields. The border is the only thing that moves on focus; the ring is
      // added on top of it by `focusable`, never in place of it.
      field:
        'block w-full h-8 px-[11px] rounded-sm border border-solid border-line2 bg-sunken text-ink text-[13px] frame:text-[15px] transition-[border-color] duration-base hover:border-line3 focus:border-line3 disabled:(opacity-45 cursor-not-allowed) placeholder:text-faint motion-reduce:transition-none focusable',
      'field-bad': 'border-badline',
      'field-label': 'flex flex-col gap-[6px]',
      'field-cap': 'text-[12px] frame:text-[14px] font-medium text-body tracking-[-0.005em]',

      // Section eyebrow above a group of settings or rows. Mono, because it is
      // structure rather than prose. At --meta, not --faint: an eyebrow is how a
      // reader finds a section, and a label that has to be found should clear
      // 4.5:1 like anything else that is read — --faint is for placeholders,
      // which are read once and then replaced.
      eyebrow:
        'font-mono text-[11px] frame:text-[12px] font-medium uppercase tracking-[0.12em] text-meta',

      /**
       * The display register: the only two sizes in the app above body copy,
       * and the three places they are spent — the sign-in wordmark, an empty
       * state's headline, and a machine card's figure. Everything else stays at
       * 12–16px, because a tool is read at arm's length all day and a headline
       * that outshouts the rows under it is a headline nobody needed.
       *
       * Tracking is in em so the sizes scale with the frame breakpoint. Line
       * height closes up as the size rises: at 28px a 1.6 body leading leaves a
       * gap between lines that reads as two headlines rather than one.
       */
      'display-md':
        'text-[24px] frame:text-[28px] font-medium leading-[1.1] tracking-[-0.022em] text-ink text-balance',
      'display-lg':
        'text-[36px] frame:text-[44px] font-medium leading-[0.98] tracking-[-0.03em] text-ink text-balance tabular-nums',
      // The two halves of a two-tone headline, both inside a `display-*` element.
      // The lead is the first sentence in the serif: the face that carries the
      // name carries the one sentence that names the moment, so the brand is in
      // the room and not only on the door. It is set 1.16× the container's size
      // because Instrument Serif has a smaller x-height than Geist and reads a
      // step lighter at equal size; the tracking opens slightly for the same
      // reason. The deck is the second sentence in Geist, carried by tone alone.
      // At 24px `meta` is large text and clears 3:1 on every surface.
      'headline-lead': 'font-display font-normal text-[1.16em] tracking-[-0.012em] text-ink',
      'headline-deck': 'font-sans font-normal text-meta',
      // The wordmark, the serif's only job (see DISPLAY_STACK): full size on the
      // splash and the sign-in card, header size beside the 22px orb on the
      // machine list. The same face at two sizes, so the sign-in entrance can
      // carry the name from one to the other as a shared element.
      wordmark:
        'font-display text-[36px] frame:text-[40px] leading-none tracking-[-0.02em] text-ink',
      'wordmark-sm':
        'font-display text-[22px] frame:text-[24px] leading-none tracking-[-0.02em] text-ink',

      /**
       * A specification row: a mono key in the left column, the value in the
       * right, hairline rules between rows through the shared pseudo-element.
       * How the Account tab states what this build is made of.
       */
      'spec-row':
        'relative grid grid-cols-[112px_minmax(0,1fr)] items-baseline gap-x-3 px-[14px] py-[9px]',
      'spec-key':
        'font-mono text-[11px] frame:text-[12px] font-medium uppercase tracking-[0.12em] text-meta whitespace-nowrap',
      'spec-val': 'min-w-0 font-mono text-[12.5px] frame:text-[14px] text-ink break-words',

      chip: 'inline-flex items-center gap-[5px] h-5 px-2 rounded-full border border-solid border-line2 bg-raised text-body text-[11px] frame:text-[12px] font-medium whitespace-nowrap',
      'chip-ok': 'chip bg-oksoft border-okline text-okink',
      'chip-warn': 'chip bg-warnsoft border-warnline text-warnink',
      'chip-bad': 'chip bg-badsoft border-badline text-badink',
      'chip-accent': 'chip bg-accentsoft border-accentline text-accentink',

      kbd: 'inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-xs border border-solid border-line2 bg-raised shadow-lift font-mono text-[10.5px] frame:text-[12px] text-meta',

      menu: 'flex flex-col gap-px min-w-[178px] p-1 rounded-md corner-smooth border border-solid border-line2 bg-raised shadow-float',
      'menu-sep': 'h-px my-1 bg-line1',

      // Surfaces. Three elevations, and each states what it is: a card sits on
      // the page, a dialog sits over the app, a menu sits over one control.
      card: 'rounded-md corner-smooth border border-solid border-line2 bg-panel shadow-raise',
      // The one kind of object that sits on the desk: the app frame above the
      // `frame` breakpoint and the login card. Black, because the desk is lit,
      // and the largest radius in the system, because it is the largest object.
      slab: 'rounded-xl corner-smooth border border-solid border-line2 bg-ground shadow-float',

      alert:
        'flex items-start gap-[10px] px-3 py-[10px] rounded-sm border border-solid border-line2 bg-raised text-[12.5px] frame:text-[14px] leading-[1.5] text-body',
      'alert-bad': 'alert bg-badsoft border-badline text-badink',
      'alert-warn': 'alert bg-warnsoft border-warnline text-warnink',
      'alert-ok': 'alert bg-oksoft border-okline text-okink',
    },
    rules: [
      [
        'h-app',
        [
          ['height', '100vh'],
          ['height', '100dvh'],
        ],
      ],
      [
        'min-h-app',
        [
          ['min-height', '100vh'],
          ['min-height', '100dvh'],
        ],
      ],
      [
        'w-app',
        [
          ['width', '100vw'],
          ['width', '100dvw'],
        ],
      ],
      // Solid hoists a static `style` object into the compiled template's HTML as
      // a real `style="..."` attribute, which `style-src 'self'` blocks outright
      // (unlike a runtime `element.style` write, which is CSSOM and exempt). Any
      // constant styling therefore has to reach the element as a class.
      ['tap-transparent', { '-webkit-tap-highlight-color': 'transparent' }],
      // A continuous corner. `superellipse(1.6)` sits between a circular arc (1)
      // and the CSS `squircle` keyword (2), which is where hardware corners live.
      // Engines without `corner-shape` ignore the declaration and draw the same
      // `border-radius` as an arc: one element, less shaping, no second path.
      ['corner-smooth', { 'corner-shape': 'superellipse(1.6)' }],
    ],
    /**
     * Never fold rules with the same body into one selector list.
     *
     * UnoCSS merges by default, and a merged list is only as valid as its least
     * valid member: CSS drops the WHOLE rule when any selector in the list is
     * unparseable, and a vendor pseudo-element the engine does not know is
     * unparseable. The app's font-size slider styles its Firefox thumb through
     * `[&::-moz-range-thumb]:` variants, whose bodies are identical to plain
     * utilities, so the generator emitted
     * `.[&::-moz-range-thumb]:appearance-none::-moz-range-thumb, .appearance-none{…}`
     * and Chromium and WebKit threw away `appearance-none`, `bg-transparent`,
     * `rounded-full`, `border-none`, `bg-white`, `cursor-pointer` and the
     * 4px/14px sizes with it — the unselected theme tiles painted the UA
     * button grey, the slider went native, and every switch was square, in
     * every browser but Firefox. Nothing catches a dropped rule: every class is
     * real and the stylesheet is valid text. A few KB of unmerged CSS is the
     * price of a rule meaning what it says; `preset.test.ts` pins it.
     *
     * A generator option rather than a preset field, so the preset sets it on
     * the resolved config: every surface built on Quicksilver gets it without
     * having to remember it.
     */
    configResolved(config) {
      config.mergeSelectors = false;
    },
  };
}
