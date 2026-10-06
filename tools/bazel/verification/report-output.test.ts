import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertReportOutputOutside,
  openReportOutput,
  retireReportOutput,
  verifyReportOutput,
} from './report-output';

test('report publication refuses a moved caller parent and preserves its replacement', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-report-output-control-'));
  try {
    for (const name of ['source', 'reports', 'replacement']) mkdirSync(path.join(root, name));
    const output = openReportOutput(
      path.join(root, 'reports', 'report.json'),
      path.join(root, 'source'),
    );
    try {
      renameSync(path.join(root, 'reports'), path.join(root, 'moved'));
      symlinkSync(path.join(root, 'replacement'), path.join(root, 'reports'));
      expect(() => output.write('{}\n')).toThrow('parent changed');
      expect(readdirSync(path.join(root, 'moved'))).toEqual([]);
      expect(readdirSync(path.join(root, 'replacement'))).toEqual([]);
    } finally {
      output.close();
    }
    const existing = path.join(root, 'replacement', 'caller.json');
    writeFileSync(existing, 'caller\n');
    const retained = openReportOutput(existing, path.join(root, 'source'));
    try {
      expect(() => retained.write('{}\n')).toThrow('fresh');
    } finally {
      retained.close();
    }
    expect(readFileSync(existing, 'utf8')).toBe('caller\n');
    expect(() =>
      openReportOutput(path.join(root, 'source', 'report.json'), path.join(root, 'source')),
    ).toThrow('outside');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the actual open publisher can verify its retained durable output', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-report-receipt-control-'));
  try {
    mkdirSync(path.join(root, 'source'));
    const file = path.join(root, 'expected.json');
    const output = openReportOutput(file, path.join(root, 'source'));
    try {
      expect(Object.isFrozen(output)).toBe(true);
      expect(() => verifyReportOutput(output)).toThrow('not been durably');
      output.write('[{"platform":"darwin-arm64"}]\n');
      verifyReportOutput(output);
      expect(() => verifyReportOutput({ ...output })).toThrow('owned report');
      expect(() => verifyReportOutput(Object.create(output))).toThrow('owned report');
      expect(() => assertReportOutputOutside(output, root)).toThrow('outside source');
      expect(() => output.write('replacement')).toThrow('only once');
      writeFileSync(file, 'substituted bytes');
      expect(() => verifyReportOutput(output)).toThrow('facts changed');
    } finally {
      output.close();
    }
    expect(() => verifyReportOutput(output)).toThrow('open owned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure retirement removes only owned output and allows fresh blocked diagnostics', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'merkur-report-retirement-control-'));
  try {
    mkdirSync(path.join(root, 'source'));
    for (const mutation of ['bytes', 'replacement', 'existing']) {
      const file = path.join(root, `${mutation}.json`);
      if (mutation === 'existing') writeFileSync(file, 'caller-owned');
      const output = openReportOutput(file, path.join(root, 'source'));
      try {
        if (mutation === 'existing') {
          expect(() => output.write('accepted')).toThrow('fresh');
          retireReportOutput(output);
          expect(readFileSync(file, 'utf8')).toBe('caller-owned');
          continue;
        }
        output.write('accepted');
        if (mutation === 'bytes') {
          writeFileSync(file, 'corrupted');
          expect(() => verifyReportOutput(output)).toThrow('facts changed');
          retireReportOutput(output);
          expect(() => verifyReportOutput(output)).toThrow('not been durably');
          output.write('blocked');
          verifyReportOutput(output);
          expect(readFileSync(file, 'utf8')).toBe('blocked');
        } else {
          renameSync(file, `${file}.owned`);
          writeFileSync(file, 'caller-replacement');
          expect(() => retireReportOutput(output)).toThrow();
          expect(readFileSync(file, 'utf8')).toBe('caller-replacement');
          expect(readFileSync(`${file}.owned`, 'utf8')).toBe('accepted');
        }
      } finally {
        output.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
