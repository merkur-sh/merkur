// Editing surface for the terminal: the focused, off-screen element that owns
// IME composition, the emoji/symbol picker, dead-key accents, and soft-keyboard
// editing intents. The low-latency keydown→prediction→PTY path stays primary
// (see TerminalPanel); this surface handles only what keydown cannot:
// composition and insertion that arrive via `beforeinput`/composition events
// (textarea tier) or `textupdate` (EditContext tier).
//
// Two tiers behind one interface:
//   - EditContext (Chromium): purpose-built for canvas/custom-rendered editors;
//     lets us place the IME candidate window exactly at the terminal cursor.
//   - Textarea (Firefox/WebKit/all): a cursor-anchored hidden <textarea>.
//
// Touch mode (`options.touch`) uses the textarea tier only (EditContext with
// mobile soft keyboards is unproven), pinned at the origin (`setCursorRect`
// is a no-op — iOS scrolls ancestors to reveal the focused element when the
// soft keyboard opens), with element-scoped delete-intent dedup for soft
// keyboards that report Backspace inconsistently.

import type { CursorRect } from '../terminal-worker-client';

const NATIVE_INPUT_SENTINEL = ' ';

const SURFACE_STYLE =
  'position:absolute;left:0;top:0;width:1px;height:1px;padding:0;margin:0;border:0;' +
  'opacity:0;outline:none;resize:none;overflow:hidden;white-space:pre;' +
  'color:transparent;background:transparent;caret-color:transparent;' +
  'pointer-events:none;z-index:0';

export interface EditingSurfaceCallbacks {
  /**
   * Committed text that the keydown fast path did not already send: an IME
   * commit, an emoji/symbol-picker insertion, a dead-key accent, or any other
   * `insertText`. Newlines are passed through; the caller maps `\n`→`\r`.
   */
  onInsertText(text: string): void;
  /**
   * The in-progress composition changed. `text === ''` means the preedit was
   * cleared (commit or cancel). `caret` is a UTF-16 offset into `text`.
   */
  onPreedit(text: string, caret: number): void;
  /** Composition began — callers typically flush predictions here. */
  onCompositionStart(): void;
  /** Composition ended (after any commit has been delivered via onInsertText). */
  onCompositionEnd(): void;
  /** A soft-keyboard backspace with no corresponding keydown (touch IME). */
  onDeleteBackward(): void;
  /** A soft-keyboard forward-delete with no corresponding keydown. */
  onDeleteForward(): void;
  /** A soft-keyboard Enter/newline with no corresponding keydown. */
  onEnter(): void;
  /** A paste landing directly on the surface. */
  onPaste(text: string): void;
  /**
   * The surface element gained/lost focus. Touch keyboard policy (virtual
   * keyboard visibility, sticky modifiers) stays with the caller.
   */
  onFocusChange(focused: boolean): void;
}

export interface EditingSurfaceOptions {
  /**
   * Touch mode: textarea tier only, pinned at the origin, soft-keyboard
   * delete-intent dedup via element-scoped keydown/keyup.
   */
  readonly touch: boolean;
}

export interface EditingSurface {
  readonly element: HTMLElement;
  readonly kind: 'textarea' | 'editcontext';
  focus(): void;
  blur(): void;
  /** True while an IME composition is active. */
  isComposing(): boolean;
  /** Anchor the IME UI (candidate window) at the cursor cell, container px. */
  setCursorRect(rect: CursorRect): void;
  destroy(): void;
}

// ── EditContext ambient types (not yet in lib.dom.d.ts as of TS 5.x) ─────────

