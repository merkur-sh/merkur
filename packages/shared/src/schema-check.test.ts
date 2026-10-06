import { describe, expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

import * as contract from './api-schema';
import { isRecord, type JsonRecord } from './parsing';
import { compileCheck, compileRequire } from './schema-check';

/**
 * TypeBox is the oracle: the server validates every response with it, so the
 * browser's checker is correct exactly when it returns TypeBox's verdict. Each
 * schema gets a valid value and every systematic way of spoiling one. The two
 * must agree on all of them, accept or reject, and where the checker says a
 * value went wrong must be a fault TypeBox reports at that same place.
 */

const LABEL = 'Invalid response';

const FAULT = /^Invalid response at (\S+) \((\w+)\)$/u;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Covers the keywords the contract does not happen to use yet. */
const everyKeyword = Type.Object(
  {
    pair: Type.Tuple([Type.Literal('terminal-session'), Type.Integer({ minimum: 1 })]),
    ratio: Type.Number({ minimum: -1.5, maximum: 1.5 }),
    note: Type.Optional(Type.String({ pattern: '^[\\s\\S]{2,4}$' })),
    tags: Type.Array(Type.String({ pattern: '^[A-Za-z0-9_-]{1,3}$' }), {
      minItems: 1,
      maxItems: 3,
    }),
    count: Type.Literal(7),
    open: Type.Object({ kind: Type.Union([Type.Literal('a'), Type.Null()]) }),
    nested: Type.Array(Type.Array(Type.Boolean(), { maxItems: 2 })),
  },
  { additionalProperties: false },
);

/** Every schema the contract exports; its builders are functions and are tested by name below. */
const CONTRACT = Object.entries(contract).flatMap(([name, schema]): [string, TSchema][] =>
  isRecord(schema) ? [[name, schema]] : [],
);

const SCHEMAS: ReadonlyArray<readonly [string, TSchema]> = [
  ...CONTRACT,
  ['everyKeyword', everyKeyword],
  ['top-level union', Type.Union([Type.Null(), Type.String({ pattern: '^[\\s\\S]{1,}$' })])],
  ['top-level array', Type.Array(Type.Integer({ minimum: 0, maximum: 9 }), { minItems: 2 })],
];

const WRONG_VALUES: readonly unknown[] = [
  null,
  undefined,
  true,
  false,
  0,
  1,
  -1,
  1.5,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  1e300,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  '',
  'x',
  '0',
  [],
  [null],
  {},
  { type: 'object' },
];

describe('compileCheck agrees with TypeBox', () => {
  test('the contract is every schema the browser reads', () => {
    expect(CONTRACT.length).toBeGreaterThan(18);
  });

  for (const [name, schema] of SCHEMAS) {
    test(name, () => {
      const check = compileCheck(schema);
      const demand = compileRequire(schema, LABEL);
      const valid = sample(node(schema));

      expect(Value.Check(schema, valid)).toBe(true);
      expect(check(valid)).toBe(true);
      expect(demand(valid)).toBe(valid);

      const cases = spoiled(node(schema), valid);

      // A schema this small in cases would mean the walk below missed it.
      expect(cases.length).toBeGreaterThan(WRONG_VALUES.length + 3);

      for (const value of cases) {
        const verdict = Value.Check(schema, value);

        if (check(value) !== verdict) {
          throw new Error(
            `${name}: compileCheck says ${check(value)}, TypeBox says ${verdict} for ${shown(value)}`,
          );
        }

        if (verdict) {
          expect(demand(value)).toBe(value);
        } else {
          const message = refusal(() => demand(value));
          const fault = FAULT.exec(message);

          if (fault === null || !isReported(schema, value, fault[1] ?? '', fault[2] ?? '')) {
            throw new Error(
              `${name}: "${message}" is no fault TypeBox reports for ${shown(value)}: ${shown(Value.Errors(schema, value))}`,
            );
          }
        }
      }
    });
  }

  test('an optional property may be absent or undefined, a required one may be neither', () => {
    const schema = Type.Object({ a: Type.Optional(Type.String()), b: Type.String() });
    const check = compileCheck(schema);

    for (const value of [
      { b: 'x' },
      { a: undefined, b: 'x' },
      { a: 'y', b: 'x' },
      { a: 1, b: 'x' },
      { a: null, b: 'x' },
      { a: 'y' },
      { a: 'y', b: undefined },
      { b: 'x', extra: 1 },
    ]) {
      expect(check(value)).toBe(Value.Check(schema, value));
    }
  });
});

describe('a refused response says where, and nothing of what it held', () => {
  const session = {
    delegationId: 'delegation-1',
    issuedAt: 1,
    expiresAt: 2,
    revokedAt: null,
    current: true,
    client: { browser: 'Chrome', platform: null, installed: false },
  };

  const demand = compileRequire(
    contract.BrowserSessionListResponse,
    'Invalid browser sessions response',
  );

  const refused: ReadonlyArray<readonly [string, object | null, string]> = [
    [
      'a property of the wrong type, by index and name',
      {
        serverTimeMs: 5,
        sessions: [
          session,
          session,
          session,
          { ...session, client: { ...session.client, browser: 7 } },
        ],
      },
      '/sessions/3/client/browser (type)',
    ],
    [
      'the branch of the value’s own type explains a union',
      { serverTimeMs: 5, sessions: [{ ...session, client: { ...session.client, browser: '' } }] },
      '/sessions/0/client/browser (pattern)',
    ],
    [
      'a bound',
      { serverTimeMs: 5, sessions: [{ ...session, revokedAt: -1 }] },
      '/sessions/0/revokedAt (minimum)',
    ],
    [
      'a missing property, by the name it should have had',
      { serverTimeMs: 5, sessions: [{ ...session, client: { browser: null, installed: true } }] },
      '/sessions/0/client/platform (required)',
    ],
    [
      'an unexpected property, at the object that holds it',
      { serverTimeMs: 5, sessions: [session, { ...session, sessionToken: 's3cr3t-value' }] },
      '/sessions/1 (additionalProperties)',
    ],
    ['the first fault only', { serverTimeMs: -1, sessions: 7 }, '/serverTimeMs (minimum)'],
    ['a response that is no object', null, '/ (type)'],
  ];

  for (const [name, response, where] of refused) {
    test(name, () => {
      expect(refusal(() => demand(response))).toBe(`Invalid browser sessions response at ${where}`);
    });
  }

  test('neither a value nor a name the schema does not know reaches the message', () => {
    const message = refusal(() =>
      demand({
        serverTimeMs: 5,
        sessions: [{ ...session, delegationId: 7, sessionToken: 's3cr3t-value' }],
      }),
    );

    expect(message).toBe('Invalid browser sessions response at /sessions/0/delegationId (type)');
    expect(
      refusal(() =>
        demand({ serverTimeMs: 5, sessions: [{ ...session, sessionToken: 's3cr3t' }] }),
      ),
    ).not.toMatch(/sessionToken|s3cr3t/u);
  });

  test('a union of literals no branch explains fails as the union', () => {
    const policy = compileRequire(contract.AuthPolicyResponse, 'Invalid policy');

    expect(refusal(() => policy({ identity: 'phone', registration: true }))).toBe(
      'Invalid policy at /identity (anyOf)',
    );
    expect(refusal(() => policy({ identity: 5, registration: true }))).toBe(
      'Invalid policy at /identity (type)',
    );
  });

  test('a tuple names the item it has no place for', () => {
    const pair = compileRequire(Type.Tuple([Type.Literal('a'), Type.Boolean()]), 'Invalid pair');

    expect(refusal(() => pair(['a', true, 1]))).toBe('Invalid pair at /2 (additionalItems)');
    expect(refusal(() => pair(['a']))).toBe('Invalid pair at / (minItems)');
    expect(refusal(() => pair(['b', true]))).toBe('Invalid pair at /0 (const)');
  });
});

describe('Base64Url is canonical unpadded base64url of an exact byte count', () => {
  /** The last characters a final group of `bytes` bytes encodes to, found by encoding every one. */
  function lastCharacters(bytes: 1 | 2 | 3): string {
    const seen = new Set<string>();
    const lead = bytes === 3 ? [0x5a] : [];

    for (let tail = 0; tail < (bytes === 1 ? 256 : 65_536); tail += 1) {
      const group = bytes === 1 ? [tail] : [...lead, tail >> 8, tail & 0xff];

      seen.add(Buffer.from(group).toString('base64url').slice(-1));
    }

    return [...ALPHABET].filter((character) => seen.has(character)).join('');
  }

  test('the last character’s class is the one every encoding of that tail lands in', () => {
    expect(lastCharacters(1)).toHaveLength(4);
    expect(lastCharacters(2)).toHaveLength(16);
    expect(lastCharacters(3)).toBe(ALPHABET);
    expect(node(contract.Base64Url(1)).pattern).toBe(`^[A-Za-z0-9_-]{1}[${lastCharacters(1)}]$`);
    expect(node(contract.Base64Url(2)).pattern).toBe(`^[A-Za-z0-9_-]{2}[${lastCharacters(2)}]$`);
    expect(node(contract.Base64Url(3)).pattern).toBe('^[A-Za-z0-9_-]{4}$');
    expect(node(contract.Base64Url(32)).pattern).toBe(`^[A-Za-z0-9_-]{42}[${lastCharacters(2)}]$`);
    expect(node(contract.Base64Url(64)).pattern).toBe(`^[A-Za-z0-9_-]{85}[${lastCharacters(1)}]$`);
  });

  for (const bytes of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 32, 48, 64, 65, 320, 2_592]) {
    test(`${bytes} bytes: a string passes exactly when it decodes to them and encodes back`, () => {
      const schema = contract.Base64Url(bytes);
      const check = compileCheck(schema);

      const encodings = [
        Buffer.alloc(bytes, 0x00),
        Buffer.alloc(bytes, 0xff),
        Buffer.alloc(bytes, 0xa5),
        Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))),
      ].map((value) => value.toString('base64url'));

      for (const encoding of encodings) {
        const stem = encoding.slice(0, -1);

        // Every possible last character, one character short and long, and what
        // padded or standard base64 would have written.
        const candidates = [
          encoding,
          stem,
          `${encoding}A`,
          `${encoding}=`,
          `+${encoding.slice(1)}`,
          `/${encoding.slice(1)}`,
          ...[...ALPHABET, '+', '/', '=', '!', '\n'].map((last) => `${stem}${last}`),
        ];

        for (const candidate of candidates) {
          const decoded = Buffer.from(candidate, 'base64url');
          const canonical =
            decoded.byteLength === bytes && decoded.toString('base64url') === candidate;

          if (check(candidate) !== canonical || Value.Check(schema, candidate) !== canonical) {
            throw new Error(
              `${bytes} bytes: ${candidate.slice(-8)} (${candidate.length} characters) is ${canonical ? '' : 'not '}canonical, compileCheck says ${check(candidate)}, TypeBox says ${Value.Check(schema, candidate)}`,
            );
          }
        }
      }
    });
  }

  test('a nonce whose last character carries spare bits is refused at the nonce', () => {
    const demand = compileRequire(contract.DaemonLinkClaimInspectResponse, LABEL);
    const inspection = sample(node(contract.DaemonLinkClaimInspectResponse));

    if (!isRecord(inspection)) throw new Error('the sample is not an object');

    // 43 characters of the alphabet, as 32 bytes encode; `R` sets the two bits they leave spare.
    const serverNonce = `${Buffer.alloc(32, 4).toString('base64url').slice(0, -1)}R`;

    expect(refusal(() => demand(inspection))).toBe('');
    expect(refusal(() => demand({ ...inspection, serverNonce }))).toBe(
      'Invalid response at /serverNonce (pattern)',
    );
  });
});

