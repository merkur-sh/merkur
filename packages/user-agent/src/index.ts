type Browser =
  | 'Amazon Silk'
  | 'Brave'
  | 'Chrome'
  | 'Chrome Headless'
  | 'Chrome WebView'
  | 'Chromium'
  | 'DuckDuckGo'
  | 'Edge'
  | 'Edge WebView2'
  | 'Electron'
  | 'Facebook'
  | 'Firefox'
  | 'Firefox Focus'
  | 'Huawei Browser'
  | 'Instagram'
  | 'LibreWolf'
  | 'MIUI Browser'
  | 'Mobile Chrome'
  | 'Mobile Firefox'
  | 'Mobile Safari'
  | 'Opera'
  | 'Opera GX'
  | 'Opera Mini'
  | 'QQBrowser'
  | 'Safari'
  | 'Samsung Internet'
  | 'SeaMonkey'
  | 'UCBrowser'
  | 'Vivaldi'
  | 'Waterfox'
  | 'WeChat'
  | 'Whale'
  | 'Yandex';
type Platform = 'Windows' | 'macOS' | 'iOS' | 'Android' | 'Chrome OS' | 'Linux';

// Request metadata is untrusted. Reject oversized fields whole: truncating a
// structured field could turn a malformed suffix into a valid-looking prefix.
const MAX_HEADER_LENGTH = 512;

/** Browser family and OS family only; no device, engine, CPU, or version parsing. */
export function parseBrowser(headers: Headers): {
  readonly browser: Browser | null;
  readonly platform: Platform | null;
} {
  const brands = headers.get('sec-ch-ua');
  const platform = headers.get('sec-ch-ua-platform');
  const hinted = brands === null ? null : browserFromHints(brands);
  const genericHint = hinted === 'Chrome' || hinted === 'Chromium';
  const ua = brands === null || genericHint || platform === null ? userAgent(headers) : '';
  return {
    browser:
      brands === null ? browserFromUA(ua) : genericHint ? refineChromiumHint(hinted, ua) : hinted,
    platform: platform === null ? platformFromUA(ua) : platformFromHints(platform),
  };
}

function refineChromiumHint(hint: 'Chrome' | 'Chromium', ua: string): Browser {
  const browser = browserFromUA(ua);
  // An engine brand does not erase an explicitly advertised Chromium derivative
  // or its embedding app. Specific hints, by contrast, select their own identity.
  switch (browser) {
    case 'Amazon Silk':
    case 'Brave':
    case 'Chrome Headless':
    case 'Chrome WebView':
    case 'DuckDuckGo':
    case 'Edge':
    case 'Edge WebView2':
    case 'Electron':
    case 'Facebook':
    case 'Huawei Browser':
    case 'Instagram':
    case 'MIUI Browser':
    case 'Mobile Chrome':
    case 'Opera':
    case 'Opera GX':
    case 'QQBrowser':
    case 'Samsung Internet':
    case 'UCBrowser':
    case 'Vivaldi':
    case 'WeChat':
    case 'Whale':
    case 'Yandex':
      return browser;
    default:
      return hint;
  }
}

/** Session issuance needs only the OS; it never scans browser brands or allocates a result. */
export function parsePlatform(headers: Headers): Platform | null {
  const platform = headers.get('sec-ch-ua-platform');
  return platform === null ? platformFromUA(userAgent(headers)) : platformFromHints(platform);
}

function userAgent(headers: Headers): string {
  const value = headers.get('user-agent');
  return value !== null && value.length <= MAX_HEADER_LENGTH ? value : '';
}

function platformFromUA(ua: string): Platform | null {
  const text = ua.toLowerCase();
  // A Windows Phone UA can also advertise Android. It is outside our supported OS set.
  if (text.includes('windows phone') || text.includes('harmonyos')) return null;
  if (text.includes('android')) return 'Android';
  if (text.includes('iphone') || text.includes('ipad') || text.includes('ipod')) return 'iOS';
  if (text.includes('cros ')) return 'Chrome OS';
  if (text.includes('windows nt ')) return 'Windows';
  if (text.includes('macintosh') || text.includes('mac os x')) return 'macOS';
  if (text.includes('linux')) return 'Linux';
  return null;
}

