import { type Component, Match, Show, Switch } from 'solid-js';

/**
 * The status sprite: one 14px glyph per machine state, drawn in `currentColor`
 * and coloured by its `st--*` class.
 *
 * Every state is the same 14px box, which is the whole point. A dot that
 * becomes a spinner that becomes a cross is three different widths, and it
 * reflows the name beside it in a column whose only job is that nothing shifts
 * while a list of machines changes state under the reader.
 *
 * Shape carries the state as well as hue, so the column still reads without
 * colour: filled for up, half-filled for degraded, hollow for down, ringed for
 * the one this browser is talking to, dashed while something is in flight, and
 * a cross when it failed.
 */
export type MachineStatus = 'connected' | 'online' | 'degraded' | 'offline' | 'working' | 'failed';

const TONE: Record<MachineStatus, string> = {
  connected: 'st--conn',
  online: 'st--ok',
  degraded: 'st--warn',
  offline: 'st--off',
  working: 'st--busy',
  failed: 'st--bad',
};

interface Props {
  readonly status: MachineStatus;
  /**
   * Whether anything is currently confirming this status.
   *
   * A filled glyph is an assertion about right now, and a list restored from
   * cache or one whose stream died in a way `fetch` never reported renders
   * exactly the same rows as a live one. Unconfirmed keeps the hue the list
   * last heard and drops to the hollow shape: the same fact, stated as the last
   * thing known rather than as the current one.
   *
   * `working` and `failed` are facts about this browser's own action, so they
   * are never unconfirmed.
   */
  readonly confirmed?: boolean;
  /**
   * The state in words. The glyph is the only place a row states its presence —
   * the subtitle names the platform — so without this a screen reader hears a
   * machine's name and its architecture and nothing about whether it can be
   * reached. Read out before the name, because that is where the glyph sits.
   */
  readonly label: string;
}

const HOLLOW: readonly MachineStatus[] = ['online', 'degraded'];

const StatusGlyph: Component<Props> = (props) => {
  const hollow = (): boolean => props.confirmed === false && HOLLOW.includes(props.status);

  return (
    <>
      <svg class={`st ${TONE[props.status]}`} viewBox="0 0 14 14" aria-hidden="true">
        <Show
          when={!hollow()}
          fallback={
            <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4" />
          }
        >
          <Switch>
            <Match when={props.status === 'connected'}>
              <circle cx="7" cy="7" r="5.1" fill="none" stroke="currentColor" stroke-width="1.4" />
              <circle cx="7" cy="7" r="2.4" fill="currentColor" />
            </Match>
            <Match when={props.status === 'online'}>
              <circle cx="7" cy="7" r="4.2" fill="currentColor" />
            </Match>
            <Match when={props.status === 'degraded'}>
              <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4" />
              <path d="M7 2.7a4.3 4.3 0 0 0 0 8.6z" fill="currentColor" />
            </Match>
            <Match when={props.status === 'offline'}>
              <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4" />
            </Match>
            <Match when={props.status === 'working'}>
              <circle
                cx="7"
                cy="7"
                r="4.3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-dasharray="1.1 2.5"
              />
            </Match>
            <Match when={props.status === 'failed'}>
              <path
                d="M3.7 3.7 10.3 10.3M10.3 3.7 3.7 10.3"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
            </Match>
          </Switch>
        </Show>
      </svg>
      <span class="sr-only">{props.label}</span>
    </>
  );
};

export default StatusGlyph;
