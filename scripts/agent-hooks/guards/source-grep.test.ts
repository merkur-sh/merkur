import { expect, test } from 'bun:test';

import type { GuardContext, GuardDecision } from '../hook-io';
import { splitCommandLine } from '../shell-command';
import {
  classifyOperand,
  evaluateGrepTool,
  evaluateSourceGrepCommand,
  probeFromCommand,
  restrictorAdmitsOnlyAllowed,
} from './source-grep';

const ROOT = '/repo';

function context(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    root: ROOT,
    cwd: ROOT,
    home: '/home/agent',
    indexPresent: true,
    planApproved: false,
    ...overrides,
  };
}

/** The first decision any command on the line produces. */
function decide(line: string, ctx: GuardContext = context()): GuardDecision | null {
  for (const command of splitCommandLine(line, ctx.cwd, ctx.home)) {
    const decision = evaluateSourceGrepCommand(command, ctx);
    if (decision !== null) return decision;
  }
  return null;
}

function denied(line: string, ctx?: GuardContext): boolean {
  return decide(line, ctx)?.kind === 'deny';
}

test('a ~ path resolves through home: outside the repository is allowed, inside it is source', () => {
  expect(denied('cd ~/.codex/sessions && find .')).toBe(false);
  const underHome = context({ root: '/home/agent/repo', cwd: '/home/agent/repo' });
  expect(denied('grep -rn foo ~/repo/apps', underHome)).toBe(true);
  expect(denied('cd ~/repo/apps && grep -rn foo .', underHome)).toBe(true);
  expect(denied('cd ~/elsewhere && grep -rn foo .', underHome)).toBe(false);
});

test('a heredoc body is not searched; its live substitutions are', () => {
  expect(denied("cat > /tmp/notes.md <<'EOF'\ngrep -rn foo apps/web/src\nEOF")).toBe(false);
  expect(denied('cat <<EOF\n$(grep -rn foo apps/web/src)\nEOF')).toBe(true);
});

test('grep over a source directory is denied with the codegraph replacements', () => {
  const decision = decide('grep -rn foo apps/web/src');
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('codegraph explore');
  expect(decision.reason).not.toContain('codegraph node');
  expect(decision.reason).toContain("--include='*.md'");
});

test('grep over prose, config and lockfiles is allowed', () => {
  expect(decide('grep foo docs/transport.md')).toBeNull();
  expect(decide('grep -n foo README.md')).toBeNull();
  expect(decide('grep foo apps/web/package.json')).toBeNull();
  expect(decide('grep foo Cargo.lock')).toBeNull();
  expect(decide('grep -r foo docs')).toBeNull();
  expect(decide('grep foo apps/edge/fly.toml apps/edge/Dockerfile')).toBeNull();
  expect(decide('grep foo apps/server/.env.example')).toBeNull();
  expect(decide('grep -r foo target/rust')).toBeNull();
  expect(decide('grep -r foo apps/web/dist')).toBeNull();
});

test('licence texts and extensionless config under a source root are allowed', () => {
  expect(decide('cat packages/logger/LICENSE')).toBeNull();
  expect(decide('grep -n MIT packages/wtransport-patch/LICENSE-MIT')).toBeNull();
  expect(decide('grep -n target apps/site/.gitignore')).toBeNull();
  expect(denied('cat packages/logger/LICENSE.ts')).toBe(true);
  expect(denied('cat packages/logger/LICENSE-x.ts')).toBe(true);
});

test('a recursive grep with no path sweeps the root and is denied', () => {
  expect(denied('grep -rn foo')).toBe(true);
  expect(denied('grep -R foo .')).toBe(true);
  expect(denied('rg foo')).toBe(true);
  expect(denied('rg -n "display ack"')).toBe(true);
});

test('a non-recursive grep with no path filters stdin and is allowed', () => {
  expect(decide('grep foo')).toBeNull();
  expect(decide('grep -e foo')).toBeNull();
});

test('a grep piped from a previous command is allowed', () => {
  expect(decide('codegraph explore x | grep y')).toBeNull();
  expect(decide('git log --oneline | grep -i fix')).toBeNull();
  expect(decide('bun test 2>&1 | grep -c pass')).toBeNull();
  expect(decide('cat package.json | rg scripts')).toBeNull();
});

