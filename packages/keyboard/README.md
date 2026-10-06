# `@merkur/keyboard`

A framework-independent, geometry-driven on-screen keyboard. Rendering and hit testing
share one layout model; pointer movement never queries DOM layout or scans DOM nodes. The
package exports `createKeyboardLayout` from `@merkur/keyboard`, the DOM adapter
`createDomKeyboard` from `@merkur/keyboard/dom`, the bundled
`@merkur/keyboard/layouts/terminal-us` layout and the `@merkur/keyboard/cupertino.css`
stylesheet.

## Defining a layout

Layouts are data, not components. Each layer selects a column count and places keys with
fractional `column` and `span` values:

```ts
import { createKeyboardLayout } from '@merkur/keyboard';

const layout = createKeyboardLayout({
  id: 'my-layout',
  initialLayer: 'main',
  keys: {
    deploy: {
      id: 'deploy',
      label: 'deploy',
      kind: 'action',
      action: 'deploy',
      variant: 'accent',
    },
  },
  layers: {
    main: {
      id: 'main',
      columns: 4,
      rows: [{ keys: [{ key: 'deploy', column: 0.5, span: 3 }] }],
    },
  },
});
```

`createKeyboardLayout` validates placement references, map/id consistency, required key
metadata, repeat configuration, per-layer key limits, bounds, duplicates and overlap before
the layout reaches the input engine. A layer key's `targetLayer` is required but is not
checked against the layer map, so persisted or untrusted layouts should validate that
relationship too.

## Using the DOM adapter

```ts
import { createDomKeyboard } from '@merkur/keyboard/dom';
import { TERMINAL_US_LAYOUT } from '@merkur/keyboard/layouts/terminal-us';
import '@merkur/keyboard/cupertino.css';

const keyboard = createDomKeyboard(element, {
  layout: TERMINAL_US_LAYOUT,
  // Build inactive layers during idle periods so their first switch is immediate.
  prewarmLayers: true,
  behavior: {
    preview: 'keycap',
  },
  onKey: (key, value) => send(key, value),
});

keyboard.setModifiers(['ctrl']);
keyboard.setLayer('pc');
keyboard.destroy();
```

At least one of `onKey` or `onKeyCommit` is required. `onKey` delivers only the semantic
key and value and keeps the production path allocation-free through recognition and
dispatch. `onKeyCommit` adds pointer coordinates, hold duration, layer and repeat metadata
at the cost of one commit object per key. The controller can replace its layout, geometry
profile, behaviour, active modifiers and theme, toggle visibility and refresh geometry
without being recreated.

## How a tap is decided

The keyboard has one character-recognition path, and it decides each contact as early as
it soundly can rather than always waiting for the lift.

A key is decided at **touch-down** when the contact lands inside that key's anchor, the
middle quarter of its area, and the key produces a single character. Keys that are not one
recoverable character are excluded on purpose: a wrong letter costs one Backspace, whereas
Enter runs the command line and has no undo, so Enter, Tab, Escape and the navigation keys
wait for the release. Controls that declare `activation: 'press'` (Backspace, the
modifiers, the layer switches) commit at touch-down.

Everything else is decided at **release**, scoring the nearest four candidates in
continuous coordinates against a Student-t spatial model.

Characters commit in **press order, not release order**, so a lingering thumb during a
two-thumb rollover cannot transpose two characters. Nothing is buffered to achieve that.
When a contact is ready to commit, any contact that pressed earlier and is still undecided
is resolved first, from wherever its finger currently sits; waiting never produces a better
decision for that older contact, only a later one. A contact still down past 250 ms has
outlasted essentially every real tap, so it is treated as a resting thumb: it yields its
place in the order and keeps its own release decision.

A tap is anchored to where the finger landed, not to where it lifted. A finger pivots as it
leaves the glass, so the release point carries a roll-off bias while the contact point
still marks the aim. The bundled Cupertino profile therefore sets `releaseWeight` to zero,
and a tap is decided by contact plus path. How much the release point matters ramps with
how far the finger travelled while down: the profile weight up to `tapDrift`, rising
smoothly to release-only at `slideDrift`, so a deliberate slide onto another key is still
decided by where it ended. `slideDrift` is three key pitches, which keeps one-, two- and
three-key slide-to-correct landing.

## Context prior

`setKeyPrior` supplies the causal probability of every key given the text committed so
far. It is added to the spatial score in log space, the standard
`argmax_k p(key | history) · p(touch | key)` decomposition, and weighted by the profile's
`priorWeight`. The weight is deliberately low (0.25 in the Cupertino profile): a stronger
prior overrides the touch and types what the language model expects instead of what was
pressed.

Two invariants make it safe on a surface where bytes reach a PTY irrevocably:

- **Anchoring.** Inside a key's anchor the prior is not consulted, so a tap on a key always
  types that key however unlikely the context makes it. Gunawardana, Paek and Meek
  (IUI 2010) show this guarantee needs a truncated-support touch model; a Student-t has
  infinite support, so it is enforced as an explicit short circuit rather than left to the
  score.
- **Stepping aside.** A key with no language statistics carries `NaN`, and one such
  candidate disables the prior for that tap. There is no honest probability for Backspace:
  a high guess lets the prior turn a letter into a destructive key, a low one does the
  reverse.

The prior is indexed by key, so a layer change clears it and the owner must set a fresh one
for the layer it switched to.

## Learned offsets and privacy

Two things read `onTouchTrace` during ordinary use, and both keep **aggregates only**:
per-key running sums and histograms, folded in and discarded. No keystroke sequence, no
ordering and no timestamps are retained, so the stored state can answer "where does this
key get hit on average" and cannot reconstruct what was typed. That is what makes it safe
to leave running. The one ordered thing is the line being typed, held in memory until it
ends (Enter, any other key that types no character, input from outside the keyboard) so
its corrections can be analysed, and wiped when it does.

