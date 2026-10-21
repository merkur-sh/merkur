import { describe, expect, test } from 'bun:test';
import { diffTables, fillQuery, parseQueryOptions, parseQueryOutput, renderTable } from './cli';

describe('profile queries', () => {
  test('trace_processor output parses into typed cells', () => {
    const table = parseQueryOutput(
      '"name","count","p50_us"\n"display.flush",64,71.6\n"a ""b""",1,[NULL]\n',
    );
    expect(table).toEqual({
      columns: ['name', 'count', 'p50_us'],
      rows: [
        ['display.flush', 64, 71.6],
        ['a "b"', 1, null],
      ],
    });
  });

  test('only a site name and numbers reach the SQL', () => {
    expect(parseQueryOptions([])).toEqual({
      span: 'display.flush',
      thresholdUs: 0,
      limit: 20,
      json: false,
    });
    expect(parseQueryOptions(['--span', "x'; drop table slice; --"])).toBeNull();
    expect(parseQueryOptions(['--threshold-us', 'NaN'])).toBeNull();
    const options = parseQueryOptions([
      '--span',
      'display.pack',
      '--threshold-us',
      '100',
      '--json',
    ]);
    expect(options).toEqual({ span: 'display.pack', thresholdUs: 100, limit: 20, json: true });
    if (options === null) throw new Error('options');
    expect(
      fillQuery("where name = '{{span}}' and dur >= {{threshold_us}} limit {{limit}}", options),
    ).toBe("where name = 'display.pack' and dur >= 100 limit 20");
  });

  test('a diff joins rows by their first column and states each numeric delta', () => {
    const before = {
      columns: ['name', 'p50_us'],
      rows: [
        ['display.flush', 70],
        ['display.fec', 1],
      ],
    };
    const after = { columns: ['name', 'p50_us'], rows: [['display.flush', 60.5]] };
    expect(diffTables(before, after)).toEqual({
      columns: ['name', 'p50_us a', 'p50_us b', 'p50_us Δ'],
      rows: [
        ['display.flush', 70, 60.5, -9.5],
        ['display.fec', 1, null, null],
      ],
    });
  });

  test('a table keeps the end of a long symbol', () => {
    const symbol = `${'x'.repeat(100)}::plan_for_carrier`;
    const rendered = renderTable({ columns: ['function'], rows: [[symbol]] });
    expect(rendered).toContain('…');
    expect(rendered.endsWith('::plan_for_carrier')).toBe(true);
  });
});
