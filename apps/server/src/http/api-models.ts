import {
  MAX_KEYBOARD_KEY_ID_LENGTH,
  MAX_KEYBOARD_LAYER_KEYS,
  MAX_KEYBOARD_MACRO_NAME_LENGTH,
  MAX_KEYBOARD_MACRO_STEPS,
  MAX_KEYBOARD_MACROS,
  MAX_TOOLBAR_KEYS,
  MAX_WEBTRANSPORT_OFFER_CANDIDATES,
  type TERMINAL_KEYBOARD_LAYER_IDS,
} from '@merkur/shared';
import {
  AccountDeletionResponse,
  AuthEmailCodeResponse,
  AuthPolicyResponse,
  AuthResetCodeResponse,
  AuthResetStartResponse,
  AuthResetVerifyResponse,
  AuthSessionResponse,
  AuthStartResponse,
  BoxAccessResponse,
  BoxCreatedResponse,
  BrowserSessionListResponse,
  BrowserSessionsRevokedResponse,
  DaemonLinkClaimInspectResponse,
  DeviceName,
  DevicePlatform,
  OkResponse,
  PushVapidPublicKeyResponse,
  ServerVersionResponse,
} from '@merkur/shared/api-schema';
import { t, validationDetail } from 'elysia';
import { Type } from 'typebox';

/**
 * A non-negative integer with an explicit ceiling.
 *
 * Telemetry bodies are untrusted client input, so every numeric field is bounded
 * rather than merely typed: an unbounded number is a denial-of-service surface
 * on the metric registry and produces meaningless histograms.
 */
function BoundedCount(maximum = Number.MAX_SAFE_INTEGER) {
  return t.Integer({ minimum: 0, maximum });
}

const ErrorResponse = t.Object({
  error: t.String(),
  details: t.Optional(t.String()),
});

