import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { zoneForEdgeRegion } from '../apps/server/src/services/ip-region';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Render one edge replica's `fly.toml` from `apps/edge/replicas.json`.
 *
 * The edge used to be one tracked `apps/edge/fly.toml` carrying its own
 * `MERKUR_VERSION`, which the release had to bump and commit before the tag.
 * That is exactly one replica's worth of process: a second replica meant a
 * hand-copied file, and every copy is another label to forget. The deployment
 * is now a manifest of what genuinely differs per replica — id, Fly app,
 * region, public URL — and everything else, including the version, is rendered
 * here at deploy time from the release being deployed. A rendered file cannot
 * drift from the release, and adding a replica is one manifest entry.
 *
 * Generated files land in `apps/edge/fly/` (gitignored): `release.sh fly`
 * re-renders every replica on each deploy, so a stale one is never used.
 */

/** Fly app names are lowercase DNS labels; the id pattern matches the server's. */
const APP_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `EDGE_ID_PATTERN` in `apps/server/src/http/edge-registration-auth.ts`. */
const EDGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;

/** Every replica listens here, and its public URL names the same port. */
const EDGE_PORT = 4433;

/**
 * What the replicas already run, now stated instead of inherited: the machine
 * behind `mercury-edge-tntcl` is `shared-cpu-1x:256MB`, the same size
 * `apps/stun/fly.toml` names for the responder. Rendering it changes nothing
 * about today's deployment and stops a new replica's size depending on
 * whatever Fly defaults to on the day it is created.
 *
 * It is below what the relay's own ceilings admit, and that is a deliberate,
 * recorded gap rather than an oversight: `SPLICE_RELIABLE_BYTES_GLOBAL` and
 * `SPLICE_FINITE_BYTES_GLOBAL` (`apps/edge/src/splice.rs`) are 256 MiB each,
 * so retention the code permits exceeds this machine before any QUIC buffer or
 * datagram mailbox. See BACKLOG.md; raising it is a cost decision, not a
 * mechanical one.
 */
const VM_SIZE = 'shared-cpu-1x';
const VM_MEMORY = '256mb';

/** Existing external dataset identities; migrate separately from the project name. */
const OTLP_ENDPOINT = 'https://eu-central-1.aws.edge.axiom.co';
const OTLP_DATASET = 'mercury';
const OTLP_METRICS_DATASET = 'mercury-metrics';

export interface EdgeReplica {
  readonly edgeId: string;
  readonly app: string;
  readonly region: string;
  readonly publicUrl: string;
  /**
   * Aggregate egress ceiling the container's entrypoint installs with `tc`
   * before the relay starts (`MERKUR_EDGE_EGRESS_RATE_MBIT`). A backstop on the
   * bill, not a budget: set well above what honest use reaches, it bounds the
   * worst month at `rate × seconds in a month` whatever the relay itself does.
   */
  readonly egressRateMbit: number;
  readonly egressBudgetGB: number;
  readonly signalingReserveGB: number;
}

const REPLICA_FIELDS = ['edgeId', 'app', 'region', 'publicUrl'] as const;
const REPLICA_NUMBER_FIELDS = ['egressRateMbit', 'egressBudgetGB', 'signalingReserveGB'] as const;
/** A shared-cpu-1x machine cannot push more; a larger cap would cap nothing. */
const MAX_EGRESS_RATE_MBIT = 10_000;
/** Whole GiB that fit in the ledger's u64 byte count. */
const MAX_EGRESS_BUDGET_GB = 17_179_869_183;

export class EdgeReplicaManifestError extends Error {}

function fail(detail: string): never {
  throw new EdgeReplicaManifestError(detail);
}

/**
 * Parse and validate the manifest. Every rule here is one the deployment
 * enforces anyway, moved to where it is cheap: a region the server cannot zone
 * silently loses proximity selection, and a duplicate URL is refused by the
 * registry's atomic ownership claim only once the replica is already live.
 */
