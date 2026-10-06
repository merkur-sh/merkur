/** Marks the control that should take focus when a dialog opens. */
export const OVERLAY_AUTOFOCUS_ATTRIBUTE = 'data-overlay-autofocus';

export interface OverlayControls {
  /** Close this overlay. Refused while it is busy. */
  dismiss(): void;
  /**
   * Blocks dismissal while an in-flight submit owns the dialog, so Escape, a
   * backdrop click, and Cancel cannot strand a request that is still running.
   */
  setBusy(busy: boolean): void;
}
