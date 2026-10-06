---
paths:
  - "apps/web/**"
---

# Web app

This is SolidJS, not React. Use Solid primitives and the existing controller patterns.
Keep rendering off the main thread: `terminal-worker.ts`, WASM, and WebGPU own it. The
main thread owns UI and input capture; transport, terminal, and telemetry workers own
everything latency-sensitive. Browser hot-path modules (the list in
`scripts/check-latency-boundaries.ts`) must not import `effect`.

- Keep Effect fibers in controllers and hooks interruptible; stop functions must abort
  controllers and interrupt fibers. The web app uses Effect for async API wrappers, SSE,
  reconnect loops, fiber cleanup, and the Atom-backed device-event lifetime.
- Preserve the reactive boundary: the resilient device-event stream and its cached
  list/status/boot state live in Effect Atom, read through the in-repo bridge in
  `apps/web/src/lib/atom-solid.ts`; other screen and terminal controller state uses Solid
  signals. Upstream `@effect/atom-solid` is unusable here: it is built on
  `createComputed`, `createResource`, and `Context.Provider`, all removed in Solid 2, and
  its peer range excludes 2.x.
- Service worker, installed-PWA behavior, push, and notification permissions have
  security and UX implications; exercise them with browser flows when changed.
- Preserve current UnoCSS/Vite/Solid conventions unless the task is explicitly a larger UI
  change.
- Gate: `bun test apps/web`; worker, prediction, display, or render-path changes also
  need `test:e2e:latency`.
