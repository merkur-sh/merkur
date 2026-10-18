# The rules in Merkur

Quicksilver already encodes most of the premium rules. Reuse what is here before adding
anything; a new pattern that duplicates one of these is a second system, which is exactly
what reads as unfinished.

## Surfaces and their budgets

- **Web app** (`apps/web`): a tool used all day. Frequency rules apply in full. Rendering of
  the terminal stays off the main thread; chrome motion must never cost the terminal a frame
  (`.claude/rules/frontend.md`).
- **Site** (`apps/site`): seen once per visitor. Showier moments are allowed there, built as
  markup with script only choosing a state (`.claude/rules/site.md`).
- **TUI** (`apps/tui`): a cell grid; the same rules of steadiness and quiet structure apply,
  in characters.

## Colour and depth

`packages/quicksilver/src/tokens.ts` holds the palette, dark only.

- Surfaces step in perceived lightness: `ground` L* 2.3, `sunken` 5.6, `panel` 9.0,
  `raised` 12.5, `lifted` 15.9, `pressed` 19.2. Hover and press move one step up the ramp;
  never invent an in-between grey.
- Text: `ink` for primary, `body` for copy, `meta` for metadata, `faint` for placeholders and
  eyebrows only (it never carries information). Contrast is noted beside each token.
- Lines: `line1`/`line2`/`line3` are white at 6, 10 and 16 percent. Dividers take `line1`,
  outlines `line2`, hover and emphasis `line3`.
- Accent: an OKLCH ladder (`accent`, `accentlo` on hover, `accentdn` on press, `accentlt` for
  small marks, `accentink` for text on a tint). One accent per screen region.
- Status: `ok`, `warn`, `bad`, each with `*ink`, `*soft` and `*line` variants. Status is never
  colour alone; it has a glyph or words too.
- Depth: every raised control carries the lit top edge (`shadow-lift`, an inset 1 px of white
  at 6.5 percent); `shadow-raise`, `shadow-float` and `shadow-over` add stacked drop shadows
  for higher layers, on a lighter surface. `shadow-cursor` marks the chosen row with a 1 px
  accent ring. `shadow-glow` is the one control allowed to emit light, painted once and
  never animated.
- Radius says what an object is: `xs` 4 px chips and keys, `sm` 6 px controls and rows, `md`
  10 px cards, `lg` 14 px dialogs and sheets, `xl` 20 px the slabs. From `md` up the corner is
  a superellipse (`corner-smooth`, `corner-shape: superellipse(1.6)`); engines without it draw
  the circular arc. A child inside padding takes a smaller step, never the parent's radius.

## Type

- Faces: Geist for UI, JetBrains Mono for figures and machine text, Instrument Serif for the
  display register (`headline-lead`, `display-md`), at most one display moment per screen.
- Tracking tightens as size grows, as the shortcuts in `packages/quicksilver/src/preset.ts`
  already do: −0.005em at 12 px, −0.008em at 13 px, −0.012em at 14 px, −0.022em at 24 px,
  −0.03em at 36 px; mono eyebrows open up to +0.12em in capitals.
- `tabular-nums` on every figure that changes or aligns (`row-num`, large numbers);
  `text-balance` on headlines.
- `frame:` switches the type scale at the 461 px frame breakpoint; size changes go through it,
  not ad hoc media queries.

## Motion values

- Curves: `OUT_EASE` for arrivals and departures, `TRAVEL_EASE` for things crossing the window
  (`packages/quicksilver/src/motion.ts`). CSS and Motion share them.
- Springs, all stated as visual duration and bounce (`apps/web/src/lib/motion.ts`):
  `NAV_SPRING` 0.28 s / 0, `PHASE_SPRING` 0.34 s / 0, `SURFACE_SPRING` 0.26 s / 0.22,
  `SHEET_SPRING` 0.36 s / 0. Navigation never bounces.
- Opacity is never a spring: `fadeTransition`, and `dissolveTransition` (linear) for a swap
  between two full-bleed surfaces.
- `motionDuration` collapses durations under reduced motion; `hintMotion` sets `will-change`
  only for the life of an animation.
- Completion is an animation's own `finished` with a generation counter, never a timer that
  has to agree with it (`ViewLayer`, `Sheet`, `HoldButton`).

## House components

| Need | Use | Where |
| --- | --- | --- |
| A control busy with its own work | `aria-busy` + `aria-disabled`, a guard in the handler, and `BusyLabel` | `apps/web/src/components/BusyLabel.tsx` |
| An error that must not move the dialog | `MessageSlot`, which reserves the longest message | `apps/web/src/components/MessageSlot.tsx` |
| Labels that swap in one cell | `.swap-inline` with `data-on` | `apps/web/uno.config.ts` |
| A destructive confirm without a dialog | `HoldButton` (1 s fill, drains on release, leave or blur) | `apps/web/src/components/HoldButton.tsx` |
| An immediate on/off setting | `ToggleSwitch` | `apps/web/src/components/ToggleSwitch.tsx` |
| A tooltip | `tooltip()`: 500 ms first open, instant for 300 ms after, 450 ms long press | `apps/web/src/components/tooltip.ts` |
| A dialog or the palette | `OverlayHost`; dialogs land on `SURFACE_SPRING`, the palette appears and leaves in one frame | `apps/web/src/components/OverlayHost.tsx` |
| A bottom sheet | `Sheet` | `apps/web/src/components/Sheet.tsx` |
| A screen push or pop | `ViewLayer` | `apps/web/src/components/ViewLayer.tsx` |
| The splash to shell handover | `PhaseHost`, with the orb and wordmark as view-transition pairs | `apps/web/src/components/PhaseHost.tsx` |
| A disclosure opening | `revealDisclosure` (opacity and 4 px, space claimed at once) | `apps/web/src/lib/motion.ts` |
| Key caps and key hints | `.keys-only`, hidden where the primary pointer is coarse | `apps/web/uno.config.ts` |
| A scroller with rows below its edge | `.scroll-fade` plus `data-more` set from its own scroll geometry | `apps/web/uno.config.ts` |
| A small control on touch | an `after:` press area of 44 px, as `btn` carries | `packages/quicksilver/src/preset.ts` |

## Press and focus

- Buttons register on pointer down with zero ramp (`active:duration-0 active:scale-[0.97]` in
  `btn-chrome`) and ease back on release. Hover deepens a filled control.
- `focusable` and `focusable-inset` draw the ring; a row's highlight is its focus indicator,
  so the row does not draw both.
- A list has exactly one cursor: hover moves it, `j`/`k` move it, and both are DOM focus.

## What to check first

The classes of gap a review here finds most often: an overlay that animates on a
high-frequency path, a figure without `tabular-nums`, a busy control made `disabled`, a
colour or grey that is not on the ramp, a state that changes size, and a screen only ever
seen with friendly data.
