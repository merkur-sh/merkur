/**
 * The codec section's squares, told in the order the bytes are: when the
 * section is reached, zstd's square starts as large as raw's and springs down
 * to its own size, then MZ's comes out of zstd's at its size and springs down
 * to its own, and the labels follow. As with every arrival (`reveal.ts`), only
 * squares still below the fold are set back, so nothing a visitor is looking
 * at jumps.
 */
import { animate, inView } from 'motion';

import { belowFold, firstLook } from './clock';

/** A square settling into its size: long enough to read as shrinking, barely past it. */
const SHRINK = { type: 'spring', visualDuration: 0.5, bounce: 0.1 } as const;
/** MZ's square starts once zstd's is most of the way down. */
const MZ_DELAY_S = 0.25;
/** The labels appear once both squares are mostly settled. */
const LABEL_DELAY_S = 0.6;

export function playSquares(root: HTMLElement): void {
  firstLook(root, (entry) => {
    if (belowFold(entry)) shrink(root);
  });
}

function shrink(root: HTMLElement): void {
  const zstd = root.querySelector<HTMLElement>('[data-mz-shrink="zstd"]');
  const mz = root.querySelector<HTMLElement>('[data-mz-shrink="mz"]');
  if (zstd === null || mz === null) throw new Error('site: the codec squares are missing');
  const labels = [...root.querySelectorAll<HTMLElement>('[data-mz-label]')];
  // Each start is a ratio of laid-out sides, so it follows the figure; all
  // three are read before any of them is set.
  const [side, zstdSide, mzSide] = [root.clientWidth, zstd.offsetWidth, mz.offsetWidth];
  animate(zstd, { scale: side / zstdSide }, { duration: 0 });
  animate(mz, { scale: zstdSide / mzSide, opacity: 0.01 }, { duration: 0 });
  for (const label of labels) animate(label, { opacity: 0.01 }, { duration: 0 });
  inView(
    root,
    () => {
      animate(zstd, { scale: 1 }, SHRINK);
      animate(mz, { opacity: 1 }, { duration: 0.15, delay: MZ_DELAY_S });
      animate(mz, { scale: 1 }, { ...SHRINK, delay: MZ_DELAY_S });
      for (const label of labels) {
        animate(label, { opacity: 1 }, { duration: 0.25, delay: LABEL_DELAY_S });
      }
    },
    { amount: 0.5 },
  );
}
