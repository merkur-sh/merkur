/**
 * Figure 3: groups of four packets and a parity shard crossing a lossy link.
 * A reader sets the loss, or clicks a packet to lose it.
 */
import type { JSX } from '@solidjs/web';
import { createSignal, For, flush, onSettled } from 'solid-js';

import { arrive, places, settle } from '../../../../../src/blog/kit/motion';
import { onScreen } from '../../../../../src/blog/kit/on-screen';
import { Rows } from '../../../../../src/blog/kit/terminal';
import {
  describe,
  GROUP,
  type Group,
  openLink,
  outcome,
  packetName,
  SHOWN,
  send,
  tally,
  toggle,
} from './parity.model';

/** A group crosses the link this often, in ms. */
const GROUP_EVERY_MS = 1100;

/** How a packet is drawn: there, lost and rebuilt, lost with nothing to rebuild, or lost for good. */
function packetState(group: Group, index: number): string {
  if (group.lost[index] !== true) return index === GROUP - 1 ? 'parity' : 'there';
  const result = outcome(group);

  if (result === 'rebuilt') return 'rebuilt';

  return result === 'parity' ? 'spare' : 'lost';
}

export default function Parity(): JSX.Element {
  // The still is paused. In the page it plays, unless the reader asked for less motion:
  // then they start it themselves.
  const [link, setLink] = createSignal(openLink(false));
  let root: HTMLDivElement | undefined;
  let slider: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;
  let timer = 0;

  /** One more group crosses: it arrives at the top and the others make room. */
  const cross = (): void => {
    const before = list === undefined ? null : places(list);
    setLink((held) => send(held, Math.random));
    flush();

    if (list !== undefined && before !== null) settle(list, before);
  };

  /** A reader loses or restores a packet, and the group says what became of it. */
  const lose = (group: Group, packet: number, fate: Element | null): void => {
    setLink((held) => toggle(held, group.id, packet));

    if (fate !== null) arrive(fate);
  };

  onSettled(() => {
    if (root === undefined) return undefined;

    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLink((held) => ({ ...held, playing: true }));
    }

    const leave = onScreen(root, (on) => {
      window.clearInterval(timer);

      if (!on) return;
      timer = window.setInterval(() => {
        if (link().playing) cross();
      }, GROUP_EVERY_MS);
    });

    // Solid takes what a settled callback returns as its cleanup; `onCleanup` is refused here.
    return () => {
      leave();
      window.clearInterval(timer);
    };
  });

  const shown = (): Group[] => link().groups.slice(0, SHOWN);

  return (
    <>
      <div class="ft" ref={root}>
        <div class="groups" ref={list}>
          {/* Kept by its number, so a group stays itself as newer ones push it down. */}
          <For each={shown()} keyed={(group) => group.id}>
            {(group) => (
              <div class="group" data-outcome={outcome(group())}>
                <span class="group-id">#{group().id}</span>
                <div class="group-packets">
                  <Rows rows={group().lost}>
                    {(lost, index) => (
                      <button
                        type="button"
                        class="packet"
                        data-packet={packetState(group(), index)}
                        aria-pressed={lost() ? 'true' : 'false'}
                        aria-label={`${lost() ? 'Restore' : 'Lose'} ${
                          index === GROUP - 1 ? 'parity shard' : `packet ${index + 1}`
                        } of group ${group().id}`}
                        onClick={(event) =>
                          lose(
                            group(),
                            index,
                            event.currentTarget.closest('.group')?.querySelector('.group-fate') ??
                              null,
                          )
                        }
                      >
                        {packetName(index)}
                      </button>
                    )}
                  </Rows>
                </div>
                <span class="group-fate">{describe(group())}</span>
              </div>
            )}
          </For>
        </div>
        <div class="groups-sum">
          <span>{tally(link()).groups} groups</span>
          <span class="tk-green">{tally(link()).rebuilt} rebuilt</span>
          <span class="tk-yellow">{tally(link()).fallback} left to the next update</span>
          <span class="groups-resends">0 resends</span>
        </div>
      </div>
      <div class="fig-controls">
        <button
          type="button"
          class="fig-button"
          data-steady
          onClick={() => setLink((held) => ({ ...held, playing: !held.playing }))}
        >
          {link().playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          class="fig-button"
          onClick={() => {
            const fresh = openLink(link().playing);

            if (slider !== undefined) slider.value = String(fresh.loss);
            setLink(fresh);
          }}
        >
          Reset
        </button>
        <label class="fig-range">
          Loss
          <input
            ref={slider}
            type="range"
            min="0"
            max="30"
            step="1"
            value="10"
            onInput={(event) => {
              const loss = Number(event.currentTarget.value);
              setLink((held) => ({ ...held, loss }));
            }}
          />
          <span class="fig-range-value">{link().loss}%</span>
        </label>
      </div>
    </>
  );
}
