/**
 * The security section: three panes, one at a time, each acting out its
 * claim. A tab shows its pane; while the section is on screen each pane hands
 * over to the next when the bar over its tab has filled. The bar is the
 * clock, so leaving the section pauses the bar and the pane's scene with it.
 * Everything that moves here is a Motion animation of a transform or an
 * opacity, handed to the browser whole (`animateMini`); only a verdict's
 * spring is driven from script, for the third of a second it lasts.
 */
import { animate, animateMini } from 'motion';

import { type Agenda, createAgenda, EASE_GLIDE, EASE_OUT, onScreen, reducedMotion } from './clock';

type Playing = ReturnType<typeof animate>;

/** How long each pane holds before the next takes over, in ms. */
const PANE_HOLD_MS = [5_500, 4_200, 6_000] as const;
const POP = { type: 'spring', visualDuration: 0.32, bounce: 0.35 } as const;

const HEX = '0123456789abcdef';
const hex = (): string =>
  Array.from({ length: 4 }, () => HEX[Math.floor(Math.random() * HEX.length)]).join('');

const need = <T extends Element>(root: Element, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`site: the security section has no ${selector}`);
  return found;
};

/** A label that travels a track: a packet, a proof, a ticket. */
function pill(
  track: HTMLElement,
  text: string,
  kind: 'sealed' | 'refused' | 'ticket',
): HTMLElement {
  const element = document.createElement('span');
  element.className = 'pill';
  element.dataset.kind = kind;
  element.textContent = text;
  track.append(element);
  return element;
}

/** Moves `element` along its track's long axis from `from` to `to`, as shares of the track. */
function travel(
  element: HTMLElement,
  track: HTMLElement,
  from: number,
  to: number,
  options: { ms: number; vertical?: boolean; fade?: boolean },
): void {
  const length = options.vertical === true ? track.clientHeight : track.clientWidth;
  const at = (share: number): string =>
    options.vertical === true
      ? `translate(-50%, calc(${(share * length).toFixed(1)}px - 50%))`
      : `translate(calc(${(share * length).toFixed(1)}px - 50%), -50%)`;
  const duration = options.ms / 1000;
  if (options.fade !== false) {
    animateMini(
      element,
      { opacity: [0, 1, 1, 0] },
      { duration, times: [0, 0.1, 0.9, 1], ease: 'linear' },
    );
  }
  animateMini(element, { transform: [at(from), at(to)] }, { duration, ease: EASE_GLIDE });
}

const fade = (element: HTMLElement, ms: number): Playing =>
  animateMini(element, { opacity: [1, 0] }, { duration: ms / 1000, ease: 'linear' });

/** A verdict lands: it springs up to full size, then the stylesheet has it again. */
function pop(element: HTMLElement): void {
  void animate(element, { opacity: [0.3, 1], scale: [0.9, 1] }, POP).finished.then(() => {
    element.style.opacity = '';
    element.style.transform = '';
  });
}

interface Scene {
  /** Puts the pane back to its first frame and plays it on `agenda`. */
  begin(agenda: Agenda): void;
}

/** A command typed in the browser arrives on the machine a key at a time, sealed in between. */
function tunnelScene(pane: HTMLElement): Scene {
  const track = need<HTMLElement>(pane, '[data-t-track]');
  const typed = need<HTMLElement>(pane, '[data-t-in]');
  const arrived = need<HTMLElement>(pane, '[data-t-out]');
  const seen = need<HTMLElement>(pane, '[data-t-seen]');
  const command = typed.textContent ?? '';
  return {
    begin(agenda) {
      const vertical = matchMedia('(max-width: 719px)').matches;
      const flight = vertical ? 1100 : 1300;
      const recent: string[] = [];
      typed.textContent = '';
      arrived.textContent = '';
      seen.textContent = '';
      for (const element of track.querySelectorAll('.pill')) element.remove();
      [...command].forEach((character, index) => {
        agenda.at(140 * (index + 1), () => {
          typed.textContent += character;
          const sealed = hex();
          const packet = pill(track, sealed, 'sealed');
          travel(packet, track, 0, 1, { ms: flight, vertical });
          agenda.at(60, () => {
            recent.push(sealed);
            seen.textContent = recent.slice(vertical ? -3 : -5).join(' ');
          });
          agenda.at(flight, () => {
            packet.remove();
            arrived.textContent += character;
          });
        });
      });
    },
  };
}

/** The machine's chip signs and is verified; a copy of its disk has no chip and is refused. */
function hardwareScene(pane: HTMLElement): Scene {
  const tracks = [0, 1].map((lane) => need<HTMLElement>(pane, `[data-hw-track="${lane}"]`));
  const results = [0, 1].map((lane) => need<HTMLElement>(pane, `[data-hw-res="${lane}"]`));
  const [chipTrack, diskTrack] = tracks;
  const [verified, refused] = results;
  if (!chipTrack || !diskTrack || !verified || !refused) throw new Error('site: no hardware lanes');
  return {
    begin(agenda) {
      for (const track of tracks)
        for (const element of track.querySelectorAll('.pill')) element.remove();
      for (const result of results) result.toggleAttribute('data-waiting', true);
      agenda.at(200, () => {
        const proof = pill(chipTrack, 'ML-DSA-87 + P-256', 'sealed');
        travel(proof, chipTrack, 0, 1, { ms: 1100, fade: false });
        agenda.at(1020, () => {
          fade(proof, 180);
          verified.toggleAttribute('data-waiting', false);
          pop(verified);
        });
        agenda.at(1300, () => proof.remove());
      });
      agenda.at(1600, () => {
        const copy = pill(diskTrack, 'seed file only', 'refused');
        travel(copy, diskTrack, 0, 0.5, { ms: 800, fade: false });
        agenda.at(800, () => {
          // Turned away: it shakes where it stopped.
          animateMini(
            copy,
            { translate: ['0px 0px', '-7px 0px', '7px 0px', '-4px 0px', '0px 0px'] },
            { duration: 0.32, ease: 'easeOut' },
          );
        });
        agenda.at(1180, () => {
          fade(copy, 220);
          refused.toggleAttribute('data-waiting', false);
          pop(refused);
        });
        agenda.at(1500, () => copy.remove());
      });
    },
  };
}

