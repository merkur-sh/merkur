# Component collections

The collections that rank highest for "beautiful UI" mostly sell effects for pages seen once.
The ones that feel premium in daily use are few, and they share their implementation habits.
Read this before lifting a component from any registry, and port the behaviour into Solid
and Quicksilver rather than the markup.

## The collections

| Collection | What it is | Use in the app |
| --- | --- | --- |
| [Sonner](https://github.com/emilkowalski/sonner) | Toast stack. CSS transitions only (`transform` 400 ms `ease`, 200 ms exit), 4 s life, pauses on hover and while `document.hidden`, swipe dismiss at 45 px or by velocity, all motion off under reduced motion | The model for any notice stack |
| [Vaul](https://github.com/emilkowalski/vaul) | Drawer. 0.5 s on `cubic-bezier(0.32, 0.72, 0, 1)`, velocity dismiss at 0.4, close at 25 percent of height, damped overdrag, `translateY` written to the element directly | The model for sheets; `Sheet` follows it |
| [cmdk](https://github.com/pacocoursey/cmdk) | Unstyled command menu with filtering, keywords and async items, fine to about 2–3 thousand items | The model for the palette; open it without an animation |
| [interior.dev](https://www.interior.dev/) | Micro-interactions: loading button, hold to confirm, tooltip group, slider detents, segmented control, copy button | All app-grade; its rules (every state reserves its space, every abandonment is handled, the keyboard is a full second implementation) are the bar |
| [shadcn/ui](https://ui.shadcn.com/docs/components), [coss ui](https://coss.com/ui) | Accessible primitives on Radix, Base UI or React Aria | Behaviour reference for dialogs, menus, comboboxes, drawers |
| [motion-primitives](https://motion-primitives.com/docs) | Morphing popover and dialog (shared layout, spring bounce 0.1, 0.4 s), sliding highlight, text morph, sliding number | Selected pieces, for occasional actions only |
| [Cult UI](https://www.cult-ui.com/docs) | Family-style drawer and button, direction-aware tabs, plus textured buttons and shaders | Mixed: the drawers and tabs, not the textures |
| [Magic UI](https://magicui.design/docs/components) | Border beam, shine border, shimmer button, marquee, dock, globe, bento grid, number ticker, many text effects | Number ticker for a value that really changes; the rest is landing-page material. Its border beam is a permanent JS loop and ignores reduced motion |
| [Aceternity UI](https://ui.aceternity.com/components) | Aurora, vortex, lamp, meteors, spotlight, 3D and tilt cards, scroll-driven heroes | Site only, sparingly; animated tabs and stateful button are the app-grade exceptions |
| [21st.dev](https://21st.dev) | Community registry of thousands of shadcn components; its most installed items are scroll heroes, spline scenes and spotlight cards | Treat as a catalogue of what has become the template look |
| [Annnimate](https://annnimate.com/animations) | GSAP library, mostly scroll-triggered sections, shaders and experimental pieces | Site only; morphing list is the one app candidate |
| [React Bits](https://github.com/DavidHDev/react-bits), Animata, Skiper UI | Text effects, WebGL backgrounds, widgets | Site only, if at all |

## Patterns, by where they belong

| Pattern | Where | Why |
| --- | --- | --- |
| Toast stack | App | Interruptible, pauses when hidden, swipeable |
| Sheet or drawer | App | Gesture-driven, velocity dismiss |
| Command menu | App, unanimated | Opened hundreds of times a day |
| Sliding tab or segment indicator | App | Shows where the selection went; 150–250 ms, no bounce |
| Morphing popover | App, occasional actions only | Shows origin; too slow for frequent ones |
| Hold to confirm | App | Proportionate friction for destruction |
| Tooltip group | App | First waits, the rest are instant |
| Fixed-width loading button | App | Status without layout shift |
| Slider detents | App | A physical process with stops |
| Number ticker | App when the value changes live | Counting up on scroll-in is decoration |
| Progressive blur at a scroll edge | App, watching cost | Calm edge; blur is expensive |
| Confetti, like burst | App for rare successes only | Delight wears out with frequency |
| Bento grid, marquee, logo cloud | Site | Layouts for selling, not for working |
| Text reveal, blur-in, split text | Site | Seen once, delays reading |
| Spotlight, glow card, border beam, shimmer button | Site, one at most | Ambient motion pulls attention to nothing |
| Aurora, meteors, particles, shader backgrounds | Site | GPU cost with no information |
| Scroll-hijacking heroes | Site, with care | The most templated look on the web |
| Dock magnification | Avoid | Targets move under the pointer |
| 3D tilt, wobble, glare cards | Avoid | Reads as cheap almost everywhere |
| Typewriter or scramble on real content | Avoid | Delays reading |

## What the best implementations share

- **Interruptible.** CSS transitions or springs that retarget mid-flight; keyframes only for
  loops and one-shot entrances.
- **Compositor-only.** `transform` and `opacity`; a value written to the element itself, not
  through an inherited custom property that restyles every child (Vaul's measured fix).
- **Short and asymmetric.** Under 300 ms for UI; exits shorter than entrances; ease-out on
  enter and exit, never ease-in.
- **Low bounce.** Bounce near 0 for anything that navigates; a trace (0.1–0.25) only for a
  surface that lands.
- **Origin-aware.** Popovers grow from their trigger; nothing scales from 0 (start at about
  0.95).
- **Frequency-gated.** No animation on keyboard-initiated or high-frequency actions.
- **Reduced motion keeps the information.** The change still happens, as an instant switch or
  a fade; only the travel goes.
- **State hygiene.** Timers pause when hidden, gestures cancel on blur, pointer capture is
  managed, space is reserved.

## The template tells

An interface reads as generated when it has several of these:

- Ambient motion on static elements: beams, shimmers, marquees, pulsing badges.
- Glow, spotlight and gradient borders on every card, over a dark grid or aurora.
- Gradient text on headings.
- Fades of 600 ms or more; staggered blur-in on every paragraph; reveal on every scroll.
- Scale from 0, or from the centre when the trigger is a corner.
- Bouncy springs on menus, modals and navigation.
- Animated dropdowns, palettes and list hovers.
- Custom cursors, cursor followers, tilt.
- No reduced-motion path.
- A registry component used unchanged, recognisable on sight.