describe('text is bounded in code points', () => {
  // Units whose UTF-16 length, grapheme count and code point count part ways:
  // astral, combining, variation-selected, a flag, a joined family, a bare
  // joiner, and each half of a surrogate pair on its own.
  const UNITS = [
    'a',
    '\n',
    '\u{1f44d}',
    'e\u{301}',
    '\u{2764}\u{fe0f}',
    '\u{1f1ea}\u{1f1f8}',
    '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}',
    '\u{200d}',
    '\ud83d',
    '\ude00',
  ];

  const BOUNDED: ReadonlyArray<readonly [string, TSchema, number, number]> = [
    ['a device name', contract.DeviceName, 1, 128],
    ['a device platform', contract.DevicePlatform, 1, 64],
    ['two to three', Type.String({ pattern: '^[\\s\\S]{2,3}$' }), 2, 3],
    ['at least one', Type.String({ pattern: '^[\\s\\S]{1,}$' }), 1, Number.POSITIVE_INFINITY],
    ['anything', Type.String({ pattern: '^[\\s\\S]{0,}$' }), 0, Number.POSITIVE_INFINITY],
  ];

  for (const [name, schema, minimum, maximum] of BOUNDED) {
    test(name, () => {
      const check = compileCheck(schema);
      const totals = [minimum - 1, minimum, minimum + 1, maximum - 1, maximum, maximum + 1, 200];

      for (const unit of UNITS) {
        for (const total of totals) {
          if (total < 0 || !Number.isFinite(total)) continue;

          const value = filled(unit, total);
          const bounded = total >= minimum && total <= maximum;

          expect([...value]).toHaveLength(total);

          if (check(value) !== bounded || Value.Check(schema, value) !== bounded) {
            throw new Error(
              `${name}: ${total} code points of ${JSON.stringify(unit)} should ${bounded ? 'pass' : 'fail'}; compileCheck says ${check(value)}, TypeBox says ${Value.Check(schema, value)}`,
            );
          }
        }
      }
    });
  }
});