export function parseReplicaManifest(source: string): readonly EdgeReplica[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return fail(`replicas.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('replicas.json must be a JSON object');
  }
  const entries = (parsed as Record<string, unknown>).replicas;
  if (!Array.isArray(entries) || entries.length === 0) {
    return fail('replicas.json must hold a non-empty `replicas` array');
  }

  const replicas: EdgeReplica[] = [];
  const seen = new Map<(typeof REPLICA_FIELDS)[number], Set<string>>(
    REPLICA_FIELDS.map((field) => [field, new Set<string>()]),
  );
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return fail('every replica must be a JSON object');
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (
        !REPLICA_FIELDS.includes(key as (typeof REPLICA_FIELDS)[number]) &&
        !REPLICA_NUMBER_FIELDS.includes(key as (typeof REPLICA_NUMBER_FIELDS)[number])
      ) {
        return fail(`unknown replica field \`${key}\``);
      }
    }
    for (const field of REPLICA_FIELDS) {
      if (typeof record[field] !== 'string') {
        return fail(`replica field \`${field}\` must be a string`);
      }
    }
    const egressRateMbit = record.egressRateMbit;
    if (
      typeof egressRateMbit !== 'number' ||
      !Number.isSafeInteger(egressRateMbit) ||
      egressRateMbit < 1 ||
      egressRateMbit > MAX_EGRESS_RATE_MBIT
    ) {
      return fail(
        `replica field \`egressRateMbit\` must be an integer from 1 to ${MAX_EGRESS_RATE_MBIT}`,
      );
    }
    for (const field of ['egressBudgetGB', 'signalingReserveGB'] as const) {
      const value = record[field];
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MAX_EGRESS_BUDGET_GB
      ) {
        return fail(`replica field \`${field}\` must be a positive integer GiB budget in range`);
      }
    }
    const replica: EdgeReplica = {
      edgeId: record.edgeId as string,
      app: record.app as string,
      region: record.region as string,
      publicUrl: record.publicUrl as string,
      egressRateMbit,
      egressBudgetGB: record.egressBudgetGB as number,
      signalingReserveGB: record.signalingReserveGB as number,
    };

    if (replica.egressBudgetGB + replica.signalingReserveGB > MAX_EGRESS_BUDGET_GB) {
      fail('combined egress budget exceeds u64 bytes');
    }
    if (!EDGE_ID_PATTERN.test(replica.edgeId)) {
      fail(`edgeId \`${replica.edgeId}\` is not a valid replica id`);
    }
    if (!APP_PATTERN.test(replica.app)) {
      fail(`app \`${replica.app}\` is not a valid Fly app name`);
    }
    if (zoneForEdgeRegion(replica.region) === null) {
      fail(
        `region \`${replica.region}\` is absent from ZONE_BY_FLY_REGION ` +
          '(apps/server/src/services/ip-region.ts), so `selectEdge` cannot rank this replica ' +
          'by proximity — add the region there first',
      );
    }
    assertCanonicalPublicUrl(replica.publicUrl);
    for (const field of REPLICA_FIELDS) {
      const values = seen.get(field);
      if (values === undefined) continue;
      if (values.has(replica[field])) fail(`duplicate ${field} \`${replica[field]}\``);
      values.add(replica[field]);
    }
    replicas.push(replica);
  }
  return replicas;
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

export function loadReplicas(root: string = ROOT): readonly EdgeReplica[] {
  return parseReplicaManifest(readFileSync(path.join(root, 'apps/edge/replicas.json'), 'utf8'));
}

