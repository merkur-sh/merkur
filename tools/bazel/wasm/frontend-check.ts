import { readFile } from 'node:fs/promises';
import { verifyCompilerArtifacts } from '../bun/compiler-inventory';
import { frontendContext, verifyFrontendArtifacts } from '../bun/npm-attribution';

const [configurationPath, inventoryPath, directory] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  configurationPath === undefined ||
  inventoryPath === undefined ||
  directory === undefined
) {
  throw new Error('Frontend WASM attribution requires original configuration, inventory and Tree');
}
const configuration: unknown = JSON.parse(await readFile(configurationPath, 'utf8'));
const inventory: unknown = JSON.parse(await readFile(inventoryPath, 'utf8'));
if (
  typeof configuration !== 'object' ||
  configuration === null ||
  Array.isArray(configuration) ||
  typeof inventory !== 'object' ||
  inventory === null ||
  Array.isArray(inventory)
) {
  throw new Error('Frontend WASM attribution requires original object metadata');
}
const context = configuration as Record<string, unknown>;
if (
  context.producer === '//apps/web:frontend_precompressed' ||
  context.producer === '@@//apps/web:frontend_precompressed'
) {
  frontendContext(context);
  await verifyFrontendArtifacts(inventory as Record<string, unknown>, {
    kind: 'bundle',
    directory,
  });
} else {
  if (
    !['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64'].includes(
      String(context.compile_target),
    ) ||
    typeof context.file_loaders !== 'object' ||
    context.file_loaders === null ||
    Array.isArray(context.file_loaders) ||
    Object.keys(context.file_loaders).join(',') !== '.wasm' ||
    (context.file_loaders as Record<string, unknown>)['.wasm'] !== 'file'
  )
    throw new Error(
      'Native WASM absence requires the original four-platform compiler/file-loader context',
    );
  await verifyCompilerArtifacts(inventory, { kind: 'standalone', executable: directory });
}
