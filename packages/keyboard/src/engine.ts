import { hitTestKeyboard, rectContainsExpanded } from './geometry';
import {
  classifyKeyboardTouch,
  createKeyboardSpatialPrior,
  keyboardAnchorContains,
  keyboardReleaseWeight,
  validateKeyboardTouchModel,
} from './touch-model';
import type {
  KeyboardEngineCommit,
  KeyboardGeometryProfile,
  KeyboardKeyDefinition,
  KeyboardPointerSample,
  KeyboardTouchModel,
  KeyboardTouchTrace,
  ResolvedKeyboardGeometry,
  ResolvedKeyboardKey,
} from './types';

export interface KeyboardTimerHost {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
  now?(): number;
}

export type KeyboardEngineRawCommitHandler = (
  key: ResolvedKeyboardKey,
  layerId: string,
  pointerId: number,
  x: number,
  y: number,
  /**
   * The pointer event timestamp of touch-down, in the caller's event time base.
   * Not an elapsed duration: a key decided at touch-down has no duration yet,
   * and reporting zero there would make the physical-contact-to-commit stage
   * read as zero by definition instead of by measurement, hiding every later
   * regression in pointer dispatch. The physical contact duration is still
   * reported, on `KeyboardTouchTrace.durationMs`, at release.
   */
  contactAtMs: number,
  repeat: boolean,
) => void;

export type KeyboardEngineRawProvisionalHandler = (
  key: ResolvedKeyboardKey | null,
  layerId: string,
  pointerId: number,
) => void;

export interface KeyboardEngineOptions {
  readonly geometry: ResolvedKeyboardGeometry;
  readonly profile: KeyboardGeometryProfile;
  readonly touchModel?: KeyboardTouchModel;
  readonly onCommit?: (commit: KeyboardEngineCommit) => void;
  readonly onRawCommit?: KeyboardEngineRawCommitHandler;
  readonly onRawProvisional?: KeyboardEngineRawProvisionalHandler;
  readonly onTouchTrace?: (trace: KeyboardTouchTrace) => void;
  readonly onKeyStateChange?: (keyIndex: number, active: boolean) => void;
  readonly timers?: KeyboardTimerHost;
}

export interface KeyboardEngine {
  beginPointer(sample: KeyboardPointerSample): boolean;
  movePointer(sample: KeyboardPointerSample): boolean;
  endPointer(sample: KeyboardPointerSample): boolean;
  beginPointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean;
  movePointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean;
  endPointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean;
  cancelPointer(pointerId: number): boolean;
  activateKey(keyId: string, timeStamp?: number): boolean;
  updateGeometry(geometry: ResolvedKeyboardGeometry, profile?: KeyboardGeometryProfile): void;
  updateTouchModel(model: KeyboardTouchModel): void;
  /**
   * Sets the causal log-probability of every key given the text committed so
   * far, or clears it. One entry per key in the current geometry.
   *
   * A contact that is already down keeps whatever prior was current when it
   * began only in the sense that the next classification reads this field
   * directly; with rollover, a tap that starts before its predecessor commits is
   * scored against a prior that does not yet include that predecessor. That is
   * inherent to deciding causally and is why the anchor exists.
   */
  setKeyPrior(logPrior: Float64Array | null): void;
  cancelAll(): void;
  destroy(): void;
}

const NO_POINTER = -1;
const NO_KEY = -1;
const TRAJECTORY_CAPACITY = 8;
/**
 * A contact still down this long after its own press is a hold, not a rollover
 * partner, so it yields its place in the press order rather than stalling every
 * later keystroke. Human motor timing rather than geometry, so it is not a
 * profile field; no device varies it.
 *
 * Derived from OptiTrack finger motion capture of two-thumb typing (Jiang et
 * al., CHI 2020; 30 participants, 16,237 consecutive tap pairs). Two independent
 * lines of evidence put the value here:
 *
 *   - Contact duration is p50 84ms, p90 133ms, and its log-survival curve knees
 *     at 167ms, separating ordinary taps from a ~2% parked tail. 250ms is the
 *     p97.4 of contact duration, so a contact still down at this point has
 *     outlasted essentially every real tap.
 *   - Widening the window from 200ms to 250ms recovers 18.9 percentage points of
 *     the measured nested rollovers, the most productive 50ms in the entire
 *     curve; every later increment yields at most 11.3 and mostly falls away.
 *
 * This window no longer delays anything. It used to bound how long a resolved
 * commit would wait for an older contact; a contact that is overtaken is now
 * resolved from where its finger already is instead of being waited on, so the
 * only thing left to decide is ORDER: inside the window the older contact keeps
 * its place in the press order, outside it the contact is a resting thumb and
 * yields. Widening it is therefore no longer a latency trade — but it is still a
 * measured value and should not move without re-measuring.
 */
export const ROLLOVER_HOLD_MS = 250;