/** The server checks the sign-in, hands over a ticket, steps aside and sees nothing after. */
function serverScene(pane: HTMLElement): Scene {
  const server = need<HTMLElement>(pane, '[data-b-srv]');
  const link = need<HTMLElement>(pane, '[data-b-link]');
  const says = need<HTMLElement>(pane, '[data-b-say]');
  const track = need<HTMLElement>(pane, '[data-b-track]');
  const first = says.textContent ?? '';
  const say = (text: string, faint = false): void => {
    says.toggleAttribute('data-faint', faint);
    if (says.textContent === text) return;
    says.textContent = text;
    animateMini(
      says,
      { opacity: [0, 1], transform: ['translateY(4px)', 'translateY(0px)'] },
      { duration: 0.4, ease: EASE_OUT },
    );
  };
  let dimmed: Playing[] = [];
  const dim = (element: HTMLElement, opacity: number, ms: number): void => {
    dimmed.push(
      animateMini(element, { opacity: [1, opacity] }, { duration: ms / 1000, ease: EASE_OUT }),
    );
  };
  return {
    begin(agenda) {
      for (const element of pane.querySelectorAll('.pill')) element.remove();
      for (const playing of dimmed) playing.stop();
      dimmed = [];
      for (const element of [server, link]) element.style.opacity = '';
      say(first);
      agenda.at(900, () => {
        say('issues a short-lived ticket');
        const ticket = pill(link, 'ticket', 'ticket');
        travel(ticket, link, 0, 1, { ms: 550, vertical: true, fade: false });
        agenda.at(550, () => {
          ticket.remove();
          for (const to of [0.04, 0.96]) {
            const copy = pill(track, 'ticket', 'ticket');
            travel(copy, track, 0.5, to, { ms: 600, fade: false });
            animateMini(
              copy,
              { opacity: [1, 1, 0] },
              { duration: 0.68, times: [0, 0.5, 1], ease: 'linear' },
            );
            agenda.at(720, () => copy.remove());
          }
        });
      });
      agenda.at(2200, () => {
        say('steps aside');
        dim(server, 0.32, 550);
        dim(link, 0.1, 550);
      });
      agenda.at(2950, () => {
        say('sees none of your session', true);
        for (let sent = 0; sent < 4; sent += 1) {
          agenda.at(420 * sent, () => {
            const packet = pill(track, hex(), 'sealed');
            const outward = sent % 2 === 0;
            travel(packet, track, outward ? 0 : 1, outward ? 1 : 0, { ms: 1200 });
            agenda.at(1250, () => packet.remove());
          });
        }
      });
    },
  };
}

export function playSecurity(root: HTMLElement): void {
  const tabs = [...root.querySelectorAll<HTMLElement>('[data-sec-tab]')];
  const panes = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  if (tabs.length !== PANE_HOLD_MS.length || panes.length !== tabs.length) {
    throw new Error('site: the security section needs three tabs and a pane for each');
  }
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => show(index));
  }
  if (reducedMotion.matches) return;

  const bars = tabs.map((tab) => need<HTMLElement>(tab, '[data-sec-bar]'));
  const scenes = panes.map((pane, index) =>
    index === 0 ? tunnelScene(pane) : index === 1 ? hardwareScene(pane) : serverScene(pane),
  );
  const agenda = createAgenda();
  let current = -1;
  let visible = false;
  let clock: Playing | null = null;

  function show(index: number): void {
    root.dataset.sec = String(index);
    for (const [at, tab] of tabs.entries()) {
      tab.setAttribute('aria-selected', at === index ? 'true' : 'false');
    }
    if (reducedMotion.matches) return;
    clock?.stop();
    for (const filled of bars) filled.style.transform = '';
    agenda.clear();
    const pane = panes[index];
    const bar = bars[index];
    if (pane === undefined || bar === undefined) return;
    if (index !== current) {
      animateMini(
        pane,
        { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] },
        { duration: 0.6, ease: EASE_OUT },
      );
    }
    current = index;
    scenes[index]?.begin(agenda);
    const filling = animateMini(
      bar,
      { transform: ['scaleX(0)', 'scaleX(1)'] },
      { duration: (PANE_HOLD_MS[index] ?? PANE_HOLD_MS[0]) / 1000, ease: 'linear' },
    );
    clock = filling;
    if (!visible) filling.pause();
    void filling.finished.then(() => {
      // Stopped by a tab or by a later pane: that one's clock decides now.
      if (clock === filling && index < tabs.length - 1) show(index + 1);
    });
  }

  onScreen(
    root,
    (on) => {
      visible = on;
      if (on) agenda.resume();
      else agenda.pause();
      if (clock === null) {
        if (on) show(0);
      } else if (on) clock.play();
      else clock.pause();
    },
    0.2,
  );
}
