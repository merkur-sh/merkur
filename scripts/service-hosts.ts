import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import path from 'node:path';

import { Schema } from 'effect';

import { zoneForEdgeRegion } from '../apps/server/src/services/ip-region';

const ROOT = path.resolve(import.meta.dir, '..');
const MANIFEST = 'deploy/service-hosts.json';

/**
 * The hosts the edge relay and the STUN responder run on, from
 * `deploy/service-hosts.json`.
 *
 * The manifest holds only what genuinely differs per host: its address, the SSH
 * host key the deploy pins, the edge's identity and egress limits, and the STUN
 * responder's addresses and ports. Everything else, including the version, is
 * rendered here at deploy time into the non-secret environment files the
 * systemd units read, so a rendered file cannot drift from the release. Secrets
 * live only on the host, in `/etc/merkur/*.secrets.env`.
 */

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
/** `EDGE_ID_PATTERN` in `apps/server/src/http/edge-registration-auth.ts`. */
const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const SSH_HOST_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
/** A Linux interface name: at most 15 bytes. */
const INTERFACE_PATTERN = /^[a-z][a-z0-9]{0,14}$/;

/** Every edge listens here, and its public URL names the same port. */
const EDGE_PORT = 4433;
/** The unit's `StateDirectory`; the identity survives restarts and upgrades. */
const EDGE_IDENTITY_DIR = '/var/lib/merkur-edge/identity';
/** Existing external dataset identities; migrate separately from the project name. */
const OTLP_ENDPOINT = 'https://eu-central-1.aws.edge.axiom.co';
const OTLP_DATASET = 'mercury';
const OTLP_METRICS_DATASET = 'mercury-metrics';

/** A rate above the NIC's line rate would cap nothing. */
const MAX_EGRESS_RATE_MBIT = 10_000;
/** Whole GiB that fit in the ledger's u64 byte count. */
const MAX_EGRESS_BUDGET_GB = 17_179_869_183;

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }));
const Budget = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EGRESS_BUDGET_GB }));

const EdgeService = Schema.Struct({
  edgeId: Schema.String.check(Schema.isPattern(EDGE_ID_PATTERN)),
  region: Schema.String,
  publicUrl: Schema.String,
  /**
   * Aggregate egress ceiling `edge-egress-cap` installs with `tc` before the
   * relay starts (`MERKUR_EDGE_EGRESS_RATE_MBIT`): the host's line rate, so it
   * shapes nothing honest traffic reaches. The monthly budget is what keeps a
   * month inside the host's included traffic.
   */
  egressRateMbit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EGRESS_RATE_MBIT })),
  egressBudgetGB: Budget,
  signalingReserveGB: Budget,
});

const StunService = Schema.Struct({
  /** The host's IPv4, then two addresses from its routed IPv6 /64. */
  addresses: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
  ports: Schema.NonEmptyArray(Port),
  changePorts: Schema.Array(Port),
});

const ServiceHost = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(NAME_PATTERN)),
  address: Schema.String,
  sshHostKey: Schema.String.check(Schema.isPattern(SSH_HOST_KEY_PATTERN)),
  interface: Schema.String.check(Schema.isPattern(INTERFACE_PATTERN)),
  edge: EdgeService,
  stun: StunService,
});

const Manifest = Schema.fromJsonString(Schema.Struct({ hosts: Schema.NonEmptyArray(ServiceHost) }));

export type ServiceHost = typeof ServiceHost.Type;

export class ServiceHostManifestError extends Error {}

function fail(detail: string): never {
  throw new ServiceHostManifestError(detail);
}

/**
 * The daemon and browser dial this exact string, and the registry claims
 * ownership of it verbatim, so anything but a canonical root HTTPS URL on the
 * listen port is a deployment that half-works.
 */
function assertCanonicalPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`publicUrl \`${value}\` is not a URL`);
  }
  if (url.protocol !== 'https:') fail(`publicUrl \`${value}\` must be https`);
  if (url.username !== '' || url.password !== '')
    fail(`publicUrl \`${value}\` carries credentials`);
  if (url.port !== String(EDGE_PORT)) fail(`publicUrl \`${value}\` must name port ${EDGE_PORT}`);
  if (url.href !== `${url.origin}/`) fail(`publicUrl \`${value}\` must be a canonical root URL`);
}

