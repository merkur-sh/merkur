import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTestProcess } from './test-process';
import { greenTestFiles } from './verification-junit';

test('the real parallel runner attributes assertions, hook errors and worker crashes per file', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'merkur-junit-')));
  const sources = {
    'green&quoted.test.ts': `import {describe,test,expect} from 'bun:test';describe('nested',()=>{test('green',()=>expect(1).toBe(1));describe('inner',()=>test('also green',()=>expect(2).toBe(2)));});`,
    'red.test.ts': `import {test,expect} from 'bun:test';test('red',()=>expect(1).toBe(2));`,
    'hook.test.ts': `import {test,afterAll} from 'bun:test';test('green before teardown',()=>{});afterAll(()=>{throw Error('teardown failed')});`,
    'crash.test.ts': `import {test} from 'bun:test';test('crash',()=>process.exit(2));`,
    'empty.test.ts': 'export const noTests = true;',
  };
  try {
    for (const [file, source] of Object.entries(sources))
      writeFileSync(path.join(root, file), source);
    const report = path.join(root, 'report.xml');
    const result = await runTestProcess(
      [
        process.execPath,
        'test',
        '--parallel=4',
        '--reporter=junit',
        `--reporter-outfile=${report}`,
        ...Object.keys(sources).map((file) => `./${file}`),
      ],
      { cwd: root },
    );
    expect(result.exitCode).toBe(1);
    const xml = readFileSync(report, 'utf8');
    const selection = [...Object.keys(sources), 'never-started.test.ts'];
    expect(greenTestFiles(xml, root, selection)).toEqual(['green&quoted.test.ts']);
    expect(greenTestFiles(xml.slice(0, xml.lastIndexOf('</testsuites>')), root, selection)).toEqual(
      [],
    );
    expect(greenTestFiles(xml.replace('tests="6"', 'tests="999"'), root, selection)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
