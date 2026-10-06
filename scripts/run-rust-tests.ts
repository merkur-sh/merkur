import path from 'node:path';
import { rustWorkspacePlan } from './select-gates';
import { executePlan } from './verification-executor';

const ROOT = path.resolve(import.meta.dir, '..');

const metadata = Bun.spawnSync(
  ['cargo', 'metadata', '--no-deps', '--format-version', '1', '--locked'],
  { cwd: ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
);
if (metadata.exitCode !== 0) throw new Error('cargo metadata failed');
const { packages } = JSON.parse(metadata.stdout.toString()) as {
  packages: { readonly name: string }[];
};

process.exitCode = await executePlan(rustWorkspacePlan(packages.map((entry) => entry.name)));
