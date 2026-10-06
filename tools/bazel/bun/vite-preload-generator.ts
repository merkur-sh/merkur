import { readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const GENERATOR_FUNCTIONS = ['detectScriptRel', 'preload', 'getPreloadCode'];
const IMPORT_TOKEN = '𝐢𝐦𝐩𝐨𝐫𝐭';

export interface GeneratorSpan {
  name: string;
  start: number;
  end: number;
}

export interface PreparedPreloadGenerator {
  script: string;
  originalModule: string;
  spans: GeneratorSpan[];
}

/** Prepare the original published Vite generator for Node-API's script context. */
export function preparePreloadGenerator(source: string): PreparedPreloadGenerator {
  const originalBindings = generatorBindings(source);
  const original = originalBindings.spans
    .map((span) => source.slice(span.start, span.end))
    .join('\n');
  const originalModule = `${original}\nexport { getPreloadCode, preload, detectScriptRel };`;
  // Vite's configured Bun action loads ES modules through this same pinned compiler.
  // Its Function.toString text differs from raw source and is part of the output.
  const compiled = new Bun.Transpiler({ loader: 'js', target: 'bun' }).transformSync(
    originalModule,
  );
  const { spans, importMeta } = generatorBindings(compiled);
  importMeta.sort((a, b) => a.start - b.start);
  const prepared = spans
    .map((span) => {
      let code = compiled.slice(span.start, span.end);
      for (const replacement of importMeta.toReversed()) {
        if (replacement.start < span.start || replacement.end > span.end) continue;
        if (compiled.slice(replacement.start, replacement.end) !== 'import.meta') {
          throw new Error('Original Vite import-meta source span is invalid');
        }
        const start = replacement.start - span.start;
        const end = replacement.end - span.start;
        code = code.slice(0, start) + `${IMPORT_TOKEN}.meta` + code.slice(end);
      }
      return code;
    })
    .join('\n');
  const invoke =
    '(base, polyfill, renderBuiltUrl, isRelativeBase) => ' +
    'getPreloadCode({config: {base, build: {modulePreload: {polyfill}}}}, renderBuiltUrl, isRelativeBase)';
  const script = `(() => {\n${prepared}\nreturn ${invoke};\n})()`;
  const checked = parseSync('vite-preload-generator.js', script, { sourceType: 'script' });
  if (checked.errors.length !== 0) {
    throw new Error('Original Vite generator cannot execute in Node-API script context');
  }
  return { script, originalModule, spans: originalBindings.spans };
}

function generatorBindings(source: string): {
  spans: GeneratorSpan[];
  importMeta: { start: number; end: number }[];
} {
  const parsed = parseSync('vite/dist/node/chunks/node.js', source, { sourceType: 'module' });
  if (parsed.errors.length !== 0) throw new Error('Original Vite generator source is invalid');
  const spans: GeneratorSpan[] = [];
  const importMeta: { start: number; end: number }[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id) {
      const name = statement.id.name;
      if (!GENERATOR_FUNCTIONS.includes(name)) continue;
      spans.push({ name, start: statement.start, end: statement.end });
      if (name === 'preload') {
        collectImportMeta(statement, importMeta);
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== 'Identifier' || declaration.id.name !== 'preloadMethod')
          continue;
        if (
          statement.kind !== 'const' ||
          statement.declarations.length !== 1 ||
          !declaration.init
        ) {
          throw new Error('Original Vite preload method declaration is ambiguous');
        }
        spans.push({ name: 'preloadMethod', start: statement.start, end: statement.end });
      }
    }
  }
  for (const name of [...GENERATOR_FUNCTIONS, 'preloadMethod']) {
    if (spans.filter((span) => span.name === name).length !== 1) {
      throw new Error(`Original Vite generator declaration is missing or ambiguous: ${name}`);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return { spans, importMeta };
}

function collectImportMeta(value: unknown, result: { start: number; end: number }[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImportMeta(item, result);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node.type === 'MetaProperty') {
    const meta = node.meta as Record<string, unknown>;
    const property = node.property as Record<string, unknown>;
    if (meta.name !== 'import' || property.name !== 'meta') return;
    if (typeof node.start !== 'number' || typeof node.end !== 'number') {
      throw new Error('Original Vite import-meta node has no source span');
    }
    result.push({ start: node.start, end: node.end });
  }
  for (const item of Object.values(node)) collectImportMeta(item, result);
}

if (import.meta.main) {
  const [sourceFile, outputFile, ...extra] = process.argv.slice(2);
  if (!sourceFile || !outputFile || extra.length !== 0) {
    throw new Error('Expected original Vite File and generated script File');
  }
  const source = readFileSync(sourceFile);
  const prepared = preparePreloadGenerator(source.toString('utf8'));
  writeFileSync(outputFile, prepared.script, { flag: 'wx' });
  if (!readFileSync(sourceFile).equals(source)) {
    throw new Error('Original Vite generator File changed during preparation');
  }
}
