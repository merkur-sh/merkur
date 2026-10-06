import path from 'node:path';
import { parseSync } from 'oxc-parser';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  return value.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined;
}

function identifier(value: unknown, name: string): boolean {
  return record(value) && value.type === 'Identifier' && value.name === name;
}

function memberObject(value: unknown, property: string): unknown {
  if (
    !record(value) ||
    value.type !== 'MemberExpression' ||
    value.computed === true ||
    !record(value.property)
  )
    return undefined;
  return value.property.name === property ? value.object : undefined;
}

function importMeta(value: unknown): boolean {
  return (
    record(value) &&
    value.type === 'MetaProperty' &&
    identifier(value.meta, 'import') &&
    identifier(value.property, 'meta')
  );
}

interface Requests {
  readonly requests: Set<string>;
  readonly relativeFiles: Set<string>;
  readonly programFiles: Set<string>;
  computedImports: number;
  computedFiles: number;
  readonly bindings: Map<string, string>;
  readonly runtimeOutputReads: ReadonlySet<unknown>;
}

function importedBindings(program: unknown): Map<string, string> {
  const bindings = new Map<string, string>();
  if (!record(program) || !Array.isArray(program.body)) return bindings;
  for (const node of program.body) {
    if (!record(node) || node.type !== 'ImportDeclaration' || !Array.isArray(node.specifiers))
      continue;
    const source = literal(node.source);
    if (source === undefined) continue;
    for (const specifier of node.specifiers) {
      if (!record(specifier) || !record(specifier.local)) continue;
      const local = specifier.local.name;
      if (typeof local !== 'string') continue;
      const imported = record(specifier.imported) ? specifier.imported.name : undefined;
      const member = typeof imported === 'string' ? imported : '*';
      bindings.set(local, `${source}:${member}`);
    }
  }
  taintShadowedBindings(program, bindings);
  return bindings;
}

function taintPattern(pattern: unknown, bindings: Map<string, string>): void {
  if (!record(pattern)) return;
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    const binding = bindings.get(pattern.name);
    if (binding !== undefined && !binding.startsWith('shadowed:'))
      bindings.set(pattern.name, `shadowed:${binding}`);
    return;
  }
  if (pattern.type === 'AssignmentPattern') taintPattern(pattern.left, bindings);
  else if (pattern.type === 'RestElement') taintPattern(pattern.argument, bindings);
  else if (pattern.type === 'ArrayPattern' && Array.isArray(pattern.elements)) {
    for (const element of pattern.elements) taintPattern(element, bindings);
  } else if (pattern.type === 'ObjectPattern' && Array.isArray(pattern.properties)) {
    for (const property of pattern.properties) {
      if (record(property))
        taintPattern(
          property.type === 'RestElement' ? property.argument : property.value,
          bindings,
        );
    }
  }
}

function taintShadowedBindings(node: unknown, bindings: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) taintShadowedBindings(child, bindings);
    return;
  }
  if (!record(node)) return;
  if (node.type === 'VariableDeclarator' || node.type === 'ClassDeclaration')
    taintPattern(node.id, bindings);
  if (
    ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
      String(node.type),
    )
  ) {
    taintPattern(node.id, bindings);
    if (Array.isArray(node.params))
      for (const parameter of node.params) taintPattern(parameter, bindings);
  }
  if (node.type === 'CatchClause') taintPattern(node.param, bindings);
  for (const [key, value] of Object.entries(node)) {
    if (!['parent', 'comments', 'tokens'].includes(key)) taintShadowedBindings(value, bindings);
  }
}

function imported(value: unknown, bindings: Map<string, string>): string | undefined {
  if (!record(value)) return undefined;
  if (value.type === 'Identifier' && typeof value.name === 'string')
    return bindings.get(value.name);
  if (value.type !== 'MemberExpression' || value.computed === true || !record(value.property))
    return undefined;
  const object = imported(value.object, bindings);
  const property = value.property.name;
  if (object === undefined || typeof property !== 'string') return undefined;
  return object.endsWith(':*') ? `${object.slice(0, -1)}${property}` : `${object}.${property}`;
}

