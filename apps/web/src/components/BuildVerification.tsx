import { verifyBuildIdentity } from '@merkur/shared/build-identity';
import { Effect, Fiber } from 'effect';
import {
  type Component,
  createSignal,
  For,
  Match,
  onCleanup,
  onSettled,
  Show,
  Switch,
} from 'solid-js';
import { ariaBool } from '../lib/aria';
import { loadE2eWasmModule } from '../lib/e2e-wasm-module';

const PUBLIC_KEY = process.env.MERKUR_RELEASE_MLDSA87_PUBLIC_KEY ?? '';
const BUILD_ID = process.env.MERKUR_BUILD_ID ?? '';

/**
 * What the card can say about the bytes this tab is running. One value, so the
 * row's verdict chip, its sentence and whether the ID row exists can never
 * disagree with each other.
 */
type Verdict =
  | { readonly kind: 'development' }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'verified'; readonly id: string; readonly commit: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unverified' };

const SENTENCE: Record<Verdict['kind'], string> = {
  development: 'Local build. There is no release signature to check.',
  verifying: 'Checking the release signatures…',
  verified: 'Server and client are signed by the release key.',
  stale: 'This tab loaded an older build than the server is serving.',
  unverified: 'The release signatures could not be verified.',
};

/**
 * What this tab is running, stated the way a specification sheet states it.
 *
 * The verdict row says whether the bytes are signed; the client row identifies
 * the loaded browser build.
 */
