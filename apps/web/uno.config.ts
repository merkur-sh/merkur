import { ORB_STILL_DATA_URI } from '@merkur/quicksilver/assets';
import { cssEase, TRAVEL_EASE } from '@merkur/quicksilver/motion';
import { presetQuicksilver } from '@merkur/quicksilver/preset';
import {
  COLORS,
  DESK_FIELD,
  DISPLAY_STACK,
  FIELD_DOT_PITCH,
  FRAME_BREAKPOINT,
} from '@merkur/quicksilver/tokens';
import presetUno from '@unocss/preset-uno';
import { defineConfig, transformerVariantGroup } from 'unocss';

/**
 * The app's layer over Quicksilver: the shell's own preflight (the desk, the
 * boot splash, the element resets, the row rules and the view transitions),
 * the app's shortcuts and its few rules. The tokens, the base preflight and
 * the shared controls and surfaces are `presetQuicksilver()`.
 *
 * The desk the app sits on is Quicksilver's field (`DESK_FIELD`): above the
 * `frame` breakpoint the app is a card on it, and the card is not, so the card
 * reads as a smooth black slab resting on a bench mat rather than a rectangle
 * drawn on nothing.
 *
 * Where it shows is split at that breakpoint. From `frame` up it is under
 * every phase, splash included, because the orb and the frame are objects on
 * a desk there. Below it the body stays flat `ground` and the field shows
 * behind the login, and behind the splash only when the boot is heading for
 * the login (`data-boot="fresh"`, guessed by `createAppController` from the
 * device-list cache before the refresh round trip): a splash that is about
 * to become the machine list stays black like the frame that follows it, so
 * neither arrival changes the ground under the orb.
 *
 * It is painted by `body::before` in the preflight, a fixed pseudo-element
 * that never moves, never scrolls and is never animated except in opacity —
 * not by the body's own background and not by the login phase layer. The
 * phone's login layer scales and fades on entry and scrolls under the
 * keyboard, and putting a texture on it flashed white on iOS: WebKit tiles a
 * composited layer and shows the tiles unpainted until the texture has been
 * rasterised into them, and a scale re-rasterises every tile. The body's own
 * background cannot carry it either, because toggling it with the phase
 * snaps the desk away under the login card's exit cross-fade; the
 * pseudo-element fades in the same 160 ms the phase layers do.
 */
