/**
 * "Feels local": a terminal that types and prints while a fader sets the
 * link it runs over.
 *
 * What it shows is what the app does, at the speed the app does it. A key
 * appears the moment it is pressed, as the app's prediction draws it, and
 * stays underlined in the link's colour until the frame that answers it is on
 * the glass. How long that takes is not written here: it is drawn from the
 * delays measured on a release for the link the fader names (`latency.ts`),
 * so a key on a lossy link sometimes waits as long as the app's slow ones do,
 * and no longer. Enter is not predicted, so the line stays as typed until the
 * machine's frame breaks it, and what a command writes lands in one frame per
 * write; both were measured on the same links, and they are slower than a
 * key's echo. The typing rhythm and each command's own thinking time are the
 * page's; the commands and their output are its markup (`sim-script.ts`).
 */
import { animate } from 'motion';

import { KEY_LATENCY, LINE_BREAK_LATENCY, OUTPUT_LATENCY } from '../content/latency-model';
import { createLatency } from '../latency';
import { type Agenda, createAgenda, onScreen, reducedMotion } from './clock';

const KEY_DELAY = createLatency(KEY_LATENCY);
const LINE_BREAK_DELAY = createLatency(LINE_BREAK_LATENCY);
const OUTPUT_DELAY = createLatency(OUTPUT_LATENCY);

/**
 * The fader's stops: position, name, round trip in ms, loss in %, and the
 * link's colour. Every one lies inside what was measured, and the last is the
 * measurement's own slowest, lossiest cell.
 */
const STOPS = [
  { at: 0, name: 'Fibre', rtt: 15, loss: 0, colour: [166, 227, 161] },
  { at: 0.2, name: 'Home Wi-Fi', rtt: 40, loss: 0.2, colour: [148, 226, 213] },
  { at: 0.4, name: 'Café', rtt: 80, loss: 1, colour: [249, 226, 175] },
  { at: 0.6, name: 'Hotel Wi-Fi', rtt: 120, loss: 3, colour: [250, 179, 135] },
  { at: 0.8, name: 'Train', rtt: 160, loss: 5, colour: [235, 160, 172] },
  { at: 1, name: 'Underground', rtt: 200, loss: 9, colour: [243, 139, 168] },
] as const;
const STEP = 1 / (STOPS.length - 1);

interface Link {
  readonly rtt: number;
  readonly loss: number;
  readonly colour: string;
  /** The nearest stop. */
  readonly stop: number;
}

const mix = (from: number, to: number, share: number): number => from + (to - from) * share;

/** The link at fader position `p`, between its two neighbouring stops. */
export function linkAt(p: number): Link {
  const below = Math.min(STOPS.length - 2, Math.floor(p / STEP));
  const from = STOPS[below];
  const to = STOPS[below + 1];
  if (from === undefined || to === undefined) throw new Error('site: no fader stop');
  const share = (p - from.at) / STEP;
  return {
    rtt: Math.round(mix(from.rtt, to.rtt, share)),
    loss: mix(from.loss, to.loss, share),
    colour: from.colour
      .map((channel, at) => Math.round(mix(channel, to.colour[at] ?? 0, share)))
      .join(' '),
    stop: Math.round(p / STEP),
  };
}

interface Job {
  readonly command: string;
  readonly clear: boolean;
  /** What the command writes, each after `after` ms of its own work. */
  readonly writes: readonly {
    readonly after: number;
    readonly replace: boolean;
    readonly rows: readonly Node[];
  }[];
}

function readJobs(template: HTMLTemplateElement): { greeting: Node | null; jobs: Job[] } {
  const jobs = [...template.content.querySelectorAll<HTMLElement>('[data-cmd]')].map(
    (job): Job => ({
      command: job.dataset.cmd ?? '',
      clear: job.hasAttribute('data-clear'),
      writes: [...job.children].map((entry) => ({
        after: Number((entry as HTMLElement).dataset.after ?? 0),
        replace: entry.hasAttribute('data-replace'),
        rows: [...entry.children],
      })),
    }),
  );
  return { greeting: template.content.querySelector('[data-greeting]'), jobs };
}

const need = <T extends Element>(root: Element, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`site: the simulator has no ${selector}`);
  return found;
};