function sourceRelativeFile(value: unknown, bindings: Map<string, string>): string | undefined {
  if (importMeta(memberObject(value, 'dir'))) return '.';
  if (!record(value)) return undefined;
  if (value.type === 'TemplateLiteral') {
    const suffix = importMetaDirectorySuffix(value);
    return suffix?.startsWith('/') ? `.${suffix}` : undefined;
  }
  if (value.type !== 'CallExpression' || !Array.isArray(value.arguments)) return undefined;
  const callee = imported(value.callee, bindings);
  if (!['node:path:join', 'path:join', 'node:path:resolve', 'path:resolve'].includes(callee ?? ''))
    return undefined;
  if (!importMeta(memberObject(value.arguments[0], 'dir'))) return undefined;
  const components = value.arguments.slice(1).map(literal);
  if (components.some((component) => component === undefined)) return undefined;
  const parts = components as string[];
  if (parts.some((component) => path.posix.isAbsolute(component))) return undefined;
  return path.posix.join('.', ...parts);
}

export interface RuntimeOutputDirectory {
  readonly environment: 'MERKUR_BAZEL_SCRATCH_ROOT';
  readonly directory: string;
}

function nodes(
  value: unknown,
  result: Record<string, unknown>[] = [],
  descendFunctions = true,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) nodes(child, result, descendFunctions);
  } else if (record(value)) {
    if (
      !descendFunctions &&
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
        String(value.type),
      )
    )
      return result;
    result.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (!['parent', 'comments', 'tokens'].includes(key)) nodes(child, result, descendFunctions);
    }
  }
  return result;
}

function constants(body: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const node of nodes(body, [], false)) {
    if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) continue;
    for (const declaration of node.declarations) {
      if (!record(declaration) || !record(declaration.id)) continue;
      if (declaration.id.type === 'Identifier' && typeof declaration.id.name === 'string') {
        const name = declaration.id.name;
        result.set(name, node.kind === 'const' && !result.has(name) ? declaration.init : undefined);
      } else {
        const names = new Map(
          nodes(declaration.id)
            .filter((part) => part.type === 'Identifier' && typeof part.name === 'string')
            .map((part) => [String(part.name), 'declaration']),
        );
        taintPattern(declaration.id, names);
        for (const [name, binding] of names) {
          if (binding.startsWith('shadowed:')) result.set(name, undefined);
        }
      }
    }
  }
  return result;
}

function stableBindings(body: unknown, names: readonly string[]): boolean {
  const bindings = new Map(names.map((name) => [name, 'constant']));
  for (const node of nodes(body, [], false)) {
    if (node.type === 'AssignmentExpression') taintPattern(node.left, bindings);
    if (node.type === 'UpdateExpression') taintPattern(node.argument, bindings);
  }
  return [...bindings.values()].every((value) => value === 'constant');
}

function resolved(value: unknown, definitions: Map<string, unknown>): unknown {
  const seen = new Set<string>();
  while (record(value) && value.type === 'Identifier' && typeof value.name === 'string') {
    if (seen.has(value.name)) return undefined;
    seen.add(value.name);
    value = definitions.get(value.name);
  }
  return value;
}

function environmentRoot(
  value: unknown,
  definitions: Map<string, unknown>,
  environment: string,
): boolean {
  value = resolved(value, definitions);
  return identifier(memberObject(memberObject(value, environment), 'env'), 'process');
}

