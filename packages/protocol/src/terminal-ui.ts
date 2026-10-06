/**
 * Typed UI state/effects; never terminal escape bytes. Mirrors
 * merkur-wire::terminal_ui, whose decoder is the one place their limits are
 * enforced.
 */
export type TerminalUiEffect =
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'bell' }
  | { readonly kind: 'notification'; readonly title: string; readonly body: string }
  | { readonly kind: 'clipboard'; readonly selection: 'c' | 'p'; readonly text: string };
