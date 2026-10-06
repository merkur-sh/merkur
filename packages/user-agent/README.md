# Browser request identification

`@merkur/user-agent` identifies browser and operating-system families for Merkur's
server from request headers. It performs family identification only: it does not
authenticate a browser or its operating system, and it does not parse versions, device
models, engines, CPU architectures, bots or legacy browser catalogues.

## API

| Function | Returns |
| --- | --- |
| `parseBrowser(headers)` | `{ browser, platform }` with fixed labels, or `null` |
| `parsePlatform(headers)` | the platform label alone, without constructing a result object or parsing browser identity |

## Labels

Browser labels cover Chrome and mobile Chrome, Chromium, Edge, Firefox and mobile Firefox,
Firefox Focus, Safari and mobile Safari, Opera/Mini/GX, Samsung Internet, Vivaldi, Brave,
DuckDuckGo, Yandex, Chrome WebView, Edge WebView2, Chrome Headless, Electron, Facebook and
Instagram, plus Amazon Silk, Huawei Browser, LibreWolf, MIUI Browser, QQBrowser, SeaMonkey,
UCBrowser, Waterfox, WeChat and Whale. Each requires an explicit recognised product or
Client Hint. Both `QQBrowser` and `MQQBrowser` product tokens select QQBrowser,
`MicroMessenger` selects WeChat and `Silk` selects Amazon Silk.

An unbranded derivative that advertises only Chrome, Firefox or Safari is indistinguishable
from that browser. Recognising a brand does not imply that every release or privacy
configuration advertises it, and unknown extra products do not erase recognised
compatibility products.

OS labels are Windows, macOS, iOS, Android, Chrome OS and Linux. Distributions advertising
Linux normalise to that family. Unsupported OSes remain unknown. An iPad in desktop mode
advertises macOS and cannot be distinguished from these headers alone.

## Precedence

UA products are scanned once, case-insensitively. Embedded apps outrank runtime wrappers,
which outrank named browsers, which outrank generic compatibility products; named Firefox
derivatives outrank the Firefox compatibility token. Product entries and brand aliases are
alphabetical within their groups, and explicit ranks decide precedence. Conflicting names at
the same specificity return `null`. The OS-only path does no browser work.

## Client Hints

Each hint selects its own dimension, and a specific browser hint takes precedence over the
UA. Generic Chrome/Chromium hints retain an explicitly advertised Chromium derivative or
embedding app. Within a brand list a named browser outranks Chrome, which outranks
Chromium; a named WebView or headless runtime outranks its browser. Equal-specificity
conflicts return `null` regardless of list order. Unrecognised brands, including GREASE, are
ignored and never copied into a display name; nothing tries to identify GREASE by its
spelling.

Hints are parsed as structured-field strings and parameters. Quoted escapes, version
parameter types, extension parameters, repeated parameters (last value wins) and separators
are validated, and malformed trailing content invalidates the whole field. Browser list
members must have a string `v` parameter. When a hint is absent, that dimension uses the
UA; a hint that is present but malformed, unsupported, ambiguous or oversized returns
`null`. Each consumed header has a 512-character limit, and an oversized field is rejected
whole. The parser reads no high-entropy hints and requests no extra browser round trip; the
mobile hint is unnecessary because no form-factor result is produced.

## References

- [User-Agent Client Hints](https://wicg.github.io/ua-client-hints/)
- [Structured Field Values for HTTP](https://www.rfc-editor.org/rfc/rfc8941.html)
- [Microsoft Edge product identifiers](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/user-agent-guidance)
- [Chrome for iOS user agents](https://chromium.googlesource.com/chromium/src.git/+/master/docs/ios/user_agent.md)
- [Samsung Internet user agents](https://developer.samsung.com/browser/user-agent-string-format.html)
- [Android WebView user-agent reduction](https://android-developers.googleblog.com/2024/12/user-agent-reduction-on-android-webview.html)
- [Electron's user-agent construction](https://github.com/electron/electron/blob/main/shell/common/application_info.cc)

## Tests and benchmark

Tests exercise labels, precedence, malformed input, bounds, structured-field parameters,
OS-only header access and the server's port-range mapping. `scripts/bench-user-agent.ts`
times browser/OS and OS-only operations across UA, Client Hints and unknown-input groups
on the same corpus, validating each result before timing.
