/**
 * The one module a page of the blog adds. It marks the section being read in
 * "On this page", copies a code block, and wakes the figures: each is a still
 * in the markup, and when one nears the viewport its module is fetched and the
 * same component draws over the still, alive. Solid arrives with the first
 * figure, so a page without one never fetches it.
 *
 * What moves (`moves.ts`) is fetched once the page has loaded, with Motion,
 * which every page of the site fetches then anyway.
 */
import { islands } from 'virtual:blog-islands';

import { loadMotion } from './kit/motion';

/** How far ahead of the viewport a figure's module is fetched. */
const AHEAD = '100% 0px';

/** How long a copy button says it has copied, in ms. */
const COPIED_HOLD_MS = 1600;

async function wake(root: HTMLElement): Promise<void> {
  const name = root.dataset.island ?? '';
  const load = islands[name];

  if (load === undefined) throw new Error(`blog: no figure named ${name}`);

  // All three are fetched at once: the figure's and Motion's requests are on
  // their way before this one waits.
  const figure = load();
  const moving = loadMotion();
  const { mount } = await import('./mount');
  await moving;
  mount((await figure).default, root);
}

const nearing = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;

      nearing.unobserve(entry.target);
      void wake(entry.target);
    }
  },
  { rootMargin: AHEAD },
);

for (const root of document.querySelectorAll<HTMLElement>('[data-island]')) nearing.observe(root);

// The section being read is the one under a line three tenths down the window.
// Every block of the post belongs to the section whose heading came before it,
// and the observer says which block the line is on, however the page got there:
// a scroll, a jump to an address, a reload half way down.
const contents = new Map<string, HTMLAnchorElement>();

for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-toc]')) {
  contents.set(decodeURIComponent(link.hash.slice(1)), link);
}

let reading: HTMLAnchorElement | null = null;

/** Moves the contents' marker, once `moves.ts` has loaded. */
let follow: ((link: HTMLElement | null) => void) | null = null;

const sectionOf = new Map<Element, string>();

const line = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const section = sectionOf.get(entry.target);
      reading = null;

      for (const [id, link] of contents) {
        if (id === section) {
          link.setAttribute('aria-current', 'location');
          reading = link;
        } else link.removeAttribute('aria-current');
      }

      follow?.(reading);
    }
  },
  { rootMargin: '-30% 0px -70% 0px' },
);

let section = '';

for (const block of document.querySelector('.post-body')?.children ?? []) {
  if (block.matches('h2[data-section]')) section = block.id;

  sectionOf.set(block, section);
  line.observe(block);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-code-copy]')) {
  const lines = button.closest('.code')?.querySelectorAll('.code-line');

  if (lines === undefined) throw new Error('blog: a copy button has no code beside it');

  const label = button.textContent ?? '';
  let timer = 0;
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText([...lines].map((row) => row.textContent).join('\n'));
    button.textContent = 'Copied';
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      button.textContent = label;
    }, COPIED_HOLD_MS);
  });
}

async function move(): Promise<void> {
  const { startMoves } = await import('./moves');
  follow = await startMoves();
  follow?.(reading);
}

if (document.readyState === 'complete') void move();
else window.addEventListener('load', () => void move(), { once: true });
