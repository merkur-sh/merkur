import type { Static, TSchema } from 'typebox';

import { isRecord } from './parsing';

/**
 * A checker for the JSON Schema subset the HTTP response contract is written
 * in (`api-schema.ts`), for the browser: it re-checks every response against
 * the schema object the server route declares, without shipping TypeBox's
 * validator. A schema is walked once, into closures: nothing is generated, and
 * a value that passes allocates nothing.
 *
 * The subset is closed. A keyword, type or keyword value outside it throws
 * while compiling, so a schema this cannot honour never passes anything.
 * Checked values are `JSON.parse` output: own enumerable properties only.
 * `schema-check.test.ts` holds it to TypeBox's own verdict on every schema of
 * the contract.
 */
type Keyword =
  | 'type'
  | 'const'
  | 'anyOf'
  | 'properties'
  | 'required'
  | 'additionalProperties'
  | 'items'
  | 'additionalItems'
  | 'minItems'
  | 'maxItems'
  | 'pattern'
  | 'minimum'
  | 'maximum';

type SchemaNode = { readonly [K in Keyword]?: unknown };

/** Where a value first failed its schema: a path of property names and indexes, and the keyword. */
interface Fault {
  path: string;
  keyword: Keyword;
}

/**
 * One compiled schema node: whether `value` passes it. Handed a `fault`, a
 * failing node also writes the keyword it failed and every node around it
 * prefixes its own step, so the walk that refuses a value is the walk that
 * says where. A fault is only ever passed after a check has already failed.
 */
type Check = (value: unknown, fault: Fault | null) => boolean;

const UNION: readonly Keyword[] = ['anyOf'];

const OBJECT: readonly Keyword[] = ['type', 'properties', 'required', 'additionalProperties'];

const ARRAY: readonly Keyword[] = ['type', 'items', 'additionalItems', 'minItems', 'maxItems'];

const STRING: readonly Keyword[] = ['type', 'const', 'pattern'];

const NUMBER: readonly Keyword[] = ['type', 'const', 'minimum', 'maximum'];

const BOOLEAN: readonly Keyword[] = ['type', 'const'];

const NULL: readonly Keyword[] = ['type'];

/** Whether a value is what `schema` describes. */
export function compileCheck<S extends TSchema>(schema: S): (value: unknown) => value is Static<S> {
  const check = compile(schema, '#');

  return (value: unknown): value is Static<S> => check(value, null);
}

/**
 * The one call a reader of a response makes: the value as what `schema`
 * describes, or an `Error` reading `<label> at <path> (<keyword>)` for the
 * first place it is not, as in
 * `Invalid browser sessions response at /sessions/3/client/browser (type)`.
 * The error names a location and never a value: responses carry tokens and
 * keys, and a property the schema does not name is reported at its object.
 */
export function compileRequire<S extends TSchema>(
  schema: S,
  label: string,
): (value: unknown) => Static<S> {
  const check = compile(schema, '#');
  const passes = (value: unknown): value is Static<S> => check(value, null);

  return (value) => {
    if (passes(value)) return value;

    const fault: Fault = { path: '', keyword: 'type' };

    check(value, fault);

    throw new Error(`${label} at ${fault.path === '' ? '/' : fault.path} (${fault.keyword})`);
  };
}

function compile(node: SchemaNode, at: string): Check {
  if (node.anyOf !== undefined) return compileUnion(node, at);

  switch (node.type) {
    case 'object':
      return compileObject(node, at);
    case 'array':
      return compileArray(node, at);
    case 'string':
      return compileString(node, at);
    case 'integer':
    case 'number':
      return compileNumber(node, at, node.type === 'integer');
    case 'boolean':
      return compileBoolean(node, at);
    case 'null':
      return compileNull(node, at);
    default:
      throw unsupported(at, `type ${JSON.stringify(node.type)}`);
  }
}

