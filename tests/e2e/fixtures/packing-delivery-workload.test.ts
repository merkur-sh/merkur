import { expect, test } from 'bun:test';
import {
  packingDeliveryApplication,
  packingExpectedCanonicalRows,
  packingExpectedViewport,
  packingMarker,
} from './packing-delivery-workload';

test('application uses bounded precomputed alternating rows and explicit sync updates', () => {
  const source = packingDeliveryApplication(
    { cols: 384, rows: 256, entropy: true },
    '/tmp/owned-packing-status',
  );
  expect(source).toContain('variant<2');
  expect(source).toContain('[?2026h');
  expect(source).toContain('[?2026l');
  expect(source).toContain('records.length>=2000');
  expect(source).not.toContain('133;B');
  expect(source).not.toContain('?2004h');
  expect(() => new Function(source)).not.toThrow();
});

test('independent XXH3 primitive matches the native canonical digest golden vector', () => {
  // merkur-codec/src/hash.rs pins row_hash([CellRepr::BLANK; 4]) to this
  // literal value; this is the same independently packed byte contract.
  const packed = new Uint8Array(4 * 11);
  for (let cell = 0; cell < 4; cell++) packed.set([205, 214, 244, 30, 30, 46], cell * 11 + 4);
  expect(Bun.hash.xxHash3(packed)).toBe(0x8f2b85d5de9cdd2fn);
});

test('absolute row digests include fixed colors and flags independently of received data', () => {
  const shape = { cols: 120, rows: 40, entropy: false };
  const rows: Uint8Array[] = [];
  const hashes = packingExpectedCanonicalRows(shape, 1, 1, 0, (bytes) => {
    rows.push(bytes.slice());
    return Bun.hash.xxHash3(bytes);
  });
  expect(hashes).toHaveLength(40);
  expect(rows[0]?.slice(4, 11)).toEqual(new Uint8Array([222, 223, 224, 13, 14, 15, 0]));
  expect(rows[39]?.slice(0, 11)).toEqual(
    new Uint8Array([88, 0, 0, 0, 222, 223, 224, 13, 14, 15, 0]),
  );
  const secondRow = rows[1];
  if (secondRow === undefined) throw new Error('fixture omitted row');
  // palette index18 is the blue-cube value135, independent of a UI theme.
  expect(secondRow.slice(4, 11)).toEqual(new Uint8Array([0, 0, 135, 13, 14, 15, 0]));
  const original = Bun.hash.xxHash3(secondRow);
  for (const offset of [0, 4, 7, secondRow.length - 1]) {
    const changed = secondRow.slice();
    changed[offset] = (changed[offset] ?? 0) ^ 1;
    expect(Bun.hash.xxHash3(changed)).not.toBe(original);
  }
});

test('full viewport oracle checks every cell and distinguishes each redraw variant', () => {
  const shape = { cols: 120, rows: 40, entropy: false };
  const first = packingExpectedViewport(shape, 1, 1, 0).split('\n');
  const second = packingExpectedViewport(shape, 2, 2, 0).split('\n');
  expect(first).toHaveLength(40);
  expect(first.every((row) => row.length === 120)).toBe(true);
  expect(first[0]).toStartWith(packingMarker(1, 1, 0));
  expect(first[39]).toStartWith('X');
  expect(first.every((row, index) => row !== second[index])).toBe(true);
});

test('shape and operation identity refuse malformed or unsupported fixtures', () => {
  expect(() =>
    packingDeliveryApplication({ cols: 120, rows: 256, entropy: false }, '/tmp/status'),
  ).toThrow();
  expect(() =>
    packingDeliveryApplication({ cols: 120, rows: 40, entropy: false }, 'relative'),
  ).toThrow();
  expect(packingMarker(1, 2, 3)).toBe('PACK-r000001-x000002-h000003');
  expect(() => packingMarker(-1, 0, 0)).toThrow();
});
