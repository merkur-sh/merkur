import { readFileSync } from 'node:fs';
import {
  ACCENT_SRGB,
  COLORS,
  FIELD_DARK,
  FIELD_DOT_PITCH,
  FIELD_DOTS,
  MONO_STACK,
  mixHex,
  UI_STACK,
} from '@merkur/quicksilver/tokens';

import lockupPath from './mail-lockup.png' with { type: 'file' };

/**
 * What one email says, once: the HTML part and the plain-text part are both
 * rendered from it, so neither can say something the other does not.
 */
export interface MailContent {
  readonly subject: string;
  /** The inbox preview line, shown after the subject and never in the body. */
  readonly preview: string;
  /** The headline's first sentence, in ink. */
  readonly title: string;
  /** The headline's second sentence, in the quieter grey. */
  readonly deck: string;
  readonly code?: {
    /** Names the code above it, e.g. "Sign-up code". */
    readonly label: string;
    readonly value: string;
    readonly expiry: string;
  };
  readonly paragraphs: readonly string[];
  readonly notice?: { readonly tone: 'warn' | 'bad'; readonly text: string };
  readonly action?: { readonly label: string; readonly href: string };
  /** The small print under everything else, e.g. what to do if it was not you. */
  readonly footnote?: string;
  /** Why this address got the mail at all, in the footer. */
  readonly reason: string;
}

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * The orb and wordmark, carried inside every message rather than linked
 * (`scripts/render-mail-lockup.ts` explains why). The `file` import is what
 * makes `bun build --compile` embed it in the server executable; at runtime
 * the binding is the file's path.
 */
export const MAIL_LOCKUP = {
  contentId: 'merkur-lockup',
  filename: 'merkur.png',
  content: readFileSync(lockupPath).toString('base64'),
} as const;

/** The lockup's CSS size; the image is three times that. */
const LOCKUP_WIDTH = 112;
const LOCKUP_HEIGHT = 36;

/**
 * Mail clients read no OKLCH, no custom properties and, in Outlook, no
 * `rgba()`, so every Quicksilver line and tint is flattened onto the surface
 * it sits on.
 */
