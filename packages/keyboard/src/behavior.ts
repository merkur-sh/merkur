import type { KeyboardBehaviorOptions, ResolvedKeyboardBehavior } from './types';

export const DEFAULT_KEYBOARD_BEHAVIOR: ResolvedKeyboardBehavior = Object.freeze({
  preview: 'keycap',
});

export function resolveKeyboardBehavior(
  options: KeyboardBehaviorOptions = DEFAULT_KEYBOARD_BEHAVIOR,
): ResolvedKeyboardBehavior {
  const behavior: ResolvedKeyboardBehavior = {
    preview: options.preview ?? DEFAULT_KEYBOARD_BEHAVIOR.preview,
  };

  if (behavior.preview !== 'none' && behavior.preview !== 'keycap') {
    throw new Error(`Unknown keyboard preview mode: ${String(behavior.preview)}`);
  }
  return behavior;
}