describe('compileCheck refuses what it cannot honour', () => {
  const refused: ReadonlyArray<readonly [string, TSchema, string]> = [
    ['minLength', Type.String({ minLength: 1 }), 'keyword minLength'],
    ['maxLength', Type.String({ maxLength: 4 }), 'keyword maxLength'],
    ['format', Type.String({ format: 'email' }), 'keyword format'],
    ['exclusiveMinimum', Type.Number({ exclusiveMinimum: 0 }), 'keyword exclusiveMinimum'],
    ['multipleOf', Type.Integer({ multipleOf: 2 }), 'keyword multipleOf'],
    ['uniqueItems', Type.Array(Type.String(), { uniqueItems: true }), 'keyword uniqueItems'],
    ['minProperties', Type.Object({}, { minProperties: 1 }), 'keyword minProperties'],
    ['a record', Type.Record(Type.String(), Type.Number()), 'keyword patternProperties'],
    ['an enum', Type.Enum(['a', 'b']), 'type undefined'],
    ['an intersection', Type.Intersect([Type.Object({}), Type.Object({})]), 'type undefined'],
    ['any', Type.Any(), 'type undefined'],
    ['unknown', Type.Unknown(), 'type undefined'],
    ['void', Type.Void(), 'type "void"'],
    ['a description', Type.String({ description: 'a name' }), 'keyword description'],
    ['a typed extra', Type.Object({}, { additionalProperties: Type.String() }), 'additional'],
    ['an inherited name', Type.Object({ toString: Type.String() }), 'property name toString'],
    ['a nested keyword', Type.Object({ a: Type.Array(Type.String({ format: 'uuid' })) }), '#/'],
    ['a union branch', Type.Union([Type.Null(), Type.Any()]), '#/anyOf/1'],
  ];

  for (const [name, schema, message] of refused) {
    test(name, () => {
      expect(() => compileCheck(schema)).toThrow(message);
      expect(() => compileRequire(schema, LABEL)).toThrow(message);
    });
  }

  test('a refusal names where the keyword sits', () => {
    expect(() =>
      compileCheck(Type.Object({ list: Type.Array(Type.String({ format: 'uuid' })) })),
    ).toThrow('schema-check: unsupported keyword format at #/properties/list/items');
  });
});