/**
 * How a contact's key was decided, which is what determines whether it still
 * owes the stream a byte. Only `DECIDED_AT_RELEASE` does: every other state has
 * already committed, so those contacts cannot hold a later commit back, cannot
 * be resolved a second time, and must not commit again when their own finger
 * finally lifts. Any test for "already committed" therefore has to be `!==
 * DECIDED_AT_RELEASE` rather than a list of the states that existed when it was
 * written — enumerating them is how the overtaken state once got left out of
 * `endPointerAt` and committed twice.
 */
const DECIDED_AT_RELEASE = 0;
/** A key the layout declares `activation: 'press'` — Backspace, arrows, modifiers. */
const DECIDED_ON_PRESS = 1;
/**
 * A character key whose contact landed inside its anchor. The anchor already
 * promises that the language prior cannot override geometry there; this extends
 * the same promise to the release sample, which makes the key final at
 * touch-down and takes the contact duration (p50 84ms, p90 133ms) out of the
 * commit's latency. The cost is slide-to-correct inside the anchor — a quarter
 * of the key's area — and it is paid deliberately.
 */
const DECIDED_IN_ANCHOR = 2;
/**
 * A contact that was still undecided when a later contact became ready to
 * commit. Rather than making the later one wait for a finger that is already on
 * its way off its key, the older contact is resolved from where it currently
 * sits — the same thing `commitLiveContacts` does for a layer switch, through
 * the same classifier — and commits first. Press order is preserved and nobody
 * waits. What it gives up is a slide-to-correct that had not started yet at the
 * moment the next key was pressed.
 */
const DECIDED_ON_OVERTAKE = 3;
/** No live ordinal. A slot that is free or decided at press never holds one. */
const NO_ORDINAL = -1;
/**
 * Whether committing this key early is recoverable if it turns out to be wrong.
 *
 * Anchor-commit trades slide-to-correct for latency. That trade is right for a
 * key that types one character, because the whole cost of getting it wrong is
 * one Backspace. It is wrong for Enter, which in a terminal runs whatever is on
 * the line: there is no undo, and taking your finger off the key without lifting
 * is the only way to change your mind once you have touched it. The same holds
 * for Tab, Escape and the navigation keys, which move or transform state rather
 * than adding a character.
 *
 * The predicate is the key's own `value`, not a new field, and it is the same
 * distinction the language prior already draws: a key that does not produce a
 * single character has no bigram statistics either. One property, two uses, no
 * layout flag to keep in sync.
 */
function isRecoverable(key: ResolvedKeyboardKey): boolean {
  const value = key.definition.value;
  return value !== undefined && value.length === 1;
}

