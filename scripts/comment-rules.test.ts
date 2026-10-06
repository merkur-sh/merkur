import { expect, test } from 'bun:test';

import { findHedges, isRustSource, measureFile, RULES, rustComments } from './comment-rules';

/** The text of each comment the lexer finds, in order. */
function texts(source: string): string[] {
  return rustComments('src/lib.rs', source).map((comment) => comment.value);
}

/** Each finding of a file as `line:column rule`. */
function found(file: string, source: string): string[] {
  return measureFile(file, source).map(
    (finding) => `${finding.line}:${finding.column} ${finding.rule}`,
  );
}

test('line comments, block comments and their doc forms are comments, each at its opener', () => {
  const source = [
    '//! inner doc',
    '/// outer doc',
    'fn f() {} // trailing',
    '/** block doc */',
    'mod m { /*! inner block doc */ }',
    '/* spans',
    '   two lines */ fn g() {}',
    '/**/ //',
    '',
  ].join('\n');

  const comments = rustComments('src/lib.rs', source);

  expect(comments.map((comment) => comment.value)).toEqual([
    '! inner doc',
    '/ outer doc',
    ' trailing',
    '* block doc ',
    '! inner block doc ',
    ' spans\n   two lines ',
    '',
    '',
  ]);
  expect(comments.map((comment) => source.slice(comment.start, comment.start + 2))).toEqual([
    '//',
    '//',
    '//',
    '/*',
    '/*',
    '/*',
    '/*',
    '//',
  ]);
  expect(texts('fn f() {} // no newline at the end')).toEqual([' no newline at the end']);
});

test('block comments nest, and the code after the outermost close is read again', () => {
  expect(texts('/* a /* b /* c */ b */ a */ fn f() {} // after')).toEqual([
    ' a /* b /* c */ b */ a ',
    ' after',
  ]);
  // The opener of a nested comment is taken before the closer it overlaps.
  expect(texts('/* a /*/ b */ c */ // after')).toEqual([' a /*/ b */ c ', ' after']);
  expect(texts('/* // not a line comment */ fn f() {}')).toEqual([' // not a line comment ']);
});

test('a comment opener inside a string or a byte string is not a comment', () => {
  const source = [
    'let a = "// not a comment";',
    'let b = "say \\"/* still a string */\\" \\\\"; // one',
    'let c = b"/* bytes */"; let d = b"\\"//"; // two',
    'let e = "spans',
    '  // lines"; // three',
    'let f = c"// C string"; // four',
    '',
  ].join('\n');

  expect(texts(source)).toEqual([' one', ' two', ' three', ' four']);
});

test('a raw string ends at its own closer, whatever it holds', () => {
  const source = [
    'let a = r"// raw \\"; // one',
    'let b = r#"a "quoted" // word"#; // two',
    'let c = r##"ends "# not here /* nor here "##; // three',
    'let d = br#"/* bytes " */"#; let e = br"//"; // four',
    'let f = cr#"// C "raw""#; // five',
    'let g = r#""#; // six',
    '',
  ].join('\n');

  expect(texts(source)).toEqual([' one', ' two', ' three', ' four', ' five', ' six']);
});

test('a raw identifier is a word, not the start of a raw string', () => {
  const source = [
    'let r#type = 1; let r#fn = r#type; // one',
    'let br = r; let x = br#"// raw bytes"#; // two',
    'let number = for_r"// a string after a word that only ends in r"; // three',
    '',
  ].join('\n');

  expect(texts(source)).toEqual([' one', ' two', ' three']);
});

test('a quote opens a character literal or a lifetime, and only the literal can hide an opener', () => {
  const source = [
    "let a = '\"'; // one",
    "let b = '\\''; let c = '\\\\'; // two",
    "let d = '\\u{1F600}'; let e = '😀'; let f = 'é'; // three",
    "let g = b'\"'; let h = b'\\''; let i = '/'; // four",
    "fn j<'a, 'b: 'a>(x: &'a str, y: &'b str) -> &'static str { x } // five",
    "fn k() { 'outer: loop { break 'outer; } } // six",
    "impl<'de> Visitor<'de> for V<'_> {} // seven",
    'let l = f::<\'static>("// in a string after a lifetime"); // eight',
    '',
  ].join('\n');

  expect(texts(source)).toEqual([
    ' one',
    ' two',
    ' three',
    ' four',
    ' five',
    ' six',
    ' seven',
    ' eight',
  ]);
});

test('source the lexer cannot follow to its end has no answer', () => {
  expect(() => texts('/* open /* nested */')).toThrow(
    'src/lib.rs: a block comment is never closed',
  );
  expect(() => texts('let a = "open; // one')).toThrow(
    'src/lib.rs: a string literal is never closed',
  );
  expect(() => texts('let a = r#"open"; // one')).toThrow(
    'src/lib.rs: a raw string literal is never closed',
  );
  expect(() => texts("let a = '\\u{1F600")).toThrow(
    'src/lib.rs: a character literal is never closed',
  );
});