function node(schema: unknown): JsonRecord {
  if (!isRecord(schema)) throw new Error('schema-check.test: a schema is an object');

  return schema;
}

function nodes(schemas: unknown): JsonRecord[] {
  if (!Array.isArray(schemas)) throw new Error('schema-check.test: expected a schema list');

  return schemas.map(node);
}

function integer(value: unknown, otherwise: number): number {
  return typeof value === 'number' ? value : otherwise;
}

/** What the call threw, or nothing when it returned. */
function refusal(call: () => void): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return '';
}

function shown(value: unknown): string {
  return (JSON.stringify(value) ?? String(value)).slice(0, 400);
}

/** `total` code points: as many whole `unit`s as fit, then `a`s. */
function filled(unit: string, total: number): string {
  const size = [...unit].length;
  const whole = Math.floor(total / size);

  return unit.repeat(whole) + 'a'.repeat(total - whole * size);
}

/** The numbers a pattern is written with; its repeat counts are among them. */
function counts(schema: JsonRecord): number[] {
  return [...String(schema.pattern ?? '').matchAll(/\d+/gu)].map((match) => Number(match[0]));
}

/**
 * Whether TypeBox reports the fault the checker named: the same keyword at the
 * same place. TypeBox puts a missing property at its object and names it in the
 * error, and words a tuple's `additionalItems: false` as the boolean schema the
 * extra item fails.
 */
