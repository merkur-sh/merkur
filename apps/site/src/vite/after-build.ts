import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * A build-only plugin that runs `check` over the output directory once the
 * bundle and the public files are on disk. A failed build still closes; its
 * error, not a check of what it never wrote, is the news, so `check` is
 * skipped then.
 */
export function afterBuild(name: string, check: (outDir: string) => void): Plugin {
  let outDir = '';
  let failed = false;
  return {
    name,
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildEnd(error) {
      failed = error !== undefined;
    },
    closeBundle() {
      if (!failed) check(outDir);
    },
  };
}
