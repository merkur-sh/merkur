import { describe, expect, test } from 'bun:test';
import { assertCurrentTermWasmGlue, hardCutLegacyTermWasmGlue } from './term-wasm-current-glue';

const LEGACY_JAVASCRIPT = `
function initSync(module) {
    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for \`initSync()\`; pass a single object instead')
        }
    }
}
async function __wbg_init(module_or_path) {
    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }
}
`;

const LEGACY_DECLARATIONS = `/**
 * Instantiates the given \`module\`, which can either be bytes or
 * a precompiled \`WebAssembly.Module\`.
 *
 * @param {{ module: SyncInitInput }} module - Passing \`SyncInitInput\` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If \`module_or_path\` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls \`WebAssembly.instantiate\` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing \`InitInput\` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;`;

describe('terminal WASM current glue', () => {
  test('removes both generated direct-argument compatibility overloads', () => {
    const current = hardCutLegacyTermWasmGlue({
      javascript: LEGACY_JAVASCRIPT,
      declarations: LEGACY_DECLARATIONS,
    });

    expect(() => assertCurrentTermWasmGlue(current)).not.toThrow();
    expect(current.javascript).not.toContain('deprecated parameters');
    expect(current.javascript).toContain('initSync requires exactly { module }');
    expect(current.declarations).not.toContain('| SyncInitInput');
    expect(current.declarations).not.toContain('| InitInput | Promise<InitInput>');
  });

  test('is idempotent and rejects glue without the current exact guards', () => {
    const current = hardCutLegacyTermWasmGlue({
      javascript: LEGACY_JAVASCRIPT,
      declarations: LEGACY_DECLARATIONS,
    });
    expect(hardCutLegacyTermWasmGlue(current)).toEqual(current);
    expect(() =>
      assertCurrentTermWasmGlue({
        javascript: 'function initSync(module) {}',
        declarations: 'export function initSync(module: SyncInitInput): InitOutput;',
      }),
    ).toThrow('terminal WASM glue is not current');
  });
});