// Versioned product identifiers, not a general regex database. Each product is
// visited once; wrapper applications outrank named browsers, which outrank engine
// compatibility names. Conflicting peers report unknown rather than relying on order.
// Alphabetical by advertised token; rank determines precedence, not table order.
const PRODUCTS = new Map<string, readonly [Browser, number]>([
  ['brave', ['Brave', 3]],
  ['chrome', ['Chrome', 1]],
  ['chromium', ['Chromium', 2]],
  ['crios', ['Mobile Chrome', 1]],
  ['ddg', ['DuckDuckGo', 3]],
  ['duckduckgo', ['DuckDuckGo', 3]],
  ['edg', ['Edge', 3]],
  ['edga', ['Edge', 3]],
  ['edge', ['Edge', 3]],
  ['edgios', ['Edge', 3]],
  ['edgw', ['Edge WebView2', 4]],
  ['electron', ['Electron', 4]],
  ['fbav', ['Facebook', 5]],
  ['firefox', ['Firefox', 2]],
  ['focus', ['Firefox Focus', 3]],
  ['fxios', ['Mobile Firefox', 2]],
  ['headlesschrome', ['Chrome Headless', 4]],
  ['huaweibrowser', ['Huawei Browser', 3]],
  ['instagram', ['Instagram', 5]],
  ['librewolf', ['LibreWolf', 3]],
  ['micromessenger', ['WeChat', 5]],
  ['miuibrowser', ['MIUI Browser', 3]],
  ['mqqbrowser', ['QQBrowser', 3]],
  ['opios', ['Opera Mini', 3]],
  ['opr', ['Opera', 3]],
  ['oprgx', ['Opera GX', 3]],
  ['qqbrowser', ['QQBrowser', 3]],
  ['samsungbrowser', ['Samsung Internet', 3]],
  ['seamonkey', ['SeaMonkey', 3]],
  ['silk', ['Amazon Silk', 3]],
  ['ucbrowser', ['UCBrowser', 3]],
  ['vivaldi', ['Vivaldi', 3]],
  ['waterfox', ['Waterfox', 3]],
  ['whale', ['Whale', 3]],
  ['yabrowser', ['Yandex', 3]],
]);
const PRODUCT = new RegExp(
  `(?:^|[ \\t;[(])(${[...PRODUCTS.keys(), 'safari', 'version', 'mobile'].join('|')})/(?=[0-9])`,
  'gi',
);
const MOBILE = /(?:^|[ (;])(?:mobile|tablet)(?:[ ;/)]|$)/i;
const WEBVIEW = /; wv\)/i;

function browserFromUA(ua: string): Browser | null {
  PRODUCT.lastIndex = 0;
  let selected: Browser | null = null;
  let specificity = 0;
  let ambiguous = false;
  let safari = false;
  let version = false;
  let mobile = false;
  for (let match = PRODUCT.exec(ua); match !== null; match = PRODUCT.exec(ua)) {
    const token = match[1]?.toLowerCase();
    if (token === undefined) continue;
    if (token === 'safari') safari = true;
    else if (token === 'version') version = true;
    else if (token === 'mobile') mobile = true;
    const product = PRODUCTS.get(token);
    if (product === undefined) continue;
    if (product[1] > specificity) {
      [selected, specificity] = product;
      ambiguous = false;
    } else if (product[1] === specificity && selected !== product[0]) {
      ambiguous = true;
    }
  }
  if (ambiguous) return null;
  if (selected === 'Chrome' && WEBVIEW.test(ua)) return 'Chrome WebView';
  if (selected === 'Chrome' && MOBILE.test(ua)) return 'Mobile Chrome';
  if (selected === 'Firefox' && MOBILE.test(ua)) return 'Mobile Firefox';
  if (selected !== null) return selected;
  return safari && version ? (mobile ? 'Mobile Safari' : 'Safari') : null;
}

function browserBrand(brand: string): Browser | null {
  switch (brand) {
    // Advertised aliases, followed by names already matching our display labels.
    case 'Android WebView':
      return 'Chrome WebView';
    case 'Google Chrome':
      return 'Chrome';
    case 'HeadlessChrome':
      return 'Chrome Headless';
    case 'Microsoft Edge':
      return 'Edge';
    case 'Microsoft Edge WebView2':
      return 'Edge WebView2';
    case 'Silk':
      return 'Amazon Silk';
    case 'YaBrowser':
      return 'Yandex';
    case 'Amazon Silk':
    case 'Brave':
    case 'Chromium':
    case 'DuckDuckGo':
    case 'Firefox':
    case 'Huawei Browser':
    case 'LibreWolf':
    case 'MIUI Browser':
    case 'Opera':
    case 'Opera GX':
    case 'QQBrowser':
    case 'Safari':
    case 'Samsung Internet':
    case 'SeaMonkey':
    case 'UCBrowser':
    case 'Vivaldi':
    case 'Waterfox':
    case 'WeChat':
    case 'Whale':
      return brand;
    default:
      return null;
  }
}