const PAINT = {
  field: FIELD_DARK,
  card: COLORS.ground,
  cardLine: mixHex(FIELD_DARK, '#ffffff', 0.1),
  ink: COLORS.ink,
  body: COLORS.body,
  meta: COLORS.meta,
  /** The site's small print (`--note`): the darkest grey at 4.5:1 on the field. */
  note: '#87878f',
  codeFill: mixHex(COLORS.ground, ACCENT_SRGB, 0.1),
  codeLine: mixHex(COLORS.ground, ACCENT_SRGB, 0.42),
  accent: ACCENT_SRGB,
  warnFill: mixHex(COLORS.ground, COLORS.warn, 0.08),
  warnLine: mixHex(COLORS.ground, COLORS.warn, 0.32),
  warnInk: COLORS.warnink,
  badFill: mixHex(COLORS.ground, COLORS.bad, 0.08),
  badLine: mixHex(COLORS.ground, COLORS.bad, 0.32),
  badInk: COLORS.badink,
} as const;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The card's content: lockup, headline, code, paragraphs, action, notice, footnote. */
function cardHtml(content: MailContent): string {
  const rows: string[] = [
    `<tr><td style="padding:0 0 32px 0;"><img src="cid:${MAIL_LOCKUP.contentId}" width="${LOCKUP_WIDTH}" height="${LOCKUP_HEIGHT}" alt="Merkur" style="display:block;border:0;outline:none;width:${LOCKUP_WIDTH}px;height:${LOCKUP_HEIGHT}px;font-family:Georgia,serif;font-size:26px;line-height:${LOCKUP_HEIGHT}px;color:${PAINT.ink};"></td></tr>`,
    `<tr><td style="padding:0 0 16px 0;"><h1 style="margin:0;font-family:${UI_STACK};font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${PAINT.ink};">${escapeHtml(content.title)} <span style="font-weight:400;color:${PAINT.meta};">${escapeHtml(content.deck)}</span></h1></td></tr>`,
  ];
  if (content.code !== undefined) {
    // The code is one unbroken run of digits in one element. Gmail's "Copy
    // code" chip and Apple's AutoFill find it the way a person would; digits
    // split into a cell each, or spaced apart, read as six numbers. Letter
    // spacing gives the gaps without putting characters between them, and the
    // same amount of left padding keeps the run optically centred.
    rows.push(
      `<tr><td style="padding:8px 0 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td class="mail-code-cell" align="center" bgcolor="${PAINT.codeFill}" style="background-color:${PAINT.codeFill};border:1px solid ${PAINT.codeLine};border-radius:14px;padding:22px 16px 20px 16px;">` +
        `<div style="font-family:${MONO_STACK};font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:${PAINT.meta};padding:0 0 10px 0;">${escapeHtml(content.code.label)}</div>` +
        `<div class="mail-code" style="font-family:${MONO_STACK};font-size:36px;line-height:44px;font-weight:600;letter-spacing:0.18em;padding-left:0.18em;color:${PAINT.ink};">${escapeHtml(content.code.value)}</div>` +
        `<div style="font-family:${UI_STACK};font-size:13px;line-height:20px;color:${PAINT.meta};padding:10px 0 0 0;">${escapeHtml(content.code.expiry)}</div>` +
        '</td></tr></table></td></tr>',
    );
  }
  for (const paragraph of content.paragraphs) {
    rows.push(
      `<tr><td style="padding:0 0 16px 0;font-family:${UI_STACK};font-size:15px;line-height:1.6;color:${PAINT.body};">${escapeHtml(paragraph)}</td></tr>`,
    );
  }
  if (content.action !== undefined) {
    // A table cell with a fill, not a CSS button: Outlook on Windows draws
    // the cell's fill and padding and ignores both on a link.
    rows.push(
      `<tr><td style="padding:8px 0 24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td bgcolor="${PAINT.accent}" style="background-color:${PAINT.accent};border-radius:10px;mso-padding-alt:12px 22px;box-shadow:0 0 28px rgba(127,90,240,0.35);"><a href="${escapeHtml(content.action.href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${UI_STACK};font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(content.action.label)}</a></td></tr></table></td></tr>`,
    );
  }
  if (content.notice !== undefined) {
    const { tone, text } = content.notice;
    const fill = tone === 'warn' ? PAINT.warnFill : PAINT.badFill;
    const line = tone === 'warn' ? PAINT.warnLine : PAINT.badLine;
    const ink = tone === 'warn' ? PAINT.warnInk : PAINT.badInk;
    rows.push(
      `<tr><td style="padding:4px 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td bgcolor="${fill}" style="background-color:${fill};border:1px solid ${line};border-radius:10px;padding:14px 16px;font-family:${UI_STACK};font-size:14px;line-height:1.55;color:${ink};">${escapeHtml(text)}</td></tr></table></td></tr>`,
    );
  }
  if (content.footnote !== undefined) {
    rows.push(
      `<tr><td style="padding:8px 0 0 0;border-top:1px solid ${PAINT.cardLine};"><p style="margin:16px 0 0 0;font-family:${UI_STACK};font-size:13px;line-height:1.55;color:${PAINT.meta};">${escapeHtml(content.footnote)}</p></td></tr>`,
    );
  }
  return rows.join('');
}

/**
 * Inbox previews read on past the preview line into the body unless
 * something fills the rest: zero-width joiners and non-breaking spaces, which
 * no client shows, until the preview runs out of room.
 */
const PREVIEW_FILL = '&#847;&zwnj;&nbsp;'.repeat(90);

