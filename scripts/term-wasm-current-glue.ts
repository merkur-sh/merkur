import { promises as fs } from 'node:fs';
import path from 'node:path';

const LEGACY_SYNC_INIT = `    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for \`initSync()\`; pass a single object instead')
        }
    }
`;

const CURRENT_SYNC_INIT = `    if (
        module === undefined ||
        module === null ||
        typeof module !== 'object' ||
        Object.getPrototypeOf(module) !== Object.prototype ||
        Object.keys(module).length !== 1 ||
        !Object.hasOwn(module, 'module')
    ) {
        throw new TypeError('initSync requires exactly { module }')
    }
    ({module} = module)
`;

const LEGACY_ASYNC_INIT = `    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }
`;

const CURRENT_ASYNC_INIT = `    if (module_or_path !== undefined) {
        if (
            module_or_path === null ||
            typeof module_or_path !== 'object' ||
            Object.getPrototypeOf(module_or_path) !== Object.prototype ||
            Object.keys(module_or_path).length !== 1 ||
            !Object.hasOwn(module_or_path, 'module_or_path')
        ) {
            throw new TypeError('WASM initialization requires exactly { module_or_path }')
        }
        ({module_or_path} = module_or_path)
    }
`;

const LEGACY_SYNC_DECLARATION = `/**
 * Instantiates the given \`module\`, which can either be bytes or
 * a precompiled \`WebAssembly.Module\`.
 *
 * @param {{ module: SyncInitInput }} module - Passing \`SyncInitInput\` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;`;

const CURRENT_SYNC_DECLARATION = `/**
 * Instantiates bytes or a precompiled module from the exact current options object.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput }): InitOutput;`;

const LEGACY_ASYNC_DECLARATION = `/**
 * If \`module_or_path\` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls \`WebAssembly.instantiate\` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing \`InitInput\` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;`;

const CURRENT_ASYNC_DECLARATION = `/**
 * Loads the default module or the input from the exact current options object.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> }): Promise<InitOutput>;`;

export interface TermWasmGlue {
  readonly javascript: string;
  readonly declarations: string;
}

export function hardCutLegacyTermWasmGlue(glue: TermWasmGlue): TermWasmGlue {
  const current = {
    javascript: replaceIfPresent(
      replaceIfPresent(glue.javascript, LEGACY_SYNC_INIT, CURRENT_SYNC_INIT, 'sync initializer'),
      LEGACY_ASYNC_INIT,
      CURRENT_ASYNC_INIT,
      'async initializer',
    ),
    declarations: replaceIfPresent(
      replaceIfPresent(
        glue.declarations,
        LEGACY_SYNC_DECLARATION,
        CURRENT_SYNC_DECLARATION,
        'sync declaration',
      ),
      LEGACY_ASYNC_DECLARATION,
      CURRENT_ASYNC_DECLARATION,
      'async declaration',
    ),
  };
  assertCurrentTermWasmGlue(current);
  return current;
}

export function assertCurrentTermWasmGlue(glue: TermWasmGlue): void {
  const violations: string[] = [];
  if (glue.javascript.includes('deprecated parameters')) {
    violations.push('JavaScript exposes deprecated initializer parameters');
  }
  if (!glue.javascript.includes("throw new TypeError('initSync requires exactly { module }')")) {
    violations.push('JavaScript lacks the exact sync initializer guard');
  }
  if (
    !glue.javascript.includes(
      "throw new TypeError('WASM initialization requires exactly { module_or_path }')",
    )
  ) {
    violations.push('JavaScript lacks the exact async initializer guard');
  }
  if (glue.declarations.includes('deprecated')) {
    violations.push('declarations expose a deprecated initializer');
  }
  if (
    !glue.declarations.includes(
      'export function initSync(module: { module: SyncInitInput }): InitOutput;',
    )
  ) {
    violations.push('declarations lack the exact sync initializer signature');
  }
  if (
    !glue.declarations.includes(
      'module_or_path?: { module_or_path: InitInput | Promise<InitInput> }',
    )
  ) {
    violations.push('declarations lack the exact async initializer signature');
  }
  if (violations.length > 0) {
    throw new Error(`terminal WASM glue is not current:\n${violations.join('\n')}`);
  }
}

export async function hardCutGeneratedTermWasmGlue(artifactDirectory: string): Promise<void> {
  const javascriptPath = path.join(artifactDirectory, 'term_wasm.js');
  const declarationsPath = path.join(artifactDirectory, 'term_wasm.d.ts');
  const current = hardCutLegacyTermWasmGlue({
    javascript: await fs.readFile(javascriptPath, 'utf8'),
    declarations: await fs.readFile(declarationsPath, 'utf8'),
  });
  await Promise.all([
    fs.writeFile(javascriptPath, current.javascript),
    fs.writeFile(declarationsPath, current.declarations),
  ]);
}

function replaceIfPresent(source: string, retired: string, current: string, label: string): string {
  const first = source.indexOf(retired);
  if (first < 0) return source;
  if (source.indexOf(retired, first + retired.length) >= 0) {
    throw new Error(`terminal WASM glue contains multiple retired ${label} blocks`);
  }
  return source.replace(retired, current);
}