const UserDelegationCertificate = t.Object(
  {
    userId: t.String({ minLength: 1, maxLength: 128 }),
    rootKeyCommitment: t.String({ minLength: 86, maxLength: 86, pattern: '^[A-Za-z0-9_-]+$' }),
    delegationId: t.String({ minLength: 1, maxLength: 128 }),
    delegatePublicKey: t.String({
      minLength: 3_456,
      maxLength: 3_456,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
    scopes: t.Tuple([t.Literal('terminal-session'), t.Literal('session-revoke')]),
    serverOrigin: t.String({ minLength: 1, maxLength: 2_048 }),
    rootEpoch: t.Integer({ minimum: 1 }),
    issuedAt: t.Integer({ minimum: 0 }),
    expiresAt: t.Integer({ minimum: 0 }),
    signature: t.String({ minLength: 6_170, maxLength: 6_170, pattern: '^[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
);

const DelegationRevocation = t.Object(
  {
    userId: t.String({ minLength: 1, maxLength: 128 }),
    rootKeyCommitment: t.String({ minLength: 86, maxLength: 86, pattern: '^[A-Za-z0-9_-]+$' }),
    actorDelegationId: t.String({ minLength: 1, maxLength: 128 }),
    targets: t.Array(
      t.Object(
        {
          delegationId: t.String({ minLength: 1, maxLength: 128 }),
          expiresAt: t.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    issuedAt: t.Integer({ minimum: 0 }),
    nonce: t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
    signature: t.String({ minLength: 6_170, maxLength: 6_170, pattern: '^[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
);

const AccountDeletion = t.Object(
  {
    userId: t.String({ minLength: 1, maxLength: 128 }),
    rootKeyCommitment: t.String({ minLength: 86, maxLength: 86, pattern: '^[A-Za-z0-9_-]+$' }),
    rootEpoch: t.Integer({ minimum: 1 }),
    issuedAt: t.Integer({ minimum: 0 }),
    nonce: t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
    signature: t.String({ minLength: 6_170, maxLength: 6_170, pattern: '^[A-Za-z0-9_-]+$' }),
  },
  { additionalProperties: false },
);

const SignedRevocationBody = t.Object(
  {
    actorCertificate: UserDelegationCertificate,
    revocation: DelegationRevocation,
  },
  { additionalProperties: false },
);

/**
 * One layer's key ids in visual order, or the toolbar's contents.
 *
 * The vocabulary is the browser keyboard's, so the server bounds the row rather
 * than checking membership: an unbounded array of unbounded strings is the only
 * thing about this body that could hurt it. The browser drops ids it does not
 * recognise when it reads the settings back.
 */
function KeyboardKeyIdArray(maxItems: number) {
  return t.Array(t.String({ minLength: 1, maxLength: MAX_KEYBOARD_KEY_ID_LENGTH }), { maxItems });
}

const KeyboardLayerKeyOrder = t.Object(
  {
    alpha: KeyboardKeyIdArray(MAX_KEYBOARD_LAYER_KEYS),
    numbers: KeyboardKeyIdArray(MAX_KEYBOARD_LAYER_KEYS),
    symbols: KeyboardKeyIdArray(MAX_KEYBOARD_LAYER_KEYS),
    pc: KeyboardKeyIdArray(MAX_KEYBOARD_LAYER_KEYS),
    // Named one by one rather than built from the id list, so the schema and the
    // contract cannot drift: adding a layer fails to compile here.
  } satisfies Record<(typeof TERMINAL_KEYBOARD_LAYER_IDS)[number], unknown>,
  { additionalProperties: false },
);

const KeyboardSettings = t.Object(
  {
    toolbarKeys: KeyboardKeyIdArray(MAX_TOOLBAR_KEYS),
    macros: t.Array(
      t.Object(
        {
          id: t.String({ minLength: 7, maxLength: MAX_KEYBOARD_KEY_ID_LENGTH, pattern: '^macro:' }),
          name: t.String({
            minLength: 1,
            maxLength: MAX_KEYBOARD_MACRO_NAME_LENGTH,
            pattern: '\\S',
          }),
          steps: t.Array(
            t.Object(
              {
                key: t.String({ minLength: 1, maxLength: MAX_KEYBOARD_KEY_ID_LENGTH }),
                ctrl: t.Boolean(),
                alt: t.Boolean(),
                shift: t.Boolean(),
                meta: t.Boolean(),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: MAX_KEYBOARD_MACRO_STEPS },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: MAX_KEYBOARD_MACROS },
    ),
    layerKeyOrder: KeyboardLayerKeyOrder,
  },
  { additionalProperties: false },
);

/**
 * Plain schema objects imported directly rather than Elysia reference models
 * registered with `.model()`. Reference models exist to emit `$ref` in an
 * OpenAPI document and to share schemas by name across instances; no OpenAPI
 * plugin is installed here, and registering them would add a `.use()` edge to
 * all nine route plugins while trading go-to-definition on these names for
 * string keys. The one genuinely shared schema is already shared as a `const`.
 *
 * The responses the browser reads are not written here: they are the objects
 * of `@merkur/shared/api-schema`, which the browser checks each response
 * against. Request bodies stay here; only the server validates those.
 */
export const ApiModels = {
  AuthStartBody: t.Object(
    {
      username: t.String({
        minLength: 3,
        maxLength: 254,
        error: validationDetail('username must be at least 3 characters'),
      }),
      startLoginRequest: t.String({ minLength: 128, maxLength: 128 }),
      registrationRequest: t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
    },
    { additionalProperties: false },
  ),
  AuthStartResponse,
  AuthPolicyResponse,
  AuthEmailCodeBody: t.Object(
    { flowId: t.String({ minLength: 43, maxLength: 43 }) },
    { additionalProperties: false },
  ),
  AuthEmailCodeResponse,
  AuthRegisterFinishBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      /** The mailed code under email identity; `null` under username identity. */
      emailCode: t.Union([
        t.String({ minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' }),
        t.Null(),
      ]),
      registrationRecord: t.String({ minLength: 256, maxLength: 256 }),
      rootPublicKey: t.String({ minLength: 3_456, maxLength: 3_456 }),
      rootEnvelope: t.Object(
        {
          nonce: t.String({ minLength: 16, maxLength: 16 }),
          ciphertext: t.String({ minLength: 64, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
      delegationCertificate: UserDelegationCertificate,
      installed: t.Boolean(),
    },
    { additionalProperties: false },
  ),
  AuthLoginFinishBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      finishLoginRequest: t.String({ minLength: 86, maxLength: 86 }),
      delegationCertificate: UserDelegationCertificate,
      installed: t.Boolean(),
    },
    { additionalProperties: false },
  ),
  AuthSessionResponse,
  AuthResetCodeBody: t.Object(
    {
      username: t.String({
        minLength: 3,
        maxLength: 254,
        error: validationDetail('email address is required'),
      }),
    },
    { additionalProperties: false },
  ),
  AuthResetCodeResponse,
  AuthResetVerifyBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      emailCode: t.String({ minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' }),
    },
    { additionalProperties: false },
  ),
  AuthResetVerifyResponse,
  AuthResetStartBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      registrationRequest: t.String({ minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' }),
    },
    { additionalProperties: false },
  ),
  AuthResetStartResponse,
  AuthResetFinishBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      registrationRecord: t.String({ minLength: 256, maxLength: 256 }),
      rootPublicKey: t.String({ minLength: 3_456, maxLength: 3_456 }),
      rootEnvelope: t.Object(
        {
          nonce: t.String({ minLength: 16, maxLength: 16 }),
          ciphertext: t.String({ minLength: 64, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
      delegationCertificate: UserDelegationCertificate,
      installed: t.Boolean(),
    },
    { additionalProperties: false },
  ),
  AuthPasswordChangeBody: t.Object(
    {
      flowId: t.String({ minLength: 43, maxLength: 43 }),
      finishLoginRequest: t.String({ minLength: 86, maxLength: 86 }),
      registrationRecord: t.String({ minLength: 256, maxLength: 256 }),
      rootEnvelope: t.Object(
        {
          nonce: t.String({ minLength: 16, maxLength: 16 }),
          ciphertext: t.String({ minLength: 64, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
      delegationCertificate: UserDelegationCertificate,
      revocation: t.Union([DelegationRevocation, t.Null()]),
    },
    { additionalProperties: false },
  ),
  AccountDeletionBody: t.Object(
    {
      statement: AccountDeletion,
      actorCertificate: UserDelegationCertificate,
      revocation: DelegationRevocation,
    },
    { additionalProperties: false },
  ),
  AccountDeletionResponse,
  BoxAccessResponse,
  BoxCreatedResponse,
  BrowserSessionListResponse,
  BrowserSessionParams: t.Object({
    delegationId: t.String({ minLength: 1, maxLength: 128 }),
  }),
  BrowserSessionsRevokedResponse,
  SignedRevocationBody,
  DeleteDeviceParams: t.Object({
    id: t.String({ minLength: 1, error: validationDetail('device id is required') }),
  }),
  RenameDeviceBody: t.Object({
    // The shared bound itself, with this route's message beside it: a name is
    // refused where it would be written, never by the response that returns it.
    name: Type.With(DeviceName, {
      error: validationDetail('device name must be 1 to 128 characters'),
    }),
  }),
  DaemonLinkClaimCreateBody: t.Object(
    {
      linkToken: t.String({ minLength: 52, maxLength: 52 }),
      linkClaimId: t.String({ minLength: 1, maxLength: 128 }),
      daemonId: t.String({ minLength: 1, maxLength: 128 }),
      daemonIdentityPublicKey: t.String({ minLength: 3_456, maxLength: 3_456 }),
      daemonIdentityP256PublicKey: t.String({
        minLength: 87,
        maxLength: 87,
        pattern: '^[A-Za-z0-9_-]+$',
      }),
      identitySealBackend: t.Union([t.Literal('hardware'), t.Literal('software')]),
      daemonIdentityKeyCommitment: t.String({ minLength: 86, maxLength: 86 }),
      name: DeviceName,
      platform: DevicePlatform,
      claimCommitment: t.String({ minLength: 86, maxLength: 86 }),
    },
    { additionalProperties: false },
  ),
  DaemonLinkClaimCreatedResponse: t.Object({
    pollToken: t.String({ minLength: 43, maxLength: 43 }),
    serverNonce: t.String({ minLength: 43, maxLength: 43 }),
    expiresAt: t.Integer({ minimum: 1 }),
    machineUsage: t.Object({
      used: BoundedCount(),
      limit: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
    }),
    canLink: t.Boolean(),
  }),
  DaemonLinkClaimParams: t.Object({ linkClaimId: t.String({ minLength: 1, maxLength: 128 }) }),
  DaemonLinkClaimInspectBody: t.Object({}, { additionalProperties: false }),
  DaemonLinkClaimInspectResponse,
  DaemonLinkApproval: t.Any(),
  DaemonLinkClaimApprovedResponse: t.Union([
    t.Object({ status: t.Literal('pending') }),
    t.Object({
      status: t.Literal('approved'),
      sessionTokenVerifyKey: t.String({ minLength: 3_456, maxLength: 3_456 }),
      approval: t.Any(),
    }),
  ]),
  DaemonLinkClaimCompleteBody: t.Object(
    { approvalMac: t.String({ minLength: 86, maxLength: 86 }) },
    { additionalProperties: false },
  ),
  PushSubscriptionBody: t.Object({
    endpoint: t.String({ minLength: 1 }),
    keys: t.Object({
      p256dh: t.String({ minLength: 1 }),
      auth: t.String({ minLength: 1 }),
    }),
  }),
  PushSubscriptionDeleteBody: t.Object({
    endpoint: t.String({ minLength: 1 }),
  }),
  PushVapidPublicKeyResponse,
  /**
   * What the website's waitlist form posts, url-encoded, exactly as a plain
   * HTML `<form method="post">` would send it. Bounded like a sign-up address;
   * the service decides whether it is one.
   */
  BoxWaitlistBody: t.Object(
    {
      email: t.String({
        minLength: 3,
        maxLength: 254,
        error: validationDetail('email must be 3 to 254 characters'),
      }),
    },
    { additionalProperties: false },
  ),
  KeyboardSettingsBody: KeyboardSettings,
  /**
   * `null` when the account has never saved an arrangement. The browser answers
   * that by seeding the account from the device the user is on, so it is a
   * first-write signal rather than an empty value to render.
   */
  KeyboardSettingsResponse: t.Object(
    { settings: t.Union([KeyboardSettings, t.Null()]) },
    { additionalProperties: false },
  ),
  DaemonTerminalBellBody: t.Object({
    occurredAt: t.Number(),
  }),
  /**
   * One 60-second daemon performance window.
   *
   * Deltas, not cumulative totals: the daemon's Effect counters reset when its
   * process restarts, and shipping cumulative values would make the server-side
   * counters run backwards.
   */
  DaemonPerfReportBody: t.Object(
    {
      windowMs: BoundedCount(300_000),
      // The server records one frequency occurrence per ping outcome, so these
      // are bounded like the link report's per-window counts. The daemon pings
      // once per server-dictated 2 s and a timeout, send failure or suspension
      // ends the connection, so even the widest window (300 s) holds about 150.
      controlPingPonged: BoundedCount(10_000),
      controlPingTimeout: BoundedCount(10_000),
      controlPingSendFailed: BoundedCount(10_000),
      controlPingSuspended: BoundedCount(10_000),
      controlReconnects: BoundedCount(),
      registrationFailures: BoundedCount(),
      dataplaneRestarts: BoundedCount(),
      dataplaneAckTimeouts: BoundedCount(),
      dataplaneReady: t.Integer({ minimum: 0, maximum: 1 }),
      suspensionGapMsMax: BoundedCount(604_800_000),
      pingRttCount: BoundedCount(),
      pingRttP50Ms: BoundedCount(60_000),
      pingRttP95Ms: BoundedCount(60_000),
      pingRttMaxMs: BoundedCount(60_000),
      directWtIncomingExpected: BoundedCount(),
      directWtIncomingUnexpected: BoundedCount(),
      directWtAdmitted: BoundedCount(),
      natKeepalivesSent: BoundedCount(),
      natPunchBurstsSent: BoundedCount(),
      natPunchRefusedNotGlobal: BoundedCount(),
      natPunchRefusedRateLimited: BoundedCount(),
      natSideChannelSendFailures: BoundedCount(),
      // Carrier rebind. `requests` is every attempt that reached the flow,
      // `envelopesRejected` the ones dropped before it, and `committed` the only
      // ones that actually recovered a session without a server round trip.
      rebindRequests: BoundedCount(),
      rebindAccepted: BoundedCount(),
      rebindRefused: BoundedCount(),
      rebindCommitted: BoundedCount(),
      rebindEnvelopesRejected: BoundedCount(),
      rebindEventsSuppressed: BoundedCount(),
      // Display waste. `rowVersionsSent` is the denominator the other four are
      // read against; a count without it is not interpretable.
      rowVersionsSent: BoundedCount(),
      rowVersionsSupersededUnapplied: BoundedCount(),
      rowResendsIdentical: BoundedCount(),
      resyncRowsRequested: BoundedCount(),
      fecRepairsSent: BoundedCount(),
      fecRepairsRefused: BoundedCount(),
      // Receiver-classified, sole-carrier display datagrams. Per path:
      // classified = received + recovered + residual lost. Unknown is
      // censored evidence and is excluded from the rate denominator.
      directDisplayDatagramsReceived: BoundedCount(),
      directDisplayDatagramsRecoveredByFec: BoundedCount(),
      directDisplayDatagramsDeclaredLost: BoundedCount(),
      directDisplayDatagramsOutcomeUnknown: BoundedCount(),
      edgeDisplayDatagramsReceived: BoundedCount(),
      edgeDisplayDatagramsRecoveredByFec: BoundedCount(),
      edgeDisplayDatagramsDeclaredLost: BoundedCount(),
      edgeDisplayDatagramsOutcomeUnknown: BoundedCount(),
      rowsDeclaredLost: BoundedCount(),
    },
    { additionalProperties: false },
  ),
  /**
   * One browser link-quality report.
   *
   * Streamed, not windowed: the browser posts one of these per transport
   * heartbeat projection, so `sampleCount` is normally 1 and rises only when
   * projections coalesced behind an outstanding send. `windowMs` is the span
   * the report actually covers, not a fixed period.
   *
   * # Privacy contract
   *
   * Every field is a bounded number or a value from a closed union that the
   * server re-validates. There is no free-text field, so terminal content
   * cannot be carried here even by a compromised or modified client.
   *
   * Never add a per-keystroke timestamp or inter-keystroke delta to this body.
   * Keystroke timing is a genuine side channel for inferring typed content;
   * a count and percentiles over an interval are not, at any interval width.
   * The reporting interval is not the safeguard — the absence of these fields
   * is. It is also now roughly two seconds rather than a minute, so adding any
   * per-sample time-domain field here would reveal far more than the same
   * addition once would have.
   */
  BrowserLinkReportBody: t.Object(
    {
      windowMs: BoundedCount(3_600_000),
      sampleCount: BoundedCount(10_000),
      rttP50Ms: BoundedCount(120_000),
      rttP95Ms: BoundedCount(120_000),
      rttMaxMs: BoundedCount(120_000),
      inputAckP50Ms: BoundedCount(120_000),
      inputAckP95Ms: BoundedCount(120_000),
      degradedSampleCount: BoundedCount(10_000),
      txBytes: BoundedCount(),
      rxBytes: BoundedCount(),
      pathDirect: BoundedCount(10_000),
      pathRelay: BoundedCount(10_000),
      pathUnknown: BoundedCount(10_000),
      stateConnecting: BoundedCount(10_000),
      stateReady: BoundedCount(10_000),
      stateReconnecting: BoundedCount(10_000),
      stateDormant: BoundedCount(10_000),
      stateClosed: BoundedCount(10_000),
    },
    { additionalProperties: false },
  ),
  /**
   * One direct-WebTransport upgrade attempt.
   *
   * # Privacy contract
   *
   * Stricter than the link report above: every field is a member of a closed
   * union. No address, port, host name, or
   * duration appears here — a candidate's address is the daemon operator's
   * network topology, and the browser's own address is PII, so neither may
   * cross this boundary. What is carried is the *kind* of each candidate and
   * what *became of it*, which is exactly what a metric label needs and nothing
   * more.
   *
   * Do NOT add a duration: a handshake time is a measurement of the user's
   * network and belongs on a span, not here.
   *
   * `candidates` is capped at the offer ceiling and every member of both its
   * fields is re-validated, so this body cannot inflate metric cardinality no
   * matter what a modified client sends. It is deliberately NOT deduplicated:
   * two candidates of the same kind with different dispositions is the normal
   * case and the whole point of reporting them together.
   */
  /**
   * One class of browser failure, with how many times it happened.
   *
   * Every field is a closed union or a bounded count — there is no message, no stack, and
   * no free-text field of any kind, so terminal content cannot be carried here even by a
   * modified client. That is the same rule the other browser telemetry bodies follow, and
   * it is the reason this can be reported at all: a failure *class* is safe to ship where a
   * failure *message* is not.
   */
  BrowserErrorReportBody: t.Object(
    {
      source: t.Union([
        t.Literal('window'),
        t.Literal('unhandled_rejection'),
        t.Literal('session_start'),
        t.Literal('transport_worker'),
        t.Literal('telemetry_worker'),
        t.Literal('device_events'),
      ]),
      kind: t.Union([
        t.Literal('no_response'),
        t.Literal('no_frame'),
        t.Literal('wasm_instantiate'),
        t.Literal('webgl_context'),
        t.Literal('worker_start'),
        t.Literal('security'),
        t.Literal('network'),
        t.Literal('quota'),
        t.Literal('abort'),
        t.Literal('type_error'),
        t.Literal('range_error'),
        t.Literal('reference_error'),
        t.Literal('other'),
      ]),
      count: BoundedCount(10_000),
    },
    { additionalProperties: false },
  ),

  BrowserUpgradeReportBody: t.Object(
    {
      outcome: t.Union([t.Literal('selected'), t.Literal('failed'), t.Literal('lost')]),
      natType: t.Union([
        t.Literal('endpoint_independent'),
        t.Literal('endpoint_dependent'),
        t.Literal('none'),
      ]),
      natFiltering: t.Union([
        t.Literal('endpoint_independent'),
        t.Literal('port_independent'),
        t.Literal('port_dependent'),
        t.Literal('unknown'),
      ]),
      winnerKind: t.Union([
        t.Literal('srflx'),
        t.Literal('nat_map'),
        t.Literal('host4'),
        t.Literal('host6'),
        t.Literal('loopback'),
        t.Literal('none'),
      ]),
      admissionStage: t.Union([
        t.Literal('channels'),
        t.Literal('init_write'),
        t.Literal('challenge'),
        t.Literal('proof_sign'),
        t.Literal('proof_write'),
        t.Literal('ack'),
        t.Literal('none'),
      ]),
      admissionReason: t.Union([
        t.Literal('timeout'),
        t.Literal('invalid'),
        t.Literal('closed'),
        t.Literal('crypto'),
        t.Literal('none'),
      ]),
      candidates: t.Array(
        t.Object(
          {
            kind: t.Union([
              t.Literal('srflx'),
              t.Literal('nat_map'),
              t.Literal('host4'),
              t.Literal('host6'),
              t.Literal('loopback'),
            ]),
            disposition: t.Union([
              t.Literal('not_dialled'),
              t.Literal('no_settle'),
              t.Literal('refused'),
              t.Literal('tls_rejected'),
              t.Literal('closed_during_connect'),
              t.Literal('other'),
              t.Literal('ready_lost_race'),
              t.Literal('ready_upgrade_failed'),
              t.Literal('won'),
            ]),
          },
          { additionalProperties: false },
        ),
        { maxItems: MAX_WEBTRANSPORT_OFFER_CANDIDATES },
      ),
    },
    { additionalProperties: false },
  ),
  EmptyResponse: t.Void(),
  ErrorResponse,
  LinkTokenCreateBody: t.Object({}, { additionalProperties: false }),
  LinkTokenResponse: t.Object({
    command: t.Union([t.String({ minLength: 1 }), t.Null()]),
    expiresAt: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
    machineUsage: t.Object({
      used: BoundedCount(),
      limit: t.Union([t.Integer({ minimum: 1 }), t.Null()]),
    }),
  }),
  LogoutResponse: OkResponse,
  ServerVersionResponse,
} as const;
