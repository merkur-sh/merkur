import type {
  KeyboardKeyDefinition,
  KeyboardKeyPlacement,
  KeyboardLayer,
  KeyboardLayout,
} from './types';

const MAX_KEYS_PER_LAYER = 254;
const PLACEMENT_EPSILON = 0.000_001;

/**
 * Validates a data-only layout at its package boundary. Applications may freely
 * construct, clone, persist, and replace these objects without subclassing the
 * engine or coupling their layout format to a rendering framework.
 */
export function createKeyboardLayout(layout: KeyboardLayout): KeyboardLayout {
  if (layout.id.length === 0) throw new Error('Keyboard layout id must not be empty');
  if (!(layout.initialLayer in layout.layers)) {
    throw new Error(`Unknown initial keyboard layer: ${layout.initialLayer}`);
  }

  const keyIds = Object.keys(layout.keys);
  if (keyIds.length === 0) throw new Error('Keyboard layout must define at least one key');
  for (const [keyId, key] of Object.entries(layout.keys)) validateKey(keyId, key);
  for (const [layerId, layer] of Object.entries(layout.layers)) {
    validateLayer(layerId, layer, layout.keys);
  }
  return layout;
}

function validateKey(keyId: string, key: KeyboardKeyDefinition): void {
  if (key.id !== keyId) throw new Error(`Keyboard key map id mismatch: ${keyId}`);
  if (key.label.length === 0 && key.ariaLabel === undefined) {
    throw new Error(`Keyboard key ${keyId} needs a label or aria label`);
  }
  if (key.kind === 'input' && key.value === undefined) {
    throw new Error(`Input key ${keyId} needs a value`);
  }
  if (key.kind === 'modifier' && key.modifier === undefined) {
    throw new Error(`Modifier key ${keyId} needs a modifier name`);
  }
  if (key.kind === 'action' && key.action === undefined) {
    throw new Error(`Action key ${keyId} needs an action name`);
  }
  if (key.kind === 'layer' && key.targetLayer === undefined) {
    throw new Error(`Layer key ${keyId} needs a target layer`);
  }
  if (key.repeat !== undefined) {
    if (key.activation !== 'press') {
      throw new Error(`Repeating key ${keyId} must activate on press`);
    }
    if (key.repeat.delayMs < 0 || key.repeat.intervalMs <= 0) {
      throw new Error(`Repeating key ${keyId} has invalid timing`);
    }
  }
}

function validateLayer(
  layerId: string,
  layer: KeyboardLayer,
  definitions: Readonly<Record<string, KeyboardKeyDefinition>>,
): void {
  if (layer.id !== layerId) throw new Error(`Keyboard layer map id mismatch: ${layerId}`);
  if (!Number.isFinite(layer.columns) || layer.columns <= 0) {
    throw new Error(`Keyboard layer ${layerId} has invalid columns`);
  }
  if (layer.rows.length === 0) throw new Error(`Keyboard layer ${layerId} has no rows`);

  let keyCount = 0;
  const placedIds = new Set<string>();
  for (const row of layer.rows) {
    if (row.keys.length === 0) throw new Error(`Keyboard layer ${layerId} has an empty row`);
    const sorted = [...row.keys].sort((left, right) => left.column - right.column);
    let previousEnd = 0;
    for (const placement of sorted) {
      validatePlacement(layer, placement, definitions);
      const span = placement.span ?? 1;
      if (placement.column + PLACEMENT_EPSILON < previousEnd) {
        throw new Error(`Keyboard layer ${layerId} has overlapping keys`);
      }
      previousEnd = placement.column + span;
      if (placedIds.has(placement.key)) {
        throw new Error(`Keyboard layer ${layerId} places ${placement.key} more than once`);
      }
      placedIds.add(placement.key);
      keyCount += 1;
    }
  }
  if (keyCount > MAX_KEYS_PER_LAYER) {
    throw new Error(`Keyboard layer ${layerId} exceeds ${MAX_KEYS_PER_LAYER} keys`);
  }
}

function validatePlacement(
  layer: KeyboardLayer,
  placement: KeyboardKeyPlacement,
  definitions: Readonly<Record<string, KeyboardKeyDefinition>>,
): void {
  const span = placement.span ?? 1;
  if (!(placement.key in definitions)) {
    throw new Error(`Keyboard layer ${layer.id} references unknown key ${placement.key}`);
  }
  if (!Number.isFinite(placement.column) || placement.column < 0) {
    throw new Error(`Keyboard key ${placement.key} has an invalid column`);
  }
  if (!Number.isFinite(span) || span <= 0) {
    throw new Error(`Keyboard key ${placement.key} has an invalid span`);
  }
  if (placement.column + span > layer.columns + PLACEMENT_EPSILON) {
    throw new Error(`Keyboard key ${placement.key} exceeds layer ${layer.id}`);
  }
}