const DEFAULT_TIMER_HOST: KeyboardTimerHost = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createKeyboardEngine(options: KeyboardEngineOptions): KeyboardEngine {
  if (options.onCommit === undefined && options.onRawCommit === undefined) {
    throw new Error('Keyboard engine requires a commit callback');
  }
  let geometry = options.geometry;
  let profile = options.profile;
  let keyPrior: Float64Array | null = null;
  let spatialPrior = options.touchModel ?? createKeyboardSpatialPrior(geometry);
  validateKeyboardTouchModel(geometry, spatialPrior);
  const capacity = profile.maximumPointers;
  const pointerIds = new Float64Array(capacity);
  const selectedKeys = new Int16Array(capacity);
  const downX = new Float64Array(capacity);
  const downY = new Float64Array(capacity);
  const lastX = new Float64Array(capacity);
  const lastY = new Float64Array(capacity);
  const downAt = new Float64Array(capacity);
  // How this contact's key was decided. Only a release-decided contact can block
  // a later commit, because only its key is still unknown while it is down.
  const downDecision = new Uint8Array(capacity);
  const trajectoryCounts = new Uint8Array(capacity);
  const trajectoryCursors = new Uint8Array(capacity);
  // How many samples this contact has actually produced, uncensored. The ring
  // above deliberately keeps only the most recent `TRAJECTORY_CAPACITY` for the
  // centroid, so its count saturates; a saturated count cannot tell a browser
  // delivering 8 samples from one delivering 30, which is exactly the question
  // the diagnostics exist to answer.
  const contactSamples = new Uint16Array(capacity);
  const trajectoryX = new Float32Array(capacity * TRAJECTORY_CAPACITY);
  const trajectoryY = new Float32Array(capacity * TRAJECTORY_CAPACITY);
  const trajectoryT = new Float64Array(capacity * TRAJECTORY_CAPACITY);
  const centroidX = new Float64Array(capacity);
  const centroidY = new Float64Array(capacity);
  // The key the touch alone scored highest when this contact's key was decided,
  // before the context prior; the trace reports it so a correction can tell a
  // miss the prior made from one the finger made. `spatialWinner` is the
  // classifier's out-slot, read right after each deciding call.
  const spatialKeys = new Int16Array(capacity);
  const spatialWinner = new Int16Array(1);
  const repeatKeyIndices = new Int16Array(capacity);
  const repeatHandles: Array<unknown | null> = Array.from({ length: capacity }, () => null);
  const repeatCallbacks = Array.from({ length: capacity }, (_, slot) => () => repeatTick(slot));
  // Press order, which is the order bytes must reach the PTY in. A contact's key
  // is not always known when it presses, so this is what a later commit compares
  // itself against to decide whether anything older still owes the stream a byte.
  const pressOrdinals = new Float64Array(capacity);
  let nextPressOrdinal = 0;
  // Live contacts whose key is still undecided. Only these can owe the stream a
  // byte, so this is the whole test for whether a ready commit has to do
  // anything before emitting.
  let undecidedContacts = 0;
  let activeCounts = new Uint8Array(geometry.keys.length);
  let destroyed = false;
  const timers = options.timers ?? DEFAULT_TIMER_HOST;

  pointerIds.fill(NO_POINTER);
  selectedKeys.fill(NO_KEY);
  repeatKeyIndices.fill(NO_KEY);
  pressOrdinals.fill(NO_ORDINAL);

  function beginPointer(sample: KeyboardPointerSample): boolean {
    return beginPointerAt(sample.pointerId, sample.x, sample.y, sample.timeStamp);
  }

  function beginPointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean {
    if (destroyed) return false;
    const duplicate = findSlot(pointerId);
    if (duplicate !== NO_POINTER) {
      // A duplicate id means the platform lost the previous up. That contact
      // still pressed a key, and this is the last moment it can produce its
      // byte: the slot is about to be reused. Dropping it here is how a lost
      // pointerup turns into a missing character with nothing recording that it
      // happened. Anything already decided has committed, so this only fires for
      // one that was still waiting on its release.
      if (downDecision[duplicate] === DECIDED_AT_RELEASE) commitContactNow(duplicate);
      releaseSlot(duplicate, true);
    }
    if (hitTestKeyboard(geometry, x, y) === null) return false;
    const slot = findFreeSlot();
    if (slot === NO_POINTER) return false;

    pointerIds[slot] = pointerId;
    // The ordinal is taken below, only on the path that can actually block:
    // a decided contact never needs one, and skipping the increment cannot
    // disorder anything, since ordinals only have to increase among the
    // release-decided contacts that compare against each other.
    pressOrdinals[slot] = NO_ORDINAL;
    selectedKeys[slot] = NO_KEY;
    downX[slot] = x;
    downY[slot] = y;
    lastX[slot] = x;
    lastY[slot] = y;
    downAt[slot] = timeStamp;
    downDecision[slot] = DECIDED_AT_RELEASE;
    trajectoryCounts[slot] = 0;
    trajectoryCursors[slot] = 0;
    recordTrajectorySample(slot, x, y, timeStamp);
    const keyIndex = classifyCurrentTouch(slot, x, y, timeStamp);
    if (keyIndex === null) {
      pointerIds[slot] = NO_POINTER;
      return false;
    }
    selectedKeys[slot] = keyIndex;
    keepSpatialWinner(slot);
    setKeyActive(keyIndex, true);

    const key = geometry.keys[keyIndex];
    if (key?.definition.activation === 'press') {
      downDecision[slot] = DECIDED_ON_PRESS;
      emitProvisional(slot, keyIndex);
      // Anything pressed earlier still owes the stream a byte, and it has to
      // arrive before this one: a Backspace that overtook the letter it was
      // meant to delete would delete the wrong character.
      resolveOlderContacts(timeStamp, nextPressOrdinal);
      emitCommit(key, pointerId, x, y, timeStamp, false);
      if (pointerIds[slot] === pointerId && selectedKeys[slot] === keyIndex) {
        scheduleRepeat(slot, key);
      }
      return true;
    }

    if (key !== undefined && isRecoverable(key) && keyboardAnchorContains(key.rect, x, y)) {
      // Set before resolution runs: it scans live slots, and this one is neither
      // undecided nor a candidate for being resolved by itself.
      downDecision[slot] = DECIDED_IN_ANCHOR;
      // Every live contact pressed before this one, so `nextPressOrdinal` bounds
      // them all. Each is either committed from where its finger currently sits
      // or, if it has outlasted every real tap, yielded past this one. Either
      // way this commit leaves immediately.
      resolveOlderContacts(timeStamp, nextPressOrdinal);
      // No provisional: the committed glyph IS the feedback, and the overlay
      // stages provisional and committed glyphs additively, so one beside the
      // other would paint the character twice for the whole contact.
      emitCommit(key, pointerId, x, y, timeStamp, false);
      return true;
    }

    pressOrdinals[slot] = nextPressOrdinal;
    nextPressOrdinal += 1;
    undecidedContacts += 1;
    emitProvisional(slot, keyIndex);
    return true;
  }

  /**
   * Commits every still-down contact that pressed before `bound` and whose key
   * is still undecided, so the caller can emit immediately instead of waiting.
   *
   * This is what replaces buffering. Waiting never produced a BETTER decision
   * for the older contact — with `releaseWeight` at zero its release point
   * contributes nothing directly, and any slide already in progress is in the
   * trajectory centroid this reads. It only produced a later one. The single
   * case waiting would have caught is a slide-to-correct that had not begun by
   * the time the user pressed the next key, which is not a gesture people make.
   *
   * Ascending ordinal order, so the bytes leave in press order.
   */
  function resolveOlderContacts(now: number, bound: number): void {
    if (undecidedContacts === 0) return;
    // A yield raises the slot's ordinal past `bound` and a resolve clears its
    // undecided flag, so every pass removes exactly one candidate from a set of
    // at most `capacity`. The bound is belt and braces: if a later change ever
    // breaks that invariant the loop must not spin, because this runs
    // synchronously inside a pointer handler and a spin here is a frozen
    // keyboard rather than a wrong character.
    for (let pass = 0; pass < capacity; pass += 1) {
      let oldestSlot = NO_POINTER;
      let oldestOrdinal = bound;
      for (let slot = 0; slot < capacity; slot += 1) {
        if (pointerIds[slot] === NO_POINTER) continue;
        if (downDecision[slot] !== DECIDED_AT_RELEASE) continue;
        const ordinal = pressOrdinals[slot] ?? 0;
        if (ordinal < oldestOrdinal) {
          oldestOrdinal = ordinal;
          oldestSlot = slot;
        }
      }
      if (oldestSlot === NO_POINTER) return;
      resolveOvertakenContact(oldestSlot, now);
    }
  }

  /**
   * Decides one overtaken contact. A contact still down past `ROLLOVER_HOLD_MS`
   * has outlasted essentially every real tap, so it is a resting thumb rather
   * than a rollover partner: it keeps its own release decision and simply yields
   * its place in the press order, exactly as it did before.
   */
  function resolveOvertakenContact(slot: number, now: number): void {
    if (now - (downAt[slot] ?? now) >= ROLLOVER_HOLD_MS) {
      yieldContact(slot);
      return;
    }
    const x = lastX[slot] ?? 0;
    const y = lastY[slot] ?? 0;
    const keyIndex = classifyCurrentTouch(slot, x, y, now);
    const key = keyIndex === null ? undefined : geometry.keys[keyIndex];
    if (key === undefined) {
      // The finger is currently off every key, so there is no byte to emit and
      // nothing for the stream to wait on. Its own release still decides it.
      yieldContact(slot);
      return;
    }
    keepSpatialWinner(slot);
    downDecision[slot] = DECIDED_ON_OVERTAKE;
    undecidedContacts -= 1;
    pressOrdinals[slot] = NO_ORDINAL;
    const previous = selectedKeys[slot] ?? NO_KEY;
    if (previous !== key.index) {
      // The finger moved after the provisional was staged; the keycap follows
      // the key that is actually committing.
      if (previous !== NO_KEY) setKeyActive(previous, false);
      setKeyActive(key.index, true);
      selectedKeys[slot] = key.index;
    }
    const pointerId = pointerIds[slot] ?? NO_POINTER;
    // The provisional stood in for this character; the committed glyph replaces
    // it. Cleared before the commit so the two never coexist.
    if (pointerId !== NO_POINTER) options.onRawProvisional?.(null, geometry.layerId, pointerId);
    emitCommit(key, pointerId, x, y, downAt[slot] ?? now, false);
  }

  /** Moves a contact behind everything currently pending in the press order. */
  function yieldContact(slot: number): void {
    pressOrdinals[slot] = nextPressOrdinal;
    nextPressOrdinal += 1;
  }

  function movePointer(sample: KeyboardPointerSample): boolean {
    return movePointerAt(sample.pointerId, sample.x, sample.y, sample.timeStamp);
  }

  function movePointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean {
    if (destroyed) return false;
    const slot = findSlot(pointerId);
    if (slot === NO_POINTER) return false;
    lastX[slot] = x;
    lastY[slot] = y;
    recordTrajectorySample(slot, x, y, timeStamp);
    // A contact whose key was already decided at touch-down does not reclassify:
    // for a press key it never did, and for an anchored one the decision is
    // final by construction. This is where slide-to-correct is given up inside
    // the anchor, and where the per-move classify and centroid work disappears.
    if (downDecision[slot] !== DECIDED_AT_RELEASE) return true;

    // Hysteresis first. A contact still inside the key it already selected keeps
    // it whatever a reclassification would say, so running one is pure waste —
    // and it is not cheap waste: a classify rebuilds the recency-weighted
    // trajectory centroid over the whole sample ring and scores four candidates
    // at up to three points each. Most move samples during real typing land
    // here, because fingers spend most of a contact inside the key they are on.
    const currentIndex = selectedKeys[slot] ?? NO_KEY;
    const current = currentIndex === NO_KEY ? undefined : geometry.keys[currentIndex];
    if (current !== undefined && rectContainsExpanded(current.rect, x, y, profile.hysteresis)) {
      return true;
    }
    const candidate = classifyCurrentTouch(slot, x, y, timeStamp);
    if (candidate === null || candidate === currentIndex) return true;
    switchSelectedKey(slot, candidate);
    return true;
  }

  function endPointer(sample: KeyboardPointerSample): boolean {
    return endPointerAt(sample.pointerId, sample.x, sample.y, sample.timeStamp);
  }

  function endPointerAt(pointerId: number, x: number, y: number, timeStamp: number): boolean {
    if (destroyed) return false;
    const slot = findSlot(pointerId);
    if (slot === NO_POINTER) return false;
    lastX[slot] = x;
    lastY[slot] = y;
    recordTrajectorySample(slot, x, y, timeStamp);
    const decision = downDecision[slot];
    const contactAtMs = downAt[slot] ?? timeStamp;
    const durationMs = Math.max(0, timeStamp - contactAtMs);

    // Anything already decided has already committed, so this lift must never
    // produce a second byte. Written as "not release-decided" rather than as a
    // list of the decided states on purpose: enumerating them is how the
    // overtaken state was once left out here and committed twice, and a state
    // added later must default to the safe side of that line.
    if (decision !== DECIDED_AT_RELEASE) {
      // A press-activated key staged a provisional and produces no touch trace;
      // an anchored or overtaken contact is exactly the reverse. Anchored
      // contacts never stage one, and an overtaken contact had its cleared when
      // it was resolved, so neither has anything left to clear here.
      const decidedOnPress = decision === DECIDED_ON_PRESS;
      // The trace is deliberately NOT coupled to the commit: the offset learner
      // and the diagnostics histograms both read it, and they need the real
      // lift point, the real contact duration and the real move-sample count,
      // none of which existed when the key was decided.
      if (!decidedOnPress && options.onTouchTrace !== undefined) {
        const committed = geometry.keys[selectedKeys[slot] ?? NO_KEY];
        computeTrajectoryCentroid(slot, timeStamp, x, y);
        options.onTouchTrace({
          // Read from the slot, so the trace reports the key that was actually
          // committed rather than what a second classification would now say.
          predictedKey: committed?.definition ?? null,
          layerId: geometry.layerId,
          pointerId,
          downX: downX[slot] ?? x,
          downY: downY[slot] ?? y,
          trajectoryX: centroidX[slot] ?? x,
          trajectoryY: centroidY[slot] ?? y,
          releaseX: x,
          releaseY: y,
          durationMs,
          sampleCount: contactSamples[slot] ?? 0,
          contactAtMs,
          modelCenterX:
            committed === undefined
              ? Number.NaN
              : (spatialPrior.centerX[committed.index] ?? Number.NaN),
          modelCenterY:
            committed === undefined
              ? Number.NaN
              : (spatialPrior.centerY[committed.index] ?? Number.NaN),
          spatialKey: spatialKeyOf(slot),
        });
      }
      releaseSlot(slot, decidedOnPress);
      return true;
    }

    // Still undecided, so this lift is what decides it.
    const originX = downX[slot] ?? x;
    const originY = downY[slot] ?? y;
    const deltaX = x - originX;
    const deltaY = y - originY;
    computeTrajectoryCentroid(slot, timeStamp, x, y);
    const commitIndex = classifyKeyboardTouch(
      geometry,
      spatialPrior,
      originX,
      originY,
      centroidX[slot] ?? x,
      centroidY[slot] ?? y,
      x,
      y,
      keyboardReleaseWeight(
        deltaX * deltaX + deltaY * deltaY,
        profile.tapDrift,
        profile.slideDrift,
        profile.releaseWeight,
      ),
      keyPrior,
      profile.priorWeight,
      spatialWinner,
    );
    keepSpatialWinner(slot);
    const commitKey = commitIndex === null ? undefined : geometry.keys[commitIndex];
    if (options.onTouchTrace !== undefined) {
      options.onTouchTrace({
        predictedKey: commitKey?.definition ?? null,
        layerId: geometry.layerId,
        pointerId,
        downX: originX,
        downY: originY,
        trajectoryX: centroidX[slot] ?? x,
        trajectoryY: centroidY[slot] ?? y,
        releaseX: x,
        releaseY: y,
        durationMs,
        sampleCount: contactSamples[slot] ?? 0,
        contactAtMs,
        modelCenterX:
          commitKey === undefined
            ? Number.NaN
            : (spatialPrior.centerX[commitKey.index] ?? Number.NaN),
        modelCenterY:
          commitKey === undefined
            ? Number.NaN
            : (spatialPrior.centerY[commitKey.index] ?? Number.NaN),
        spatialKey: spatialKeyOf(slot),
      });
    }

    // Anything that pressed earlier and is still undecided commits first, from
    // where its finger currently sits. It is not waited on, so this contact's
    // own byte leaves on this event either way.
    if (commitKey !== undefined) {
      resolveOlderContacts(timeStamp, pressOrdinals[slot] ?? 0);
    }
    releaseSlot(slot, true);
    if (commitKey !== undefined) emitCommit(commitKey, pointerId, x, y, contactAtMs, false);
    return true;
  }

  function cancelPointer(pointerId: number): boolean {
    const slot = findSlot(pointerId);
    if (slot === NO_POINTER) return false;
    // Nothing is ever held back waiting for this contact, so a cancel only has
    // to release the slot. Whatever it was blocking has already been emitted.
    releaseSlot(slot, true);
    return true;
  }

  function activateKey(keyId: string, timeStamp?: number): boolean {
    if (destroyed) return false;
    const key = geometry.keys.find((candidate) => candidate.definition.id === keyId);
    if (key === undefined) return false;
    // A synthetic activation still lands after whatever the user's fingers
    // already pressed, so anything undecided commits first.
    resolveOlderContacts(timeStamp ?? timers.now?.() ?? 0, nextPressOrdinal);
    emitCommit(
      key,
      NO_POINTER,
      key.rect.x + key.rect.width / 2,
      key.rect.y + key.rect.height / 2,
      0,
      false,
    );
    return true;
  }

  function updateGeometry(nextGeometry: ResolvedKeyboardGeometry, nextProfile = profile): void {
    if (nextProfile.maximumPointers !== capacity) {
      throw new Error('Keyboard maximumPointers cannot change after engine construction');
    }
    // A contact that is still down when the layer changes has to be committed
    // against the geometry it was typed on, not dropped. Tapping a layer key
    // while a letter is still under the other thumb is ordinary two-thumb
    // typing, and `cancelAll` would release that letter with no commit, no
    // trace and no counter — a silently lost keystroke on an input surface
    // where nothing downstream can recover it.
    commitLiveContacts();
    cancelAll();
    geometry = nextGeometry;
    profile = nextProfile;
    spatialPrior = createKeyboardSpatialPrior(geometry);
    activeCounts = new Uint8Array(geometry.keys.length);
    // A prior is indexed by key, and a different layer has different keys, so
    // carrying it across would score the new layer against the old layer's
    // probabilities. The owner sets a fresh one for the layer it switched to.
    keyPrior = null;
  }

  function updateTouchModel(nextModel: KeyboardTouchModel): void {
    validateKeyboardTouchModel(geometry, nextModel);
    spatialPrior = nextModel;
  }

  function setKeyPrior(logPrior: Float64Array | null): void {
    if (logPrior !== null && logPrior.length !== geometry.keys.length) {
      throw new Error('Keyboard key prior does not match resolved geometry');
    }
    keyPrior = logPrior;
  }

  /**
   * Commits every still-down, release-decided contact from where it currently
   * sits. Only `updateGeometry` calls this: `destroy` and a real `pointercancel`
   * must keep discarding, because there the contact genuinely did not become a
   * keystroke. Contacts decided at touch-down have already committed and are
   * skipped.
   */
  function commitLiveContacts(): void {
    // Ascending press order, and deliberately without the resting-thumb yield
    // that `resolveOvertakenContact` applies: nothing is overtaking these, the
    // layer is simply about to change underneath them, so every one of them owes
    // the stream its byte however long it has been held. Bounded for the same
    // reason as `resolveOlderContacts`.
    for (let pass = 0; pass < capacity; pass += 1) {
      let oldestSlot = NO_POINTER;
      let oldestOrdinal = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < capacity; slot += 1) {
        if (pointerIds[slot] === NO_POINTER) continue;
        if (downDecision[slot] !== DECIDED_AT_RELEASE) continue;
        const ordinal = pressOrdinals[slot] ?? 0;
        if (ordinal < oldestOrdinal) {
          oldestOrdinal = ordinal;
          oldestSlot = slot;
        }
      }
      if (oldestSlot === NO_POINTER) return;
      commitContactNow(oldestSlot);
    }
  }

  /**
   * Commits one still-undecided contact from where its finger currently sits,
   * unconditionally. Used where the contact is about to stop existing — the
   * layer is changing under it, or the platform reused its pointer id — so
   * unlike `resolveOvertakenContact` there is no option to yield and decide
   * later: the choice is commit now or lose the keystroke.
   */
  function commitContactNow(slot: number): void {
    const pointerId = pointerIds[slot] ?? NO_POINTER;
    const x = lastX[slot] ?? 0;
    const y = lastY[slot] ?? 0;
    const keyIndex = classifyCurrentTouch(slot, x, y, downAt[slot] ?? 0);
    keepSpatialWinner(slot);
    // Marked decided before emitting, both so the caller's loop advances and so
    // a reentrant layer commit cannot see it as still owing a byte.
    downDecision[slot] = DECIDED_ON_OVERTAKE;
    undecidedContacts -= 1;
    pressOrdinals[slot] = NO_ORDINAL;
    const key = keyIndex === null ? undefined : geometry.keys[keyIndex];
    if (key === undefined) return;
    if (pointerId !== NO_POINTER) options.onRawProvisional?.(null, geometry.layerId, pointerId);
    emitCommit(key, pointerId, x, y, downAt[slot] ?? 0, false);
  }

  function cancelAll(): void {
    // Nothing is buffered any more, so there is nothing to flush before the
    // slots go: every commit was emitted on the event that decided it, while
    // `geometry` still described the layer it was typed on.
    for (let slot = 0; slot < capacity; slot += 1) {
      if (pointerIds[slot] !== NO_POINTER) releaseSlot(slot, true);
    }
  }

  function destroy(): void {
    if (destroyed) return;
    cancelAll();
    destroyed = true;
  }

  function findSlot(pointerId: number): number {
    for (let slot = 0; slot < capacity; slot += 1) {
      if (pointerIds[slot] === pointerId) return slot;
    }
    return NO_POINTER;
  }

  function findFreeSlot(): number {
    for (let slot = 0; slot < capacity; slot += 1) {
      if (pointerIds[slot] === NO_POINTER) return slot;
    }
    return NO_POINTER;
  }

  function switchSelectedKey(slot: number, nextKey: number): void {
    const previous = selectedKeys[slot] ?? NO_KEY;
    if (previous === nextKey) return;
    if (previous !== NO_KEY) setKeyActive(previous, false);
    selectedKeys[slot] = nextKey;
    setKeyActive(nextKey, true);
    emitProvisional(slot, nextKey);
  }

  function setKeyActive(keyIndex: number, active: boolean): void {
    const previous = activeCounts[keyIndex] ?? 0;
    const next = active ? Math.min(255, previous + 1) : Math.max(0, previous - 1);
    activeCounts[keyIndex] = next;
    if ((previous === 0) !== (next === 0)) options.onKeyStateChange?.(keyIndex, next > 0);
  }

  /**
   * `notifyProvisional` is false when the commit is buffered: the keycap must
   * un-press the instant the finger lifts, but the provisional glyph represents a
   * character that is still going to be typed, so it survives until the drain.
   */
  function releaseSlot(slot: number, notifyProvisional: boolean): void {
    const pointerId = pointerIds[slot] ?? NO_POINTER;
    const selected = selectedKeys[slot] ?? NO_KEY;
    if (selected !== NO_KEY) setKeyActive(selected, false);
    const repeatHandle = repeatHandles[slot];
    if (repeatHandle !== null) timers.clear(repeatHandle);
    if (notifyProvisional && pointerId !== NO_POINTER) {
      options.onRawProvisional?.(null, geometry.layerId, pointerId);
    }
    if (pointerId !== NO_POINTER) {
      if (downDecision[slot] === DECIDED_AT_RELEASE) undecidedContacts -= 1;
    }
    repeatHandles[slot] = null;
    repeatKeyIndices[slot] = NO_KEY;
    pointerIds[slot] = NO_POINTER;
    selectedKeys[slot] = NO_KEY;
    downDecision[slot] = DECIDED_AT_RELEASE;
    // Retired so a stale ordinal on a free slot can never be mistaken for the
    // live contact a queued entry is still waiting behind.
    pressOrdinals[slot] = NO_ORDINAL;
    trajectoryCounts[slot] = 0;
    trajectoryCursors[slot] = 0;
    contactSamples[slot] = 0;
  }

  function recordTrajectorySample(slot: number, x: number, y: number, timeStamp: number): void {
    const cursor = trajectoryCursors[slot] ?? 0;
    const offset = slot * TRAJECTORY_CAPACITY + cursor;
    trajectoryX[offset] = x;
    trajectoryY[offset] = y;
    trajectoryT[offset] = timeStamp;
    trajectoryCursors[slot] = (cursor + 1) % TRAJECTORY_CAPACITY;
    trajectoryCounts[slot] = Math.min(TRAJECTORY_CAPACITY, (trajectoryCounts[slot] ?? 0) + 1);
    // Saturating rather than wrapping: a contact that produced more samples than
    // this can represent is already far outside anything the histogram needs to
    // separate, and wrapping would report a small number for a huge stream.
    contactSamples[slot] = Math.min(0xffff, (contactSamples[slot] ?? 0) + 1);
  }

  function computeTrajectoryCentroid(
    slot: number,
    releaseAt: number,
    fallbackX: number,
    fallbackY: number,
  ): void {
    const count = trajectoryCounts[slot] ?? 0;
    if (count === 0) {
      centroidX[slot] = fallbackX;
      centroidY[slot] = fallbackY;
      return;
    }
    const base = slot * TRAJECTORY_CAPACITY;
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    for (let index = 0; index < count; index += 1) {
      const sampleAt = trajectoryT[base + index] ?? releaseAt;
      const age = Math.max(0, releaseAt - sampleAt);
      const weight = 1 / (1 + age * 0.08);
      weightedX += (trajectoryX[base + index] ?? fallbackX) * weight;
      weightedY += (trajectoryY[base + index] ?? fallbackY) * weight;
      totalWeight += weight;
    }
    centroidX[slot] = totalWeight > 0 ? weightedX / totalWeight : fallbackX;
    centroidY[slot] = totalWeight > 0 ? weightedY / totalWeight : fallbackY;
  }

  function classifyCurrentTouch(
    slot: number,
    x: number,
    y: number,
    timeStamp: number,
  ): number | null {
    const originX = downX[slot] ?? x;
    const originY = downY[slot] ?? y;
    const deltaX = x - originX;
    const deltaY = y - originY;
    computeTrajectoryCentroid(slot, timeStamp, x, y);
    return classifyKeyboardTouch(
      geometry,
      spatialPrior,
      originX,
      originY,
      centroidX[slot] ?? x,
      centroidY[slot] ?? y,
      x,
      y,
      keyboardReleaseWeight(
        deltaX * deltaX + deltaY * deltaY,
        profile.tapDrift,
        profile.slideDrift,
        profile.releaseWeight,
      ),
      keyPrior,
      profile.priorWeight,
      spatialWinner,
    );
  }

  /**
   * Keeps, for this contact's trace, the key the classification that just
   * decided it scored highest on the touch alone.
   */
  function keepSpatialWinner(slot: number): void {
    spatialKeys[slot] = spatialWinner[0] ?? -1;
  }

  function spatialKeyOf(slot: number): KeyboardKeyDefinition | null {
    return geometry.keys[spatialKeys[slot] ?? -1]?.definition ?? null;
  }

  function emitProvisional(slot: number, keyIndex: number): void {
    const key = geometry.keys[keyIndex];
    const pointerId = pointerIds[slot] ?? NO_POINTER;
    if (key !== undefined && pointerId !== NO_POINTER) {
      options.onRawProvisional?.(key, geometry.layerId, pointerId);
    }
  }

  function scheduleRepeat(slot: number, key: ResolvedKeyboardKey): void {
    const repeat = key.definition.repeat;
    if (repeat === undefined) return;
    repeatKeyIndices[slot] = key.index;
    const callback = repeatCallbacks[slot];
    if (callback !== undefined) repeatHandles[slot] = timers.set(callback, repeat.delayMs);
  }

  function repeatTick(slot: number): void {
    repeatHandles[slot] = null;
    const pointerId = pointerIds[slot] ?? NO_POINTER;
    const keyIndex = repeatKeyIndices[slot] ?? NO_KEY;
    if (pointerId === NO_POINTER || keyIndex === NO_KEY || selectedKeys[slot] !== keyIndex) return;
    const key = geometry.keys[keyIndex];
    const repeat = key?.definition.repeat;
    if (key === undefined || repeat === undefined) return;
    const now = timers.now?.() ?? performance.now();
    // A repeat tick is a fresh keystroke and must not overtake a character the
    // other thumb is still resting on.
    resolveOlderContacts(now, nextPressOrdinal);
    emitCommit(
      key,
      pointerId,
      lastX[slot] ?? key.rect.x + key.rect.width / 2,
      lastY[slot] ?? key.rect.y + key.rect.height / 2,
      Math.max(0, now - (downAt[slot] ?? now)),
      true,
    );
    if (pointerIds[slot] !== pointerId || selectedKeys[slot] !== keyIndex) return;
    const callback = repeatCallbacks[slot];
    if (callback !== undefined) repeatHandles[slot] = timers.set(callback, repeat.intervalMs);
  }

  function emitCommit(
    key: ResolvedKeyboardKey,
    pointerId: number,
    x: number,
    y: number,
    contactAtMs: number,
    repeat: boolean,
  ): void {
    const currentLayerId = geometry.layerId;
    options.onRawCommit?.(key, currentLayerId, pointerId, x, y, contactAtMs, repeat);
    options.onCommit?.({
      key: key.definition,
      layerId: currentLayerId,
      pointerId,
      x,
      y,
      contactAtMs,
      repeat,
    });
  }

  return {
    beginPointer,
    movePointer,
    endPointer,
    beginPointerAt,
    movePointerAt,
    endPointerAt,
    cancelPointer,
    activateKey,
    updateGeometry,
    updateTouchModel,
    setKeyPrior,
    cancelAll,
    destroy,
  };
}
