/** Text made safe to write into HTML, as element content or a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The tokens a line must never break inside at one of their own hyphens: a
 * lab-notes entry id, an ISO date or its month-day tail, a platform pair, and
 * the algorithm names. A browser breaks after any hyphen, so `2026-09-` could
 * end a line and `20` start the next.
 */
export const WHOLE_TOKEN =
  /\b\d{4}-\d{2}-\d{2}(?:-[a-z0-9]+)*\b|\b\d{2}-\d{2}\b|\b(?:darwin|linux)-(?:arm64|x64)\b|\bML-(?:KEM|DSA)-\d+\b|\bChaCha20-Poly1305\b|\b(?:HKDF-)?SHA-\d+\b/g;

/**
 * Escaped text with each `WHOLE_TOKEN` in a `nw` span, which the stylesheet
 * keeps on one line. For element content only, never an attribute.
 */
export function keepWhole(escaped: string): string {
  return escaped.replace(WHOLE_TOKEN, (token) => `<span class="nw">${token}</span>`);
}
