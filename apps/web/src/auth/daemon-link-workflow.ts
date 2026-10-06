import {
  createDaemonBinding,
  createDaemonLinkApproval,
  deriveDaemonLinkClaimCommitment,
  deriveUserAuthorizationSigningKey,
  deriveUserRootKeyCommitment,
  encodeUserAuthorizationBytes,
  parseDaemonLinkCode,
  USER_AUTHORIZATION_NONCE_BYTES,
  USER_AUTHORIZATION_SEED_BYTES,
} from '@merkur/shared/user-authorization';
import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import {
  approveDaemonLinkClaim,
  type DaemonLinkInspectResponse,
  inspectDaemonLinkClaim,
} from './account-api';
import { type ActiveBrowserAccount, unlockUserRootForAccount } from './account-workflow';
import { decodeBase64UrlExact } from './encoding';

const LINK_SERVER_TIME_MAX_AGE_MS = 20_000;

/**
 * How an approval ended, as the dialog needs to say it. The machine limit is
 * the one refusal the reader can act on, so it is told apart from every other
 * failure.
 */
export type DaemonLinkApprovalOutcome = 'approved' | 'machine_limit_reached' | 'failed';

export async function approvePermanentDaemonLink(
  account: ActiveBrowserAccount,
  code: string,
  password: string,
  signal?: AbortSignal,
): Promise<void> {
  const parsedCode = parseDaemonLinkCode(code.trim());
  let rootSeed: Uint8Array | null = null;
  let rootPublicKey: Uint8Array | null = null;
  try {
    // Authenticate the public claim with the code secret before asking the user
    // root to sign anything.
    const initial = await inspectAndVerifyClaim(
      account.session.accessToken,
      parsedCode.linkClaimId,
      parsedCode.linkSecret,
      signal,
    );
    const unlocked = await unlockUserRootForAccount(account, password, signal);
    rootSeed = unlocked.rootSeed;
    rootPublicKey = unlocked.rootPublicKey;

    // OPAQUE/Argon2 work can consume most of the server's binding clock window.
    // Inspect again after unlock and bind the signature to this fresh server time.
    const current = await inspectAndVerifyClaim(
      account.session.accessToken,
      parsedCode.linkClaimId,
      parsedCode.linkSecret,
      signal,
    );
    if (current.claim.claimCommitment !== initial.claim.claimCommitment) {
      throw new Error('Daemon-link claim changed during approval');
    }
    const issuedAt = estimatedServerTime(current);
    const rootKey = deriveUserAuthorizationSigningKey(rootSeed);
    const rootKeyPublicKey = rootKey.publicKey;
    const bindingEntropy = crypto.getRandomValues(new Uint8Array(USER_AUTHORIZATION_SEED_BYTES));
    const serverNonce = decodeBase64UrlExact(
      current.claim.serverNonce,
      USER_AUTHORIZATION_NONCE_BYTES,
      'daemon-link server nonce',
    );
    try {
      const rootKeyCommitment = deriveUserRootKeyCommitment(rootKeyPublicKey);
      if (
        encodeUserAuthorizationBytes(rootKeyPublicKey) !== account.rootPublicKey ||
        rootKeyCommitment !== account.certificate.rootKeyCommitment
      ) {
        throw new Error('Unlocked user root does not match the active account');
      }
      const daemonBinding = createDaemonBinding(
        {
          userId: account.session.userId,
          rootKeyCommitment,
          daemonId: current.claim.daemonId,
          daemonIdentityKeyCommitment: current.claim.daemonIdentityKeyCommitment,
          serverOrigin: globalThis.location.origin,
          linkClaimId: current.claim.linkClaimId,
          issuedAt,
        },
        rootKey,
        bindingEntropy,
      );
      const approval = createDaemonLinkApproval(
        {
          linkClaimId: current.claim.linkClaimId,
          claimCommitment: current.claim.claimCommitment,
          userRootPublicKey: account.rootPublicKey,
          rootEpoch: unlocked.rootEpoch,
          daemonBinding,
        },
        serverNonce,
        parsedCode.linkSecret,
      );
      await approveDaemonLinkClaim(
        account.session.accessToken,
        current.claim.linkClaimId,
        approval,
        signal,
      );
    } finally {
      rootKey.free();
      rootKeyPublicKey.fill(0);
      bindingEntropy.fill(0);
      serverNonce.fill(0);
    }
  } finally {
    parsedCode.linkSecret.fill(0);
    rootSeed?.fill(0);
    rootPublicKey?.fill(0);
  }
}

/**
 * The machine a link code belongs to, as its own claim describes it — shown
 * before the password is asked for. The code's secret authenticates the claim,
 * so a coordinator cannot put another machine's name on this one.
 */
export async function previewDaemonLink(
  account: ActiveBrowserAccount,
  code: string,
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly platform: string }> {
  const parsedCode = parseDaemonLinkCode(code.trim());
  try {
    const { claim } = await inspectAndVerifyClaim(
      account.session.accessToken,
      parsedCode.linkClaimId,
      parsedCode.linkSecret,
      signal,
    );
    return { name: claim.name, platform: claim.platform };
  } finally {
    parsedCode.linkSecret.fill(0);
  }
}

interface InspectedClaim {
  readonly claim: DaemonLinkInspectResponse;
  readonly monotonicReceiptMs: number;
}

async function inspectAndVerifyClaim(
  accessToken: string,
  linkClaimId: string,
  linkSecret: Uint8Array,
  signal?: AbortSignal,
): Promise<InspectedClaim> {
  const [claim] = await Promise.all([
    inspectDaemonLinkClaim(accessToken, linkClaimId, signal),
    loadE2eWasmModule(),
  ]);
  const monotonicReceiptMs = performance.now();
  const expectedCommitment = deriveDaemonLinkClaimCommitment(
    {
      linkClaimId: claim.linkClaimId,
      daemonId: claim.daemonId,
      daemonIdentityPublicKey: claim.daemonIdentityPublicKey,
      daemonIdentityP256PublicKey: claim.daemonIdentityP256PublicKey,
      daemonIdentityKeyCommitment: claim.daemonIdentityKeyCommitment,
      name: claim.name,
      platform: claim.platform,
      identitySealBackend: claim.identitySealBackend,
    },
    linkSecret,
  );
  if (expectedCommitment !== claim.claimCommitment) {
    throw new Error('Daemon-link code does not authenticate this claim');
  }
  return { claim, monotonicReceiptMs };
}

function estimatedServerTime(inspected: InspectedClaim): number {
  const elapsedMs = performance.now() - inspected.monotonicReceiptMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > LINK_SERVER_TIME_MAX_AGE_MS) {
    throw new Error('Daemon-link server time is stale');
  }
  return Math.round(inspected.claim.serverTimeMs + elapsedMs);
}