function runtimeDirectory(
  value: unknown,
  definitions: Map<string, unknown>,
  bindings: Map<string, string>,
  output: RuntimeOutputDirectory,
): boolean {
  value = resolved(value, definitions);
  if (record(value) && value.type === 'ConditionalExpression' && record(value.test)) {
    const condition = value.test;
    if (
      condition.type !== 'BinaryExpression' ||
      condition.operator !== '===' ||
      !identifier(condition.right, 'undefined') ||
      !environmentRoot(condition.left, definitions, output.environment)
    )
      return false;
    // The declared runner binds this root. The source-run default is never
    // qualified as part of the declared action's writable namespace.
    value = value.alternate;
  }
  if (!record(value) || value.type !== 'CallExpression' || !Array.isArray(value.arguments))
    return false;
  return (
    imported(value.callee, bindings) === 'node:path:join' &&
    value.arguments.length === 2 &&
    environmentRoot(value.arguments[0], definitions, output.environment) &&
    literal(value.arguments[1]) === output.directory
  );
}

function hashedBytes(value: unknown): string | undefined {
  if (
    !record(value) ||
    value.type !== 'CallExpression' ||
    !Array.isArray(value.arguments) ||
    value.arguments.length !== 1 ||
    literal(value.arguments[0]) !== 'hex'
  )
    return undefined;
  const update = memberObject(value.callee, 'digest');
  if (
    !record(update) ||
    update.type !== 'CallExpression' ||
    !Array.isArray(update.arguments) ||
    update.arguments.length !== 1 ||
    !record(update.arguments[0]) ||
    update.arguments[0].type !== 'Identifier' ||
    typeof update.arguments[0].name !== 'string'
  )
    return undefined;
  const hasher = memberObject(update.callee, 'update');
  if (
    !record(hasher) ||
    hasher.type !== 'NewExpression' ||
    !Array.isArray(hasher.arguments) ||
    hasher.arguments.length !== 1 ||
    literal(hasher.arguments[0]) !== 'sha256' ||
    !identifier(memberObject(hasher.callee, 'CryptoHasher'), 'Bun')
  )
    return undefined;
  return update.arguments[0].name;
}

function stagingFile(value: unknown, file: string): boolean {
  if (
    !record(value) ||
    value.type !== 'TemplateLiteral' ||
    !Array.isArray(value.expressions) ||
    !Array.isArray(value.quasis) ||
    value.expressions.length !== 3 ||
    value.quasis.length !== 4
  )
    return false;
  const [first, processId, random] = value.expressions;
  return (
    identifier(first, file) &&
    identifier(memberObject(processId, 'pid'), 'process') &&
    record(random) &&
    random.type === 'CallExpression' &&
    Array.isArray(random.arguments) &&
    random.arguments.length === 0 &&
    identifier(memberObject(random.callee, 'randomUUID'), 'crypto') &&
    JSON.stringify(value.quasis.map(quasiText)) === JSON.stringify(['', '.', '.', ''])
  );
}

function generatedFile(
  value: unknown,
  producer: Record<string, unknown>,
  globals: Map<string, unknown>,
  bindings: Map<string, string>,
  outputs: readonly RuntimeOutputDirectory[],
): boolean {
  if (!record(value) || value.type !== 'Identifier' || typeof value.name !== 'string') return false;
  const fileName = value.name;
  const locals = constants(producer.body);
  const definitions = new Map([...globals, ...locals]);
  if (!stableBindings(producer.body, [...definitions.keys()])) return false;
  for (const parameter of Array.isArray(producer.params) ? producer.params : []) {
    if (record(parameter) && typeof parameter.name === 'string') definitions.delete(parameter.name);
  }
  const file = definitions.get(fileName);
  if (
    !record(file) ||
    file.type !== 'CallExpression' ||
    !Array.isArray(file.arguments) ||
    file.arguments.length !== 2 ||
    imported(file.callee, bindings) !== 'node:path:join'
  )
    return false;
  const [directory, digest] = file.arguments;
  if (!outputs.some((output) => runtimeDirectory(directory, definitions, bindings, output)))
    return false;
  const bytes = hashedBytes(digest);
  if (bytes === undefined || definitions.get(bytes) === undefined || !locals.has(bytes))
    return false;
  const calls = nodes(producer.body, [], false).filter((node) => node.type === 'CallExpression');
  for (const [temporary, initializer] of locals) {
    if (!stagingFile(initializer, fileName)) continue;
    const write = calls.find(
      (node) =>
        imported(node.callee, bindings) === 'node:fs:writeFileSync' &&
        Array.isArray(node.arguments) &&
        identifier(node.arguments[0], temporary) &&
        identifier(node.arguments[1], bytes),
    );
    const rename = calls.find(
      (node) =>
        imported(node.callee, bindings) === 'node:fs:renameSync' &&
        Array.isArray(node.arguments) &&
        identifier(node.arguments[0], temporary) &&
        identifier(node.arguments[1], fileName),
    );
    if (
      write !== undefined &&
      rename !== undefined &&
      typeof write.start === 'number' &&
      typeof rename.start === 'number' &&
      write.start < rename.start
    )
      return true;
  }
  return false;
}