test('restrictors that admit only allowed extensions neutralise a source sweep', () => {
  expect(decide("grep -rn foo --include='*.md' apps")).toBeNull();
  expect(decide('grep -rn --include=*.md foo .')).toBeNull();
  expect(decide("rg foo -g '*.md'")).toBeNull();
  expect(decide("rg foo --glob '*.{md,txt}' packages")).toBeNull();
  expect(decide('rg --type md foo')).toBeNull();
  expect(decide('rg -t json foo apps/web')).toBeNull();
  expect(decide('rg -tmd foo')).toBeNull();
  expect(decide("find docs -name '*.md'")).toBeNull();
  expect(decide("find apps -name '*.md'")).toBeNull();
  expect(decide('fd -e md . apps')).toBeNull();
});

test('restrictors that admit source do not neutralise', () => {
  expect(denied("grep -rn foo --include='*.ts' apps")).toBe(true);
  expect(denied("rg foo -g '*.rs'")).toBe(true);
  expect(denied('rg -t ts foo')).toBe(true);
  expect(denied("rg foo -g '!*.md'")).toBe(true);
  expect(denied("find . -name '*.md' -o -name '*.ts'")).toBe(true);
  expect(denied("find apps -name '*.rs'")).toBe(true);
  expect(denied("find apps -name 'README*'")).toBe(true);
});

test('find and fd over source are denied, over prose allowed', () => {
  expect(denied("find apps -name '*.rs'")).toBe(true);
  expect(denied('find . -type f')).toBe(true);
  expect(decide("find docs -name '*.md'")).toBeNull();
  expect(decide('find target -newer Cargo.lock')).toBeNull();
  expect(denied('fd display apps/web')).toBe(true);
  expect(denied('fd -e rs planner')).toBe(true);
  expect(decide('fd -e toml Cargo')).toBeNull();
});

test('readers over source files are denied, over allowed files not', () => {
  expect(denied('cat apps/web/src/x.ts')).toBe(true);
  expect(denied('head -n 40 apps/daemon/dataplane/src/main.rs')).toBe(true);
  expect(denied('tail -f apps/web/src/terminal/terminal-worker.ts')).toBe(true);
  expect(denied('sed -n 10,20p packages/protocol/src/index.ts')).toBe(true);
  expect(denied("sed -n '1,5p' apps/web/src/a.ts")).toBe(true);
  expect(denied("awk '/foo/' scripts/check-dead.ts")).toBe(true);
  expect(denied('bat apps/edge/src/main.rs')).toBe(true);
  expect(decide('cat package.json')).toBeNull();
  expect(decide('cat apps/server/.env.example')).toBeNull();
  expect(decide('head -50 docs/security.md')).toBeNull();
  expect(decide('tail -n 100 .codegraph/daemon.log')).toBeNull();
  expect(decide('cat')).toBeNull();
  expect(decide('sed -e s/a/b/ -i README.md')).toBeNull();
  expect(decide("sed -i '' 's/a/b/' docs/x.md")).toBeNull();
  expect(decide('less +F apps/server/data/server.log')).toBeNull();
});

test('git grep follows the same rule', () => {
  expect(denied('git grep foo')).toBe(true);
  expect(denied('git grep -n foo -- apps/web/src')).toBe(true);
  expect(decide("git grep foo -- '*.md'")).toBeNull();
  expect(decide('git grep foo -- docs')).toBeNull();
  expect(decide('git -C docs grep foo')).toBeNull();
  expect(decide('git log -p')).toBeNull();
});

test('the effective cwd from cd and absolute paths both resolve against the root', () => {
  expect(denied('cd apps/web && grep -rn foo src')).toBe(true);
  expect(denied(`grep -rn foo ${ROOT}/packages/shared/src`)).toBe(true);
  expect(decide(`grep -rn foo ${ROOT}/docs`)).toBeNull();
  expect(decide('grep -rn foo /etc')).toBeNull();
  expect(decide('cat ~/.merkur/config.json')).toBeNull();
  expect(denied('rg foo', context({ cwd: '/repo/apps/web' }))).toBe(true);
  expect(decide('rg foo', context({ cwd: '/repo/docs' }))).toBeNull();
});

test('a shell-expanded glob at the root counts as source', () => {
  expect(denied('grep foo **/*.ts')).toBe(true);
  expect(denied('cat apps/web/src/*.ts')).toBe(true);
  expect(decide('cat docs/*.md')).toBeNull();
});

test('a grep inside a substitution is caught', () => {
  expect(denied('echo $(grep -rl foo apps/web/src)')).toBe(true);
  expect(denied('wc -l `find packages -name "*.rs"`')).toBe(true);
});

test('--help is never denied', () => {
  expect(decide('grep --help')).toBeNull();
  expect(decide('rg -h apps')).toBeNull();
});

