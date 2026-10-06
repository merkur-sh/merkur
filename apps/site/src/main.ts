/**
 * The one module every page loads. It wires what the markup declares and does
 * nothing a page does not carry: the Boxes waitlist, questions that open when
 * a link points at them, and, once the page has loaded and painted, Rybbit's
 * script and everything that moves (`motion.ts`).
 *
 * Analytics are declarative (`data-rybbit-event`), so nothing here calls Rybbit
 * and the page works the same with it blocked.
 */
import 'virtual:uno.css';
import './styles/base.css';

import { initWaitlist } from './waitlist';

/** The Rybbit event a question's summary names while the question is closed. */
const FAQ_OPEN_EVENT = 'faq_open';

/**
 * Settles once the window has loaded and the page has painted its first
 * content, the browser's own `first-contentful-paint` entry, so nothing that
 * waits on it is part of what the first screen waited on.
 */
const firstPaint = new Promise<void>((resolve) => {
  if (!PerformanceObserver.supportedEntryTypes.includes('paint')) {
    throw new Error('site: this browser reports no paint timing');
  }
  const loaded = new Promise<void>((settle) => {
    if (document.readyState === 'complete') settle();
    else window.addEventListener('load', () => settle(), { once: true });
  });
  const painted = new Promise<void>((settle) => {
    new PerformanceObserver((list, observer) => {
      if (!list.getEntries().some((entry) => entry.name === 'first-contentful-paint')) return;
      observer.disconnect();
      settle();
    }).observe({ type: 'paint', buffered: true });
  });
  void Promise.all([loaded, painted]).then(() => resolve());
});

/**
 * Rybbit's script, added once the page has loaded and painted, so it is never
 * part of the bytes a first paint waits on. It reads the site id from its own
 * tag, and the page names it on `<html data-rybbit-site>`.
 */
function loadAnalytics(): void {
  const siteId = document.documentElement.dataset.rybbitSite;
  if (siteId === undefined || siteId === '') {
    throw new Error('site: <html> names no data-rybbit-site');
  }
  const script = document.createElement('script');
  script.src = '/analytics/script.js';
  script.dataset.siteId = siteId;
  document.head.append(script);
}
void firstPaint.then(() => {
  // The mono faces, which the first paint set in their fallbacks (`uno.config.ts`).
  document.documentElement.dataset.faces = 'all';
  loadAnalytics();
  void import('./motion').then(({ startMotion }) => startMotion());
});

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-waitlist]')) {
  initWaitlist(form);
}

/**
 * Rybbit counts a click on any element that names an event. A summary is
 * clicked to close its question as well as to open it, so it names `faq_open`
 * only while its question is closed: `toggle` fires after the click, so the
 * click that opens is counted and the one that closes is not, and a question
 * the address opens sends nothing. The event says which question by its id.
 */
for (const question of document.querySelectorAll<HTMLDetailsElement>('details[data-question]')) {
  const summary = question.querySelector('summary');
  if (summary === null) throw new Error(`site: question ${question.id} has no summary`);
  summary.dataset.rybbitPropQuestion = question.id;
  const sync = (): void => {
    if (question.open) delete summary.dataset.rybbitEvent;
    else summary.dataset.rybbitEvent = FAQ_OPEN_EVENT;
  };
  question.addEventListener('toggle', sync);
  sync();
}

/** A question named by the address opens, so a link to it lands on its answer. */
function openQuestion(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  const target = id === '' ? null : document.getElementById(id);
  if (target instanceof HTMLDetailsElement) target.open = true;
}
openQuestion();
window.addEventListener('hashchange', openQuestion);