/**
 * The page around the card, written for what mail clients actually render:
 * tables for layout (Outlook on Windows lays out with Word), inline styles
 * (Gmail keeps a `<style>` block only for the media query and the client
 * fixes), every colour stated where it is used, with `bgcolor` beside
 * `background-color`. The design is Quicksilver's dark one in every client;
 * `color-scheme` says the mail chose its colours, so a client's dark mode
 * leaves them alone where it respects that. The desk is its dot grid over
 * the field's dark end, without the app's gradient: the body and the table
 * each paint it (Gmail drops the body's), and a gradient would show a seam
 * where the table ends.
 */
function pageHtml(content: MailContent, origin: string): string {
  const host = new URL(origin).host;
  const subject = escapeHtml(content.subject);
  return `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,a,h1,p,div{font-family:'Segoe UI',Arial,sans-serif !important;}</style><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body{margin:0 !important;padding:0 !important;width:100% !important;background-color:${PAINT.field};background-image:${FIELD_DOTS};background-size:${FIELD_DOT_PITCH} ${FIELD_DOT_PITCH};}
a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;font-size:inherit !important;font-family:inherit !important;font-weight:inherit !important;line-height:inherit !important;}
u + .mail-body a{color:inherit;text-decoration:none;}
@media screen and (max-width:540px){
  .mail-outer{padding:20px 12px 28px 12px !important;}
  .mail-card{padding:28px 22px 26px 22px !important;border-radius:16px !important;}
  .mail-code{font-size:32px !important;}
}
</style>
</head>
<body class="mail-body" bgcolor="${PAINT.field}" style="margin:0;padding:0;background-color:${PAINT.field};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAINT.field};">${escapeHtml(content.preview)}${PREVIEW_FILL}</div>
<div role="article" aria-roledescription="email" aria-label="${subject}" lang="en" dir="ltr">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAINT.field}" style="background-color:${PAINT.field};background-image:${FIELD_DOTS};background-size:${FIELD_DOT_PITCH} ${FIELD_DOT_PITCH};">
<tr><td class="mail-outer" align="center" style="padding:48px 16px 40px 16px;">
<!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;">
<tr><td class="mail-card" bgcolor="${PAINT.card}" style="background-color:${PAINT.card};border:1px solid ${PAINT.cardLine};border-radius:20px;padding:40px 40px 36px 40px;box-shadow:0 1px 0 rgba(255,255,255,0.065) inset,0 24px 64px rgba(0,0,0,0.45);">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cardHtml(content)}</table>
</td></tr>
<tr><td style="padding:24px 8px 0 8px;font-family:${UI_STACK};font-size:12px;line-height:1.6;color:${PAINT.note};">
<p style="margin:0 0 6px 0;">${escapeHtml(content.reason)}</p>
<p style="margin:0;"><a href="${escapeHtml(origin)}" target="_blank" style="color:${PAINT.meta};text-decoration:none;">${escapeHtml(host)}</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${escapeHtml(origin)}/legal/privacy.html" target="_blank" style="color:${PAINT.meta};text-decoration:none;">Privacy</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${escapeHtml(origin)}/legal/terms.html" target="_blank" style="color:${PAINT.meta};text-decoration:none;">Terms</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>`;
}

/** The plain-text part: the same content, in the order the card shows it. */
function plainText(content: MailContent, origin: string): string {
  const blocks: string[] = [`${content.title} ${content.deck}`];
  if (content.code !== undefined) {
    blocks.push(`${content.code.label}:\n\n${content.code.value}\n\n${content.code.expiry}`);
  }
  blocks.push(...content.paragraphs);
  if (content.action !== undefined) {
    blocks.push(`${content.action.label}: ${content.action.href}`);
  }
  if (content.notice !== undefined) blocks.push(content.notice.text);
  if (content.footnote !== undefined) blocks.push(content.footnote);
  blocks.push(`--\n${content.reason}\nMerkur · ${origin}`);
  return `${blocks.join('\n\n')}\n`;
}

export function renderMail(content: MailContent, origin: string): RenderedMail {
  return {
    subject: content.subject,
    html: pageHtml(content, origin),
    text: plainText(content, origin),
  };
}
