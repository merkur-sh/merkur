/**
 * One latest pending scene; cadence controls ordinary admission, genuine queue
 * callbacks bound unconfirmed work. Callback latency is not GPU execution time.
 */
export type MailboxAction =
  | { readonly kind: 'render-now' }
  | { readonly kind: 'wait-frame' }
  | { readonly kind: 'wait-fence' }
  | { readonly kind: 'none' };

const ACTION_NONE: MailboxAction = { kind: 'none' };
const ACTION_RENDER_NOW: MailboxAction = { kind: 'render-now' };
const ACTION_WAIT_FRAME: MailboxAction = { kind: 'wait-frame' };
const ACTION_WAIT_FENCE: MailboxAction = { kind: 'wait-fence' };
export const MAX_IN_FLIGHT_RENDER_FRAMES = 2;

export interface RenderMailbox {
  /**
   * Offer the latest scene.
   *
   * `renderImmediately` says the caller already paid its presentation wait — a
   * coherent transaction the presentation coordinator released — so this image
   * must not wait for a second cadence edge here.
   */
  noteDirty(renderImmediately?: boolean): MailboxAction;
  noteSubmitted(nowMs: number, submissionId: number): MailboxAction;
  noteFrameComplete(submissionId: number): MailboxAction;
  noteOpportunity(frameTimeMs: number): MailboxAction;
  noteRenderAborted(): MailboxAction;
  /** A scene is offered and waiting only on a cadence opportunity. */
  renderQueued(): boolean;
  reset(): void;
}

export function createRenderMailbox(): RenderMailbox {
  const ids = new Uint32Array(MAX_IN_FLIGHT_RENDER_FRAMES);
  let dirty = false;
  let inFlight = 0;
  let awaitingSubmit = false;
  let opportunity = true;
  let lastSubmitAt = Number.NEGATIVE_INFINITY;

  function advance(): MailboxAction {
    if (awaitingSubmit || !dirty) return ACTION_NONE;
    if (inFlight >= MAX_IN_FLIGHT_RENDER_FRAMES) return ACTION_WAIT_FENCE;
    // Genuine completion is stronger than a cadence estimate. An idle GPU must
    // not impose a frame wait on a new keystroke just because rAF has not run.
    if (inFlight === 0) opportunity = true;
    if (!opportunity) return ACTION_WAIT_FRAME;
    awaitingSubmit = true;
    dirty = false;
    return ACTION_RENDER_NOW;
  }

  return {
    // Progress comes from a real animation frame or a genuine fence completion.
    // There is no wall-clock deadline here: the estimated period it was built
    // from could be a whole frame wrong, and it bought nothing a delivered
    // frame does not already prove.
    noteDirty(renderImmediately = false) {
      dirty = true;
      if (renderImmediately) opportunity = true;
      return advance();
    },
    noteSubmitted(nowMs, submissionId) {
      if (!awaitingSubmit) throw new Error('render submission without a mailbox claim');
      if (
        !Number.isSafeInteger(submissionId) ||
        submissionId <= 0 ||
        submissionId > 0xffff_ffff ||
        ids.includes(submissionId)
      )
        throw new Error('invalid render submission identity');
      const slot = ids.indexOf(0);
      if (slot < 0) throw new Error('render credit overflow');
      ids[slot] = submissionId;
      inFlight += 1;
      awaitingSubmit = false;
      opportunity = false;
      lastSubmitAt = nowMs;
      // One idle-reset opportunity, not an always-running animation loop.
      return ACTION_WAIT_FRAME;
    },
    noteFrameComplete(submissionId) {
      const slot = ids.indexOf(submissionId);
      if (submissionId === 0 || slot < 0)
        throw new Error('render credit completion without an owner');
      ids[slot] = 0;
      inFlight -= 1;
      return advance();
    },
    noteOpportunity(frameTimeMs) {
      // A delayed rAF for an already submitted frame grants nothing.
      if (frameTimeMs > lastSubmitAt) opportunity = true;
      return advance();
    },
    noteRenderAborted() {
      awaitingSubmit = false;
      dirty = true;
      return ACTION_NONE;
    },
    renderQueued() {
      // At the exceptional limit only genuine completion can unblock work.
      return dirty && !awaitingSubmit && inFlight < MAX_IN_FLIGHT_RENDER_FRAMES;
    },
    reset() {
      ids.fill(0);
      dirty = false;
      inFlight = 0;
      awaitingSubmit = false;
      opportunity = true;
      lastSubmitAt = Number.NEGATIVE_INFINITY;
    },
  };
}
