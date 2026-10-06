import { ConfigProvider, Data, Effect, Redacted } from 'effect';
import { serverEnvironment } from './server-environment';

export class EnvironmentError extends Data.TaggedError('EnvironmentError')<{
  readonly message: string;
}> {}

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

const localEnvironmentKeys = [...Object.keys(serverEnvironment), 'MERKUR_EDGE_PORT'] as const;

/** Dotenv expansion is file-local; external overrides are literal and win, including empty values. */
export const resolveEnvironment = Effect.fnUntraced(function* (
  contents: string,
  overrides: EnvironmentRecord = {},
) {
  const provider = yield* Effect.try({
    try: () =>
      ConfigProvider.fromDotEnvContents(contents, {
        preserveEmptyStrings: true,
      }),
    catch: () => new EnvironmentError({ message: 'Cannot parse or expand the environment file' }),
  });
  const values: Record<string, string> = {};
  const sources: Record<string, 'file' | 'environment'> = {};
  const expanded = new Map<string, string | undefined>();
  const resolving = new Set<string>();
  const expandEntry = Effect.fnUntraced(function* (
    key: string,
  ): Effect.fn.Return<string | undefined, EnvironmentError | ConfigProvider.SourceError> {
    if (resolving.has(key)) {
      return yield* new EnvironmentError({
        message: `Cannot parse or expand the environment file: cyclic reference at ${key}`,
      });
    }
    if (expanded.has(key)) return expanded.get(key);
    const node = yield* provider.load([key]);
    if (node?.value === undefined) return undefined;
    resolving.add(key);
    let value = node.value;
    // Match Effect's dotenv-expand grammar, evaluating the innermost/rightmost reference first.
    while (true) {
      let dollar = -1;
      for (const match of value.matchAll(/(?<!\\)\$/g)) dollar = match.index;
      if (dollar === -1) break;
      const match = /^(\$\{?([\w]+)(?::-([^}\\]*))?}?)/.exec(value.slice(dollar));
      if (match === null) break;
      const reference = match[2];
      if (reference === undefined) break;
      const replacement = yield* expandEntry(reference);
      value =
        value.slice(0, dollar) +
        (replacement === undefined || replacement === '' ? (match[3] ?? '') : replacement) +
        value.slice(dollar + match[0].length);
    }
    resolving.delete(key);
    expanded.set(key, value);
    return value;
  });
  for (const key of localEnvironmentKeys) {
    const value = yield* expandEntry(key);
    if (value !== undefined) {
      values[key] = value.replaceAll('\\$', '$');
      sources[key] = 'file';
    }
    const override = overrides[key];
    if (override !== undefined) {
      values[key] = override;
      sources[key] = 'environment';
    }
  }
  return { values: Redacted.make(Object.freeze(values)), sources: Object.freeze(sources) };
});

/** Credentials are never rendered while reporting which input won. */
export function environmentSources(sources: Readonly<Record<string, string>>): string {
  return Object.entries(sources)
    .map(([key, source]) => `${key}: ${source}`)
    .join('\n');
}
