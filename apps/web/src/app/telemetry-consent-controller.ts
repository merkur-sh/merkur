import { createSignal, onCleanup } from 'solid-js';

/**
 * 'unknown' until this signed-in lifetime's device-events stream states the
 * account's consent; 'unchosen' while the account has not answered. Only 'on'
 * reports anything.
 */
export type TelemetryConsentState = 'unknown' | 'unchosen' | 'on' | 'off';

/**
 * The account's performance-reporting consent as this page knows it.
 *
 * The server is the only source: the stream states it, and a choice made here
 * takes effect when the PUT answers with what was stored, never before. One
 * choice is in flight at a time, and signing out abandons it.
 */
export function createTelemetryConsentController(options: {
  getAccessToken(): string | null;
  save(token: string, enabled: boolean, signal: AbortSignal): Promise<{ enabled: boolean }>;
  applyEnabled(enabled: boolean): void;
}) {
  const [consent, setConsent] = createSignal<TelemetryConsentState>('unknown');
  const [pending, setPending] = createSignal<boolean | null>(null);
  const [failed, setFailed] = createSignal(false);
  // Solid publishes on flush; reporting and duplicate-save guards must change
  // synchronously with the server statement or the user's choice.
  let enabled = false;
  let request: AbortController | null = null;

  function state(value: boolean | null): void {
    setConsent(value === null ? 'unchosen' : value ? 'on' : 'off');
    apply(value === true);
  }

  function apply(next: boolean): void {
    if (enabled === next) return;
    enabled = next;
    options.applyEnabled(next);
  }

  function reset(): void {
    const previous = request;
    request = null;
    previous?.abort();
    setPending(null);
    setFailed(false);
    setConsent('unknown');
    apply(false);
  }

  function receive(value: boolean | null | undefined): void {
    if (value === undefined) reset();
    else state(value);
  }

  async function choose(next: boolean): Promise<void> {
    if (request !== null) return;
    const token = options.getAccessToken();
    if (token === null) return;
    const current = new AbortController();
    request = current;
    setPending(next);
    setFailed(false);
    try {
      const saved = await options.save(token, next, current.signal);
      if (request === current) state(saved.enabled);
    } catch {
      if (request === current) setFailed(true);
    } finally {
      if (request === current) {
        request = null;
        setPending(null);
      }
    }
  }

  onCleanup(reset);
  return { consent, pending, failed, isEnabled: () => enabled, receive, choose, reset };
}