function privateCalls(
  program: unknown,
  reader: Record<string, unknown>,
  functions: readonly Record<string, unknown>[],
): { producer: Record<string, unknown>; call: Record<string, unknown> }[] {
  if (!record(reader.id) || typeof reader.id.name !== 'string') return [];
  const name = reader.id.name;
  const calls = functions.flatMap((producer) =>
    nodes(producer.body, [], false)
      .filter((node) => node.type === 'CallExpression' && identifier(node.callee, name))
      .map((call) => ({ producer, call })),
  );
  const references = new Set([reader.id, ...calls.map(({ call }) => call.callee)]);
  if (nodes(program).some((node) => identifier(node, name) && !references.has(node))) return [];
  if (
    calls.some(
      ({ producer }) =>
        constants(producer.body).has(name) ||
        (Array.isArray(producer.params) &&
          producer.params.some((parameter) => identifier(parameter, name))),
    )
  )
    return [];
  return calls;
}

function unmodifiedBuiltins(program: unknown): boolean {
  const bindings = new Map(
    ['Bun', 'process', 'crypto', 'globalThis'].map((name) => [name, 'global']),
  );
  taintShadowedBindings(program, bindings);
  for (const node of nodes(program)) {
    if (node.type === 'ImportDeclaration' && Array.isArray(node.specifiers)) {
      for (const specifier of node.specifiers) {
        if (record(specifier)) taintPattern(specifier.local, bindings);
      }
    }
    const targets =
      node.type === 'CallExpression' && Array.isArray(node.arguments)
        ? node.arguments
        : [
            node.type === 'AssignmentExpression'
              ? node.left
              : node.type === 'UpdateExpression' ||
                  (node.type === 'UnaryExpression' && node.operator === 'delete')
                ? node.argument
                : undefined,
          ];
    for (let target of targets) {
      while (record(target) && target.type === 'MemberExpression') target = target.object;
      taintPattern(target, bindings);
    }
  }
  return [...bindings.values()].every((value) => value === 'global');
}

function runtimeOutputReads(
  program: unknown,
  bindings: Map<string, string>,
  outputs: readonly RuntimeOutputDirectory[],
): Set<unknown> {
  const reads = new Set<unknown>();
  if (outputs.length === 0 || !record(program) || !Array.isArray(program.body)) return reads;
  for (const output of outputs) {
    if (
      output.environment !== 'MERKUR_BAZEL_SCRATCH_ROOT' ||
      output.directory === '' ||
      path.posix.isAbsolute(output.directory) ||
      output.directory.split('/').some((part) => part === '..' || part === '.' || part === '')
    )
      throw new Error('Runtime output directory requires the declared scratch namespace');
  }
  if (!unmodifiedBuiltins(program)) return reads;
  const globals = constants(
    program.body.filter((node) => record(node) && node.type === 'VariableDeclaration'),
  );
  if (!stableBindings(program, [...globals.keys()])) return reads;
  const functions: Record<string, unknown>[] = [];
  const privateFunctions: Record<string, unknown>[] = [];
  for (const entry of program.body) {
    if (!record(entry)) continue;
    const node = entry.type === 'ExportNamedDeclaration' ? entry.declaration : entry;
    if (record(node) && node.type === 'FunctionDeclaration') {
      functions.push(node);
      if (entry.type !== 'ExportNamedDeclaration') privateFunctions.push(node);
    }
  }
  for (const reader of privateFunctions) {
    if (!Array.isArray(reader.params)) continue;
    const callers = privateCalls(program, reader, functions);
    if (callers.length === 0) continue;
    for (const call of nodes(reader.body, [], false)) {
      if (
        call.type !== 'CallExpression' ||
        imported(call.callee, bindings) !== 'node:fs:readFileSync' ||
        !Array.isArray(call.arguments) ||
        !record(call.arguments[0]) ||
        call.arguments[0].type !== 'Identifier'
      )
        continue;
      const argument = call.arguments[0];
      const parameter = reader.params.findIndex((param) =>
        identifier(param, String(argument.name)),
      );
      if (
        parameter < 0 ||
        constants(reader.body).has(String(argument.name)) ||
        !stableBindings(reader.body, [String(argument.name)])
      )
        continue;
      if (
        callers.every(
          ({ producer, call: caller }) =>
            Array.isArray(caller.arguments) &&
            generatedFile(caller.arguments[parameter], producer, globals, bindings, outputs),
        )
      )
        reads.add(call);
    }
  }
  return reads;
}

