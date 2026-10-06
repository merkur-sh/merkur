export interface RedisScript {
  readonly name: string;
  readonly sha1: string;
  readonly source: string;
}

/** Defines an immutable Lua script and its Redis-compatible SHA-1 identity. */
export function defineRedisScript(name: string, source: string): RedisScript {
  return Object.freeze({
    name,
    sha1: Bun.CryptoHasher.hash('sha1', source, 'hex'),
    source,
  });
}
