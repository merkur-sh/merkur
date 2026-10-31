import { readFileSync } from 'node:fs';

function readerCode(path: string | URL): string {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('const MAX_RECORD_BYTES =');
  const end = source.indexOf('\nexport function carrierRecord', start);
  if (start < 0 || end < start) throw new Error('missing production carrier reader');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    source.slice(start, end).replace('export class', 'class'),
  );
  return `${code}\nreturn CarrierReader;`;
}

function fixedReaderCode(code: string): string {
  const start = code.indexOf('async record(');
  const end = code.indexOf('async part(', start);
  if (start < 0 || end < start) throw new Error('missing carrier record method');
  return code.slice(0, start) + code.slice(end);
}

export function carrierReaderSources() {
  const production = readerCode(
    new URL('../../apps/web/src/transport/client-carrier.ts', import.meta.url),
  );
  const comparison =
    process.env.BENCH_COMPARE_SOURCE === undefined
      ? production
      : readerCode(process.env.BENCH_COMPARE_SOURCE);
  if (fixedReaderCode(production) !== fixedReaderCode(comparison))
    throw new Error('carrier comparison must preserve fields, exact and part');
  return { production, comparison };
}
