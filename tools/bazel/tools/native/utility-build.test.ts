import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('native GNU Make executes its declared shell and fails when that shell is unavailable', () => {
  const make = process.env.MERKUR_NATIVE_MAKE;
  if (make === undefined || !path.isAbsolute(make))
    throw new Error('GNU Make controls require the exact declared Make executable');
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-make-shell-'));
  try {
    const recipe = path.join(root, 'Makefile');
    writeFileSync(recipe, 'all:\n\t@printf "DECLARED_MAKE_SHELL_OK\\n"\n');
    const args = [make, '--no-print-directory', '-f', recipe, 'SHELL=sh'];
    const positive = Bun.spawnSync(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(positive.exitCode).toBe(0);
    expect(new TextDecoder().decode(positive.stdout).trim()).toBe('DECLARED_MAKE_SHELL_OK');
    const negative = Bun.spawnSync(args, {
      cwd: root,
      env: { ...process.env, PATH: '/__no_ambient_native_make_shell__' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(negative.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(negative.stdout)).not.toContain('DECLARED_MAKE_SHELL_OK');
    // This is the unchanged expression used by upstream Git GIT-VERSION-GEN.
    // A shell crash inside command substitution can otherwise become an empty
    // version string while Make reports a successful outer recipe.
    const version = Bun.spawnSync(['sh', '-c', String.raw`VN=2.56.0; expr "$VN" : v*'\(.*\)'`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(version.exitCode).toBe(0);
    expect(new TextDecoder().decode(version.stdout).trim()).toBe('2.56.0');
    const substitution = Bun.spawnSync(
      ['sh', '-c', String.raw`VN=2.56.0; VN=$(expr "$VN" : v*'\(.*\)'); printf '<%s>\n' "$VN"`],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(substitution.exitCode).toBe(0);
    expect(new TextDecoder().decode(substitution.stdout)).toBe('<2.56.0>\n');
    const unmatched = Bun.spawnSync(['sh', '-c', String.raw`printf '<%s>\n' v*`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(unmatched.exitCode).toBe(0);
    expect(new TextDecoder().decode(unmatched.stdout)).toBe('<v*>\n');
    writeFileSync(path.join(root, 'v-one'), 'first');
    writeFileSync(path.join(root, 'v-two'), 'second');
    const matched = Bun.spawnSync(['sh', '-c', String.raw`printf '<%s>\n' v-*`], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(matched.exitCode).toBe(0);
    expect(new TextDecoder().decode(matched.stdout)).toBe('<v-one>\n<v-two>\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
