export type KeyboardKeyKind = 'input' | 'modifier' | 'action' | 'layer';

export type KeyboardKeyVariant = 'character' | 'special' | 'accent' | 'space';

export type KeyboardPreviewMode = 'none' | 'keycap';

export interface KeyboardBehaviorOptions {
  readonly preview?: KeyboardPreviewMode;
}

export interface ResolvedKeyboardBehavior {
  readonly preview: KeyboardPreviewMode;
}

export interface KeyboardRepeatConfig {
  readonly delayMs: number;
  readonly intervalMs: number;
}

export interface KeyboardKeyDefinition {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly kind: KeyboardKeyKind;
  readonly value?: string;
  readonly shiftedLabel?: string;
  readonly shiftedValue?: string;
  readonly modifier?: string;
  readonly action?: string;
  readonly targetLayer?: string;
  readonly variant?: KeyboardKeyVariant;
  readonly activation?: 'press' | 'release';
  readonly repeat?: KeyboardRepeatConfig;
}

export interface KeyboardKeyPlacement {
  readonly key: string;
  /** Start position in layer columns. Fractional columns are supported. */
  readonly column: number;
  /** Width in layer columns. A span of one is one standard character key. */
  readonly span?: number;
}

export interface KeyboardRow {
  readonly keys: readonly KeyboardKeyPlacement[];
}

export interface KeyboardLayer {
  readonly id: string;
  /** Shared horizontal track count. Ten matches the iPhone Latin layout. */
  readonly columns: number;
  readonly rows: readonly KeyboardRow[];
}

export interface KeyboardLayout {
  readonly id: string;
  readonly initialLayer: string;
  readonly keys: Readonly<Record<string, KeyboardKeyDefinition>>;
  readonly layers: Readonly<Record<string, KeyboardLayer>>;
}

export interface KeyboardGeometryProfile {
  readonly horizontalPadding: number;
  readonly topPadding: number;
  readonly bottomPadding: number;
  /** System-control band below the visible surface; bottom-row hit regions extend through it. */
  readonly bottomUtilityHeight: number;
  readonly keyGap: number;
  readonly rowGap: number;
  readonly keyHeight: number;
  readonly cornerRadius: number;
  readonly hysteresis: number;
  readonly tapDrift: number;
  /**
   * Drift at which the gesture is unambiguously a deliberate slide and the
   * release point alone decides. Between `tapDrift` and here the release
   * sample's weight ramps; it never jumps. Must be at least `tapDrift`.
   */
  readonly slideDrift: number;
  /** Weight of the release sample for a contact that never left `tapDrift`. */
  readonly releaseWeight: number;
  /**
   * How far the causal key prior may bend a decision, in log-odds per nat.
   * Zero disables it. It only ever applies outside a key's anchor, so raising it
   * cannot make a tap on a key's own centre commit a different key.
   */
  readonly priorWeight: number;
  readonly maximumPointers: number;
}

export interface KeyboardRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ResolvedKeyboardKey {
  readonly index: number;
  readonly row: number;
  readonly definition: KeyboardKeyDefinition;
  readonly placement: KeyboardKeyPlacement;
  readonly rect: KeyboardRect;
}

export interface ResolvedKeyboardGeometry {
  readonly layerId: string;
  readonly width: number;
  /** Exact interactive height, including any invisible bottom utility band. */
  readonly hitHeight: number;
  readonly height: number;
  readonly atlasWidth: number;
  /** Candidate-atlas height, which may include an invisible bottom utility band below `height`. */
  readonly atlasHeight: number;
  /** Four nearest plausible keys for every CSS-pixel coordinate; the first is the hit winner. */
  readonly candidateAtlas: Uint8Array;
  readonly keys: readonly ResolvedKeyboardKey[];
  readonly rows: readonly (readonly number[])[];
}

export interface KeyboardPointerSample {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly timeStamp: number;
}

/** Allocation-free per-key spatial parameters used by touch recognition. */
export interface KeyboardTouchModel {
  readonly keyCount: number;
  readonly centerX: Float64Array;
  readonly centerY: Float64Array;
  readonly precisionXX: Float32Array;
  readonly precisionXY: Float32Array;
  readonly precisionYY: Float32Array;
}

export type KeyboardTouchModelResolver = (
  geometry: ResolvedKeyboardGeometry,
) => KeyboardTouchModel | undefined;

/** Release-time gesture summary, built for every classifiable contact. */
export interface KeyboardTouchTrace {
  /** Null when the contact ended without a classifiable key commit. */
  readonly predictedKey: KeyboardKeyDefinition | null;
  readonly layerId: string;
  readonly pointerId: number;
  readonly downX: number;
  readonly downY: number;
  readonly trajectoryX: number;
  readonly trajectoryY: number;
  readonly releaseX: number;
  readonly releaseY: number;
  readonly durationMs: number;
  /**
   * Every pointer sample this contact produced, uncensored. The engine's own
   * trajectory ring keeps only the most recent few for the centroid, so its
   * count saturates; this one does not, because telling a browser that delivers
   * eight move samples from one that delivers thirty is the point.
   */
  readonly sampleCount: number;
  /**
   * Pointer timestamp of touch-down, in the caller's event time base. Consumers
   * that want an inter-tap interval subtract the previous contact's value, which
   * needs one remembered number rather than a keystroke sequence.
   */
  readonly contactAtMs: number;
  /**
   * The committed key's centre in the touch model the engine was scoring with
   * when this contact ended: the visual centre plus whatever the learner had
   * applied. NaN when no key committed. A tap's distance from this, rather than
   * from the drawn key, is the error the personalised model still leaves.
   */
  readonly modelCenterX: number;
  readonly modelCenterY: number;
  /**
   * The key the touch alone scored highest, before the context prior: equal to
   * `predictedKey` unless the prior changed the decision. Once the user's own
   * correction says which key was meant, this is what tells a miss the finger
   * made from one the prior made.
   */
  readonly spatialKey: KeyboardKeyDefinition | null;
}

export interface KeyboardEngineCommit {
  readonly key: KeyboardKeyDefinition;
  readonly layerId: string;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /**
   * The pointer event timestamp of touch-down, in the caller's event time base.
   * Deliberately not an elapsed duration: a key decided at touch-down has no
   * duration yet. The physical contact duration is reported separately, on
   * `KeyboardTouchTrace.durationMs`, when the finger actually lifts.
   */
  readonly contactAtMs: number;
  readonly repeat: boolean;
}

export interface KeyboardCommit extends KeyboardEngineCommit {
  readonly value: string | undefined;
}

export interface KeyboardTheme {
  readonly background?: string;
  readonly keyBackground?: string;
  readonly specialKeyBackground?: string;
  readonly accentKeyBackground?: string;
  readonly pressedKeyBackground?: string;
  readonly activeKeyBackground?: string;
  readonly foreground?: string;
  readonly mutedForeground?: string;
  readonly keyShadow?: string;
  readonly fontFamily?: string;
  readonly characterFontSize?: string;
  readonly specialFontSize?: string;
}

export interface KeyboardProfileContext {
  readonly width: number;
  readonly devicePixelRatio: number;
  readonly orientation: 'portrait' | 'landscape';
}

export type KeyboardProfileResolver = (context: KeyboardProfileContext) => KeyboardGeometryProfile;

export type KeyboardLabelResolver = (
  key: KeyboardKeyDefinition,
  activeModifiers: ReadonlySet<string>,
) => string;