export function playSimulator(root: HTMLElement): void {
  const narrow = matchMedia('(max-width: 719px)').matches;
  const { greeting, jobs } = readJobs(
    need<HTMLTemplateElement>(root, `template[data-sp-script="${narrow ? 'narrow' : 'wide'}"]`),
  );
  const terminal = need<HTMLElement>(root, '[data-sp-term]');
  const history = need<HTMLElement>(root, '[data-sp-hist]');
  const typed = need<HTMLElement>(root, '[data-sp-type]');
  const prompt = typed.parentElement;
  const tube = need<HTMLElement>(root, '[data-sp-tube]');
  const track = need<HTMLElement>(root, '[data-sp-track]');
  const name = need<HTMLElement>(root, '[data-sp-name]');
  const rtt = need<HTMLElement>(root, '[data-sp-rtt]');
  const loss = need<HTMLElement>(root, '[data-sp-loss]');
  const stops = [...root.querySelectorAll<HTMLButtonElement>('[data-sp-stop]')];
  if (prompt === null) throw new Error('site: the simulator has no prompt');

  let p = 0;
  let link = linkAt(p);
  let shownStop = -1;
  const paint = (): void => {
    link = linkAt(p);
    root.style.setProperty('--p', p.toFixed(4));
    root.style.setProperty('--lv', link.colour);
    rtt.textContent = String(link.rtt);
    loss.textContent = `${link.loss.toFixed(1)}%`;
    const stop = STOPS[link.stop];
    if (stop === undefined) return;
    if (link.stop !== shownStop) {
      shownStop = link.stop;
      name.textContent = stop.name;
      for (const button of stops) {
        button.classList.toggle(
          'stop-on',
          Math.round(Number(button.dataset.spStop) / STEP) === link.stop,
        );
      }
    }
    tube.setAttribute('aria-valuenow', String(link.rtt));
    tube.setAttribute(
      'aria-valuetext',
      `${stop.name}, ${link.rtt} ms round trip, ${link.loss.toFixed(1)}% loss`,
    );
  };
  const set = (value: number): void => {
    p = Math.max(0, Math.min(1, value));
    paint();
  };

  let glide: ReturnType<typeof animate> | null = null;
  const stopGlide = (): void => glide?.stop();
  /** Moves the fader to `to` on a spring about `ms` long; the only frames this module asks for. */
  const go = (to: number, ms: number): void => {
    stopGlide();
    glide = animate(p, to, {
      type: 'spring',
      visualDuration: ms / 1000,
      bounce: 0.18,
      onUpdate: set,
    });
  };

  const fromPointer = (y: number): void => {
    const box = track.getBoundingClientRect();
    set((box.bottom - y) / (box.height || 1));
  };
  let dragging = false;
  tube.addEventListener('pointerdown', (event) => {
    dragging = true;
    stopGlide();
    tube.setPointerCapture(event.pointerId);
    root.toggleAttribute('data-dragging', true);
    fromPointer(event.clientY);
  });
  tube.addEventListener('pointermove', (event) => {
    if (dragging) fromPointer(event.clientY);
  });
  const release = (): void => {
    dragging = false;
    root.toggleAttribute('data-dragging', false);
  };
  tube.addEventListener('pointerup', release);
  tube.addEventListener('pointercancel', release);
  const KEYS: Readonly<Record<string, number>> = {
    ArrowUp: 0.04,
    ArrowRight: 0.04,
    ArrowDown: -0.04,
    ArrowLeft: -0.04,
    PageUp: STEP,
    PageDown: -STEP,
    Home: -1,
    End: 1,
  };
  tube.addEventListener('keydown', (event) => {
    const by = KEYS[event.key];
    if (by === undefined) return;
    event.preventDefault();
    if (Math.abs(by) >= STEP) {
      go(Math.max(0, Math.min(1, Math.round((p + by) / STEP) * STEP)), 600);
    } else {
      stopGlide();
      set(p + by);
    }
  });
  for (const button of stops) {
    button.addEventListener('click', () => go(Number(button.dataset.spStop), 900));
  }

  /** How many lines the screen holds, from its own box and line height. */
  const rows = (): number => {
    const body = history.parentElement;
    if (body === null) return 4;
    const style = getComputedStyle(body);
    const inner =
      body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return Math.max(4, Math.floor(inner / parseFloat(style.lineHeight)));
  };
  let capacity = rows();
  let busy = false;
  const trim = (): void => {
    const room = capacity - (busy ? 0 : 1);
    while (history.childElementCount > room) history.firstElementChild?.remove();
  };
  const setBusy = (on: boolean): void => {
    busy = on;
    terminal.toggleAttribute('data-busy', on);
    trim();
  };
  const print = (node: Node, replace: boolean): void => {
    const copy = node.cloneNode(true);
    if (replace && history.lastElementChild !== null) history.lastElementChild.replaceWith(copy);
    else history.append(copy);
    trim();
  };
  /** One write of a command: its rows show together. */
  const printWrite = (write: Job['writes'][number]): void => {
    for (const [index, row] of write.rows.entries()) print(row, write.replace && index === 0);
  };
  /** The line the prompt and what was typed after it become once Enter is pressed. */
  const commit = (): void => {
    const entered = document.createElement('div');
    for (const node of prompt.childNodes) {
      if (node === typed) break;
      entered.append(node.cloneNode(true));
    }
    entered.append(...typed.childNodes);
    history.append(entered);
  };

  if (greeting !== null) print(greeting, false);
  paint();

  if (reducedMotion.matches) {
    // The fader rests mid-way and the screen shows one finished command.
    set(0.6);
    const job = jobs[2];
    if (job !== undefined) {
      typed.textContent = job.command;
      commit();
      for (const write of job.writes) printWrite(write);
    }
    return;
  }

  const agenda: Agenda = createAgenda();
  let next = 0;
  /** Keys on screen that the machine has not answered yet, in the order typed. */
  const unconfirmed: HTMLElement[] = [];
  /** A frame carries the whole line as the machine has it: it answers `key` and every key before it. */
  const confirm = (key: HTMLElement | undefined): void => {
    const through = key === undefined ? -1 : unconfirmed.indexOf(key);
    for (const confirmed of unconfirmed.splice(0, through + 1)) {
      confirmed.toggleAttribute('data-pending', false);
    }
  };
  const press = (character: string): void => {
    // Drawn at once, as the app's own prediction is; confirmed when its frame lands.
    const key = document.createElement('span');
    key.toggleAttribute('data-pending', true);
    key.textContent = character;
    typed.append(key);
    unconfirmed.push(key);
    agenda.at(KEY_DELAY.sample(link.rtt, link.loss, Math.random), () => confirm(key));
  };
  const enter = (job: Job): void => {
    // What the machine sends back for Enter, in order: the line break, then
    // each write of the command (`clear` writes an empty screen), the last one
    // with the next prompt behind it. Each leaves the machine when it is
    // written and lands when the app would draw it. A later frame holds
    // everything before it, so nothing shows later than what follows it.
    const broke = LINE_BREAK_DELAY.sample(link.rtt, link.loss, Math.random);
    let written = 0;
    const landings = (job.clear ? [0] : job.writes.map((write) => write.after)).map((after) => {
      written += after;
      return written + OUTPUT_DELAY.sample(link.rtt, link.loss, Math.random);
    });
    for (let index = landings.length - 2; index >= 0; index -= 1) {
      landings[index] = Math.min(landings[index] ?? 0, landings[index + 1] ?? 0);
    }
    const last = landings[landings.length - 1] ?? broke;
    agenda.at(Math.min(broke, landings[0] ?? broke), () => {
      confirm(unconfirmed[unconfirmed.length - 1]);
      commit();
      setBusy(true);
    });
    for (const [index, landing] of landings.entries()) {
      agenda.at(landing, () => {
        const write = job.writes[index];
        if (job.clear) history.replaceChildren();
        else if (write !== undefined) printWrite(write);
        if (index === landings.length - 1) setBusy(false);
      });
    }
    agenda.at(last + 1100 + Math.random() * 700, run);
  };
  function run(): void {
    const job = jobs[next % jobs.length];
    next += 1;
    if (job === undefined) return;
    let at = 0;
    for (const character of job.command) {
      at += 55 + Math.random() * 75 + (Math.random() < 0.08 ? 200 : 0);
      agenda.at(at, () => press(character));
    }
    agenda.at(at + 260 + Math.random() * 240, () => enter(job));
  }

  window.addEventListener('resize', () => {
    capacity = rows();
    trim();
  });
  let started = false;
  onScreen(
    root,
    (on) => {
      if (!on) {
        agenda.pause();
        return;
      }
      agenda.resume();
      if (started) return;
      started = true;
      agenda.at(400, () => {
        if (p < 0.05) go(0.6, 2600);
      });
      agenda.at(900, run);
    },
    0.25,
  );
}
