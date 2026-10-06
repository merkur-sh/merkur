/**
 * Return the one current wire representation of an edge WebTransport URL.
 * Registrations and every persisted/forwarded session record use `URL.href`,
 * so consumers can reject schema drift instead of normalizing untrusted state
 * differently at each boundary.
 */
export function normalizeEdgeWebTransportUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      value.includes('?') ||
      value.includes('#')
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function isCanonicalEdgeWebTransportUrl(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && normalizeEdgeWebTransportUrl(value) === value
  );
}

/**
 * The edge closes a carrier with this code and reason when its relay egress
 * budget is spent (`EGRESS_BUDGET_CLOSE_CODE` in `merkur-edge-protocol`, which
 * the edge, the daemon and the native client share). Both fields must match.
 */
const EGRESS_BUDGET_CLOSE_CODE = 0x4d03;
const EGRESS_BUDGET_CLOSE_REASON = 'egress-budget';

export function isEgressBudgetClose(
  info: { readonly closeCode?: number; readonly reason?: string } | undefined,
): boolean {
  return info?.closeCode === EGRESS_BUDGET_CLOSE_CODE && info.reason === EGRESS_BUDGET_CLOSE_REASON;
}