function compileUnion(node: SchemaNode, at: string): Check {
  restrict(node, at, UNION);

  if (!Array.isArray(node.anyOf)) throw unsupported(at, 'anyOf');

  const branches = children(node.anyOf, `${at}/anyOf`);

  return (value, fault) => {
    for (const branch of branches) if (branch(value, null)) return true;

    return fault !== null && blame(branches, value, fault);
  };
}

/**
 * Says where a value no branch accepts went wrong. The branch of the value's
 * own type explains it when there is exactly one: `null | text` given an empty
 * string fails that text's pattern. A value of no branch's type fails `type`,
 * and one that several branches could have meant fails the union itself.
 */
function blame(branches: readonly Check[], value: unknown, fault: Fault): false {
  const trial: Fault = { path: '', keyword: 'type' };
  let typed = 0;

  for (const branch of branches) {
    branch(value, trial);

    if (trial.path !== '' || trial.keyword !== 'type') {
      typed += 1;
      fault.path = trial.path;
      fault.keyword = trial.keyword;
    }
  }

  if (typed === 0) return fail(fault, 'type');

  if (typed > 1) return fail(fault, 'anyOf');

  return false;
}

interface Property {
  readonly key: string;
  readonly required: boolean;
  readonly check: Check;
}

function compileObject(node: SchemaNode, at: string): Check {
  restrict(node, at, OBJECT);
  const table = node.properties;

  if (!isRecord(table)) throw unsupported(at, 'properties');

  const required = node.required ?? [];

  if (!Array.isArray(required)) throw unsupported(at, 'required');

  for (const key of required) {
    if (typeof key !== 'string' || !Object.hasOwn(table, key)) throw unsupported(at, 'required');
  }

  const properties: Property[] = [];

  for (const key of Object.keys(table)) {
    // TypeBox finds a required key with `in`, which a name every object
    // inherits always satisfies; presence here is an own property.
    if (key in Object.prototype) throw unsupported(at, `property name ${key}`);

    const path = `${at}/properties/${key}`;

    properties.push({
      key,
      required: required.includes(key),
      check: compile(child(table[key], path), path),
    });
  }

  const additional = node.additionalProperties;

  if (additional !== undefined && typeof additional !== 'boolean') {
    throw unsupported(at, 'additionalProperties');
  }

  const closed = additional === false;

  return (value, fault) => {
    if (!isRecord(value)) return fail(fault, 'type');

    for (const property of properties) {
      if (Object.hasOwn(value, property.key)) {
        const field = value[property.key];

        // TypeBox reads an optional property holding `undefined` as absent.
        if (!(field === undefined && !property.required) && !property.check(field, fault)) {
          return below(fault, property.key);
        }
      } else if (property.required) {
        fail(fault, 'required');

        return below(fault, property.key);
      }
    }

    // Reported at the object: the unexpected name is the response's, not the schema's.
    if (closed) {
      for (const key in value)
        if (!Object.hasOwn(table, key)) return fail(fault, 'additionalProperties');
    }

    return true;
  };
}

function compileArray(node: SchemaNode, at: string): Check {
  restrict(node, at, ARRAY);
  const minimum = bound(node, 'minItems', at, 0);
  const maximum = bound(node, 'maxItems', at, Number.POSITIVE_INFINITY);

  if (Array.isArray(node.items)) {
    // A tuple, as TypeBox writes one: positional schemas and nothing after them.
    if (node.additionalItems !== false) throw unsupported(at, 'additionalItems');

    const positions = children(node.items, `${at}/items`);

    return (value, fault) => {
      if (!isSized(value, minimum, maximum, fault)) return false;

      for (let index = 0; index < value.length; index += 1) {
        const position = positions[index];

        if (position === undefined) {
          fail(fault, 'additionalItems');

          return below(fault, index);
        }

        if (!position(value[index], fault)) return below(fault, index);
      }

      return true;
    };
  }

  if (node.additionalItems !== undefined) throw unsupported(at, 'additionalItems');

  const item = compile(child(node.items, `${at}/items`), `${at}/items`);

  return (value, fault) => {
    if (!isSized(value, minimum, maximum, fault)) return false;

    for (let index = 0; index < value.length; index += 1) {
      if (!item(value[index], fault)) return below(fault, index);
    }

    return true;
  };
}

