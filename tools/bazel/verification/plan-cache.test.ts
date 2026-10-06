import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanCache } from './plan-cache';

test('a slot answers only the digest it was written for, and a newer digest replaces it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'merkur-plan-cache-'));
  try {
    const cache = new PlanCache(path.join(directory, 'plans'));
    expect(cache.read('plan:unit', 'a')).toBeUndefined();
    cache.write('plan:unit', 'a', { required: ['//x:test'] });
    expect(cache.read('plan:unit', 'a')).toEqual({ required: ['//x:test'] });
    expect(cache.read('plan:unit', 'b')).toBeUndefined();
    expect(cache.read('plan:all', 'a')).toBeUndefined();
    cache.write('plan:unit', 'b', { required: [] });
    expect(cache.read('plan:unit', 'a')).toBeUndefined();
    expect(cache.read('plan:unit', 'b')).toEqual({ required: [] });
    const files = readdirSync(path.join(directory, 'plans'));
    expect(files).toHaveLength(1);
    writeFileSync(path.join(directory, 'plans', files[0] ?? ''), '{"key":"b","val');
    expect(cache.read('plan:unit', 'b')).toBeUndefined();
    expect(() => new PlanCache('relative')).toThrow('absolute');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
