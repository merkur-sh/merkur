import { loadE2eWasmModule } from '../lib/e2e-wasm-module';
import {
  finishPasswordResetRequest,
  type PasswordResetDevice,
  requestPasswordResetCode,
  startPasswordResetRequest,
  verifyPasswordResetCode,
} from './account-api';
import { finishAccountRegistration, startAccountRegistration } from './account-opaque';
import {
  type ActiveBrowserAccount,
  adoptNewAccountRoot,
  sealNewAccountRoot,
} from './account-workflow';
import { requireValidAccountPassword } from './password-policy';

/**
 * A password reset on an email-identity server.
 *
 * The mailbox is the whole authority here, and what it buys is narrow: the
 * account under a new password and a new user root. Every machine is bound to
 * the root being discarded, so the reset unlinks them all and reaches no
 * terminal; `devices` is what the server will destroy, shown before the new
 * password is asked for.
 *
 * Nothing secret is held between steps. The new root is generated, sealed and
 * wiped inside `complete`.
 */
export type PasswordReset = PasswordResetAwaitingCode | PasswordResetProven;

/** Waiting for the code mailed to `address`. */
export interface PasswordResetAwaitingCode {
  readonly step: 'code';
  readonly address: string;
  /**
   * Spends one guess. A wrong code rejects with the server's
   * `invalid_email_code` and leaves this step usable; any other failure means
   * the server's flow is gone and the reset starts over.
   */
  submitCode(code: string, signal?: AbortSignal): Promise<PasswordResetProven>;
  /** Mails a new code and returns the step that waits for it. */
  resend(signal?: AbortSignal): Promise<PasswordResetAwaitingCode>;
}

/** The mailbox is proven; only the new password is missing. */
export interface PasswordResetProven {
  readonly step: 'confirm';
  readonly address: string;
  readonly devices: readonly PasswordResetDevice[];
  /**
   * Replaces the password and root and signs this browser in. The server
   * spends the reset on the first finish it is offered, and answers a later
   * attempt as an expired flow.
   */
  complete(password: string, signal?: AbortSignal): Promise<ActiveBrowserAccount>;
}

export async function beginPasswordReset(
  address: string,
  signal?: AbortSignal,
): Promise<PasswordResetAwaitingCode> {
  return awaitingCode(address, await requestPasswordResetCode(address, signal));
}

function awaitingCode(address: string, flowId: string): PasswordResetAwaitingCode {
  return {
    step: 'code',
    address,
    async submitCode(code, signal) {
      const proof = await verifyPasswordResetCode(flowId, code, signal);
      return proven(address, proof.flowId, proof.devices);
    },
    resend: (signal) => beginPasswordReset(address, signal),
  };
}

function proven(
  address: string,
  flowId: string,
  devices: readonly PasswordResetDevice[],
): PasswordResetProven {
  return {
    step: 'confirm',
    address,
    devices,
    async complete(password, signal) {
      requireValidAccountPassword(password);
      const [registration] = await Promise.all([
        startAccountRegistration(password),
        // The new root signs this browser's delegation.
        loadE2eWasmModule(),
      ]);
      const start = await startPasswordResetRequest(
        flowId,
        registration.registrationRequest,
        signal,
      );
      const opaqueFinish = await finishAccountRegistration(
        password,
        registration.clientRegistrationState,
        start.registrationResponse,
        start.userId,
        globalThis.location.origin,
        signal,
      );
      const root = await sealNewAccountRoot(opaqueFinish.exportKey, {
        userId: start.userId,
        rootEpoch: start.rootEpoch,
        issuedAt: start.delegationIssuedAt,
        expiresAt: start.delegationExpiresAt,
      });
      try {
        const session = await finishPasswordResetRequest(
          {
            flowId,
            registrationRecord: opaqueFinish.registrationRecord,
            rootPublicKey: root.rootPublicKeyEncoded,
            rootEnvelope: root.rootEnvelope,
            delegationCertificate: root.delegation.certificate,
          },
          signal,
        );
        return await adoptNewAccountRoot(address, session, root);
      } finally {
        root.wipe();
      }
    },
  };
}