function fileRequest(value: unknown, inputs: Requests): void {
  const relative = sourceRelativeFile(value, inputs.bindings);
  if (relative !== undefined) {
    inputs.relativeFiles.add(relative);
    return;
  }
  const file = literal(value);
  if (file !== undefined && !path.posix.isAbsolute(file)) {
    inputs.programFiles.add(file);
    return;
  }
  // URL references already have their own source-relative AST handler.
  if (
    record(value) &&
    value.type === 'NewExpression' &&
    (identifier(value.callee, 'URL') ||
      identifier(memberObject(value.callee, 'URL'), 'globalThis')) &&
    Array.isArray(value.arguments) &&
    importMeta(memberObject(value.arguments[1], 'url')) &&
    literal(value.arguments[0]) !== undefined
  )
    return;
  inputs.computedFiles++;
}

function sourceRequest(node: Record<string, unknown>, inputs: Requests): void {
  const request = literal(node.source);
  if (request !== undefined) inputs.requests.add(request);
  else if (node.type === 'ImportExpression') inputs.computedImports++;
}

function expressionRequest(node: Record<string, unknown>, inputs: Requests): void {
  const request = literal(node.expression);
  if (request !== undefined) inputs.requests.add(request);
}

function quasiText(value: unknown): string | undefined {
  if (!record(value) || !record(value.value)) return undefined;
  return typeof value.value.cooked === 'string' ? value.value.cooked : undefined;
}

function importMetaDirectorySuffix(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.expressions) || value.expressions.length !== 1) return undefined;
  if (!Array.isArray(value.quasis) || value.quasis.length !== 2) return undefined;
  if (!importMeta(memberObject(value.expressions[0], 'dir')) || quasiText(value.quasis[0]) !== '')
    return undefined;
  return quasiText(value.quasis[1]);
}

function relativeProgram(value: unknown): string | undefined {
  if (!record(value) || value.type !== 'TemplateLiteral') return undefined;
  const suffix = importMetaDirectorySuffix(value);
  return suffix?.endsWith('.ts') ? `.${suffix}` : undefined;
}

function bunProgram(command: unknown, inputs: Requests): void {
  if (!record(command) || !Array.isArray(command.elements)) return;
  const executable = command.elements[0];
  if (literal(executable) !== 'bun' && !identifier(memberObject(executable, 'execPath'), 'process'))
    return;
  const program = command.elements[literal(command.elements[1]) === 'run' ? 2 : 1];
  const entry = literal(program);
  if (entry?.endsWith('.ts')) inputs.programFiles.add(entry);
  const relative = relativeProgram(program);
  if (relative !== undefined) inputs.relativeFiles.add(relative);
}

