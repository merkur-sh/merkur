import { type Component, createMemo, For, Show } from 'solid-js';

import type { BrowserSessionRecord } from '../auth/account-api';
import StatusGlyph from '../components/StatusGlyph';
import { ariaBool } from '../lib/aria';

interface Props {
  readonly activeDelegationIds: readonly string[] | null;
  readonly error: string;
  readonly pending: boolean;
  readonly sessions: readonly BrowserSessionRecord[];
  onRevoke(delegationId: string): Promise<void>;
  onRevokeOthers(): Promise<void>;
}

/**
 * Every browser holding a delegation for this account.
 *
 * Each is named by its family and platform, captured once when the delegation
 * was issued — the browser cannot be asked later, because the record outlives
 * the request that created it. Filled circles mean a connected browser;
 * hollow circles mean inactive. This browser cannot revoke itself here
 * (logging out is what does that).
 */
const SessionSettings: Component<Props> = (props) => {
  const activeSessions = createMemo(() => new Set(props.activeDelegationIds ?? []));
  const visibleSessions = (): readonly BrowserSessionRecord[] =>
    props.sessions.filter((session) => session.revokedAt === null);
  const currentSession = (): BrowserSessionRecord | undefined =>
    visibleSessions().find((session) => session.current);
  const otherSessions = (): readonly BrowserSessionRecord[] =>
    visibleSessions().filter((session) => !session.current);

  return (
    <>
      <Show when={props.error.length > 0}>
        <div class="alert-bad" role="alert">
          {props.error}
        </div>
      </Show>

      <Show
        when={!props.pending || visibleSessions().length > 0}
        fallback={<SessionSettingsSkeleton />}
      >
        <Show
          when={visibleSessions().length > 0}
          fallback={
            <div class="card px-4 py-10 text-center text-[13px] text-meta">
              No browser sessions found.
            </div>
          }
        >
          <Show when={currentSession()}>
            {(session) => (
              <section class="flex flex-col gap-2" aria-labelledby="current-browser-heading">
                <h2 id="current-browser-heading" class="eyebrow">
                  Current browser
                </h2>
                <div class="pref-group">
                  <BrowserSessionRow
                    session={session()}
                    pending={props.pending}
                    active={activeSessions().has(session().delegationId)}
                    confirmed={props.activeDelegationIds !== null}
                  />
                </div>
              </section>
            )}
          </Show>

          <section class="flex flex-col gap-2" aria-labelledby="other-browsers-heading">
            <div class="flex items-center justify-between gap-2">
              <h2 id="other-browsers-heading" class="eyebrow">
                Other browsers
              </h2>
              <button
                type="button"
                aria-label="Revoke all other browsers"
                disabled={props.pending || otherSessions().length === 0}
                onClick={() => void props.onRevokeOthers().catch(() => undefined)}
                class="btn-ghost btn-sm"
              >
                Revoke others
              </button>
            </div>
            <div class="pref-group" aria-busy={ariaBool(props.pending)}>
              <Show
                when={otherSessions().length > 0}
                fallback={<div class="px-4 py-8 text-center text-[13px] text-meta">None</div>}
              >
                <For each={otherSessions()}>
                  {(session) => (
                    <BrowserSessionRow
                      session={session}
                      pending={props.pending}
                      active={activeSessions().has(session.delegationId)}
                      confirmed={props.activeDelegationIds !== null}
                      onRevoke={props.onRevoke}
                    />
                  )}
                </For>
              </Show>
            </div>
          </section>
        </Show>
      </Show>
    </>
  );
};

export default SessionSettings;

/**
 * The shape of the answer, drawn before the answer arrives.
 *
 * The list used to be a single centred line of text that the real content then
 * replaced, so the panel jumped from one height to another the moment the fetch
 * landed. This is the loaded layout with its words removed — the same two
 * headings, the same `pref-group` cards, the same 52px rows — so nothing moves
 * when the sessions arrive; only the bones become text.
 *
 * Two "other" rows because that is the common case, and because guessing high
 * would make the panel shrink instead of jump.
 */