/**
 * The rules a field's own type cannot state. NAT classification needs the
 * address-change half of RFC 5780, which only distinct addresses on one host
 * answer: the single IPv4 answers the port change, two addresses out of the
 * host's IPv6 /64 answer both.
 */
function assertHost(host: ServiceHost): void {
  const { edge, stun } = host;
  if (!isIPv4(host.address)) fail(`host address \`${host.address}\` must be an IPv4 literal`);
  if (edge.egressBudgetGB + edge.signalingReserveGB > MAX_EGRESS_BUDGET_GB) {
    fail('combined egress budget exceeds u64 bytes');
  }
  if (zoneForEdgeRegion(edge.region) === null) {
    fail(
      `region \`${edge.region}\` is absent from ZONE_BY_EDGE_REGION ` +
        '(apps/server/src/services/ip-region.ts), so `selectEdge` cannot rank this edge ' +
        'by proximity — add the region there first',
    );
  }
  assertCanonicalPublicUrl(edge.publicUrl);
  const [v4, v6a, v6b] = stun.addresses;
  if (v4 !== host.address) fail('stun field `addresses` must start with the host address');
  if (!isIPv6(v6a) || !isIPv6(v6b) || v6a === v6b) {
    fail('stun field `addresses` must end with two distinct IPv6 addresses');
  }
  if (new Set(stun.ports).size !== stun.ports.length) fail('stun field `ports` repeats a port');
  if (new Set(stun.changePorts).size !== stun.changePorts.length) {
    fail('stun field `changePorts` repeats a port');
  }
  if (stun.changePorts.some((port) => stun.ports.includes(port))) {
    fail('a STUN port cannot be both an observer and a change-only port');
  }
}

/**
 * Decode and validate the manifest. Every rule here is one the deployment
 * enforces anyway, moved to where it is cheap: a region the server cannot zone
 * silently loses proximity selection, and a duplicate URL is refused by the
 * registry's atomic ownership claim only once the edge is already live.
 */
export function parseServiceHosts(source: string): readonly ServiceHost[] {
  let hosts: readonly ServiceHost[];
  try {
    hosts = Schema.decodeUnknownSync(Manifest, { onExcessProperty: 'error' })(source).hosts;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  hosts.forEach(assertHost);
  const unique: ReadonlyArray<[string, (host: ServiceHost) => string]> = [
    ['name', (host) => host.name],
    ['address', (host) => host.address],
    ['edgeId', (host) => host.edge.edgeId],
    ['publicUrl', (host) => host.edge.publicUrl],
  ];
  for (const [field, key] of unique) {
    const values = hosts.map(key);
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate !== undefined) fail(`duplicate ${field} \`${duplicate}\``);
  }
  return hosts;
}

export function loadServiceHosts(root: string = ROOT): readonly ServiceHost[] {
  return parseServiceHosts(readFileSync(path.join(root, MANIFEST), 'utf8'));
}

function serverOriginOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(`server origin \`${value}\` is not a URL`);
  }
  if (url.protocol !== 'https:' || url.href !== `${url.origin}/`) {
    fail(`server origin \`${value}\` must be a canonical HTTPS origin`);
  }
  return url.origin;
}

