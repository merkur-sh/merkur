/**
 * The questions, on springs (Motion).
 *
 * Without this a question is a plain `<details>`: it opens and closes at once,
 * and that is what a reader who asked for reduced motion keeps. With it, a
 * question opens and shuts as `unfold.ts` plays it, and the mark turns with
 * the same spring. The mark is driven from script, which lets its turn and its
 * press share a transform.
 */
import { animate, animateMini, hover, inView, press, spring, stagger } from 'motion';

import { unfold, wipe } from './unfold';

const TOUCH = { type: 'spring', visualDuration: 0.22, bounce: 0.3 } as const;
const MARK_TURN = 45;

function playQuestion(question: HTMLDetailsElement): void {
  const summary = question.querySelector('summary');
  const answer = question.querySelector<HTMLElement>('p');
  const mark = question.querySelector<HTMLElement>('.q-mark');
  if (summary === null || answer === null || mark === null) {
    throw new Error(`site: question ${question.id} is missing a part`);
  }
  // The mark's turn is the spring's from here on; its colours stay the stylesheet's.
  mark.style.transitionProperty = 'background-color, color';
  unfold(question, summary, answer, (open, at) => {
    animate(mark, { rotate: open ? MARK_TURN : 0 }, at);
  });

  hover(summary, () => {
    animate(mark, { scale: 1.1 }, TOUCH);
    return () => animate(mark, { scale: 1 }, TOUCH);
  });
  press(summary, () => {
    animate(mark, { scale: 0.9 }, TOUCH);
    return () => animate(mark, { scale: 1 }, TOUCH);
  });
}

export function playQuestions(): void {
  for (const list of document.querySelectorAll<HTMLElement>('[data-questions]')) {
    const questions = [...list.querySelectorAll<HTMLDetailsElement>('details[data-question]')];
    for (const question of questions) playQuestion(question);
    // They arrive one after another, unless the reader is already looking at them.
    if (list.getBoundingClientRect().top < window.innerHeight) continue;
    for (const question of questions) question.style.opacity = '0';
    inView(
      list,
      () => {
        const arriving = animateMini(
          questions,
          { opacity: [0, 1], transform: ['translateY(22px)', 'translateY(0px)'] },
          { type: spring, visualDuration: 0.55, bounce: 0.18, delay: stagger(0.07) },
        );
        void arriving.finished.then(() => {
          for (const question of questions) wipe(question, 'opacity', 'transform');
        });
      },
      { amount: 0.15 },
    );
  }
}