function isReported(schema: TSchema, value: unknown, at: string, keyword: string): boolean {
  const path = at === '/' ? '' : at;
  const cut = path.lastIndexOf('/');

  return Value.Errors(schema, value).some((error) => {
    if (keyword === 'required') {
      return (
        error.keyword === 'required' &&
        error.instancePath === path.slice(0, cut) &&
        shown(error.params).includes(`"${path.slice(cut + 1)}"`)
      );
    }

    return (
      error.instancePath === path &&
      error.keyword === (keyword === 'additionalItems' ? 'boolean' : keyword)
    );
  });
}

/** A value the schema accepts, with every array populated so its items can be spoiled. */
function sample(schema: JsonRecord): unknown {
  if (schema.anyOf !== undefined) {
    const [first] = nodes(schema.anyOf);

    if (first === undefined) throw new Error('schema-check.test: an empty union');

    return sample(first);
  }

  if (schema.const !== undefined) return schema.const;

  switch (schema.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(node(schema.properties)).map(([key, property]) => [
          key,
          sample(node(property)),
        ]),
      );
    case 'array':
      return Array.isArray(schema.items)
        ? nodes(schema.items).map(sample)
        : Array.from({ length: Math.max(integer(schema.minItems, 0), 2) }, () =>
            sample(node(schema.items)),
          );
    case 'string': {
      // The shortest run of `A` TypeBox accepts: a pattern's bounds are in its own text.
      const lengths = [1, 0, ...counts(schema).flatMap((count) => [count, count + 1])];
      const text = lengths
        .map((length) => 'A'.repeat(length))
        .find((run) => Value.Check(schema, run));

      if (text === undefined) throw new Error(`schema-check.test: no sample for ${shown(schema)}`);

      return text;
    }
    case 'integer':
    case 'number':
      return integer(schema.minimum, 0);
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      throw new Error(`schema-check.test: no sample for ${shown(schema)}`);
  }
}

