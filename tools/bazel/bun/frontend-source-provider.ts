import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModuleInfo, OutputBundle } from 'rolldown';
import type { Plugin, ResolvedConfig } from 'vite';
import { captureCompilerArtifactFacts, captureCompilerFileBytes } from './compiler-inventory';
import { portablePath } from './portable-path';

interface Declaration {
  readonly input: string;
  readonly link: boolean;
  readonly owner: string;
  readonly canonical: string;
}

interface Source {
  readonly path: string;
  readonly owner: string;
  readonly bytes: number;
  readonly sha256: string;
}

function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function under(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  return relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    ? relative
    : undefined;
}

function portable(value: string): void {
  portablePath(value, 'Frontend declaration has an invalid canonical destination');
}

/** Diagnostic engine selection only: unresolved generated origins never become source owners. */
export async function frontendSourceSelection(
  root: string,
  executionRoot: string,
  declarationsFile: string,
) {
  const declarations: Record<string, Declaration> = JSON.parse(
    await readFile(declarationsFile, 'utf8'),
  );
  const originals: {
    logical: string;
    declaration: Declaration;
    original: string;
    directory: boolean;
  }[] = [];
  for (const [logical, declaration] of Object.entries(declarations)) {
    if (
      Object.keys(declaration).sort().join(',') !== 'canonical,input,link,owner' ||
      typeof declaration.input !== 'string' ||
      typeof declaration.canonical !== 'string' ||
      typeof declaration.link !== 'boolean' ||
      typeof declaration.owner !== 'string'
    )
      throw new Error('Frontend selection requires exact original File declarations');
    portable(logical);
    portable(declaration.canonical);
    if (logical !== declaration.canonical) continue;
    const original = path.resolve(executionRoot, declaration.input);
    originals.push({
      logical,
      declaration,
      original,
      directory: (await stat(original)).isDirectory(),
    });
  }
  const physicalRoot = await realpath(root);
  const sources = new Map<string, Source>();
  const selectedFiles = new Map<string, { copied: string; original: string }>();
  const selectedInputs = new Map<string, Source & { imports: Map<string, unknown> }>();
  const generatedModules: unknown[] = [];
  const outputSelections = new Map<
    string,
    { bytes: number; sha256: string; observations: unknown[] }
  >();
  let mainConfig: ResolvedConfig | undefined;

  async function source(id: string): Promise<Source | undefined> {
    if (id.includes('\0') || !path.isAbsolute(id)) return undefined;
    // Vite's original cleanUrl contract removes a query/fragment before reading a source File.
    // Ownership still requires an exact canonical declaration and its original member bytes.
    const postfix = [id.indexOf('?'), id.indexOf('#')].filter((index) => index >= 0);
    const filename = postfix.length ? id.slice(0, Math.min(...postfix)) : id;
    if (under(root, filename) === undefined)
      throw new Error('Frontend selected a source outside its declared materialization');
    let physical: string;
    try {
      physical = await realpath(filename);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    const logical = under(physicalRoot, physical);
    if (logical === undefined)
      throw new Error('Frontend source alias escaped its declared materialization');
    const previous = sources.get(logical);
    if (previous !== undefined) return previous;
    const matches = originals.filter(
      (original) =>
        original.logical === logical ||
        (original.directory && under(original.logical, logical) !== undefined),
    );
    if (matches.length === 0) return undefined;
    if (matches.length !== 1)
      throw new Error('Frontend source has ambiguous original File custody');
    const original = matches[0];
    if (original === undefined) throw new Error('Frontend source declaration disappeared');
    const member = path.relative(original.logical, logical);
    const copiedBytes = await captureCompilerFileBytes(physical);
    const originalBytes = await captureCompilerFileBytes(
      path.join(original.original, member),
      true,
    );
    if (!copiedBytes.equals(originalBytes))
      throw new Error('Frontend selected source differs from its original declared File');
    const selected = {
      path: logical,
      owner: original.declaration.owner,
      bytes: originalBytes.byteLength,
      sha256: digest(originalBytes),
    };
    sources.set(logical, selected);
    selectedFiles.set(logical, {
      copied: physical,
      original: path.join(original.original, member),
    });
    return selected;
  }

  function select(selected: Source) {
    let input = selectedInputs.get(selected.path);
    if (input === undefined) {
      input = { ...selected, imports: new Map() };
      selectedInputs.set(selected.path, input);
    }
    return input;
  }

  async function nativeGenerators(info: ModuleInfo): Promise<(Source & { id: string })[]> {
    const inputs: unknown = (info as ModuleInfo & { nativeGeneratorInputs?: unknown })
      .nativeGeneratorInputs;
    if (inputs === undefined) return [];
    if (!Array.isArray(inputs))
      throw new Error('Frontend native generator metadata is not an original input list');
    const selected: (Source & { id: string })[] = [];
    for (const input of inputs) {
      if (
        input === null ||
        typeof input !== 'object' ||
        Object.keys(input).sort().join(',') !== 'content,path' ||
        typeof input.path !== 'string' ||
        typeof input.content !== 'string'
      )
        throw new Error('Frontend native generator metadata lacks exact original File bytes');
      portable(input.path);
      if (!Object.hasOwn(declarations, input.path))
        throw new Error('Frontend native generator lacks its exact declared source alias');
      const original = await source(path.resolve(root, input.path));
      if (original === undefined)
        throw new Error('Frontend native generator has no original declared File custody');
      const bytes = Buffer.from(input.content);
      if (bytes.byteLength !== original.bytes || digest(bytes) !== original.sha256)
        throw new Error('Frontend native generator differs from its actual embedded source bytes');
      select(original);
      selected.push({ id: input.path, ...original });
    }
    return selected;
  }

  async function captureModule(
    info: ModuleInfo,
    moduleInfo: (id: string) => ModuleInfo | null,
    environment: string,
  ): Promise<void> {
    const original = info.code === null ? undefined : await source(info.id);
    const generators = await nativeGenerators(info);
    const imports = [];
    for (const [kind, ids] of [
      ['import-statement', info.importedIds],
      ['dynamic-import', info.dynamicallyImportedIds],
    ] as const) {
      for (const id of ids) {
        const imported = moduleInfo(id);
        const selected = imported === null || imported.code === null ? undefined : await source(id);
        imports.push({ path: selected?.path ?? id, kind });
      }
    }
    if (original !== undefined) {
      const input = select(original);
      for (const item of imports) input.imports.set(JSON.stringify(item), item);
    }
    const code = info.code;
    if (original === undefined || code === null || digest(code) !== original.sha256) {
      generatedModules.push({
        id: info.id,
        environment,
        source: original?.path ?? null,
        bytes: code === null ? null : Buffer.byteLength(code),
        sha256: code === null ? null : digest(code),
        imports,
        native_generators: generators,
        reason: 'Pinned module metadata does not expose complete load/transform generator Files',
      });
    }
  }

  function collector(environment: string): Plugin {
    return {
      name: 'merkur-frontend-source-selection',
      enforce: 'post',
      async buildEnd(error) {
        if (error) return;
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (info !== null)
            await captureModule(info, (module) => this.getModuleInfo(module), environment);
        }
      },
      generateBundle: {
        order: 'post',
        async handler(_options, bundle: OutputBundle) {
          for (const [filename, output] of Object.entries(bundle)) {
            portable(filename);
            const bytes = output.type === 'chunk' ? output.code : output.source;
            const fact = { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
            const selected = [];
            const ids =
              output.type === 'chunk' ? Object.keys(output.modules) : output.originalFileNames;
            for (const id of ids) {
              const original = await source(id);
              if (original !== undefined) select(original);
              if (output.type === 'chunk') {
                const info = this.getModuleInfo(id);
                if (info === null)
                  throw new Error(
                    'Frontend retained chunk module has no original compiler metadata',
                  );
                selected.push({
                  id,
                  source: original?.path ?? null,
                  native_generators: await nativeGenerators(info),
                });
              } else selected.push({ id, source: original?.path ?? null });
            }
            const observation = { environment, type: output.type, selected };
            const previous = outputSelections.get(filename);
            if (previous !== undefined) {
              if (previous.bytes !== fact.bytes || previous.sha256 !== fact.sha256)
                throw new Error('Frontend compiler observations disagree about emitted bytes');
              previous.observations.push(observation);
            } else outputSelections.set(filename, { ...fact, observations: [observation] });
          }
        },
      },
    };
  }

  const plugin = collector('client');
  plugin.configResolved = (config) => {
    mainConfig = config;
    const original = config.worker.plugins;
    config.worker.plugins = async (chain) => {
      const worker = await original(chain);
      const client = worker.environments.client;
      if (client === undefined || !Array.isArray(client.plugins))
        throw new Error('Vite worker factory has no resolved client plugin boundary');
      client.plugins.push(collector('worker'));
      return worker;
    };
  };

  async function finish(outputDirectory: string, filename: string): Promise<void> {
    const artifacts = await captureCompilerArtifactFacts({
      kind: 'bundle',
      directory: outputDirectory,
    });
    const config = mainConfig;
    if (config === undefined) throw new Error('Vite did not expose its resolved configuration');
    const publicInputs = new Map<string, Source>();
    if (config.build.write !== false && config.build.copyPublicDir && config.publicDir !== '') {
      const publicDirectory = config.publicDir;
      async function publicMembers(directory: string, relative = ''): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const member = path.join(relative, entry.name);
          const input = path.join(publicDirectory, member);
          if ((await stat(input)).isDirectory()) await publicMembers(input, member);
          else {
            const original = await source(input);
            if (original === undefined)
              throw new Error('Vite copied public input without original declared File custody');
            select(original);
            publicInputs.set(member, original);
          }
        }
      }
      let present = true;
      try {
        await realpath(publicDirectory);
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        present = false;
      }
      if (present) await publicMembers(publicDirectory);
    }
    const outputs: Record<string, unknown> = Object.create(null);
    const generatedAssets = [];
    for (const [name, artifact] of Object.entries(artifacts)) {
      const compiler = outputSelections.get(name);
      if (compiler !== undefined) {
        if (compiler.bytes !== artifact.bytes || compiler.sha256 !== artifact.sha256)
          throw new Error('Frontend emitted bytes differ from the compiler output boundary');
        outputs[name] = { bytes: compiler.bytes, observations: compiler.observations };
        generatedAssets.push({
          path: name,
          reason: 'Compiler output observations do not expose complete original generator Files',
        });
      } else {
        const input = publicInputs.get(name);
        if (
          input === undefined ||
          artifact.bytes !== input.bytes ||
          artifact.sha256 !== input.sha256
        )
          throw new Error(
            'Frontend output has no compiler or exact declared public copy selection',
          );
        outputs[name] = { bytes: input.bytes, public_input: input.path };
      }
    }
    for (const name of outputSelections.keys()) {
      if (!Object.hasOwn(artifacts, name))
        throw new Error('Frontend compiler output disappeared before capture');
    }
    for (const [logical, fact] of selectedInputs) {
      const files = selectedFiles.get(logical);
      if (files === undefined) throw new Error('Frontend selected File custody disappeared');
      const original = await captureCompilerFileBytes(files.original, true);
      const copied = await captureCompilerFileBytes(files.copied);
      if (
        !original.equals(copied) ||
        original.byteLength !== fact.bytes ||
        digest(original) !== fact.sha256
      )
        throw new Error('Frontend selected source changed before output capture');
    }
    const inputs = Object.fromEntries(
      [...selectedInputs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, fact]) => [
          name,
          {
            owner: fact.owner,
            bytes: fact.bytes,
            sha256: fact.sha256,
            imports: [...fact.imports.values()],
          },
        ]),
    );
    await writeFile(
      filename,
      `${JSON.stringify(
        {
          inputs,
          outputs,
          artifacts,
          unmatched_generated_modules: generatedModules,
          unmatched_generated_assets: generatedAssets,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
  }

  return { plugin, finish };
}
