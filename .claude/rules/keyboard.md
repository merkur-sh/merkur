---
paths:
  - "packages/keyboard/**"
  - "apps/web/src/terminal/virtual-keyboard.ts"
  - "apps/server/src/**/keyboard*"
---

# Keyboard settings ownership

`packages/keyboard` holds the on-screen keyboard, layouts, DOM bindings, touch model, the
passive offset learner (grip field + per-key residuals, fed confident taps and the user's
own corrections), and the input-stream correction analysis. `fallow` treats it as public,
so its exports are not pruned. The keyboard's configuration is split by ownership: the
*arrangement* (quick-access toolbar, named macro definitions, and layer key order) is an
account fact synced through the server, while everything a device measured about itself
(learned offsets, typing diagnostics, key preview, whether the keyboard is shown) stays
local. The line is drawn in
one place, `accountKeyboardSettings` in `apps/web/src/terminal/virtual-keyboard.ts`; do not
widen it without a reason a second device would agree with.