const SessionSettingsSkeleton: Component = () => (
  <>
    <section class="flex flex-col gap-2" role="status" aria-label="Loading browser sessions">
      <span class="eyebrow" aria-hidden="true">
        Current browser
      </span>
      <div class="pref-group">
        <SkeletonRow />
      </div>
    </section>
    <section class="flex flex-col gap-2" aria-hidden="true">
      <div class="flex items-center justify-between gap-2">
        <span class="eyebrow">Other browsers</span>
        {/* The control's footprint, so the heading row is the height it will be. */}
        <span class="h-[26px] w-[96px]" />
      </div>
      <div class="pref-group">
        <SkeletonRow />
        <SkeletonRow dim />
      </div>
    </section>
  </>
);

const SkeletonRow: Component<{ readonly dim?: boolean }> = (props) => (
  <div class="session-row pref-row" style={{ opacity: props.dim === true ? '0.55' : '1' }}>
    <span class="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-white/10 motion-reduce:animate-none" />
    <span class="min-w-0 flex-1">
      <span class="relative block h-[1lh] text-[14px] font-medium">
        <span class="absolute inset-y-[3px] left-0 w-[46%] animate-pulse rounded bg-white/9 motion-reduce:animate-none" />
      </span>
      <span class="relative mt-px block h-[1lh] text-[12px]">
        <span class="absolute inset-y-[2px] left-0 w-[68%] animate-pulse rounded bg-white/5 motion-reduce:animate-none" />
      </span>
    </span>
  </div>
);

const BrowserSessionRow: Component<{
  readonly session: BrowserSessionRecord;
  readonly pending: boolean;
  readonly confirmed: boolean;
  readonly active: boolean;
  onRevoke?(delegationId: string): Promise<void>;
}> = (props) => (
  <div data-session-row={props.session.delegationId} class="session-row pref-row">
    <StatusGlyph
      status={props.active ? 'online' : 'offline'}
      confirmed={props.confirmed}
      label={props.confirmed ? (props.active ? 'Active' : 'Inactive') : 'Activity unconfirmed'}
    />
    <span class="min-w-0 flex-1">
      <span class="pref-name truncate">{describeClient(props.session)}</span>
      <span class="pref-sub truncate font-mono text-[11.5px]">
        {props.confirmed ? (props.active ? 'Active' : 'Inactive') : 'Activity unconfirmed'}
        {' · '}
        {describeOrigin(props.session)}
      </span>
    </span>
    <Show when={props.onRevoke !== undefined}>
      <button
        type="button"
        aria-label={`Revoke ${describeClient(props.session)}`}
        disabled={props.pending}
        onClick={() => void props.onRevoke?.(props.session.delegationId).catch(() => undefined)}
        class="btn-quiet btn-sm text-badink hover:(bg-badsoft text-badink)"
      >
        Revoke
      </button>
    </Show>
  </div>
);

/**
 * The browser's name, as the server parsed it when the delegation was issued.
 *
 * A delegation whose issuing request carried no recognizable client — a header
 * the parser has never seen, or one stripped by a privacy extension — says so
 * rather than guessing, because a wrong name here is worse than no name: it is
 * what someone reads before deciding whether to revoke.
 */
function describeClient(session: BrowserSessionRecord): string {
  const { browser, platform } = session.client;
  if (browser === null && platform === null) return 'Unrecognized browser';
  if (browser === null) return `Browser on ${platform}`;
  if (platform === null) return browser;
  return `${browser} on ${platform}`;
}

function describeOrigin(session: BrowserSessionRecord): string {
  const installed = session.client.installed ? 'Installed app · ' : '';
  const here = session.current ? 'This browser · ' : '';
  return `${here}${installed}added ${formatTimestamp(session.issuedAt)}`;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}