function environmentFile(entries: ReadonlyArray<[string, string]>): string {
  return `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

/** The edge unit's non-secret environment, `/etc/merkur/edge.env`. */
export function renderEdgeEnvironment(
  host: ServiceHost,
  version: string,
  serverOrigin: string,
): string {
  if (!VERSION_PATTERN.test(version)) {
    fail(`version \`${version}\` is not a release version such as v0.60.2`);
  }
  const { edge } = host;
  return environmentFile([
    ['MERKUR_EDGE_ID', edge.edgeId],
    ['MERKUR_EDGE_REGION', edge.region],
    ['MERKUR_EDGE_PUBLIC_URL', edge.publicUrl],
    ['MERKUR_EDGE_PORT', String(EDGE_PORT)],
    ['MERKUR_EDGE_IDENTITY_DIR', EDGE_IDENTITY_DIR],
    ['MERKUR_EDGE_REGISTER_URL', `${serverOriginOf(serverOrigin)}/api/edge/register`],
    ['MERKUR_EDGE_EGRESS_INTERFACE', host.interface],
    ['MERKUR_EDGE_EGRESS_RATE_MBIT', String(edge.egressRateMbit)],
    ['MERKUR_EDGE_DATA_BUDGET_GB', String(edge.egressBudgetGB)],
    ['MERKUR_EDGE_SIGNALING_RESERVE_GB', String(edge.signalingReserveGB)],
    // OTLP export to Axiom; the token is in edge.secrets.env. The host is the
    // dataset's own edge deployment, not api.axiom.co, which rejects ingest for
    // a dataset in another region with `mismatched region`.
    ['MERKUR_EDGE_OTLP_ENDPOINT', OTLP_ENDPOINT],
    ['MERKUR_EDGE_OTLP_DATASET', OTLP_DATASET],
    ['MERKUR_EDGE_OTLP_METRICS_DATASET', OTLP_METRICS_DATASET],
    ['TELEMETRY_ENVIRONMENT', 'production'],
    ['MERKUR_VERSION', version],
    ['RUST_LOG', 'info'],
  ]);
}

/** The STUN units' non-secret environment, `/etc/merkur/stun.env`. */
export function renderStunEnvironment(host: ServiceHost): string {
  const [, v6a, v6b] = host.stun.addresses;
  return environmentFile([
    ['MERKUR_STUN_BIND', host.stun.addresses.join(',')],
    ['MERKUR_STUN_PORTS', host.stun.ports.join(',')],
    ['MERKUR_STUN_CHANGE_PORTS', host.stun.changePorts.join(',')],
    ['MERKUR_STUN_IFACE', host.interface],
    ['MERKUR_STUN_ADDR_A', `${v6a}/64`],
    ['MERKUR_STUN_ADDR_B', `${v6b}/64`],
    ['RUST_LOG', 'info'],
  ]);
}

/**
 * The server's `STUN_SERVERS`: every observer port of the IPv4, whose equal or
 * differing mappings classify the daemon's NAT, and one observer per IPv6
 * address, bracketed, which is all a NAT-free family needs to be reached at.
 */
export function stunServers(hosts: readonly ServiceHost[]): string {
  return hosts
    .flatMap((host) => {
      const [v4, ...v6] = host.stun.addresses;
      const [first] = host.stun.ports;
      return [
        ...host.stun.ports.map((port) => `${v4}:${port}`),
        ...v6.map((address) => `[${address}]:${first}`),
      ];
    })
    .join(',');
}

function usage(): never {
  process.stderr.write(
    'usage: bun run service-hosts list\n' +
      '       bun run service-hosts known-hosts\n' +
      '       bun run service-hosts stun-servers\n' +
      '       bun run service-hosts render <host> <version> <server-origin> <out-dir>\n',
  );
  process.exit(1);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const hosts = loadServiceHosts();
    if (command === 'list') {
      for (const host of hosts) process.stdout.write(`${host.name}\t${host.address}\n`);
    } else if (command === 'known-hosts') {
      for (const host of hosts) process.stdout.write(`${host.address} ${host.sshHostKey}\n`);
    } else if (command === 'stun-servers') {
      process.stdout.write(`${stunServers(hosts)}\n`);
    } else if (command === 'render') {
      const [name, version, origin, outDir] = rest;
      if (name === undefined || version === undefined || origin === undefined || !outDir) usage();
      const host = hosts.find((candidate) => candidate.name === name);
      if (host === undefined) fail(`no host \`${name}\` in ${MANIFEST}`);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'edge.env'), renderEdgeEnvironment(host, version, origin));
      writeFileSync(path.join(outDir, 'stun.env'), renderStunEnvironment(host));
    } else {
      usage();
    }
  } catch (error) {
    if (!(error instanceof ServiceHostManifestError)) throw error;
    process.stderr.write(`${MANIFEST}: ${error.message}\n`);
    process.exit(1);
  }
}