/** Whether `value` is an array of an allowed length. */
function isSized(
  value: unknown,
  minimum: number,
  maximum: number,
  fault: Fault | null,
): value is unknown[] {
  if (!Array.isArray(value)) return fail(fault, 'type');

  if (value.length < minimum) return fail(fault, 'minItems');

  return value.length <= maximum || fail(fault, 'maxItems');
}

function compileString(node: SchemaNode, at: string): Check {
  restrict(node, at, STRING);
  const literal = node.const;

  if (literal !== undefined && typeof literal !== 'string') throw unsupported(at, 'const');

  const source = node.pattern;

  if (source !== undefined && typeof source !== 'string') throw unsupported(at, 'pattern');

  // The flag TypeBox compiles a pattern with: classes and counts are code points.
  const pattern = source === undefined ? null : new RegExp(source, 'u');

  return (value, fault) => {
    if (typeof value !== 'string') return fail(fault, 'type');

    if (literal !== undefined && value !== literal) return fail(fault, 'const');

    return pattern === null || pattern.test(value) || fail(fault, 'pattern');
  };
}

function compileNumber(node: SchemaNode, at: string, integer: boolean): Check {
  restrict(node, at, NUMBER);
  const literal = node.const;

  if (literal !== undefined && typeof literal !== 'number') throw unsupported(at, 'const');

  const minimum = bound(node, 'minimum', at, Number.NEGATIVE_INFINITY);
  const maximum = bound(node, 'maximum', at, Number.POSITIVE_INFINITY);

  return (value, fault) => {
    if (typeof value !== 'number') return fail(fault, 'type');

    if (!(integer ? Number.isInteger(value) : Number.isFinite(value))) return fail(fault, 'type');

    if (literal !== undefined && value !== literal) return fail(fault, 'const');

    if (value < minimum) return fail(fault, 'minimum');

    return value <= maximum || fail(fault, 'maximum');
  };
}

function compileBoolean(node: SchemaNode, at: string): Check {
  restrict(node, at, BOOLEAN);
  const literal = node.const;

  if (literal === undefined) {
    return (value, fault) => typeof value === 'boolean' || fail(fault, 'type');
  }

  if (typeof literal !== 'boolean') throw unsupported(at, 'const');

  return (value, fault) => value === literal || fail(fault, 'const');
}

function compileNull(node: SchemaNode, at: string): Check {
  restrict(node, at, NULL);

  return (value, fault) => value === null || fail(fault, 'type');
}

/** Refuses a value at the node that failed it, naming the keyword when a fault is being traced. */
function fail(fault: Fault | null, keyword: Keyword): false {
  if (fault !== null) {
    fault.path = '';
    fault.keyword = keyword;
  }

  return false;
}

/** Passes a refusal up through the property or index that led to it. */
function below(fault: Fault | null, step: string | number): false {
  if (fault !== null) fault.path = `/${step}${fault.path}`;

  return false;
}

function children(nodes: readonly unknown[], at: string): Check[] {
  return nodes.map((node, index) => compile(child(node, `${at}/${index}`), `${at}/${index}`));
}

function child(node: unknown, at: string): SchemaNode {
  if (!isRecord(node)) throw unsupported(at, 'schema');

  return node;
}

function bound(
  node: SchemaNode,
  keyword: 'minItems' | 'maxItems' | 'minimum' | 'maximum',
  at: string,
  otherwise: number,
): number {
  const value = node[keyword];

  if (value === undefined) return otherwise;

  if (typeof value !== 'number') throw unsupported(at, keyword);

  return value;
}

/** Refuses every keyword a schema node carries beyond the ones its type is checked for. */
function restrict(node: SchemaNode, at: string, keywords: readonly string[]): void {
  for (const keyword of Object.keys(node)) {
    if (!keywords.includes(keyword)) throw unsupported(at, `keyword ${keyword}`);
  }
}

function unsupported(at: string, what: string): Error {
  return new Error(`schema-check: unsupported ${what} at ${at}`);
}