interface EditContextTextUpdateEvent extends Event {
  readonly updateRangeStart: number;
  readonly updateRangeEnd: number;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface EditContextLike extends EventTarget {
  updateText(rangeStart: number, rangeEnd: number, text: string): void;
  updateSelection(start: number, end: number): void;
  updateControlBounds(rect: DOMRect): void;
  updateSelectionBounds(rect: DOMRect): void;
  text: string;
}

interface EditContextCtor {
  new (options?: {
    text?: string;
    selectionStart?: number;
    selectionEnd?: number;
  }): EditContextLike;
}

function getEditContextCtor(): EditContextCtor | null {
  const ctor = (globalThis as { EditContext?: unknown }).EditContext;
  return typeof ctor === 'function' ? (ctor as EditContextCtor) : null;
}

// ── Soft-keyboard delete-intent dedup (pure — unit-tested) ───────────────────
// Soft keyboards report deletes inconsistently: some send a real Backspace
// keydown plus a `beforeinput deleteContentBackward`, some send only the
// beforeinput, and composition-owned backspaces must not be intercepted at
// all. Queue the intent on keydown (caller preventDefaults) and deliver on
// keyup unless a beforeinput delete already took the immediate path.

export type SoftDeleteIntent = 'backward' | 'forward';

export interface SoftDeleteKeyInput {
  readonly key: string;
  readonly keyCode: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}

export interface SoftDeleteDedup {
  /** Intent to queue (the caller preventDefaults the keydown), or null. */
  keydown(e: SoftDeleteKeyInput): SoftDeleteIntent | null;
  /** A beforeinput delete took the immediate path; drop any pending intent. */
  beforeinputDelete(): void;
  /** Still-pending intent to deliver now, or null if deduped or none. */
  keyup(key: string): SoftDeleteIntent | null;
  /** Drop any pending intent (blur). */
  clear(): void;
}

export function createSoftDeleteDedup(): SoftDeleteDedup {
  let pending: SoftDeleteIntent | null = null;
  return {
    keydown(e: SoftDeleteKeyInput): SoftDeleteIntent | null {
      // Composition owns these keydowns: intercepting them would corrupt IME
      // editing. keyCode 229 / 'Process' cover engines that under-report
      // `isComposing` on the first keydown; 'Dead' lets accents compose.
      if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') {
        return null;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return null;
      if (e.key === 'Backspace') {
        pending = 'backward';
        return pending;
      }
      if (e.key === 'Delete') {
        pending = 'forward';
        return pending;
      }
      return null;
    },
    beforeinputDelete(): void {
      pending = null;
    },
    keyup(key: string): SoftDeleteIntent | null {
      if (key !== 'Backspace' && key !== 'Delete') return null;
      const intent = pending;
      pending = null;
      return intent;
    },
    clear(): void {
      pending = null;
    },
  };
}

// ── Shared host element ──────────────────────────────────────────────────────

function applyCursorTransform(el: HTMLElement, rect: CursorRect): void {
  // Position the surface over the cursor cell so the OS IME candidate window
  // renders at the terminal cursor rather than the top-left of the viewport.
  el.style.transform = `translate(${Math.round(rect.x)}px, ${Math.round(rect.y)}px)`;
  el.style.width = `${Math.max(1, Math.round(rect.w))}px`;
  el.style.height = `${Math.max(1, Math.round(rect.h))}px`;
}

// ── Textarea tier ────────────────────────────────────────────────────────────

function createTextareaEditingSurface(
  callbacks: EditingSurfaceCallbacks,
  options: EditingSurfaceOptions,
): EditingSurface {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-label', 'Terminal input');
  textarea.setAttribute('data-terminal-hidden-input', 'true');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('enterkeyhint', 'send');
  textarea.setAttribute('inputmode', 'text');
  textarea.setAttribute('tabindex', '-1');
  textarea.style.cssText = SURFACE_STYLE;
  textarea.value = NATIVE_INPUT_SENTINEL;

  let composing = false;
  // Dedup: a `compositionend` commit is followed by a trailing `input` event
  // carrying the same text; skip that echo.
  let lastCommitted: string | null = null;
  // Touch only: soft-keyboard Backspace/Delete keydown↔beforeinput dedup.
  const deleteDedup = options.touch ? createSoftDeleteDedup() : null;

  function reset(): void {
    textarea.value = NATIVE_INPUT_SENTINEL;
    textarea.setSelectionRange(NATIVE_INPUT_SENTINEL.length, NATIVE_INPUT_SENTINEL.length);
  }

  function deliverDelete(intent: SoftDeleteIntent): void {
    if (intent === 'backward') callbacks.onDeleteBackward();
    else callbacks.onDeleteForward();
    reset();
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (deleteDedup === null) return;
    const intent = deleteDedup.keydown({
      key: e.key,
      keyCode: e.keyCode,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      isComposing: e.isComposing,
    });
    if (intent !== null) e.preventDefault();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    if (deleteDedup === null) return;
    const intent = deleteDedup.keyup(e.key);
    if (intent !== null) deliverDelete(intent);
  };

  const onFocus = (): void => {
    if (!composing) reset();
    callbacks.onFocusChange(true);
  };

  const onBlur = (): void => {
    deleteDedup?.clear();
    callbacks.onFocusChange(false);
  };

  const onCompositionStart = (): void => {
    composing = true;
    callbacks.onCompositionStart();
  };

  const onCompositionUpdate = (e: CompositionEvent): void => {
    const text = e.data ?? '';
    callbacks.onPreedit(text, text.length);
  };

  const onCompositionEnd = (e: CompositionEvent): void => {
    composing = false;
    callbacks.onPreedit('', 0);
    const text = e.data ?? '';
    if (text.length > 0) {
      lastCommitted = text;
      callbacks.onInsertText(text);
    }
    reset();
    callbacks.onCompositionEnd();
  };

  const onBeforeInput = (e: InputEvent): void => {
    if (composing || e.isComposing) return;
    switch (e.inputType) {
      case 'deleteContentBackward':
        e.preventDefault();
        deleteDedup?.beforeinputDelete();
        deliverDelete('backward');
        return;
      case 'deleteContentForward':
        e.preventDefault();
        deleteDedup?.beforeinputDelete();
        deliverDelete('forward');
        return;
      case 'insertLineBreak':
      case 'insertParagraph':
        e.preventDefault();
        callbacks.onEnter();
        reset();
        return;
      case 'insertText':
        if (e.data) {
          e.preventDefault();
          callbacks.onInsertText(e.data);
        }
        reset();
        return;
    }
  };

  const onInput = (e: InputEvent): void => {
    if (composing || e.isComposing) return;
    const text = textarea.value.replaceAll(NATIVE_INPUT_SENTINEL, '');
    reset();
    if (text.length === 0) return;
    if (text === lastCommitted) {
      lastCommitted = null;
      return;
    }
    callbacks.onInsertText(text);
  };

  const onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');
    if (text) callbacks.onPaste(text);
  };

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionupdate', onCompositionUpdate as EventListener);
  textarea.addEventListener('compositionend', onCompositionEnd as EventListener);
  textarea.addEventListener('beforeinput', onBeforeInput as EventListener);
  textarea.addEventListener('input', onInput as EventListener);
  textarea.addEventListener('paste', onPaste as EventListener);
  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('keyup', onKeyUp);
  textarea.addEventListener('focus', onFocus);
  textarea.addEventListener('blur', onBlur);