function callRequest(node: Record<string, unknown>, inputs: Requests): void {
  if (!Array.isArray(node.arguments)) return;
  const binding = imported(node.callee, inputs.bindings);
  const unshadowed = binding?.replace(/^shadowed:/, '');
  if (
    identifier(node.callee, 'require') ||
    importMeta(memberObject(node.callee, 'resolve')) ||
    unshadowed === 'bun:test:mock.module'
  ) {
    if (binding?.startsWith('shadowed:')) {
      inputs.computedImports++;
      return;
    }
    const request = literal(node.arguments[0]);
    if (request !== undefined) inputs.requests.add(request);
    else inputs.computedImports++;
    return;
  }
  if (
    identifier(memberObject(node.callee, 'file'), 'Bun') ||
    [
      'node:fs:readFile',
      'node:fs:readFileSync',
      'node:fs:promises.readFile',
      'fs:readFile',
      'fs:readFileSync',
      'fs:promises.readFile',
      'node:fs/promises:readFile',
      'fs/promises:readFile',
    ].includes(unshadowed ?? '')
  )
    if (binding?.startsWith('shadowed:')) inputs.computedFiles++;
    else if (!inputs.runtimeOutputReads.has(node)) fileRequest(node.arguments[0], inputs);
  const bunSpawn =
    identifier(memberObject(node.callee, 'spawn'), 'Bun') ||
    identifier(memberObject(node.callee, 'spawnSync'), 'Bun');
  // A test runs its child through the repository's awaited spawn, whose first argument is the
  // same argv.
  if (bunSpawn || unshadowed?.endsWith('/test-process:runTestProcess'))
    bunProgram(node.arguments[0], inputs);
}

function urlRequest(node: Record<string, unknown>, inputs: Requests): void {
  const url =
    identifier(node.callee, 'URL') || identifier(memberObject(node.callee, 'URL'), 'globalThis');
  if (!url || !Array.isArray(node.arguments)) return;
  if (!importMeta(memberObject(node.arguments[1], 'url'))) return;
  const relative = literal(node.arguments[0]);
  if (relative !== undefined) inputs.relativeFiles.add(relative);
}

const handlers: Readonly<
  Record<string, (node: Record<string, unknown>, inputs: Requests) => void>
> = {
  ImportDeclaration: sourceRequest,
  ExportNamedDeclaration: sourceRequest,
  ExportAllDeclaration: sourceRequest,
  ImportExpression: sourceRequest,
  TSImportType: sourceRequest,
  TSExternalModuleReference: expressionRequest,
  CallExpression: callRequest,
  NewExpression: urlRequest,
};

function visit(node: unknown, inputs: Requests): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, inputs);
    return;
  }
  if (!record(node)) return;
  if (typeof node.type === 'string') handlers[node.type]?.(node, inputs);
  for (const [key, value] of Object.entries(node)) {
    if (!['parent', 'comments', 'tokens'].includes(key)) visit(value, inputs);
  }
}

export function moduleRequests(
  file: string,
  source: string,
  runtimeOutputs: readonly RuntimeOutputDirectory[] = [],
): {
  requests: string[];
  relativeFiles: string[];
  programFiles: string[];
  computedImports: number;
  computedFiles: number;
} {
  const ast = parseSync(file, source, { sourceType: 'module', astType: 'ts' });
  if (ast.errors.length !== 0) throw new Error(`Cannot parse source inputs for ${file}`);
  const bindings = importedBindings(ast.program);
  const inputs: Requests = {
    requests: new Set(),
    relativeFiles: new Set(),
    programFiles: new Set(),
    computedImports: 0,
    computedFiles: 0,
    bindings,
    runtimeOutputReads: runtimeOutputReads(ast.program, bindings, runtimeOutputs),
  };
  visit(ast.program, inputs);
  return {
    requests: [...inputs.requests].sort(),
    relativeFiles: [...inputs.relativeFiles].sort(),
    programFiles: [...inputs.programFiles].sort(),
    computedImports: inputs.computedImports,
    computedFiles: inputs.computedFiles,
  };
}
