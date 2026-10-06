/**
 * Regenerates `apps/server/src/services/ip-region-table.generated.ts` from
 * IANA's authoritative IPv4 address space registry.
 *
 * Run when the registry changes, which in practice means never — the IPv4 free
 * pool is exhausted and /8 delegations no longer move between RIRs:
 *
 *   bun run scripts/generate-ip-region-table.ts
 *
 * This exists because the alternative is 256 hand-written entries whose errors
 * are invisible: a wrong zone does not fail a build or a test, it just quietly
 * routes some continent's traffic to the wrong edge.
 *
 * The IPv6 side is not generated. RIR delegations there are five top-level /12s
 * plus a couple of legacy /16s, small enough to state directly and read.
 */

import { createHash } from 'node:crypto';

const REGISTRY_URL = 'https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.csv';

/** Registry designation -> zone letter. Anything unlisted becomes unknown. */
const DESIGNATION_ZONES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^APNIC$/, 'a'],
  [/^ARIN$/, 'n'],
  [/^RIPE NCC$/, 'e'],
  [/^LACNIC$/, 's'],
  [/^AFRINIC$/, 'f'],
  [/^Administered by APNIC$/, 'a'],
  [/^Administered by ARIN$/, 'n'],
  [/^Administered by RIPE NCC$/, 'e'],
  [/^Administered by LACNIC$/, 's'],
  [/^Administered by AFRINIC$/, 'f'],
];

const UNKNOWN_ZONE = '?';

/**
 * Legacy /8s predate the RIR system and carry a company or agency name instead
 * of a registry. Every one of them is a US entity administered out of ARIN, so
 * they resolve to the same zone the `Administered by ARIN` rows do. Treating
 * them as unknown instead would throw away 12 of 256 blocks, including some of
 * the most densely populated legacy space.
 */
function zoneFor(designation: string, status: string): string {
  for (const [pattern, zone] of DESIGNATION_ZONES) {
    if (pattern.test(designation)) return zone;
  }
  return status === 'LEGACY' ? 'n' : UNKNOWN_ZONE;
}

/** Minimal RFC 4180 row splitter: the registry quotes designations with commas. */
function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

const response = await fetch(REGISTRY_URL);
if (!response.ok) {
  throw new Error(`IANA registry fetch failed: ${response.status}`);
}
const body = await response.text();
const digest = createHash('sha256').update(body).digest('hex');

const rows = body
  .split('\n')
  .slice(1)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map(splitCsvRow);

const zones = new Array<string>(256).fill(UNKNOWN_ZONE);
for (const row of rows) {
  const prefix = row[0];
  const designation = row[1];
  const status = row[5];
  if (prefix === undefined || designation === undefined || status === undefined) continue;
  const octet = Number.parseInt(prefix.slice(0, prefix.indexOf('/')), 10);
  if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
    throw new Error(`unparseable prefix: ${prefix}`);
  }
  zones[octet] = zoneFor(designation, status);
}

const packed = zones.join('');
if (packed.length !== 256) {
  throw new Error(`expected 256 zone letters, produced ${packed.length}`);
}

const file = `// GENERATED FILE — do not edit by hand.
//
// Source: ${REGISTRY_URL}
// SHA-256 of the fetched registry: ${digest}
// Regenerate: bun run scripts/generate-ip-region-table.ts
//
// One character per IPv4 /8, indexed by first octet. See ip-region.ts for what
// the letters mean and why /8 granularity is the right resolution here.

export const IPV4_ZONE_TABLE =
  '${packed}';
`;

const target = new URL('../apps/server/src/services/ip-region-table.generated.ts', import.meta.url);
await Bun.write(target, file);

const counts = new Map<string, number>();
for (const zone of zones) counts.set(zone, (counts.get(zone) ?? 0) + 1);
process.stdout.write(
  `wrote ${target.pathname}\n  registry sha256 ${digest}\n  ${[...counts]
    .sort((left, right) => right[1] - left[1])
    .map(([zone, count]) => `${zone}=${count}`)
    .join(' ')}\n`,
);