/** Every way of spoiling `valid` that the schema's own keywords suggest, at every depth. */
function spoiled(schema: JsonRecord, valid: unknown): unknown[] {
  const cases: unknown[] = [...WRONG_VALUES];

  if (schema.anyOf !== undefined) {
    for (const branch of nodes(schema.anyOf)) {
      const value = sample(branch);

      cases.push(value, ...spoiled(branch, value));
    }

    return cases;
  }

  if (schema.const !== undefined) {
    cases.push(`${String(schema.const)}x`, !schema.const, Number(schema.const) + 1);

    return cases;
  }

  switch (schema.type) {
    case 'object': {
      if (!isRecord(valid)) throw new Error('schema-check.test: the sample is not an object');

      cases.push({ ...valid, unexpected: 1 }, { ...valid, toString: 1 });
      cases.push(JSON.parse(`{"__proto__":1,${JSON.stringify(valid).slice(1)}`));

      for (const [key, property] of Object.entries(node(schema.properties))) {
        const { [key]: field, ...without } = valid;

        cases.push(without, { ...without, [key]: undefined });

        for (const value of spoiled(node(property), field)) cases.push({ ...valid, [key]: value });
      }

      return cases;
    }
    case 'array': {
      if (!Array.isArray(valid)) throw new Error('schema-check.test: the sample is not an array');

      const items = Array.isArray(schema.items)
        ? nodes(schema.items)
        : valid.map(() => node(schema.items));

      const first = valid[0];

      cases.push([], valid.slice(1), [...valid, ...valid], [...valid, ...valid, ...valid]);
      cases.push([...valid, first], [...valid, null]);

      for (const length of [integer(schema.minItems, 0), integer(schema.maxItems, 0)]) {
        for (const size of [length - 1, length, length + 1]) {
          if (size >= 0) cases.push(Array.from({ length: size }, () => first));
        }
      }

      items.forEach((item, index) => {
        for (const value of spoiled(item, valid[index])) {
          cases.push(valid.map((element: unknown, at) => (at === index ? value : element)));
        }
      });

      return cases;
    }
    case 'string': {
      const lengths = new Set([0, 1, 2]);

      for (const count of counts(schema)) {
        for (const length of [count - 1, count, count + 1, count + 2]) {
          if (length >= 0) lengths.add(length);
        }
      }

      for (const length of lengths) {
        const stem = 'A'.repeat(Math.max(length - 1, 0));

        // In the alphabet and out of it; code points that are not one UTF-16
        // unit, one grapheme cluster or one whole character each; and every
        // kind of last character an encoding could end on.
        cases.push('A'.repeat(length), '_-9z'.repeat(length).slice(0, length));
        cases.push(`${'A'.repeat(length)}\n`, ' '.repeat(length), `${stem}é`);
        cases.push('👍'.repeat(length), 'e\u{301}'.repeat(length), '🇪🇸'.repeat(length));
        cases.push('\ud83d'.repeat(length), '\ude00'.repeat(length), '\u{200d}'.repeat(length));

        for (const last of 'BQgw048_-=+/!') cases.push(`${stem}${last}`);
      }

      return cases;
    }
    case 'integer':
    case 'number': {
      for (const bound of [schema.minimum, schema.maximum]) {
        if (typeof bound !== 'number') continue;

        cases.push(bound - 1, bound, bound + 1, bound - 0.5, bound + 0.5);
      }

      cases.push(String(valid), 2 ** 53, -(2 ** 53), Number.MIN_SAFE_INTEGER, 0.1);

      return cases;
    }
    case 'boolean':
      cases.push('true', 'false');

      return cases;
    case 'null':
      cases.push('null');

      return cases;
    default:
      throw new Error(`schema-check.test: no cases for ${shown(schema)}`);
  }
}