test('index missing: still denied, with the init instruction', () => {
  const decision = decide('grep -rn foo apps/web/src', context({ indexPresent: false }));
  expect(decision?.kind).toBe('deny');
  if (decision?.kind !== 'deny') return;
  expect(decision.reason).toContain('codegraph init .');
  expect(decision.reason).toContain('codegraph explore');
  expect(decision.reason).not.toContain('fallback');
  expect(decide('grep foo docs/x.md', context({ indexPresent: false }))).toBeNull();
});

test("Claude's Grep tool is evaluated like the shell", () => {
  expect(evaluateGrepTool({ pattern: 'foo', path: 'apps/web/src' }, context())?.kind).toBe('deny');
  expect(evaluateGrepTool({ pattern: 'foo' }, context())?.kind).toBe('deny');
  expect(evaluateGrepTool({ pattern: 'foo', path: 'docs' }, context())).toBeNull();
  expect(evaluateGrepTool({ pattern: 'foo', glob: '*.md' }, context())).toBeNull();
  expect(evaluateGrepTool({ pattern: 'foo', glob: '**/*.{md,txt}' }, context())).toBeNull();
  expect(evaluateGrepTool({ pattern: 'foo', type: 'md' }, context())).toBeNull();
  expect(evaluateGrepTool({ pattern: 'foo', type: 'ts' }, context())?.kind).toBe('deny');
  expect(evaluateGrepTool({ pattern: 'foo', glob: '*.ts', path: 'apps' }, context())?.kind).toBe(
    'deny',
  );
  expect(
    evaluateGrepTool({ pattern: 'foo', path: `${ROOT}/docs/transport.md` }, context()),
  ).toBeNull();
  expect(evaluateGrepTool({ pattern: 'foo' }, context({ indexPresent: false }))?.kind).toBe('deny');
});

test('operand classification', () => {
  expect(classifyOperand('apps/web/src', ROOT, ROOT)).toBe('source');
  expect(classifyOperand('apps/web/src/x.ts', ROOT, ROOT)).toBe('source');
  expect(classifyOperand('apps/web/src/x.wgsl', ROOT, ROOT)).toBe('source');
  expect(classifyOperand('.', ROOT, ROOT)).toBe('source');
  expect(classifyOperand('apps/web/package.json', ROOT, ROOT)).toBe('allowed');
  expect(classifyOperand('apps/web/src/x.png', ROOT, ROOT)).toBe('outside');
  expect(classifyOperand('docs', ROOT, ROOT)).toBe('allowed');
  expect(classifyOperand('packages/term-wasm/target/x', ROOT, ROOT)).toBe('allowed');
  expect(classifyOperand('node_modules/effect/src', ROOT, ROOT)).toBe('allowed');
  expect(classifyOperand('/etc/hosts', ROOT, ROOT)).toBe('outside');
  expect(classifyOperand('x.ts', ROOT, ROOT)).toBe('outside');
  expect(classifyOperand('src', '/repo/apps/web', ROOT)).toBe('source');
});

test('restrictor evaluation', () => {
  expect(restrictorAdmitsOnlyAllowed('*.md', ROOT, ROOT)).toBe(true);
  expect(restrictorAdmitsOnlyAllowed('**/*.{md,mdx}', ROOT, ROOT)).toBe(true);
  expect(restrictorAdmitsOnlyAllowed('*.ts', ROOT, ROOT)).toBe(false);
  expect(restrictorAdmitsOnlyAllowed('!*.ts', ROOT, ROOT)).toBe(false);
  expect(restrictorAdmitsOnlyAllowed('docs/**', ROOT, ROOT)).toBe(true);
  expect(restrictorAdmitsOnlyAllowed('apps/**', ROOT, ROOT)).toBe(false);
  expect(restrictorAdmitsOnlyAllowed('\\.md$', ROOT, ROOT)).toBe(true);
});

test('probes name the tool and paths for the reason text', () => {
  const [command] = splitCommandLine('rg -n foo apps/web packages/shared', ROOT, '/home/agent');
  expect(command).toBeDefined();
  if (command === undefined) return;
  expect(probeFromCommand(command)).toEqual({
    tool: 'rg',
    paths: ['apps/web', 'packages/shared'],
    restrictors: [],
    types: [],
    cwd: ROOT,
  });
  const [notATool] = splitCommandLine('ls apps/web', ROOT, '/home/agent');
  expect(notATool).toBeDefined();
  if (notATool === undefined) return;
  expect(probeFromCommand(notATool)).toBeNull();
});
