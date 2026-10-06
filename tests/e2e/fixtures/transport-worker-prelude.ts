import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

/** The production transport worker bundle: every WebTransport dial happens there. */
export const TRANSPORT_WORKER_URL = /\/transport-worker[^/]*\.js(?:\?.*)?$/;

/**
 * One test-only destination rewrite: a dial to loopback port `from` goes to
 * `[::1]:to` instead. Native options, TLS certificate pins, QUIC and Merkur
 * encryption are untouched, and there is no per-input, datagram or render
 * observer on this path.
 */
export interface TransportWorkerRedirect {
  readonly from: number;
  readonly to: number;
  /** Logged with the original and routed URL on every redirected dial. */
  readonly marker: string;
  /** Names the redirect in port-validation errors, e.g. `direct proxy`. */
  readonly label: string;
  /** Names what a dial to `from` must be, e.g. `direct backend`. */
  readonly candidate: string;
}

export interface TransportWorkerSource {
  readonly url: string;
  readonly productionSha256: string;
  readonly patchedSha256: string;
}

/** The prelude that installs `redirects` before the worker handles any session. */
export function transportWorkerPrelude(redirects: readonly TransportWorkerRedirect[]): string {
  const froms = new Set<number>();
  for (const redirect of redirects) {
    for (const port of [redirect.from, redirect.to]) {
      if (!Number.isInteger(port) || port < 1024 || port > 65_535)
        throw new Error(`invalid ${redirect.label} port`);
    }
    if (redirect.from === redirect.to) throw new Error(`${redirect.label} cannot target itself`);
    if (froms.has(redirect.from)) throw new Error(`two redirects from port ${redirect.from}`);
    froms.add(redirect.from);
  }
  const table = JSON.stringify(
    redirects.map(({ from, to, marker, candidate }) => ({ from, to, marker, candidate })),
  );
  return `{
    const NativeWebTransport = globalThis.WebTransport;
    if (typeof NativeWebTransport !== 'function') throw new Error('native WebTransport unavailable');
    const redirects = ${table};
    globalThis.WebTransport = new Proxy(NativeWebTransport, {
      construct(target, args, newTarget) {
        const original = new URL(args[0]);
        const redirect = redirects.find((entry) => Number(original.port) === entry.from);
        if (redirect !== undefined) {
          if (original.protocol !== 'https:' || !['127.0.0.1', '[::1]'].includes(original.hostname)) {
            throw new Error('unexpected ' + redirect.candidate + ' candidate');
          }
          const routed = new URL(original);
          routed.hostname = '[::1]';
          routed.port = String(redirect.to);
          args[0] = routed.href;
          console.info(redirect.marker, original.href, routed.href);
        }
        return Reflect.construct(target, args, newTarget);
      }
    });
  }\n`;
}

interface ContextRedirects {
  readonly redirects: TransportWorkerRedirect[];
  readonly instruments: string[];
  readonly sources: TransportWorkerSource[];
  readonly handler: (route: Route) => Promise<void>;
}

const contexts = new WeakMap<BrowserContext, ContextRedirects>();

export interface TransportWorkerRedirectHandle {
  /** Every transport worker load this context patched, in load order. */
  readonly sourceHashes: readonly TransportWorkerSource[];
  remove(): Promise<void>;
}

/**
 * Add `redirect` to `context`'s transport worker. One route serves every
 * redirect a context holds, so an edge proxy and a direct proxy compose in
 * one prelude instead of one route shadowing the other.
 */
export async function redirectTransportWorker(
  context: BrowserContext,
  redirect: TransportWorkerRedirect,
): Promise<TransportWorkerRedirectHandle> {
  const owner = await workerContext(context);
  // Validates the whole set, this redirect included, before any load uses it.
  transportWorkerPrelude([...owner.redirects, redirect]);
  owner.redirects.push(redirect);
  return {
    sourceHashes: owner.sources,
    async remove() {
      const index = owner.redirects.indexOf(redirect);
      if (index >= 0) owner.redirects.splice(index, 1);
      await removeUnusedContext(context, owner);
    },
  };
}

/** Compose observers with destination redirects instead of shadowing their response route. */
export async function instrumentTransportWorker(
  context: BrowserContext,
  prelude: string,
): Promise<() => Promise<void>> {
  const owner = await workerContext(context);
  owner.instruments.push(prelude);
  return async () => {
    const index = owner.instruments.indexOf(prelude);
    if (index >= 0) owner.instruments.splice(index, 1);
    await removeUnusedContext(context, owner);
  };
}

async function removeUnusedContext(
  context: BrowserContext,
  owner: ContextRedirects,
): Promise<void> {
  if (
    owner.redirects.length === 0 &&
    owner.instruments.length === 0 &&
    contexts.get(context) === owner
  ) {
    contexts.delete(context);
    await context.unroute(TRANSPORT_WORKER_URL, owner.handler);
  }
}

async function workerContext(context: BrowserContext): Promise<ContextRedirects> {
  let entry = contexts.get(context);
  if (entry === undefined) {
    const redirects: TransportWorkerRedirect[] = [];
    const instruments: string[] = [];
    const sources: TransportWorkerSource[] = [];
    const handler = async (route: Route): Promise<void> => {
      // Worker-scoped contexts survive idle carrier partitions. The fixture's
      // HTTP fetch must not reuse a socket the server is retiring while idle.
      const response = await route.fetch({
        headers: { ...(await route.request().allHeaders()), connection: 'close' },
      });
      if (!response.ok()) throw new Error('could not load the production transport worker');
      const production = await response.text();
      const patched = `${transportWorkerPrelude(redirects)}${instruments.join('\n')}\n${production}`;
      // Worker-scoped contexts serve multiple tests, each with a legitimate
      // new worker. Retain every load; the owning workload checks reloads.
      sources.push({
        url: route.request().url(),
        productionSha256: sha256(production),
        patchedSha256: sha256(patched),
      });
      await route.fulfill({ response, body: patched });
    };
    entry = { redirects, instruments, sources, handler };
    contexts.set(context, entry);
    await context.route(TRANSPORT_WORKER_URL, handler);
  }
  return entry;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
