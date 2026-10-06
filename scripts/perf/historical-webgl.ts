import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import archivedSources from './historical-webgl-sources.json';

export const HISTORICAL_WEBGL_BASE = 'fc3e6e36b2a91b652b25eaeca6620487937ed5ac';
// Durable source archive, NOT a buildable historical production release. Only
// the exact two-credit renderer and mailbox constant are taken from this tree;
// all other implementation dependencies retain the original fc3 baseline.
export const HISTORICAL_TWO_CREDIT_WEBGL = '3bf5179dc0e490858080eed80790aec1d6fbce90';

export function historicalWebGlPlugin(
  root: string,
  twoCredit: boolean,
  closure: Record<string, string>,
): Bun.BunPlugin {
  return {
    name: 'archived-webgl-source-only',
    setup(builder) {
      builder.onResolve({ filter: /^merkur-historical-webgl$/ }, () => ({
        path: resolve(root, 'apps/web/src/renderer-webgl2.ts'),
        namespace: 'archived-webgl',
      }));
      // Resolve deleted relative files before Bun's filesystem resolver rejects
      // them. This namespace can never enter a production Vite build.
      builder.onResolve({ filter: /^\./ }, (args) => {
        const importer = relative(root, args.importer);
        if (!importer.startsWith('apps/web/')) return;
        return {
          path: resolve(dirname(args.importer), `${args.path}.ts`),
          namespace: 'archived-webgl',
        };
      });
      // This import belongs to the immutable Git archive, before the project rename.
      builder.onResolve({ filter: /^@mercury\/shared$/ }, () => ({
        // Only nextPowerOfTwo is imported by the archived renderer. Pin its
        // defining module, not the unrelated authentication barrel dependencies.
        path: resolve(root, 'packages/shared/src/math.ts'),
        namespace: 'file',
      }));
      builder.onResolve({ filter: /^merkur-historical-task-poll$/ }, () => ({
        path: resolve(root, 'apps/web/src/terminal/task-poll-scheduler.ts'),
        namespace: 'archived-webgl',
      }));
      const load = (args: { path: string }) => {
        const path = relative(root, args.path);
        if (!path.startsWith('apps/web/') && !path.startsWith('packages/')) return;
        const candidate =
          twoCredit &&
          (path === 'apps/web/src/renderer-webgl2.ts' ||
            path === 'apps/web/src/terminal/render-mailbox.ts');
        const checkpoint = candidate ? HISTORICAL_TWO_CREDIT_WEBGL : HISTORICAL_WEBGL_BASE;
        const sources = archivedSources[checkpoint] as Record<
          string,
          { sha256: string; contents: string }
        >;
        const retained = sources[path];
        if (retained === undefined)
          throw new Error(`Undeclared archived renderer input: ${checkpoint}:${path}`);
        const contents = retained.contents;
        const digest = createHash('sha256').update(contents).digest('hex');
        if (digest !== retained.sha256)
          throw new Error(`Archived renderer source facts changed: ${path}`);
        closure[path] = digest;
        return {
          contents,
          loader: path.endsWith('.tsx') ? ('tsx' as const) : ('ts' as const),
          resolveDir: dirname(args.path),
        };
      };
      builder.onLoad({ filter: /\.[jt]sx?$/, namespace: 'archived-webgl' }, load);
      builder.onLoad({ filter: /\.[jt]sx?$/ }, load);
    },
  };
}
