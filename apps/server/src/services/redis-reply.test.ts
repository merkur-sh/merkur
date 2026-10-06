import { describe, expect, test } from 'bun:test';
import {
  parseRedisFlag,
  parseRedisNonNegativeSafeInteger,
  parseRedisNullableStringArray,
  parseRedisOptionalString,
  parseRedisPositiveSafeInteger,
  parseRedisSafeInteger,
  parseRedisSetNxResult,
  parseRedisSortedSetHead,
  parseRedisStringArray,
  parseRedisTimeMilliseconds,
} from './redis-reply';
import { RedisReplyError } from './redis-service';

describe('exact Redis numeric replies', () => {
  test('reports malformed data as a typed reply error', () => {
    expect(() => parseRedisSafeInteger('not-an-integer', 'counter')).toThrow(RedisReplyError);
  });

  test('accepts only positive safe INCR results', () => {
    expect(parseRedisPositiveSafeInteger(1, 'counter')).toBe(1);
    expect(parseRedisPositiveSafeInteger('42', 'counter')).toBe(42);
    for (const value of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '0',
      '-1',
      '1.5',
      '7junk',
      '01',
      null,
    ]) {
      expect(() => parseRedisPositiveSafeInteger(value, 'counter')).toThrow();
    }
  });

  test('accepts only canonical safe integer replies', () => {
    expect(parseRedisSafeInteger(-3, 'integer')).toBe(-3);
    expect(parseRedisSafeInteger('-3', 'integer')).toBe(-3);
    expect(parseRedisSafeInteger('0', 'integer')).toBe(0);
    expect(parseRedisNonNegativeSafeInteger(0, 'counter')).toBe(0);
    expect(parseRedisNonNegativeSafeInteger('42', 'counter')).toBe(42);

    for (const value of [
      true,
      false,
      '',
      ' 1',
      '01',
      '-0',
      '+1',
      '1.0',
      [],
      [1],
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => parseRedisSafeInteger(value, 'integer')).toThrow();
    }
    for (const value of [-1, '-1']) {
      expect(() => parseRedisNonNegativeSafeInteger(value, 'counter')).toThrow();
    }
  });

  test('accepts only exact Lua boolean replies', () => {
    expect(parseRedisFlag(0, 'flag')).toBe(false);
    expect(parseRedisFlag('0', 'flag')).toBe(false);
    expect(parseRedisFlag(1, 'flag')).toBe(true);
    expect(parseRedisFlag('1', 'flag')).toBe(true);
    for (const value of [2, -1, '01', '1junk', ' 1', true, [1], null, undefined]) {
      expect(() => parseRedisFlag(value, 'flag')).toThrow();
    }
  });

  test('parses exact Redis status and collection replies', () => {
    expect(parseRedisSetNxResult('OK', 'lease')).toBe(true);
    expect(parseRedisSetNxResult(null, 'lease')).toBe(false);
    expect(parseRedisOptionalString('value', 'GET')).toBe('value');
    expect(parseRedisOptionalString(null, 'GET')).toBeNull();
    expect(parseRedisStringArray(['one', 'two'], 'members')).toEqual(['one', 'two']);
    expect(parseRedisNullableStringArray(['one', null], 2, 'MGET')).toEqual(['one', null]);

    for (const value of [false, 0, 1, '1', '', undefined]) {
      expect(() => parseRedisSetNxResult(value, 'lease')).toThrow();
    }
    for (const value of [undefined, false, 0, [], {}]) {
      expect(() => parseRedisOptionalString(value, 'GET')).toThrow();
    }
    for (const value of [null, 'one', [''], ['one', null], ['one', 2]]) {
      expect(() => parseRedisStringArray(value, 'members')).toThrow();
    }
    for (const value of [null, ['one'], ['one', null, null], ['one', false]]) {
      expect(() => parseRedisNullableStringArray(value, 2, 'MGET')).toThrow();
    }
  });

  test('parses exact Redis TIME tuples without coercion', () => {
    expect(parseRedisTimeMilliseconds(['10', '250000'])).toBe(10_250);
    expect(parseRedisTimeMilliseconds([10, 250_999])).toBe(10_250);
    for (const value of [
      null,
      [],
      ['10'],
      ['10', '0', 'extra'],
      [true, '0'],
      ['10', false],
      ['10', ' 0'],
      ['10', '1000000'],
      [Number.MAX_SAFE_INTEGER, 0],
    ]) {
      expect(() => parseRedisTimeMilliseconds(value)).toThrow();
    }
  });

  test('parses only exact one-member ZRANGE WITHSCORES replies', () => {
    expect(parseRedisSortedSetHead([])).toBeNull();
    expect(parseRedisSortedSetHead([['member', '42']])).toEqual({
      member: 'member',
      score: 42,
    });
    expect(parseRedisSortedSetHead(['member', 42])).toEqual({
      member: 'member',
      score: 42,
    });
    for (const value of [
      null,
      {},
      ['member'],
      ['member', '42', 'extra'],
      [['member']],
      [['member', '42', 'extra']],
      ['', '42'],
      ['member', true],
      ['member', ' 42'],
      ['member', '-1'],
      [[['member'], '42']],
    ]) {
      expect(() => parseRedisSortedSetHead(value)).toThrow();
    }
  });
});
