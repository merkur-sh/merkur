import { expect, test } from 'bun:test';

import { splitCommandLine, stripPrefixes, stripRedirections, tokenize } from './shell-command';

const CWD = '/repo';
const HOME = '/home/agent';

function argvs(line: string): string[][] {
  return splitCommandLine(line, CWD, HOME).map((command) => [...command.argv]);
}

test('a single command is one simple command with quotes removed', () => {
  const [command] = splitCommandLine(`grep -rn "foo bar" 'apps/web/src'`, CWD, HOME);
  expect(command?.argv).toEqual(['grep', '-rn', 'foo bar', 'apps/web/src']);
  expect(command?.cwd).toBe(CWD);
  expect(command?.pipedFromPrevious).toBe(false);
  expect(command?.background).toBe(false);
});

test('quotes protect operators and spaces', () => {
  expect(argvs(`echo "a && b; c | d" && ls`)).toEqual([['echo', 'a && b; c | d'], ['ls']]);
  expect(argvs(`printf '%s\\n' 'it;s'`)).toEqual([['printf', '%s\\n', 'it;s']]);
  expect(tokenize(`a\\ b c`, HOME)).toEqual(['a b', 'c']);
});

test('&&, ||, ;, | and newlines all separate commands', () => {
  expect(argvs('a && b || c; d | e\nf')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
});

test('a pipe marks the consumer as piped from the previous command', () => {
  const commands = splitCommandLine('codegraph explore x | grep y', CWD, HOME);
  expect(commands[0]?.pipedFromPrevious).toBe(false);
  expect(commands[1]?.pipedFromPrevious).toBe(true);
  expect(commands[1]?.argv).toEqual(['grep', 'y']);
});

test('a single & backgrounds the command it terminates', () => {
  const commands = splitCommandLine('cargo test -p a & cargo test -p b', CWD, HOME);
  expect(commands[0]?.background).toBe(true);
  expect(commands[1]?.background).toBe(false);
  expect(argvs('cargo test -p a && cargo test -p b')).toEqual([
    ['cargo', 'test', '-p', 'a'],
    ['cargo', 'test', '-p', 'b'],
  ]);
  expect(
    splitCommandLine('cargo test -p a && cargo test -p b', CWD, HOME).some((c) => c.background),
  ).toBe(false);
});

test('$( ) and backticks are recursed into', () => {
  expect(argvs('echo $(grep foo apps/web/src/x.ts)')).toEqual([
    ['echo', '$(grep foo apps/web/src/x.ts)'],
    ['grep', 'foo', 'apps/web/src/x.ts'],
  ]);
  expect(argvs('wc -l `find apps -name "*.rs"`')).toEqual([
    ['wc', '-l', '`find apps -name "*.rs"`'],
    ['find', 'apps', '-name', '*.rs'],
  ]);
  expect(argvs('x $(a $(b c) d)')).toEqual([
    ['x', '$(a $(b c) d)'],
    ['a', '$(b c)', 'd'],
    ['b', 'c'],
  ]);
});

test('cd tracks the effective cwd for everything after it', () => {
  const commands = splitCommandLine('cd apps/web && bunx foo; ls', CWD, HOME);
  expect(commands.map((command) => command.cwd)).toEqual([CWD, '/repo/apps/web', '/repo/apps/web']);
  const nested = splitCommandLine('cd apps && cd web && bun add x', CWD, HOME);
  expect(nested[2]?.cwd).toBe('/repo/apps/web');
  const absolute = splitCommandLine('cd /elsewhere && cat x', CWD, HOME);
  expect(absolute[1]?.cwd).toBe('/elsewhere');
  const dotdot = splitCommandLine('cd apps/web && cd .. && bunx x', CWD, HOME);
  expect(dotdot[2]?.cwd).toBe('/repo/apps');
});

test('cd follows ~ and a bare cd home; cd - and unresolvable targets keep the cwd', () => {
  const cwdAfter = (line: string): string | undefined =>
    splitCommandLine(`${line} && ls`, CWD, HOME).at(-1)?.cwd;
  expect(cwdAfter('cd ~/.codex/sessions')).toBe('/home/agent/.codex/sessions');
  expect(cwdAfter('cd ~')).toBe(HOME);
  expect(cwdAfter('cd')).toBe(HOME);
  expect(cwdAfter('cd -P ~/x')).toBe('/home/agent/x');
  expect(cwdAfter('cd -')).toBe(CWD);
  expect(cwdAfter('pushd')).toBe(CWD);
  expect(cwdAfter('cd $SOMEWHERE')).toBe(CWD);
  expect(cwdAfter('cd ~other/x')).toBe(CWD);
  expect(cwdAfter("cd '~/x'")).toBe(CWD);
});

test('an unquoted leading ~ expands to home; quoted or mid-word it stays literal', () => {
  expect(argvs('grep -r foo ~/repo/apps ~')).toEqual([
    ['grep', '-r', 'foo', '/home/agent/repo/apps', HOME],
  ]);
  expect(tokenize(`echo '~/x' "~" a~b ~other`, HOME)).toEqual([
    'echo',
    '~/x',
    '~',
    'a~b',
    '~other',
  ]);
});

test('env, sudo, time, timeout and FOO=1 prefixes are stripped', () => {
  expect(argvs('FOO=1 BAR=2 grep x docs')).toEqual([['grep', 'x', 'docs']]);
  expect(argvs('env FOO=1 -u BAZ grep x docs')).toEqual([['grep', 'x', 'docs']]);
  expect(argvs('sudo -u root cat /etc/hosts')).toEqual([['cat', '/etc/hosts']]);
  expect(argvs('time cargo test')).toEqual([['cargo', 'test']]);
  expect(argvs('timeout 30 cargo test')).toEqual([['cargo', 'test']]);
  expect(argvs('timeout -s KILL 30 cargo test')).toEqual([['cargo', 'test']]);
  expect(stripPrefixes(['nohup', 'bun', 'x'])).toEqual(['bun', 'x']);
});

test('xargs yields the command it runs', () => {
  expect(argvs('find docs -name "*.md" | xargs grep foo')).toEqual([
    ['find', 'docs', '-name', '*.md'],
    ['grep', 'foo'],
  ]);
  expect(argvs('ls | xargs -0 -n 1 -I {} cat {}')).toEqual([['ls'], ['cat', '{}']]);
  expect(argvs('ls | xargs --max-args=1 rm')).toEqual([['ls'], ['rm']]);
});

test('redirections are dropped', () => {
  expect(stripRedirections(['cmd', '>', 'out.txt', '2>&1'])).toEqual(['cmd']);
  expect(stripRedirections(['cmd', '>out.txt', '<in', 'arg'])).toEqual(['cmd', 'arg']);
  expect(argvs('cargo test > /tmp/log 2>&1 && cat /tmp/log')).toEqual([
    ['cargo', 'test'],
    ['cat', '/tmp/log'],
  ]);
});

test('subshell parentheses and brace groups are transparent', () => {
  expect(argvs('(cd apps/web && bunx x)')).toEqual([
    ['cd', 'apps/web'],
    ['bunx', 'x'],
  ]);
  expect(splitCommandLine('(cd apps/web && bunx x)', CWD, HOME)[1]?.cwd).toBe('/repo/apps/web');
  expect(argvs('{ a; b; }')).toEqual([['a'], ['b']]);
  expect(argvs(`find . -name '*.md' -exec cat {} \\;`)).toEqual([
    ['find', '.', '-name', '*.md', '-exec', 'cat', '{}', ';'],
  ]);
});

test('--help is flagged', () => {
  expect(splitCommandLine('grep --help', CWD, HOME)[0]?.hasHelp).toBe(true);
  expect(splitCommandLine('rg -h', CWD, HOME)[0]?.hasHelp).toBe(true);
  expect(splitCommandLine('rg -n x docs', CWD, HOME)[0]?.hasHelp).toBe(false);
});

test('a heredoc body is data, not commands', () => {
  const line =
    "git commit -F - <<'EOF'\ngrep -rn foo apps\nsee `codegraph node x`\nEOF\ngit status";
  expect(argvs(line)).toEqual([
    ['git', 'commit', '-F', '-'],
    ['git', 'status'],
  ]);
  expect(argvs('cat <<EOF > out.txt\nrm -rf /\nEOF')).toEqual([['cat']]);
});

test("an unquoted heredoc body's substitutions still run", () => {
  expect(argvs('cat <<EOF\nlist: $(grep -rn foo apps)\nEOF')).toEqual([
    ['cat'],
    ['grep', '-rn', 'foo', 'apps'],
  ]);
  expect(argvs("cat <<'EOF'\nlist: $(grep -rn foo apps)\nEOF")).toEqual([['cat']]);
  expect(argvs('cat <<\\EOF\n`grep -rn foo apps`\nEOF')).toEqual([['cat']]);
});

test('<<- ends at a tab-indented delimiter; two heredocs on one line are both skipped', () => {
  expect(argvs('cat <<-EOF\n\tgrep x apps\n\tEOF\nls')).toEqual([['cat'], ['ls']]);
  expect(argvs('paste <<A <<B\ngrep a apps\nA\ngrep b apps\nB\nls')).toEqual([['paste'], ['ls']]);
});

test('a here-string is not a heredoc', () => {
  expect(argvs('grep x <<< "a b"\nls')).toEqual([['grep', 'x'], ['ls']]);
});

test('empty and whitespace lines yield nothing', () => {
  expect(splitCommandLine('', CWD, HOME)).toEqual([]);
  expect(splitCommandLine('  \n ; ', CWD, HOME)).toEqual([]);
});