export default defineConfig({
  presets: [presetUno(), presetQuicksilver()],
  transformers: [transformerVariantGroup()],
  preflights: [
    {
      getCSS: () => `
        /*
         * The desk. See the note on the desk above this config for why it is
         * this pseudo-element and nothing else. First in the body, so every
         * fixed layer the app adds paints over it without a z-index.
         */
        body.app-body::before {
          content: '';
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image: ${DESK_FIELD};
          background-size: ${FIELD_DOT_PITCH} ${FIELD_DOT_PITCH}, auto;
          opacity: 0;
          transition: opacity 160ms ease;
        }
        body.app-body[data-phase='auth']::before,
        body.app-body[data-phase='bootstrapping'][data-boot='fresh']::before {
          opacity: 1;
        }
        @media (min-width: ${FRAME_BREAKPOINT}) {
          body.app-body::before {
            opacity: 1;
            transition: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          body.app-body::before {
            transition: none;
          }
        }

        /*
         * The initial value of border-style is "none", so a width-only utility
         * such as border-2 draws NOTHING: it sets a width against a style that
         * refuses to paint. Every reset in this family therefore seeds
         * border-width 0 with border-style solid, and this app hand-rolled its
         * reset and omitted it — which is why all three loading spinners were
         * invisible and why borders across the app did not match the
         * specification, where every control writes a 1px solid edge. The width
         * stays 0, so nothing gains an edge it did not ask for; what changes is
         * that asking for one now works.
         */
        *,
        *::before,
        *::after {
          box-sizing: border-box;
          border-width: 0;
          border-style: solid;
          border-color: currentColor;
        }

        /*
         * The type layer, and the one place the app's base measure is set.
         * 14px/1.6 is the compact baseline. Desktop frames raise that baseline
         * through the shared shortcuts below: the extra room should buy
         * legibility rather than preserve phone-sized type in a wide viewport.
         */
        body {
          margin: 0;
          font-family: var(--ui);
          font-size: 14px;
          line-height: 1.6;
          letter-spacing: -0.005em;
          -webkit-font-smoothing: antialiased;
          -webkit-tap-highlight-color: transparent;
        }

        /*
         * JetBrains Mono has a markedly larger x-height than Geist, so 11px of
         * mono beside 13px of sans reads HEAVIER than the sans it is
         * subordinate to. Equalising the x-height rather than the em box is
         * what keeps a row's metadata quieter than its name.
         */
        .font-mono,
        .eyebrow,
        .row-meta,
        .row-num,
        .kbd,
        .pref-stat,
        code,
        kbd,
        samp {
          font-size-adjust: ex-height 0.47;
        }

        /*
         * Boot splash, in the shell HTML rather than in Solid so it paints
         * before any script runs. Matches SplashScreen's layout exactly — same
         * 96px orb box, same gap, same wordmark — so the handoff to the live
         * orb moves nothing. Removed by main.tsx once Solid has mounted.
         */
        #boot-splash {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
        }

        /*
         * The orb at rest: one captured frame of the shader itself, not a
         * gradient standing in for it. The surface is displaced noise and a
         * hand-written approximation reads as a different mark beside the live
         * one.
         *
         * The still carries the shader's own alpha, so the splash paints no
         * ground of its own: whatever the page body shows — the desk from
         * the frame breakpoint up, flat ground below it — is there from the
         * first frame. The earlier JPEG still was flattened onto the flat
         * ground colour, and keeping the splash exact meant painting that
         * colour over the desk and revealing the field only as the login
         * faded in. The still is the splash's alone: the login and
         * machine-list orbs draw over a slab with nothing to cover.
         *
         * Never screenshot the canvas over the running app: that bakes the
         * soft edge against whatever happened to be behind it, which showed up
         * as a grey ring around the sphere. \`scripts/capture-orb-still.ts\`
         * makes the whole ancestor chain transparent first.
         */
        .orb-rest {
          border-radius: 50%;
          background-image: url("${ORB_STILL_DATA_URI}");
          background-size: cover;
          background-position: center;
        }

        /*
         * The mark dissolves in rather than appearing.
         *
         * The splash exists to paint before any script runs, so the still lands
         * on the very first frame — and against a black ground a fully formed
         * sphere arriving in one frame reads as a flash, especially when the
         * whole splash is only on screen for a few hundred milliseconds. A
         * short fade costs nothing on the boot path: it is a compositor-only
         * animation on an element that is already there.
         */
        #boot-splash-orb {
          width: 96px;
          height: 96px;
          animation: boot-orb-in 260ms cubic-bezier(0.23, 1, 0.32, 1) both;
        }

        @keyframes boot-orb-in {
          from {
            opacity: 0;
            transform: scale(0.94);
          }
          to {
            opacity: 1;
            transform: none;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          #boot-splash-orb {
            animation: none;
          }
        }

        /*
         * The same wordmark the sign-in card sets (the \`wordmark\` shortcut),
         * written out here because the shell HTML cannot carry a utility class
         * that has not been generated yet. The face is preloaded from the
         * shell's head, so the first paint has it on a warm cache and swaps
         * within the splash on a cold one, never at the handoff.
         */
        #boot-splash-word {
          font-family: ${DISPLAY_STACK};
          font-size: 36px;
          font-weight: 400;
          line-height: 1;
          letter-spacing: -0.02em;
          color: ${COLORS.ink};
        }
        @media (min-width: ${FRAME_BREAKPOINT}) {
          #boot-splash-word {
            font-size: 40px;
          }
        }

        p,
        pre,
        h1,
        h2,
        h3,
        h4,
        h5,
        h6 {
          margin: 0;
        }

        /*
         * A UA-styled control inherits nothing: Chrome hands a <button> 13.33px
         * Arial with its own letter-spacing, so a button whose class does not
         * set a size renders in a different face from the label beside it.
         */
        button,
        input,
        optgroup,
        select,
        textarea {
          font-family: inherit;
          font-size: inherit;
          font-weight: inherit;
          line-height: inherit;
          letter-spacing: inherit;
          color: inherit;
        }

        /*
         * iOS zooms the page when a field it is focusing is set under 16px, and
         * an installed PWA is not exempt. Coarse pointers get the larger field
         * rather than the app getting a zoom it never asked for.
         *
         * Keyed on .field, which is the class the element actually carries.
         * A shortcut's *name* is what lands in the DOM and what UnoCSS emits
         * the expanded declarations for, so a rule keyed on a name that only
         * appears inside another shortcut's expansion matches nothing — which
         * is why the button hit area moved into the shortcut itself.
         */
        @media (pointer: coarse) {
          .field {
            height: 38px;
            font-size: 16px;
          }
        }

        /*
         * Every row separator is a pseudo-element inset past the status column,
         * so the rule starts where the text does. The cursor row suppresses its
         * own and its successor's: a highlighted row is bounded by its ring,
         * and a hairline crossing that ring reads as a seam through it.
         */
        .device-row + .device-row::before,
        .session-row + .session-row::before {
          content: '';
          position: absolute;
          left: 38px;
          right: 12px;
          top: 0;
          height: 1px;
          background: ${COLORS.line1};
        }
        .pref-row + .pref-row::before,
        .pref-row + .spec-row::before,
        .spec-row + .spec-row::before {
          content: '';
          position: absolute;
          left: 14px;
          right: 0;
          top: 0;
          height: 1px;
          background: ${COLORS.line1};
        }
        .device-row.is-cursor::before,
        .device-row.is-cursor + .device-row::before {
          opacity: 0;
        }

        /*
         * The status sprite. One 14px glyph in currentColor for every machine
         * state, so a row's status column is exactly one width whatever it says
         * — a dot that becomes a spinner that becomes a cross would reflow the
         * name beside it in a cell whose whole purpose is that nothing shifts.
         */
        .st {
          display: block;
          width: 14px;
          height: 14px;
          flex: none;
        }
        .st--conn { color: ${COLORS.accentlt}; }
        .st--ok { color: ${COLORS.ok}; }
        .st--warn { color: ${COLORS.warn}; }
        .st--off { color: ${COLORS.meta}; }
        .st--bad { color: ${COLORS.bad}; }
        .st--busy {
          color: ${COLORS.accentlt};
          animation: st-pulse 1.6s ease infinite;
        }

        @keyframes st-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.42; }
        }

        @media (prefers-reduced-motion: reduce) {
          .st--busy { animation: none; }
        }

        /*
         * The disclosure that holds the link command. Its marker is replaced by
         * the chevron in the hint bar, which rotates rather than appearing
         * twice.
         */
        summary { list-style: none; }
        summary::-webkit-details-marker { display: none; }

        /*
         * The terminal selection layer is transparent text laid over the WebGL
         * grid so the browser can own selection and copy. Only the highlight is
         * meant to be seen, painted over the glyphs beneath, so the text itself
         * stays invisible even while selected. This has to live here rather than
         * on the element: CSP is \`style-src 'self'\`, and a pseudo-element rule
         * cannot be written through CSSOM the way the layer's other styles are.
         */
        .terminal-selection-layer ::selection,
        .terminal-selection-layer::selection {
          background: rgba(127, 90, 240, 0.32);
          color: transparent;
        }

        /*
         * The one spinner. Two border colours on one ring, and deliberately NOT
         * written as border-line3 plus border-t-ink: those two utilities share
         * a single --un-border-opacity, so whichever the generator emits last
         * sets the alpha for BOTH and the ring came out a uniform opaque white
         * — a circle with no visible head, which reads as a spinner that is not
         * spinning. It is the only feedback the connecting card gives, so it
         * has to be a fact rather than an emergent property of utility order.
         *
         * 0.8s, which is the specified rate: at 1s a 14px ring reads as
         * drifting rather than working.
         */
        .spinner {
          display: block;
          flex: none;
          border-radius: 9999px;
          border: 2px solid ${COLORS.line3};
          border-top-color: ${COLORS.ink};
          animation: spinner-turn 0.8s linear infinite;
        }

        /* On a filled control the track has to clear the fill, not the panel. */
        .spinner--on-fill {
          border-color: rgba(255, 255, 255, 0.28);
          border-top-color: #ffffff;
        }

        @keyframes spinner-turn {
          to {
            transform: rotate(360deg);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .spinner {
            animation: none;
          }
        }

        /*
         * The disclosure's own marker, rotated by the element's open state
         * rather than by anything Solid has to track. The summary's own list
         * marker is removed above, so this is the only thing that says the
         * panel below belongs to the row that was just pressed.
         */
        .add-machine-chevron {
          transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
        }

        [data-add-machine][open] .add-machine-chevron {
          transform: rotate(90deg);
        }

        [data-add-machine][open] [data-add-machine-summary] {
          color: ${COLORS.ink};
        }

        @media (prefers-reduced-motion: reduce) {
          .add-machine-chevron {
            transition: none;
          }
        }

        @keyframes menu-in {
          from {
            opacity: 0;
            transform: translateY(-4px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        /*
         * The one entrance and its reverse. Signing in carries the orb and
         * the wordmark from the middle of the sign-in card to their slots in
         * the machine list header as shared elements, through the View
         * Transitions API, signing out carries them back, and nothing else on
         * the way moves on its own. \`PhaseHost\` starts the transition; these
         * rules time it. The pair travels on the same curve
         * the route layers use and takes a little longer than the surfaces
         * cross-fade, so it is the last thing to settle. Under reduced motion
         * \`PhaseHost\` never starts one, and the rule below stops any that
         * some other caller might.
         */
        /*
         * While the pair is travelling, the machine list's contents stay out
         * of the frame: the rows, the eyebrow and the empty state would
         * otherwise be sitting there when the orb lands on top of them. The
         * layer wears \`shared-arrival\` until the transition's \`finished\`
         * promise settles (see \`PhaseHost\`), and the pane fades in when it
         * comes off. The header and the hint bar are the frame itself and stay.
         */
        #device-list .app-pane {
          transition: opacity 180ms ease;
        }
        .shared-arrival #device-list .app-pane {
          opacity: 0;
          transition: none;
        }
        /*
         * The same rule for the terminal's status card. Selecting a machine
         * pushes the terminal route one visual frame later and the terminal
         * layer cross-fades in over the list, so the "Connecting" card was on
         * screen while the list was still half there. The layer wears
         * \`view-arriving\` until its entrance has finished (see \`ViewLayer\`),
         * and only then does the card fade in: the screen first, then what it
         * has to say.
         */
        #terminal-status-overlay {
          transition: opacity 160ms ease;
        }
        .view-arriving #terminal-status-overlay {
          opacity: 0;
          transition: none;
        }
        @media (prefers-reduced-motion: reduce) {
          #device-list .app-pane,
          #terminal-status-overlay {
            transition: none;
          }
        }
        ::view-transition-group(orb),
        ::view-transition-group(wordmark) {
          animation-duration: 340ms;
          animation-timing-function: ${cssEase(TRAVEL_EASE)};
        }
        /*
         * Linear, not the UA's \`ease\`: the surfaces under the travelling
         * pair are a cross-dissolve, and \`ease\` puts half of it in the first
         * quarter of the time, which reads as a cut with a tail. This is the
         * same ramp \`PhaseHost\` uses where the API is missing, so the two
         * paths are one shape.
         */
        ::view-transition-old(root),
        ::view-transition-new(root) {
          animation-duration: 200ms;
          animation-timing-function: linear;
        }
        @media (prefers-reduced-motion: reduce) {
          ::view-transition-group(*),
          ::view-transition-old(*),
          ::view-transition-new(*) {
            animation: none;
          }
        }
      `,
    },
  ],
  shortcuts: {
    // The document never scrolls and never changes shape: every phase is a
    // fixed, full-viewport layer that owns its own scrolling, which is what
    // lets two of them overlap while one dissolves into the other.
    'app-body':
      'min-h-app bg-ground text-body font-sans text-[14px] frame:text-[16px] overflow-hidden overscroll-none',
    // The app is one 460px column, centred, whatever the window is. Everything
    // that is not the terminal lives inside it.
    /*
     * The app is one 460px column, centred, whatever the window is. Below that
     * width it fills the window; above it, it becomes a window of its own —
     * a bordered, rounded, shadowed card on the page ground, exactly as the
     * screens are drawn. Without that edge a desktop browser shows a phone
     * layout floating in a dark field with nothing to say where the app stops.
     *
     * The chrome lives IN the shortcut. It was a custom rule of the same name
     * carrying `@media (min-width: 461px)`, which never applied: a shortcut and
     * a rule cannot share a name — the shortcut resolves first and the rule is
     * never consulted, silently.
     */
    'app-frame':
      'flex flex-col h-app max-w-[460px] mx-auto overflow-hidden bg-ground frame:(my-6 h-[calc(100dvh-48px)] slab)',
    'app-pane': 'flex-1 min-h-0 overflow-y-auto overscroll-contain',
    /*
     * The terminal is the one screen that is not the 460px column: it is the
     * whole viewport, and it owns the header, the grid and the keyboard as a
     * column. Without it the section has no height at all, `#terminal-viewport`
     * (`flex-1 min-h-0`) has no flex parent to grow into and collapses, and the
     * status overlay's `inset-0` box collapses with it — which draws the whole
     * screen black with the connecting card pinned to the top edge. On touch,
     * while the native keyboard is up, the height is overridden inline from
     * `visualViewport`, because the keyboard changes the viewport without
     * changing `100dvh`.
     */
    'terminal-shell': 'flex flex-col h-app w-app overflow-hidden bg-ground',

    // A row that runs a command. Rows are navigation, so anything destructive
    // leaves this vocabulary and becomes a formed button instead.
    'btn-menuitem':
      'flex w-full items-center justify-between gap-3 rounded-sm border-none bg-transparent px-[9px] py-[6px] text-left text-[12.5px] frame:text-[14px] text-body cursor-pointer select-none transition-[background-color,color] duration-tint hover:(bg-lifted text-ink) focus-visible:(bg-lifted text-ink) motion-reduce:transition-none focusable-inset',
    // The connecting card's title: the same serif, sized for a card that has to
    // hold one word ("Connecting", "Reconnecting") over a line of detail.
    'card-title':
      'font-display font-normal text-[22px] frame:text-[24px] leading-[1.1] tracking-[-0.015em] text-ink',

    // The bottom edge of a screen: what the keys do here, and the one
    // disclosure that opens over it.
    hintbar:
      'flex flex-wrap items-center gap-x-[15px] gap-y-1 px-3 py-[7px] border-t border-solid border-line1 bg-sunken',
    hint: 'inline-flex items-center gap-[5px] text-[11px] frame:text-[13px] text-meta',

    dialog: 'flex flex-col gap-[14px]',

    /**
     * A machine row. The cursor is DOM focus and the tint is how it shows, so
     * the highlight lands on the wrapper — it has to cover the actions button
     * as well, which is part of the same row. Instant, both ways: a cursor that
     * fades in reads as lag.
     */
    'device-row': 'relative flex items-center rounded-sm text-left tap-transparent',
    'row-name':
      'block text-[14px] frame:text-[16px] font-medium text-ink tracking-[-0.012em] truncate',
    'row-meta':
      'block font-mono text-[11px] frame:text-[14px] text-meta tracking-[-0.01em] truncate',
    'row-num':
      'font-mono text-[12.5px] frame:text-[14px] tabular-nums text-meta text-right whitespace-nowrap',

    // Settings rows. A group is one card; the rows inside it are separated by
    // the shared pseudo-element rule, never by their own borders.
    'pref-group':
      'overflow-hidden rounded-md corner-smooth border border-solid border-line2 bg-panel shadow-lift',
    'pref-row':
      'relative flex w-full items-center gap-3 px-[14px] py-[11px] min-h-[52px] text-left bg-transparent border-none tap-transparent',
    'pref-name': 'block text-[14px] frame:text-[16px] font-medium text-ink tracking-[-0.01em]',
    'pref-sub': 'block text-[12px] frame:text-[14px] text-meta mt-px',

    // The settings tab bar. The chosen tab takes an ink line; nothing else
    // moves, because a tab that grows or fills reads as a button. Ink, not the
    // accent: selection is white on black everywhere in the app, and the
    // accent is kept for the one action on a screen and the live dot.
    tabbar: 'flex shrink-0 gap-[2px] px-2 border-b border-solid border-line1',
    tab: 'relative px-[10px] pt-[11px] pb-[10px] bg-transparent border-none text-[13px] frame:text-[15px] font-medium tracking-[-0.008em] text-meta cursor-pointer tap-transparent transition-[color] duration-tint hover:text-body motion-reduce:transition-none focusable',
    'tab-on':
      'text-ink after:(content-empty absolute left-2 right-2 -bottom-px h-[2px] rounded-[1px] bg-ink)',
  },
  rules: [
    // The shared elements of the sign-in entrance and the sign-out exit; see
    // the view-transition rules in the preflight. Exactly one element may
    // carry each at a time.
    ['vt-orb', { 'view-transition-name': 'orb' }],
    ['vt-wordmark', { 'view-transition-name': 'wordmark' }],
    // The cursor row's interior. A gradient rather than a flat tint, so the
    // fill has a lit top edge of its own under the ring.
    [
      'bg-cursor',
      {
        background: 'linear-gradient(180deg, rgba(127,90,240,0.26), rgba(127,90,240,0.15))',
      },
    ],
  ],
  safelist: ['app-body'],
});
