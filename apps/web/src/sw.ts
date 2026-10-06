import { shouldBypassServiceWorkerRequest } from './service-worker-routing';

// Both tokens are injected at build by the `merkur-sw-precache-manifest`
// plugin (apps/web/vite.config.ts): the manifest is the real emitted file list
// (no more hand-maintained names going stale and failing the whole install),
// and the build id is a content hash of the entire build, so any byte change —
// including unhashed worker entries and public/ wasm — rolls the shell cache
// and triggers the SW update flow.
const BUILD_ID = '__MERKUR_BUILD_ID__';
const SHELL_CACHE_PREFIX = 'merkur-shell';
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}-${BUILD_ID}`;
const swGlobal = globalThis as unknown as ServiceWorkerGlobalScope;

function readShellManifest(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse('__MERKUR_SHELL_MANIFEST__');
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    }
  } catch {
    // Token not injected (unbuilt source) — the SW is disabled in dev anyway.
  }
  return ['/', '/index.html'];
}

const SHELL_ASSETS = readShellManifest();

swGlobal.addEventListener('install', (event) => {
  if (!hasWaitUntil(event)) return;
  event.waitUntil(precacheShell());
});

swGlobal.addEventListener('message', (event) => {
  if (!hasWaitUntil(event) || !('data' in event) || event.data !== 'activate_update') return;
  event.waitUntil(swGlobal.skipWaiting());
});

swGlobal.addEventListener('activate', (event) => {
  if (!hasWaitUntil(event)) return;
  event.waitUntil(activateHandler());
});

swGlobal.addEventListener('fetch', (event) => {
  if (!isFetchEvent(event)) return;
  if (shouldBypassServiceWorker(event.request)) return;
  event.respondWith(handleFetch(event));
});

swGlobal.addEventListener('push', (event) => {
  if (!isPushEvent(event)) return;
  event.waitUntil(handlePush(event));
});

swGlobal.addEventListener('notificationclick', (event) => {
  if (!isNotificationClickEvent(event)) return;
  event.notification.close();
  event.waitUntil(focusOrOpenApp(readNotificationUrl(event.notification.data)));
});

async function precacheShell(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE);
  // Publish only a complete build. Keep the incumbent worker and its cache
  // until Reload activates this one: the running page still owns old hashed
  // worker URLs, which the deployed server may no longer serve.
  await cache.addAll(SHELL_ASSETS);
}

async function activateHandler(): Promise<void> {
  // Activation is the reload boundary: pages reload on the controller change,
  // and for a page this worker did not control yet — one the reader asked to
  // update after a hard reload — the claim is that change. It goes first, so no
  // cache operation can stand between Reload and the reload.
  await swGlobal.clients.claim();
  await Promise.all([
    // The shell is served cache-first from the versioned precache, so a
    // navigation-preload network fetch would just race work we discard.
    swGlobal.registration.navigationPreload?.disable(),
    retireShellCaches(),
  ]);
  // Do not inspect or delete the legacy `merkur-assets` font cache here.
  // Font CacheStorage operations are the iOS startup stall this worker is
  // replacing, and activation must not wait on the same unreliable boundary.
  // The cache is now unreachable because /fonts requests bypass this worker.
}

async function retireShellCaches(): Promise<void> {
  // Listed before the registration is read. A build that starts installing
  // after this read opens its cache after this list was taken, so it is never
  // in it; one already installing or waiting is precaching into a cache this
  // list does hold, and retiring "every shell cache but mine" would empty the
  // update it is about to offer. That build's own activation retires this one.
  const cacheKeys = await caches.keys();
  const registration = swGlobal.registration;
  if (registration.installing !== null || registration.waiting !== null) return;
  await Promise.all(
    cacheKeys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE)
      .map((key) => caches.delete(key)),
  );
}

async function handleFetch(event: SwFetchEvent): Promise<Response> {
  const request = event.request;

  // Navigations serve the precached shell HTML instantly; deploys land via the
  // SW update flow (new build id -> new precache -> controllerchange event).
  if (request.mode === 'navigate') {
    return navigationResponse(event);
  }

  // Shell assets — SHELL_CACHE, precached on install
  return shellCacheFirst(event);
}

function shouldBypassServiceWorker(request: Request): boolean {
  return shouldBypassServiceWorkerRequest(request, swGlobal.location.origin);
}

async function handlePush(event: SwPushEvent): Promise<void> {
  if (Notification.permission !== 'granted') {
    return;
  }

  const payload = readPushPayload(event.data);
  if (payload === null) {
    return;
  }

  await swGlobal.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    data: { url: payload.url },
    icon: '/pwa-icon-192.png',
    renotify: true,
  } as NotificationOptions);
}

async function focusOrOpenApp(path: string): Promise<void> {
  const targetUrl = new URL(path, swGlobal.location.origin).toString();
  const allClients = await swGlobal.clients.matchAll({ type: 'window' });
  for (const client of allClients) {
    if ('focus' in client) {
      await client.focus();
      return;
    }
  }

  await swGlobal.clients.openWindow(targetUrl);
}

function readPushPayload(data: PushMessageData | null): PushPayload | null {
  if (data === null) return null;
  try {
    const value = data.json();
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (!('kind' in value) || !isPushPayloadKind(value.kind)) return null;
    const title = readStringField(record, 'title');
    const body = readStringField(record, 'body');
    const tag = readStringField(record, 'tag');
    const url = readStringField(record, 'url');
    if (title === null || body === null || tag === null || url === null) return null;
    return { kind: value.kind, title, body, tag, url };
  } catch {
    return null;
  }
}

function readNotificationUrl(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('url' in value)) return '/';
  return typeof value.url === 'string' && value.url.length > 0 ? value.url : '/';
}

function readStringField(value: Record<string, unknown>, field: string): string | null {
  if (!(field in value)) return null;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : null;
}

async function navigationResponse(event: SwFetchEvent): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match('/index.html')) ?? (await cache.match('/'));

  // A registration from a previous SW version may still have navigation
  // preload enabled for this request; consume it so the browser doesn't warn.
  const preloadPromise = (event as unknown as { preloadResponse?: Promise<Response | undefined> })
    .preloadResponse;

  if (cached) {
    void preloadPromise?.catch(() => undefined);
    return cached;
  }

  try {
    const preload = await preloadPromise;
    const response = preload ?? (await fetch(event.request));
    if (response.ok) await cache.put('/index.html', response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function shellCacheFirst(event: SwFetchEvent): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;

  try {
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  } catch {
    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

type SwFetchEvent = Event & {
  request: Request;
  preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response> | Response): void;
  waitUntil(promise: Promise<void>): void;
};

type SwPushEvent = Event & {
  data: PushMessageData | null;
  waitUntil(promise: Promise<void>): void;
};

type SwNotificationClickEvent = Event & {
  notification: Notification;
  waitUntil(promise: Promise<void>): void;
};

// Kinds an older installed worker will not recognise are dropped rather than
// shown, so a newly added kind only reaches clients whose worker has updated.
const PUSH_PAYLOAD_KINDS = ['terminal_bell', 'failed_sign_in'] as const;

type PushPayloadKind = (typeof PUSH_PAYLOAD_KINDS)[number];

interface PushPayload {
  readonly kind: PushPayloadKind;
  readonly title: string;
  readonly body: string;
  readonly tag: string;
  readonly url: string;
}

function isPushPayloadKind(value: unknown): value is PushPayloadKind {
  return PUSH_PAYLOAD_KINDS.some((kind) => kind === value);
}

function hasWaitUntil(event: Event): event is Event & { waitUntil(promise: Promise<void>): void } {
  return 'waitUntil' in event && typeof event.waitUntil === 'function';
}

function isFetchEvent(event: Event): event is SwFetchEvent {
  return (
    'request' in event &&
    event.request instanceof Request &&
    'respondWith' in event &&
    typeof event.respondWith === 'function'
  );
}

function isPushEvent(event: Event): event is SwPushEvent {
  return 'data' in event && 'waitUntil' in event && typeof event.waitUntil === 'function';
}

function isNotificationClickEvent(event: Event): event is SwNotificationClickEvent {
  return (
    'notification' in event &&
    event.notification instanceof Notification &&
    'waitUntil' in event &&
    typeof event.waitUntil === 'function'
  );
}