test('each rule matches its words whole, the first four in any letter case', () => {
  const source = [
    '// Kept for now.',
    '// FOR NOW this is enough; therefore now, before now and for nowhere are other words',
    '// A temporary buffer, held Temporarily; contemporary and temporaryish are other words',
    '// This should work. It Should  Work twice; should workers is another phrase',
    '// Hopefully fine; unhopefully and hopefully_ are other words',
    '// éfor now, for nowé, for_now and 9hopefully touch a letter, a digit or an underscore',
    '',
  ].join('\n');

  expect(found('src/lib.rs', source)).toEqual([
    '1:9 comment-for-now',
    '2:4 comment-for-now',
    '3:6 comment-temporary',
    '3:29 comment-temporary',
    '4:9 comment-should-work',
    '4:25 comment-should-work',
    '5:4 comment-hopefully',
  ]);
});

test('an unfinished-work marker is a finding unless its comment holds a URL', () => {
  const source = [
    '// TODO: retry on a closed stream',
    '// FIXME(owner) and a second TODO in one comment',
    '// TODO https://github.com/example/merkur/issues/12: retry on a closed stream',
    '// FIXME: see http://example.test/7',
    '// todo, Todo, TODOS, FIXMES and MASTODON are other words',
    '/* TODO: the link is in the next comment */',
    '// https://github.com/example/merkur/issues/13',
    '/*',
    ' * FIXME: a block holds its own link,',
    ' * https://github.com/example/merkur/issues/14',
    ' */',
    '',
  ].join('\n');

  expect(found('src/lib.rs', source)).toEqual([
    '1:4 comment-todo-without-link',
    '2:4 comment-todo-without-link',
    '2:30 comment-todo-without-link',
    '6:4 comment-todo-without-link',
  ]);
});

test('a finding in a block comment is on the line of the matched words', () => {
  const source = [
    'fn f() {}',
    '/*',
    ' * The first line says nothing.',
    ' * The third is temporary,',
    ' * and so is this one for now.',
    ' */',
    'const WORDS: &str = "for now, hopefully, temporary: a string is not a comment";',
    '',
  ].join('\n');

  expect(found('apps/edge/src/relay.rs', source)).toEqual([
    '4:17 comment-temporary',
    '5:23 comment-for-now',
  ]);
  expect(measureFile('apps/edge/src/relay.rs', source)[0]).toEqual({
    file: 'apps/edge/src/relay.rs',
    rule: 'comment-temporary',
    line: 4,
    column: 17,
    message:
      'A comment that calls code temporary does not say what ends it: name the condition that removes the code, or describe the code as it stands.',
  });
});

test('a script file is read by the parser: a string, a template or JSX text is not a comment', () => {
  const source = [
    "export const é = '😀 // for now, in a string';",
    'export const t = `/* hopefully, in a template */`;',
    'export const r = /should work/;',
    'export const j = <p>// temporary, in JSX text</p>;',
    "export const s = '😀'; // kept for now",
    '/**',
    ' * A doc block that should work.',
    ' */',
    'export const k = <div>{/* TODO: in a JSX comment */}</div>;',
    '',
  ].join('\n');

  expect(found('apps/web/src/a.tsx', source)).toEqual([
    '5:32 comment-for-now',
    '7:21 comment-should-work',
    '9:27 comment-todo-without-link',
  ]);
});

test('a file with no candidate is not read for comments, and one that cannot be read has no answer', () => {
  expect(measureFile('scripts/a.ts', 'export const x = (;\n')).toEqual([]);
  expect(measureFile('src/lib.rs', 'let a = "never closed;\n')).toEqual([]);
  expect(() => measureFile('scripts/a.ts', 'export const x = (; // for now\n')).toThrow(
    'could not parse scripts/a.ts to read its comments',
  );
  expect(() => measureFile('src/lib.rs', 'let a = "never closed; // for now\n')).toThrow(
    'src/lib.rs: a string literal is never closed',
  );
});

test('findings come only from the comments handed in', () => {
  const source = '// for now\nlet a = 1; // hopefully\n';
  const [first, second] = rustComments('src/lib.rs', source);

  expect(findHedges('src/lib.rs', source, [])).toEqual([]);
  expect(first === undefined || second === undefined).toBe(false);
  expect(
    findHedges('src/lib.rs', source, second === undefined ? [] : [second]).map(
      (finding) => `${finding.line}:${finding.column} ${finding.rule}`,
    ),
  ).toEqual(['2:15 comment-hopefully']);
});

test('a file is read as Rust by its extension, and as a script otherwise', () => {
  expect(['apps/edge/src/relay.rs', 'build.rs'].filter(isRustSource)).toHaveLength(2);
  expect(['scripts/a.ts', 'apps/web/src/a.tsx', 'docs/a.rs.md'].filter(isRustSource)).toEqual([]);
  // The same text has a comment in one language and a string in the other.
  expect(found('src/lib.rs', 'let a = r"// for now";\n')).toEqual([]);
  expect(found('src/lib.ts', 'let a = r; // for now\n')).toEqual(['1:15 comment-for-now']);
});

test('every rule is named as a comment rule and carries its repair instruction', () => {
  expect(RULES.map((rule) => rule.name)).toEqual([
    'comment-for-now',
    'comment-temporary',
    'comment-should-work',
    'comment-hopefully',
    'comment-todo-without-link',
  ]);

  for (const rule of RULES) {
    expect([rule.name, rule.message.endsWith('.') && rule.message.includes(': ')]).toEqual([
      rule.name,
      true,
    ]);
  }
});
