---
name: premium-ui
description: What makes an interface feel premium (instant, steady, caused, quiet, exact) and how to build it in Merkur's web app and site on Quicksilver. Use when asked to make UI feel smooth, polished, premium, expensive, nice to use or "like Linear"; when building or reviewing a screen, control, loading, empty or error state, or a colour, type, depth or density decision; or when choosing a component or effect from 21st.dev, Magic UI, Aceternity, shadcn, motion-primitives, interior.dev, Annnimate or a similar collection. Motion mechanics (curves, springs, gestures, frame budget) are in the animate, emil-design-eng, apple-design and animation-performance skills; this skill decides whether and how much, and covers everything that is not motion.
---

# Premium UI

A premium interface costs the user nothing to operate, and nothing on it happens without a
cause. People call that smooth, and they mean five measurable properties:

| Property | It means | The test |
| --- | --- | --- |
| Instant | Feedback lands before the user can wonder | Visible response ≤ 100 ms, result ≤ 400 ms, no spinner for work under 500 ms |
| Steady | Nothing shifts, flashes or jitters | Every state occupies the box of the largest one; figures are tabular |
| Caused | Every movement answers an input or a change of fact | No ambient loops in the app; motion runs only for something the user did or the system learned |
| Quiet | Structure recedes; emphasis is earned | Fewest lines, low-alpha borders, dim chrome, one accent, one display moment per screen |
| Exact | Details agree to the pixel | Concentric radii, optical alignment, tracking by size, 44 px touch targets, a complete keyboard path |

Decoration is not on the list. The collections that dominate "beautiful UI" sell landing-page
effects; applying them to a product is the most common way an interface starts to look like
a template (see [LIBRARIES.md](LIBRARIES.md)).

## The rules

1. **Nothing waits that does not have to.** Writes are optimistic and roll back in place on
   failure. Work is pre-warmed: fonts inlined, routes mounted behind `ViewLayer`, intent
   prefetched. Merkur's speculative echo is this rule at its limit; the UI chrome must not
   be slower than the terminal it frames.
2. **Motion is inverse to frequency.** Decide the tier before the curve:

   | Used | Examples | Motion budget |
   | --- | --- | --- |
   | Hundreds of times a day | command palette, list cursor, `j`/`k`, keyboard actions, tab switches | None, or a colour change; never a spring |
   | Daily | dialogs, sheets, menus, settings tabs | ≤ 250 ms, no bounce on navigation, exits shorter than entrances |
   | Occasionally | first run, a rare success, a destructive confirm | Room for a considered moment |
   | Once | the landing site | Showy is allowed, and still interruptible and reduced-motion safe |

3. **Every state reserves its space.** Busy labels, errors, copied/selected outcomes and
   skeletons occupy the final layout's box from the first frame, so changing state moves
   nothing else.
4. **Every interaction has a complete lifecycle.** Start, progress, commit, and a cancel for
   every way it can be abandoned: release, pointer leaving, blur, Escape, unmount, a hidden
   tab. The keyboard is a second full implementation, not an afterthought.
5. **Structure stays quiet.** Separate with space and surface steps before lines; a line
   that remains is low-alpha white. Inactive chrome is dimmer than content. Colour carries
   state, never decoration.
6. **Colour and depth come from one perceptual model.** Lightness steps are even in
   perceived lightness (OKLCH or L*), contrast is stated per pairing, and elevation in the
   dark is a lighter surface plus a lit top edge, with shadows as support.
7. **Exactness is cheap and compounding.** Tabular figures for anything that changes or lines
   up, tracking that tightens as size grows, concentric radii, balanced headings, optical
   ±1 px corrections, focus rings that nothing clips.
8. **States are designed, not defaulted.** Loading, empty, sparse, dense, error and success
   each get a deliberate design; the worst-case data is rendered before the screen ships
   (`break-ui`).
9. **Polish is a habit.** Small imperfections are found and fixed continuously, each in
   minutes; the `polish-pass` skill is the procedure.

## Deciding a change

1. **Name the frequency tier** and therefore the motion budget.
2. **Name the cause.** If nothing caused it, it does not move.
3. **Choose the cheapest honest feedback**, in this order: a state change in place, a
   colour change, opacity, transform. Layout properties never animate.
4. **Reserve the space** for every state the element can enter.
5. **Write the lifecycle** with every way in and every way out, pointer and keyboard.
6. **Hand the mechanics to the motion skills** when something moves (table below).
7. **Check the result** against [CHECKLIST.md](CHECKLIST.md) in screenshots of each state, at
   phone width and desktop, with reduced motion on.

## Which skill does what

| Need | Skill |
| --- | --- |
| Should this animate; curve, duration, spring, exit | `animate`, `emil-design-eng` |
| Drag, swipe, sheets, momentum, rubber-banding | `apple-design` |
| Dropped frames, which property to animate, `will-change` | `animation-performance` |
| Critique of motion code | `review-animations` |
| Where motion is missing | `find-animation-opportunities` |
| A codebase-wide motion audit | `improve-animations` |
| Phone feel: tap highlight, 100vh, input zoom, PWA | `mobile-native` |
| Worst-case data | `break-ui` |
| Naming an effect | `animation-vocabulary` |
| Finding and fixing small imperfections on one screen | `polish-pass` |

## References

- [QUICKSILVER.md](QUICKSILVER.md): where each rule already lives in Merkur, the house
  components to reach for, and the values to reuse. Read before writing UI code here.
- [CRAFT.md](CRAFT.md): the non-motion craft with numbers and sources: perceived speed,
  typography, colour and depth, shape and detail, states, haptics and sound.
- [LIBRARIES.md](LIBRARIES.md): the component collections, which of their patterns belong in
  a product and which on a landing page, and the tells of a template.
- [CHECKLIST.md](CHECKLIST.md): testable rules in order of impact, for building and review.

## Review output

When reviewing a screen, report findings as a table: what was observed (with the screenshot
or state it was seen in), the rule it breaks, the fix with exact values, and its size. Lead
with whatever breaks Instant or Steady; those are felt on every use.
