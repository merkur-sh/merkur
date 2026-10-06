/**
 * How the page arrives and answers the pointer, on Motion: sections rise on a
 * spring as they are reached, the hero's terminal leans back until it is
 * scrolled to, the phones fan out, a card turns under the pointer and settles
 * when it leaves.
 */
import { animate, animateMini, hover, inView, scroll, spring } from 'motion';

import { STRIP_PITCH, stripRandom, stripStep } from '../link-strip';
import { createAgenda, onScreen } from './clock';

/** A section coming to rest where it belongs. */
const ARRIVE = { type: 'spring', visualDuration: 0.7, bounce: 0.14 } as const;
/** Something following the pointer: quick to answer, slow to overshoot. */
const FOLLOW = { type: 'spring', visualDuration: 0.35, bounce: 0.12 } as const;
/** The same thing let go: it takes its time getting back. */
const REST = { type: 'spring', visualDuration: 0.8, bounce: 0.2 } as const;
const STAGGER_S = 0.08;
const RISE_PX = 28;

/**
 * Sections below the fold start lowered and transparent and rise when they
 * are reached. Only what is out of view when this runs is hidden, so nothing
 * a visitor is already looking at blinks.
 */
function revealOnArrival(): void {
  const targets: { element: HTMLElement; order: number }[] = [
    ...document.querySelectorAll<HTMLElement>('[data-reveal]'),
  ].map((element) => ({ element, order: 0 }));
  for (const group of document.querySelectorAll<HTMLElement>('[data-stagger]')) {
    for (const [order, child] of [...group.children].entries()) {
      if (child instanceof HTMLElement) targets.push({ element: child, order });
    }
  }
  for (const { element, order } of targets) {
    if (element.getBoundingClientRect().top < window.innerHeight) continue;
    animate(element, { opacity: 0, y: RISE_PX }, { duration: 0 });
    inView(element, () => {
      animate(element, { opacity: 1, y: 0 }, { ...ARRIVE, delay: order * STAGGER_S });
    });
  }
}

/** The pointer's place over `element`, from -0.5 to 0.5 on each axis, and in its own pixels. */
function overPointer(
  element: HTMLElement,
  move: (x: number, y: number, px: number, py: number) => void,
  leave: () => void,
): void {
  element.addEventListener('pointermove', (event) => {
    const box = element.getBoundingClientRect();
    move(
      (event.clientX - box.left) / box.width - 0.5,
      (event.clientY - box.top) / box.height - 0.5,
      event.clientX - box.left,
      event.clientY - box.top,
    );
  });
  element.addEventListener('pointerleave', leave);
}

/**
 * The hero's terminal leans back by 16° while it is below the fold and stands
 * up as it is scrolled to: upright once the stage's top is a fifth of the way
 * down the window. It also turns a little toward the pointer.
 */
function leanHero(stage: HTMLElement): void {
  const scroller = stage.querySelector<HTMLElement>('[data-hero-scroll]');
  const terminal = stage.querySelector<HTMLElement>('[data-hero3d]');
  if (scroller === null || terminal === null) throw new Error('site: the stage has no terminal');
  // Told the progress and nothing more: an animation handed to `scroll` is
  // sampled on every frame where the browser has no scroll timeline, and this
  // way the page asks for frames only while it is being scrolled.
  scroll(
    (upright: number) => {
      scroller.style.transform = `rotateX(${(16 * (1 - upright)).toFixed(2)}deg) scale(${(0.94 + 0.06 * upright).toFixed(4)})`;
    },
    { target: stage, offset: ['start end', 'start 0.2'] },
  );
  overPointer(
    stage,
    (x, y) => {
      animate(terminal, { rotateX: -y * 3, rotateY: x * 4, transformPerspective: 1800 }, FOLLOW);
    },
    () => {
      animate(terminal, { rotateX: 0, rotateY: 0 }, REST);
    },
  );
}

