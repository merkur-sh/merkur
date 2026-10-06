---
paths:
  - "apps/daemon/dataplane/src/pty/**"
  - "apps/daemon/src/cli/shell-integration.ts"
  - "apps/daemon/src/config.ts"
  - "apps/web/src/terminal/**prediction**"
  - "packages/term-wasm/**"
---

# Speculative local echo is a security boundary

Painting a character the remote never echoes is a correctness bug; painting one during a
password prompt is a disclosure bug. Read `docs/security.md` (Speculative Echo And The
Prompt Boundary) before touching any gate.

- Three gates must all hold: an open shell-editor boundary (`OSC 133;B` or bracketed-paste
  enable), a kernel termios sample that fails closed on a canonical no-`ECHO` read, and the
  foreground process group belonging to the spawned shell.
- An *authenticated* boundary, `OSC 133;B;merkur=<token>`, compared in constant time
  against the 128-bit value the daemon persists at `~/.merkur/shell-token` and exports as
  `MERKUR_SHELL_TOKEN`, relaxes exactly the third gate so prediction works under a
  multiplexer. It is never a skeleton key for the other two, and the alternate screen is
  deliberately no longer consulted anywhere in this decision.
- Enter is excluded on purpose: predicting it would set the `shadow_modelled` bit that
  suppresses the daemon's pre-emptive `observe_user_input` revocation. The daemon enforces
  it (`record_is_modelled`), and judges whether input leaves the line editor from the
  record's legacy encoding (`record_leaves_line_editor`), never from the bytes an
  application's keyboard mode chose.
- `shell-integration` emits the rc snippet carrying the prompt-boundary token; VTE owns
  synchronized-output evidence and canonical shell-boundary callbacks below application
  buffering. Never restore a parallel raw ANSI scanner for speculative authority.