export function renderEdgeFlyConfig(replica: EdgeReplica, version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    fail(`version \`${version}\` is not a release version such as v0.60.2`);
  }
  return `# GENERATED by scripts/edge-fly-config.ts from apps/edge/replicas.json.
# Do not edit and do not commit: \`release.sh fly\` re-renders it per deploy.
#
# WebTransport rides HTTP/3 over UDP/QUIC; Fly carries raw UDP over anycast
# (Cloudflare Tunnel does NOT carry WebTransport, so a dedicated edge is required).
# UDP services MUST bind \`fly-global-services\` inside the VM — the binary does this
# automatically when FLY_APP_NAME is set (see src/main.rs::resolve_bind_addr).
#
# Deploy from the REPO ROOT, not from apps/edge. The image is built from the
# Cargo workspace so that the binary Fly runs and the binary the gates compile
# come from one lockfile and one \`[patch.crates-io]\`; a build scoped to
# apps/edge would silently resolve the registry wtransport instead of the
# vendored one. See apps/edge/Dockerfile and apps/edge/README.md.
app = "${replica.app}"
primary_region = "${replica.region}"

[build]

[env]
  MERKUR_EDGE_ID = "${replica.edgeId}"
  MERKUR_EDGE_IDENTITY_DIR = "/data/identity"
  MERKUR_EDGE_PORT = "${EDGE_PORT}"
  MERKUR_EDGE_PUBLIC_URL = "${replica.publicUrl}"
  MERKUR_EDGE_REGION = "${replica.region}"
  # Aggregate egress ceiling installed with \`tc\` by the image entrypoint before
  # the relay starts; see apps/edge/entrypoint.sh. Worst month at this rate is
  # the most this replica's egress can cost, whatever the relay does.
  MERKUR_EDGE_EGRESS_RATE_MBIT = "${replica.egressRateMbit}"
  MERKUR_EDGE_DATA_BUDGET_GB = "${replica.egressBudgetGB}"
  MERKUR_EDGE_SIGNALING_RESERVE_GB = "${replica.signalingReserveGB}"
  MERKUR_EDGE_EGRESS_INTERFACE = "eth0"
  RUST_LOG = "info"
  # OTLP export to Axiom. The endpoint is the master switch: with it unset the
  # edge exports nothing and only logs to \`fly logs\`. The token is a secret:
  #   fly secrets set MERKUR_EDGE_OTLP_TOKEN=xaat-... --app ${replica.app}
  # Metrics need their own dataset because Axiom's metrics intake uses a
  # different header and accepts only protobuf.
  # The host is the dataset's own edge deployment (\`edgeDeploymentUrl\` from
  # \`GET /v2/datasets/<name>\`), not api.axiom.co, which rejects ingest for a
  # dataset in another region with \`mismatched region\`.
  MERKUR_EDGE_OTLP_ENDPOINT = "${OTLP_ENDPOINT}"
  MERKUR_EDGE_OTLP_DATASET = "${OTLP_DATASET}"
  MERKUR_EDGE_OTLP_METRICS_DATASET = "${OTLP_METRICS_DATASET}"
  # Reported as deployment.environment.name and service.version, matching the
  # server so both label themselves the same way on a shared dashboard. The
  # version is the release being deployed, never a committed literal.
  TELEMETRY_ENVIRONMENT = "production"
  MERKUR_VERSION = "${version}"

# The size the replicas already run, stated rather than inherited from Fly's
# default. It is below what apps/edge/src/splice.rs admits — see BACKLOG.md.
[[vm]]
  size = "${VM_SIZE}"
  memory = "${VM_MEMORY}"

# Per-app volume holding this replica's certificate and private key. Replicas
# never share one: each publishes its own pin.
[[mounts]]
  source = "mercury_edge_identity"
  destination = "/data"

# Anycast UDP/QUIC for WebTransport (HTTP/3). No TLS handler or termination by
# Fly — the edge terminates its own self-signed QUIC/TLS and is blind above it.
[[services]]
  protocol = "udp"
  internal_port = ${EDGE_PORT}
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = ${EDGE_PORT}
`;
}

function usage(): never {
  process.stderr.write(
    'usage: bun run edge:fly-config list\n' +
      '       bun run edge:fly-config render <edge-id> <version>\n',
  );
  process.exit(1);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'list') {
      for (const replica of loadReplicas()) {
        process.stdout.write(`${replica.edgeId}\t${replica.app}\t${replica.region}\n`);
      }
    } else if (command === 'render') {
      const [edgeId, version] = rest;
      if (edgeId === undefined || version === undefined) usage();
      const replica = loadReplicas().find((candidate) => candidate.edgeId === edgeId);
      if (replica === undefined) fail(`no replica \`${edgeId}\` in apps/edge/replicas.json`);
      const out = path.join(ROOT, 'apps/edge/fly', `${replica.edgeId}.toml`);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, renderEdgeFlyConfig(replica, version));
      process.stdout.write(`${path.relative(ROOT, out)}\n`);
    } else {
      usage();
    }
  } catch (error) {
    if (!(error instanceof EdgeReplicaManifestError)) throw error;
    process.stderr.write(`apps/edge/replicas.json: ${error.message}\n`);
    process.exit(1);
  }
}