function platformFromHints(field: string): Platform | null {
  if (field.length > MAX_HEADER_LENGTH) return null;
  const start = whitespaceEnd(field, 0);
  const end = quotedEnd(field, start);
  if (end === -1) return null;
  const next = parametersEnd(field, end, false);
  if (next === -1 || whitespaceEnd(field, next) !== field.length) return null;
  switch (field.slice(start + 1, end - 1)) {
    case 'Windows':
      return 'Windows';
    case 'macOS':
      return 'macOS';
    case 'iOS':
      return 'iOS';
    case 'Android':
      return 'Android';
    case 'Chrome OS':
    case 'Chromium OS':
      return 'Chrome OS';
    case 'Linux':
      return 'Linux';
    default:
      return null;
  }
}

function browserFromHints(field: string): Browser | null {
  if (field.length > MAX_HEADER_LENGTH) return null;
  let cursor = whitespaceEnd(field, 0);
  let selected: Browser | null = null;
  let specificity = 0;
  let ambiguous = false;
  while (cursor < field.length) {
    const end = quotedEnd(field, cursor);
    if (end === -1) return null;
    const next = parametersEnd(field, end, true);
    if (next === -1) return null;
    const brand = browserBrand(field.slice(cursor + 1, end - 1));
    if (brand !== null) {
      // Chromium < Chrome < an explicitly named browser. Conflicting specific
      // brands are unknown, independent of the randomized list ordering.
      const rank =
        brand === 'Chromium'
          ? 1
          : brand === 'Chrome'
            ? 2
            : brand === 'Chrome WebView' || brand === 'Edge WebView2' || brand === 'Chrome Headless'
              ? 4
              : 3;
      if (rank > specificity) {
        selected = brand;
        specificity = rank;
        ambiguous = false;
      } else if (rank === specificity && selected !== brand) {
        ambiguous = true;
      }
    }
    cursor = whitespaceEnd(field, next);
    if (cursor === field.length) return ambiguous ? null : selected;
    if (field.charCodeAt(cursor) !== 44) return null;
    cursor = whitespaceEnd(field, cursor + 1);
    if (cursor === field.length) return null;
  }
  return null;
}

// RFC 8941 parameter keys and bare items. Sticky matching consumes exactly the
// next parameter; leftover bytes invalidate the whole field. Unknown parameters
// are validated then ignored. No generic structured-field objects are built.
const PARAMETER =
  /; *([a-z*][a-z0-9_.*-]*)(?:=("(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"|-?(?:\d{1,12}\.\d{1,3}|\d{1,15})|[a-zA-Z*][!#$%&'*+\-.^_`|~:/a-zA-Z0-9]*|:(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}(?:==)?|[a-zA-Z0-9+/]{3}=?)?:|\?[01]))?/y;

function parametersEnd(field: string, start: number, requireVersion: boolean): number {
  let cursor = start;
  let versionIsString = false;
  while (field.charCodeAt(cursor) === 59) {
    PARAMETER.lastIndex = cursor;
    const parameter = PARAMETER.exec(field);
    if (parameter === null) return -1;
    // Structured Fields use the last occurrence of a duplicated parameter key.
    if (parameter[1] === 'v') versionIsString = parameter[2]?.charCodeAt(0) === 34;
    cursor = PARAMETER.lastIndex;
  }
  return requireVersion && !versionIsString ? -1 : cursor;
}

function quotedEnd(field: string, start: number): number {
  if (field.charCodeAt(start) !== 34) return -1;
  for (let cursor = start + 1; cursor < field.length; cursor++) {
    const code = field.charCodeAt(cursor);
    if (code === 34) return cursor + 1;
    if (code < 32 || code > 126) return -1;
    if (code === 92) {
      const escaped = field.charCodeAt(++cursor);
      if (escaped !== 34 && escaped !== 92) return -1;
    }
  }
  return -1;
}

function whitespaceEnd(field: string, start: number): number {
  let cursor = start;
  while (field.charCodeAt(cursor) === 32 || field.charCodeAt(cursor) === 9) cursor++;
  return cursor;
}
