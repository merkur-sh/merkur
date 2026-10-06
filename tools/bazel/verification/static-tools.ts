import path from 'node:path';
import { nativeExitCode } from './native-exit';

const root = process.argv[2];
const gate = process.argv[3];
if (root === undefined || !path.isAbsolute(root)) throw new Error('Declared source root required');
if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Unsupported native verification platform');
}

const executable = process.argv[4];
if (executable === undefined || !path.isAbsolute(executable))
  throw new Error('Declared native executable required');
let args: readonly string[];
switch (gate) {
  case 'lint': {
    args = ['check', '.'];
    break;
  }
  case 'exports': {
    args = ['dead-code', '--unused-exports', '--unused-types', '--fail-on-issues', '--quiet'];
    break;
  }
  default:
    throw new Error('Unknown content gate');
}
const result = Bun.spawnSync([executable, ...args], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    RUNFILES_DIR: process.env.RUNFILES_DIR,
    RUST_LOG: 'error',
  },
});
process.exit(nativeExitCode(result, 'Content gate'));
