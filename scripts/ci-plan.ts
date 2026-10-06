import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import type { CiPlan } from './ci-required';
import { RULES, ruleMatches } from './select-gates';

/** Job selection only. Every selected lane still executes its complete inventory. */
export function ciPlan(files: readonly string[], full: boolean): CiPlan {
  const all = { source: true, native: true, integration: true };
  if (full || files.length === 0) return all;
  let source = false;
  let native = false;
  let integration = false;
  for (const file of files) {
    const rules = RULES.filter((rule) => ruleMatches(rule, file));
    // Only actual prose is exempt. The local selector also exempts agent hooks;
    // those can contain executable code and CI must verify changes to them.
    const prose = file.endsWith('.md') || file.endsWith('.mdx') || file === 'LICENSE';
    if (prose && rules.some((rule) => rule.effects.noGate)) continue;
    source = true;
    // Omit native only for known TypeScript source/test paths with an owning
    // suite. Build scripts, manifests, workflow changes and unknown files earn
    // every lane, even if the local selector only assigns them static gates.
    const typedSource =
      /\.(?:ts|tsx|css)$/.test(file) &&
      (file.startsWith('apps/') || file.startsWith('packages/')) &&
      rules.some((rule) => rule.effects.bunTestDir !== undefined);
    if (!typedSource) return all;
    native ||= rules.some(
      ({ effects }) =>
        effects.rustLint ||
        effects.protocol ||
        effects.realHelper ||
        (effects.crates?.length ?? 0) > 0 ||
        (effects.cargoScripts?.length ?? 0) > 0 ||
        (effects.builds?.length ?? 0) > 0,
    );
    // All product edits get browser coverage, including ordinary UI and server
    // changes outside the local selector's transport-specific rules.
    integration ||=
      !/\.test\.tsx?$/.test(file) ||
      rules.some(
        ({ effects }) => effects.protocol || effects.e2e || (effects.deferred?.length ?? 0) > 0,
      );
  }
  return { source, native, integration };
}

if (import.meta.main) {
  const base = process.env.CI_BASE_SHA;
  const full = process.env.GITHUB_EVENT_NAME !== 'pull_request';
  if (!full && (base === undefined || !/^[0-9a-f]{40}$/.test(base))) {
    throw new Error('PR planning requires the exact base commit');
  }
  // Compare the actual checked-out merge tree to its base, not the PR head.
  // --no-renames reports both removed and added paths; -z preserves filenames.
  const files = full
    ? []
    : execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base ?? '', 'HEAD', '--'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
  const plan = ciPlan(files, full);
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined) throw new Error('GITHUB_OUTPUT is required');
  for (const [name, value] of Object.entries(plan)) appendFileSync(output, `${name}=${value}\n`);
  process.stdout.write(`${JSON.stringify({ files, plan }, null, 2)}\n`);
}