  return {
    element: textarea,
    kind: 'textarea',
    focus: () => textarea.focus({ preventScroll: true }),
    blur: () => textarea.blur(),
    isComposing: () => composing,
    // Touch stays pinned at the origin: iOS scrolls ancestors to reveal the
    // focused element when the soft keyboard opens, which would clip the
    // canvas if the surface tracked the cursor.
    setCursorRect: (rect) => {
      if (!options.touch) applyCursorTransform(textarea, rect);
    },
    destroy: () => {
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionupdate', onCompositionUpdate as EventListener);
      textarea.removeEventListener('compositionend', onCompositionEnd as EventListener);
      textarea.removeEventListener('beforeinput', onBeforeInput as EventListener);
      textarea.removeEventListener('input', onInput as EventListener);
      textarea.removeEventListener('paste', onPaste as EventListener);
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('keyup', onKeyUp);
      textarea.removeEventListener('focus', onFocus);
      textarea.removeEventListener('blur', onBlur);
      textarea.remove();
    },
  };
}

// ── EditContext tier (Chromium) ──────────────────────────────────────────────

function createEditContextEditingSurface(
  callbacks: EditingSurfaceCallbacks,
  containerForBounds: HTMLElement,
): EditingSurface | null {
  const Ctor = getEditContextCtor();
  if (Ctor === null) return null;

  const host = document.createElement('div');
  host.setAttribute('aria-label', 'Terminal input');
  host.setAttribute('data-terminal-hidden-input', 'true');
  host.setAttribute('tabindex', '-1');
  host.style.cssText = SURFACE_STYLE;

  let ec: EditContextLike;
  try {
    ec = new Ctor({ text: '' });
    // `editContext` is not yet typed on HTMLElement.
    (host as unknown as { editContext: EditContextLike }).editContext = ec;
  } catch {
    return null;
  }

  let composing = false;
  let value = '';

  function resetBuffer(): void {
    if (value.length > 0) ec.updateText(0, value.length, '');
    ec.updateSelection(0, 0);
    value = '';
  }

  const onCompositionStart = (): void => {
    composing = true;
    callbacks.onCompositionStart();
  };

  const onCompositionEnd = (): void => {
    composing = false;
    // Commit whatever the composition produced, then clear the buffer/preedit.
    const text = value;
    callbacks.onPreedit('', 0);
    resetBuffer();
    if (text.length > 0) callbacks.onInsertText(text);
    callbacks.onCompositionEnd();
  };

  const onTextUpdate = (e: EditContextTextUpdateEvent): void => {
    // Apply the platform's edit to our shadow buffer.
    value = value.slice(0, e.updateRangeStart) + e.text + value.slice(e.updateRangeEnd);
    ec.updateSelection(e.selectionStart, e.selectionEnd);

    if (composing) {
      callbacks.onPreedit(value, e.selectionEnd);
      return;
    }
    // Non-composing insert (emoji/symbol picker, dead-key, plain text the
    // keydown fast path didn't handle): forward and reset.
    const text = value;
    resetBuffer();
    if (text.length > 0) callbacks.onInsertText(text);
  };

  const onFocus = (): void => callbacks.onFocusChange(true);
  const onBlur = (): void => callbacks.onFocusChange(false);

  ec.addEventListener('compositionstart', onCompositionStart);
  ec.addEventListener('compositionend', onCompositionEnd);
  ec.addEventListener('textupdate', onTextUpdate as EventListener);
  host.addEventListener('focus', onFocus);
  host.addEventListener('blur', onBlur);

  return {
    element: host,
    kind: 'editcontext',
    focus: () => host.focus({ preventScroll: true }),
    blur: () => host.blur(),
    isComposing: () => composing,
    setCursorRect: (rect) => {
      // Read the container rect before the style writes below: reading after
      // them forces a synchronous layout on every cursor move (each keystroke).
      const base = containerForBounds.getBoundingClientRect();
      applyCursorTransform(host, rect);
      // Place the candidate window at the cursor in viewport coordinates.
      const bounds = new DOMRect(base.left + rect.x, base.top + rect.y, rect.w, rect.h);
      ec.updateControlBounds(bounds);
      ec.updateSelectionBounds(bounds);
    },
    destroy: () => {
      ec.removeEventListener('compositionstart', onCompositionStart);
      ec.removeEventListener('compositionend', onCompositionEnd);
      ec.removeEventListener('textupdate', onTextUpdate as EventListener);
      host.removeEventListener('focus', onFocus);
      host.removeEventListener('blur', onBlur);
      host.remove();
    },
  };
}

/**
 * Create the best available editing surface: EditContext on Chromium (anchored
 * candidate window), otherwise a cursor-anchored hidden textarea. Touch mode
 * always uses the textarea tier (EditContext + soft keyboards is unproven).
 */
export function createEditingSurface(
  callbacks: EditingSurfaceCallbacks,
  containerForBounds: HTMLElement,
  options: EditingSurfaceOptions,
): EditingSurface {
  if (options.touch) return createTextareaEditingSurface(callbacks, options);
  return (
    createEditContextEditingSurface(callbacks, containerForBounds) ??
    createTextareaEditingSurface(callbacks, options)
  );
}