const BuildVerification: Component = () => {
  const [verdict, setVerdict] = createSignal<Verdict>(
    PUBLIC_KEY === '' ? { kind: 'development' } : { kind: 'verifying' },
  );
  const [copied, setCopied] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  const [copying, setCopying] = createSignal(false);
  let stopCopy = (): void => {};
  onCleanup(() => stopCopy());

  onSettled(() => {
    if (PUBLIC_KEY === '') return;
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: async (signal) => {
          const [response] = await Promise.all([
            fetch('/api/build-identity', { cache: 'no-store', signal }),
            loadE2eWasmModule(),
          ]);
          if (!response.ok) throw new Error('build identity unavailable');
          const value: unknown = await response.json();
          return verifyBuildIdentity(value, PUBLIC_KEY, BUILD_ID);
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.tap((value) =>
          Effect.sync(() =>
            setVerdict({ kind: 'verified', id: value.verificationId, commit: value.commit }),
          ),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            setVerdict({
              kind:
                error.message === 'signed build does not match the loaded application'
                  ? 'stale'
                  : 'unverified',
            }),
          ),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  });

  const verified = (): Extract<Verdict, { kind: 'verified' }> | null => {
    const current = verdict();
    return current.kind === 'verified' ? current : null;
  };

  function copy(): void {
    const current = verified();
    if (current === null || copying()) return;
    setCopying(true);
    setCopyFailed(false);
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(current.id),
        catch: () => new Error('clipboard unavailable'),
      }).pipe(
        Effect.tap(() => Effect.sync(() => setCopied(true))),
        Effect.catch(() => Effect.sync(() => setCopyFailed(true))),
        Effect.ensuring(Effect.sync(() => setCopying(false))),
      ),
    );
    stopCopy = () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }

  /**
   * The copied check stays until the pointer or focus leaves the button, which
   * is when the reader has stopped looking at it — a fact about them, rather
   * than a timer's guess about how long a confirmation takes to read.
   */
  function settleCopy(): void {
    setCopied(false);
    setCopyFailed(false);
  }

  return (
    <section
      class="pref-group shrink-0"
      aria-label="Build verification"
      aria-busy={ariaBool(verdict().kind === 'verifying')}
    >
      <div class="pref-row">
        <span class="min-w-0 flex-1">
          <span class="pref-name">Build</span>
          <span class="pref-sub" role="status">
            {SENTENCE[verdict().kind]}
          </span>
        </span>
        <Switch>
          <Match when={verdict().kind === 'verifying'}>
            <span class="chip" aria-hidden="true">
              <span class="spinner h-[11px] w-[11px]" />
              Verifying
            </span>
          </Match>
          <Match when={verdict().kind === 'verified'}>
            <span class="chip-ok">
              <svg
                aria-hidden="true"
                viewBox="0 0 12 12"
                class="h-[10px] w-[10px]"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m2.5 6.5 2.3 2.3L9.5 3.5" />
              </svg>
              Verified
            </span>
          </Match>
          <Match when={verdict().kind === 'stale'}>
            <button type="button" class="btn-ghost btn-sm" onClick={() => location.reload()}>
              Reload
            </button>
          </Match>
          <Match when={verdict().kind === 'unverified'}>
            <span class="chip-bad">Unverified</span>
          </Match>
          <Match when={verdict().kind === 'development'}>
            <span class="chip">Development</span>
          </Match>
        </Switch>
      </div>

      <Show when={verdict().kind === 'verifying'}>
        <BuildVerificationSkeleton />
      </Show>

      <Show when={verified()}>
        {(value) => (
          <div class="pref-row">
            <span class="min-w-0 flex-1">
              <span class="eyebrow">Verification ID</span>
              <code
                class="mt-[3px] block break-all font-mono text-[12.5px] tracking-[0.01em] text-ink frame:text-[14px]"
                data-build-verification-id
              >
                <For each={value().id.split('-')}>
                  {(group, index) => (
                    <>
                      <Show when={index() > 0}>
                        <span class="text-faint">-</span>
                      </Show>
                      {group}
                    </>
                  )}
                </For>
              </code>
              <span class="pref-sub font-mono text-[11px] frame:text-[12px]">
                commit {value().commit.slice(0, 10)}
              </span>
            </span>
            <button
              type="button"
              class={['btn-icon', { 'text-okink hover:text-okink': copied() }]}
              onClick={copy}
              onMouseLeave={settleCopy}
              onBlur={settleCopy}
              disabled={copying()}
              aria-label="Copy build verification ID"
              title={copied() ? 'Copied' : copyFailed() ? 'Copy failed' : 'Copy verification ID'}
            >
              <Show
                when={copied()}
                fallback={
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    class="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <rect x="8" y="8" width="12" height="12" rx="2" />
                    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                  </svg>
                }
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  class="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m3 8 3 3 7-7" />
                </svg>
              </Show>
            </button>
            <span class="sr-only" role="status">
              {copyFailed()
                ? 'Could not copy build verification ID'
                : copied()
                  ? 'Build verification ID copied'
                  : ''}
            </span>
          </div>
        )}
      </Show>

      <dl class="contents">
        <div class="spec-row">
          <dt class="spec-key">Client</dt>
          <dd class="spec-val m-0">{BUILD_ID === '' ? 'local build' : BUILD_ID}</dd>
        </div>
      </dl>
    </section>
  );
};

export default BuildVerification;

/** The ID row's footprint, held while the proofs are in flight so nothing below it moves. */
const BuildVerificationSkeleton: Component = () => (
  <div class="pref-row" aria-hidden="true">
    <span class="min-w-0 flex-1">
      <span class="relative block h-[1lh] text-[10px] frame:text-[12px]">
        <span class="absolute inset-y-[3px] left-0 w-[92px] animate-pulse rounded bg-white/5 motion-reduce:animate-none" />
      </span>
      <span class="relative mt-[3px] block h-[1lh] text-[12.5px] frame:text-[14px]">
        <span class="absolute inset-y-[3px] left-0 w-[78%] animate-pulse rounded bg-white/9 motion-reduce:animate-none" />
      </span>
      <span class="relative mt-px block h-[1lh] text-[11px] frame:text-[12px]">
        <span class="absolute inset-y-[3px] left-0 w-[112px] animate-pulse rounded bg-white/5 motion-reduce:animate-none" />
      </span>
    </span>
    <span class="h-8 w-8 shrink-0 animate-pulse rounded-sm bg-white/5 motion-reduce:animate-none" />
  </div>
);
