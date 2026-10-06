import { createLogger } from '@merkur/logger';

if (typeof createLogger !== 'function' || !process.cwd().endsWith('/tools/bazel/bun')) {
  throw new Error('Declared Bun command must preserve its cwd and root TypeScript aliases');
}
