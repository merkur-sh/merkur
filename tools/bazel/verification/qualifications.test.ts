import { expect, test } from 'bun:test';
import { pendingQualifications, QUALIFICATION_GROUPS } from './qualifications';

const inventory = () => Object.fromEntries(QUALIFICATION_GROUPS.map((group) => [group, [group]]));

test('common admission obligations survive every lane selection', () => {
  expect(pendingQualifications(inventory(), [])).toEqual(['common: common']);
  expect(pendingQualifications(inventory(), ['source'])).toEqual([
    'common: common',
    'source: source',
  ]);
});

test('missing, erased, malformed or fabricated qualification cannot turn a lane green', () => {
  const missing = inventory();
  delete missing.common;
  expect(() => pendingQualifications(missing, ['source'])).toThrow('Complete');
  expect(() => pendingQualifications({ ...inventory(), common: [] }, [])).toThrow('common');
  expect(() => pendingQualifications({ ...inventory(), native: [true] }, [])).toThrow('native');
  expect(() => pendingQualifications({ ...inventory(), accepted: true }, [])).toThrow('Complete');
  expect(() => pendingQualifications(inventory(), ['source', 'source'])).toThrow('unique');
});