- **Learned offsets** (`src/offset-model.ts`). Most people tap consistently to one side of
  a key, and correcting that costs nothing in risk because it uses no language context. The
  model is hierarchical: a linear grip field over normalised board position, pooled across
  keys and layers so a rarely typed key inherits the shared component of the bias, plus
  per-key residuals for what the field cannot express. Learning from your own output is
  normally unsound, because recording a mis-committed key pulls that key toward the
  mistake, so the learner only accepts taps whose commit is not in doubt: inside the anchor
  around the current combined prediction, or inside the visual-centre anchor where the
  decoder's own anchor-commit guarantee applies. Updates are residuals from the current
  prediction, an EM iteration whose fixed point is the true offset, converging from a
  biased first step and unable to diverge. The other source is the user: a tap they erased
  and replaced with a neighbour of where it landed is labelled with the key they meant
  (`recordCorrection`), and a label they gave needs no window, only the same clamps. Those
  are exactly the boundary taps the windows reject.
- **Corrections** (`src/input-stream.ts`). Input-stream error analysis (Wobbrock and Myers,
  TOCHI 2006) over each finished line, with the final line standing in for the presented
  string: which erased taps were misses and what was meant, however many letters later the
  mistake was noticed, which were right and erased on the way, and which were extra or
  skipped. A replacement is a misread only when it lies among the four keys nearest the
  contact; elsewhere it is a change of mind. The trace's `spatialKey` then says whether
  the finger or the context prior made each miss.
- **Diagnostics.** Contact-to-release travel, contact duration, movement-free tap rate and
  per-key spread, for deciding whether the thresholds above are right for a given device,
  and the correction counts above per key.

## Geometry profiles and theming

Pass a `KeyboardGeometryProfile` or a resolver that selects one from viewport width, pixel
ratio and orientation. Profiles control padding, gaps, key height, corner radius, touch
hysteresis, `tapDrift`, `slideDrift`, `releaseWeight`, `priorWeight` and the maximum number
of simultaneous pointers. `bottomUtilityHeight` stays visually outside the key surface but
extends the bottom row's invisible hit targets downward, so low Space taps register through
the utility rail without moving or resizing the keycaps.

`KeyboardTheme` maps to CSS custom properties. Applications may also override the
`--merkur-keyboard-*` variables directly on `.merkur-keyboard`, including backgrounds,
label sizes, system font, shadows, active colours and pressed colours.

## Performance contract

Event listeners are delegated once on the keyboard root. Pointer events use scalar engine
methods backed by fixed typed-array slots; candidate generation is one bounds check and one
top-four atlas lookup, and final recognition scores those four candidates. Resolved
geometry and atlases are cached per layer until the layout, width, pixel ratio or profile
changes; `prewarmLayers` builds inactive layers one at a time during idle periods. Key
buttons and `keycap` previews are pooled DOM nodes whose state changes mutate attributes
only, so the pointer path allocates no package-owned objects and enters no framework's
reactive graph.

The offset learner caches visual centres, normalised positions, pitches and clamps once
per resolved geometry, with weak ownership. Each accepted tap updates the same field and
per-key residual state without creating a key-search closure or a bounds object. Applying
learned offsets returns independent centre arrays and shares the base precision arrays.

## Benchmarks and accuracy tooling

```sh
bun run --cwd packages/keyboard bench
bun run scripts/bench-keyboard-hotpaths.ts
bun run --cwd packages/keyboard simulate:accuracy
bun run simulate:keyboard-replay
```

The first runs the structured engine, multitouch, geometry and virtual-dispatch
benchmark; it is also the `web/virtual-keyboard-input` workload of the project profiler.
The second runs deterministic synthetic gesture families, hard-atlas comparisons,
confusion pairs and per-layer/orientation accuracy. It is development-only and not part of
the browser package; treat its absolute figure as a regression signal, because it draws
synthetic taps from a distribution and scores them with a decoder that assumes a related
one. For accuracy work use the third, `scripts/run-keyboard-replay.ts`, which replays a
corpus of real human taps with known intent through swappable decoders on this package's
own geometry; the anchor, release ramp, prior weight and learner constants are all chosen
against it.

The package-only hot-path benchmark separates atlas hit testing, anchored and unanchored
classification, release-weighted slides, ordinary and corrected learning, model application,
and an engine tap with learning and model application every 25 taps. It emits batched
p50/p95/p99 CPU times and three control-corrected live JSC cell censuses. Small constant
census noise is visible rather than rounded away; these counts measure allocations before
collection, not retained memory or allocated bytes. `BENCH_STAGE` selects one workload,
`BENCH_SAMPLES` and `BENCH_BATCH_SIZE` set the timing batches, and `BENCH_CPU=1` runs the
sampling profiler separately from timing. Run comparative timings without concurrent
builds or tests. These Bun/JSC results do not measure DOM dispatch, browser presentation or
on-device latency.

`src/hotpaths-replay.test.ts` pins baseline digests from deterministic differential replays
across every bundled layer, portrait and landscape sizes, correlated spatial precisions,
prior guards, visual anchor boundaries, corrections, restore/reset and two-thumb rollover.
The digests include learning decisions and intermediate model state, not just final text.

For device-side latency profiling pass `onPerformanceSample`. It reports cold and idle
geometry builds, pointer-down/up handler duration and input delay, and the time from an
accepted pointer-down to the next presentation opportunity. The callback is absent from
the pointer hot path when it is not supplied.
