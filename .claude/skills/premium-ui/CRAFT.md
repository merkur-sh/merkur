# The craft that is not motion

Values here come from the cited pages. Where a figure is practitioner convention rather than
a published source, it says so.

## Perceived speed

| Threshold | Meaning | Source |
| --- | --- | --- |
| 100 ms | Feels instant; the result is its own feedback. Handle input within 50 ms to land it | [Nielsen](https://www.nngroup.com/articles/response-times-3-important-limits/), [RAIL](https://web.dev/articles/rail) |
| 400 ms | Doherty threshold: past it, attention starts to leave | [Laws of UX](https://lawsofux.com/doherty-threshold/) |
| 1 s | Flow holds; no special indicator needed | Nielsen |
| 10 s | Attention is gone; show progress, an estimate and a way out | Nielsen |
| 10 ms | Frame work, of a 16 ms budget at 60 Hz | RAIL |

**Loading indicators.**
- Show nothing for work under about 500 ms. Once shown, keep an indicator at least about
  200 ms so it never flashes ([spin-delay](https://github.com/smeijer/spin-delay); Vercel's
  guidelines give 150–300 ms and 300–500 ms).
- A skeleton fits a whole page. It has to match the final layout exactly; one that shows
  only the frame is worse than nothing.
- A labelled spinner suits a single module waiting 2–10 s. Past 10 s, use a progress bar
  with an estimate ([NN/g](https://www.nngroup.com/articles/progress-indicators/)).
- Users shown a looping indicator waited about three times longer than users shown none.

**Removing the wait.**
- Update optimistically for toggles, renames, adds and deletes, and roll back in place with
  the error beside the thing that failed.
- Linear keeps a full local replica: writes change memory first, then go out as batched,
  reversible transactions ([reverse-engineered, endorsed by Linear's CTO](https://github.com/wzhudev/reverse-linear-sync-engine)).
- Prefetch on intent: [instant.page](https://instant.page/) fetches after 65 ms of hover,
  the point where a click is 50 percent likely, and gains about 300 ms.
- Pre-warm surfaces before showing them. Raycast keeps its window rendered at zero alpha so
  showing it costs nothing ([Raycast](https://raycast.com/blog/a-technical-deep-dive-into-the-new-raycast)).

## Typography

- **Tracking tightens with size.** Inter's dynamic metrics give about 0 at 12 px,
  −0.011em at 16 px, −0.02em at 24 px and above; small caps and eyebrows open up instead.
- **Optical sizing.** A face with an `opsz` axis draws sturdier shapes at text sizes and
  finer ones at display sizes. Linear pairs Inter Display for headings with Inter for
  everything else ([Linear](https://linear.app/now/how-we-redesigned-the-linear-ui)).
- **Figures.** `tabular-nums` for anything that changes or aligns, so digits do not jitter;
  `slashed-zero` where 0 and O can be confused (codes, IDs).
- **Wrapping.** `text-wrap: balance` on headings (Chromium balances up to 6 lines),
  `text-wrap: pretty` on short body copy to avoid orphans.
- **Leading.** About 1.3 to 1.5 for body text, falling toward 1.1 for display sizes.
- **Smoothing.** `-webkit-font-smoothing: antialiased` makes light-on-dark text lighter and
  crisper on macOS; it is the norm for dark UI.
- **Characters.** Curly quotes, a real `…`, non-breaking spaces in `10 MB` and `⌘ K`
  ([Vercel guidelines](https://vercel.com/design/guidelines)).

## Colour and depth

- **Perceptual space.** In OKLCH, equal L looks equally light across hues; HSL does not.
  Linear generates each theme from three inputs (base, accent, contrast) in LCH, replacing
  98 hand-set variables, and derives the elevation levels from the same model.
- **Contrast in the dark.** WCAG 2 ratios overstate contrast near black. APCA targets: Lc 90
  preferred and 75 minimum for body text, 60 for other content, 45 for headlines, 30 for
  placeholder and disabled text, 15 for dividers and focus outlines
  ([APCA](https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell)).
- **Elevation.** On a dark ground shadows barely read, so higher surfaces are lighter.
  Material's dark theme lightened by about 5 percent at the first level and 16 percent at
  the top. A 1 px inner top highlight of white at about 6 percent gives a control its body
  (practitioner convention).
- **Shadows.** One light source, layered: three or more stacked shadows with y twice x,
  larger and fainter as elevation rises, tinted toward the ground rather than pure black;
  never animate a layered shadow ([Josh Comeau](https://www.joshwcomeau.com/css/designing-shadows/)).
- **Quiet structure.** Linear's refresh cut separators that had multiplied, softened the
  ones left, dimmed the sidebar and shrank icons: "structure should be felt, not seen"
  ([Linear](https://linear.app/now/behind-the-latest-design-refresh)).
- **Grain.** Noise hides gradient banding: `feTurbulence` fractal noise, 3–4 octaves,
  frequency 0.6–1.0, opacity 0.2–0.4; past 0.5 it reads as static. It paints once, so it
  must not sit under anything that repaints.
- **Blur.** `backdrop-filter` cost grows with blurred area, radius and count; one large blur
  per scrolling card is a known frame cost on older hardware.

## Shape and detail

- **Continuous corners.** `corner-shape: superellipse()` gives the machined corner; it needs
  a non-zero `border-radius` and is a progressive enhancement, so the fallback arc must look
  right on its own. Check browser support before depending on it.
- **Concentric radii.** Inner radius = outer radius − padding − border; a pill inside a pill
  takes a full radius instead.
- **Targets.** 24 × 24 CSS px minimum (WCAG 2.5.8), 44 × 44 on touch.
- **Focus.** `:focus-visible` rings at least 2 px (3 px if inset) with a 3:1 change against
  the unfocused state; nothing may clip or cover them.
- **Inputs on iOS.** 16 px text or larger, or Safari zooms the page.
- **Scrollbars.** `scrollbar-color` for thumb and track at 3:1; `scrollbar-gutter: stable`
  where a scrollbar appearing would shift layout.
- **Alignment.** Align to a grid, baseline or optical centre, with ±1 px optical corrections;
  check at 50 percent zoom.

## States

- **Empty.** Never a blank container, and never "nothing here" while still loading. Say
  what the place is for and give the one action that fills it
  ([NN/g](https://www.nngroup.com/articles/empty-state-interface-design/)).
- **Error.** Beside what failed, in words plus a glyph or colour, keeping what the user
  typed, saying how to fix it, without blame. A modal only for something severe. Focus
  moves to the first error ([NN/g](https://www.nngroup.com/articles/error-message-guidelines/)).
- **Busy.** The control says what it is doing, in its own cell, and keeps focus.
- **Success.** Quiet and brief: the changed thing itself is the confirmation; a toast only
  for what happened out of view.
- **Destructive.** Undo where it can exist; otherwise a confirm whose friction is
  proportionate, such as a hold, released on every exit.
- **Forms.** Enter submits, ⌘/Ctrl+Enter from a textarea; never pre-disable submit; paste is
  never blocked.

## Haptics and sound

- The Vibration API does not exist in Safari on any platform, so iOS web apps have no
  sanctioned haptics. Treat haptics as absent on the owner's iPhone PWA.
- UI sound, where used, belongs to specific events (invoke, overlay show and hide,
  navigation), never to hover, varies the most frequent sound, never exceeds system volume
  and can be turned off ([Microsoft](https://learn.microsoft.com/en-us/windows/apps/design/style/sound)).
  Off by default is practitioner convention.

## Process

- Linear runs a weekly slot for small imperfections, each fixed in 30 minutes or less, and
  shipped over a thousand in two years; bugs have a fix deadline set by severity
  ([Quality Wednesdays](https://linear.app/now/quality-wednesdays)).
- Review your own work the next day, at full speed and in slow motion, and on the real
  device (`emil-design-eng`).
