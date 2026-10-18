---
name: polish-pass
description: Run a polish pass on one Merkur screen or component the way Linear runs its weekly quality slot - photograph it in every state, list the small imperfections (a label that shifts, a spinner that flashes, a clipped focus ring, a jittering figure, a grey off the ramp, a bounce on a frequent path), fix each that takes minutes, and prove every fix in a before-and-after screenshot. Use when asked to polish, tighten, refine, finish, or find what is subtly wrong with a screen or control in apps/web or apps/site. The standard it checks against is the premium-ui skill; motion critique goes to review-animations, worst-case data to break-ui, bugs to ordinary debugging.
---

# Polish pass

A polish pass finds the small imperfections that make an interface feel unfinished and fixes
them while they are small. The standard is the `premium-ui` skill and its `CHECKLIST.md`;
read both first. Scope is one screen or one component per pass.

## 1. Capture every state

Photograph the surface before changing anything. Each state at 390 px, at the 461 px frame
breakpoint and at desktop width:

- rest, hover, `:focus-visible` from the keyboard, pressed;
- busy, error, success or outcome, disabled;
- empty, one item, many items, worst-case data (`break-ui`);
- entering and leaving, recorded or sampled per frame;
- reduced motion on.

Two ways to drive it:

- **The running app.** `bun run dev`, then Playwright against `http://127.0.0.1:3000/` (the
  delegation certificate is bound to that origin, not `localhost`), from a script whose
  `node_modules` resolves to the repository's so its Playwright and browsers are used.
- **A component page.** A scratchpad Vite page that imports the real component through
  `apps/web/vite.config.ts` with `MERKUR_BACKEND_ORIGIN` set to any unreachable origin, served
  from the scratchpad over `/@fs`. It needs no server stack and runs in Chromium, Firefox and
  WebKit.

The owner's engines are Zen (Gecko) on macOS and the iPhone PWA (WebKit): every pass covers
Firefox and WebKit, not Chromium alone.

## 2. Measure what eyes miss

- **Layout shift.** Read each element's `getBoundingClientRect()` in every state; any change
  to a neighbour is a finding.
- **Flashes and frame order.** Sample per frame with `requestAnimationFrame` from the moment
  of the input. Await a few microtasks first, or the sampler reads the frame before the
  animation's first write.
- **Timing.** Time from input to first visible change and to the end state; compare with the
  checklist's thresholds.
- **Motion.** Record at full speed and slowed; compare against `review-animations`.

## 3. List findings

One row each, ranked by the checklist's order (Instant, Steady, Caused, Quiet, Exact):

| # | Seen (state, engine, width) | Rule | Fix, with exact values | Size |
| --- | --- | --- | --- | --- |

Size is the honest estimate to fix and prove it. A finding that turns out to need a design
change or a cross-cutting refactor is reported to the owner with its evidence rather than
squeezed into the pass.

## 4. Fix and prove

- Fix in the order of the list, reusing the house components and values in
  `premium-ui/QUICKSILVER.md`; a new mechanism for a solved problem is itself a finding.
- Re-capture the same state, engine and width after each fix and compare it with the before
  shot. A fix without its after shot is not done.
- Run the gate the frontend rule names for the files touched (`bun test apps/web`; worker,
  display or render-path changes also `test:e2e:latency`), and the one e2e spec that drives a
  changed interaction.

## 5. Report

Open with the answer: how many findings, how many fixed, what is left and why. Then the
table with each fix's before and after, the gates run, the engines covered and the gap to
the owner's devices if the iPhone was not tested.