/** The three phones open from a stack when they are reached, and turn with the pointer. */
function openFan(fan: HTMLElement): void {
  const inner = fan.querySelector<HTMLElement>('[data-fan-inner]');
  const cards = [...fan.querySelectorAll<HTMLElement>('[data-fan-card]')];
  if (inner === null || cards.length === 0) throw new Error('site: the fan has no phones');
  // Where the stylesheet fans each phone to; until the fan is reached they sit in one stack.
  const fanned = cards.map((card) => getComputedStyle(card).transform);
  for (const card of cards) card.style.transform = 'translateZ(0px)';
  inView(
    fan,
    () => {
      for (const [index, card] of cards.entries()) {
        const open = animateMini(
          card,
          { transform: ['translateZ(0px)', fanned[index] ?? 'none'] },
          { type: spring, visualDuration: 0.9, bounce: 0.3, delay: 0.15 + index * 0.06 },
        );
        // Back to the stylesheet's own transform, which a narrower window may change.
        void open.finished.then(() => {
          card.style.transform = '';
        });
      }
    },
    { amount: 0.2 },
  );
  overPointer(
    fan,
    (x, y) => {
      animate(inner, { rotateY: x * 14, rotateX: -y * 8 }, FOLLOW);
    },
    () => {
      animate(inner, { rotateY: 0, rotateX: 0 }, REST);
    },
  );
}

/** A card turns toward the pointer, with a soft light where the pointer is. */
function tiltCard(card: HTMLElement): void {
  const glare = document.createElement('span');
  glare.className = 'glare';
  card.append(glare);
  hover(card, () => {
    animate(glare, { opacity: 1 }, { duration: 0.3 });
    return () => {
      animate(glare, { opacity: 0 }, { duration: 0.3 });
    };
  });
  overPointer(
    card,
    (x, y, px, py) => {
      animate(card, { rotateX: -y * 6, rotateY: x * 6, transformPerspective: 1200 }, FOLLOW);
      // The light is under the pointer, not behind it.
      animate(glare, { x: px, y: py }, { duration: 0 });
    },
    () => {
      animate(card, { rotateX: 0, rotateY: 0 }, REST);
    },
  );
}

/** A mock terminal's traffic strip moves on a bar every 120 ms while it is on screen. */
function runStrip(strip: SVGSVGElement): void {
  const bars = strip.querySelector<SVGGElement>('g');
  const view = strip.viewBox.baseVal;
  if (bars === null) throw new Error('site: a traffic strip has no bars');
  const random = stripRandom(`${strip.dataset.strip ?? ''}+`);
  const span = Math.floor((view.height - 1) / 2);
  const middle = Math.floor(view.height / 2);
  let shifted = 0;
  const bar = (x: number, y: number, height: number): void => {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(STRIP_PITCH - 1));
    rect.setAttribute('height', String(height));
    bars.append(rect);
  };
  const agenda = createAgenda();
  const step = (): void => {
    shifted += STRIP_PITCH;
    for (const rect of [...bars.children]) {
      if (Number(rect.getAttribute('x')) < shifted) rect.remove();
    }
    const x = shifted + (Math.floor(view.width / STRIP_PITCH) - 1) * STRIP_PITCH;
    const { sent, received } = stripStep(random, span);
    if (sent > 0) bar(x, middle - sent, sent);
    if (received > 0) bar(x, middle + 1, received);
    bars.setAttribute('transform', `translate(${-shifted} 0)`);
    agenda.at(120, step);
  };
  agenda.at(120, step);
  onScreen(strip, (on) => (on ? agenda.resume() : agenda.pause()));
}

export function playArrival(): void {
  revealOnArrival();
  // The narrow layout has no depth: one phone, a flat terminal, stacked cards.
  if (matchMedia('(min-width: 720px)').matches) {
    for (const stage of document.querySelectorAll<HTMLElement>('[data-tilt-root]')) leanHero(stage);
    for (const fan of document.querySelectorAll<HTMLElement>('[data-fan]')) openFan(fan);
    for (const card of document.querySelectorAll<HTMLElement>('[data-tilt]')) tiltCard(card);
  }
  for (const strip of document.querySelectorAll<SVGSVGElement>('svg[data-strip]')) runStrip(strip);
}
