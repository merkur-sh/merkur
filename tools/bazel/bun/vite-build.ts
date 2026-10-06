import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { frontendSourceSelection } from './frontend-source-provider';
import { sourceBuiltViteModule } from './vite-runtime';

const [
  projectPath,
  outputPath,
  buildId,
  backendOrigin,
  opaquePin,
  commit,
  releasePublicKey,
  declarationsFile,
  executionRoot,
  selectionFile,
  vitePackage,
] = process.argv.slice(2);
if (projectPath === undefined || outputPath === undefined || buildId === undefined) {
  throw new Error('Vite requires declared project, output directory, and build identity');
}
if (
  opaquePin === undefined ||
  Buffer.from(opaquePin, 'base64url').byteLength !== 32 ||
  Buffer.from(opaquePin, 'base64url').toString('base64url') !== opaquePin
) {
  throw new Error('Frontend requires its declared canonical32-byte OPAQUE public key');
}
if (commit !== 'dev' && (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)))
  throw new Error('Frontend version requires its declared source commit or development identity');
if (
  releasePublicKey === undefined ||
  (releasePublicKey !== '' &&
    (Buffer.from(releasePublicKey, 'base64url').byteLength !== 2592 ||
      Buffer.from(releasePublicKey, 'base64url').toString('base64url') !== releasePublicKey)) ||
  (commit !== 'dev' && releasePublicKey === '')
)
  throw new Error('A deployment requires its declared canonical ML-DSA-87 release public key');
process.env.MERKUR_VERSION = commit;
process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY = releasePublicKey;
process.env.VITE_MERKUR_OPAQUE_SERVER_PUBLIC_KEY = opaquePin;
const output = path.resolve(outputPath);
const root = path.resolve(import.meta.dir, '../../..');
const physicalRoot = realpathSync(root);
const publicSelectors = new WeakSet<() => string>();
if (declarationsFile === undefined || executionRoot === undefined || selectionFile === undefined)
  throw new Error('Vite requires its original declarations, execution root, and selection output');
const selection = await frontendSourceSelection(root, executionRoot, declarationsFile);
function assertDeclaredPublicDirectory(directory: string): void {
  if (directory === '') return;
  function inspect(member: string): void {
    const relative = path.relative(physicalRoot, realpathSync(member));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Vite publicDir escaped its declared materialization');
    }
    if (statSync(member).isDirectory()) {
      for (const entry of readdirSync(member)) inspect(path.join(member, entry));
    }
  }
  const relative = path.relative(root, path.resolve(directory));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Vite publicDir escaped its declared materialization');
  }
  try {
    realpathSync(directory);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return;
  }
  inspect(directory);
}
function protectPublicDirectory(config: { publicDir: string }): void {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'publicDir');
  if (descriptor?.get !== undefined && publicSelectors.has(descriptor.get)) return;
  let directory = config.publicDir;
  assertDeclaredPublicDirectory(directory);
  const get = () => {
    assertDeclaredPublicDirectory(directory);
    return directory;
  };
  publicSelectors.add(get);
  Object.defineProperty(config, 'publicDir', {
    enumerable: true,
    get,
    set(value: string) {
      assertDeclaredPublicDirectory(value);
      directory = value;
    },
  });
}
process.chdir(path.join(root, projectPath));
if (vitePackage === undefined) throw new Error('Vite requires its actual source-built package');
const { build } = await import(sourceBuiltViteModule(vitePackage));
process.env.MERKUR_BUILD_ID = buildId;
if (backendOrigin !== undefined && backendOrigin !== '') {
  process.env.MERKUR_BACKEND_ORIGIN = backendOrigin;
} else {
  delete process.env.MERKUR_BACKEND_ORIGIN;
}
await build({
  plugins: [
    {
      name: 'merkur-declared-public-directory',
      configResolved: protectPublicDirectory,
      applyToEnvironment(environment: { config: { publicDir: string } }) {
        protectPublicDirectory(environment.config);
        return true;
      },
    },
    selection.plugin,
  ],
  root: path.join(root, projectPath),
  configFile: path.join(root, projectPath, 'vite.config.ts'),
  configLoader: 'native',
  envDir: false,
  build: { outDir: output, emptyOutDir: true },
});
await selection.finish(output, selectionFile);
