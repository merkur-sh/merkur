/**
 * The page's side of the render worker (`worker.ts`).
 *
 * The page keeps what only it can know: where each picture sits, whether it
 * is on screen, where the pointer is. Every picture starts as a still in the
 * markup; this hands a canvas for each to the worker and shows the canvas in
 * the still's place once the worker has drawn into it. From then on the main
 * thread does no drawing and asks for no frames.
 */
import { animateMini } from 'motion';

import { onScreen } from '../motion/clock';
import { float } from '../motion/loops';
import marks from './marks/marks.json';
import { PLANET_GLYPHS } from './planet';
import type { FromWorker, PlanetInit, RetrogradeSky, SurfaceInit, ToWorker } from './protocol';

const MASKS = import.meta.glob<string>('./marks/*.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Device pixels per CSS pixel a picture is drawn at; past 2 the eye gains nothing. */
const density = (cap: number): number => Math.min(window.devicePixelRatio || 1, cap);

/** How far the planet turns, in radians, while the page scrolls it through the window. */
const SCROLL_TURN = Math.PI * 1.2;

type Size = readonly [number, number];

/**
 * How one picture measures itself again when the window takes a new width.
 * The three passes run for every picture in turn, so the page is laid out
 * once: every still back in its place, every box read, every canvas set.
 */
interface Refit {
  release(): void;
  measure(): void;
  apply(): void;
}

export function startGraphics(): void {
  const refits: Refit[] = [];
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const send = (message: ToWorker, transfer: Transferable[] = []): void =>
    worker.postMessage(message, transfer);
  const whenDrawn = new Map<number, () => void>();
  const whenBackwards = new Map<number, (on: boolean) => void>();
  worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message.type === 'backwards') {
      whenBackwards.get(message.id)?.(message.on);
      return;
    }
    whenDrawn.get(message.id)?.();
    whenDrawn.delete(message.id);
  });
  let nextId = 0;

  /** Hands `canvas` to the worker as surface `init`, drawn only while `anchor` is on screen. */
  const add = (
    canvas: HTMLCanvasElement,
    init: SurfaceInit,
    anchor: Element,
    drawn: () => void,
  ): number => {
    nextId += 1;
    const id = nextId;
    const offscreen = canvas.transferControlToOffscreen();
    const carried: Transferable[] = [offscreen];
    if (init.kind === 'mark') carried.push(init.mask);
    if (init.kind === 'planet') carried.push(init.atlas);
    whenDrawn.set(id, drawn);
    send({ type: 'add', id, canvas: offscreen, init }, carried);
    onScreen(anchor, (on) => send({ type: 'visible', id, on }));
    return id;
  };

  /** Reports a drag on `element` to surface `id` as movement between pointer events. */
  const draggable = (element: HTMLElement, id: number): void => {
    let last: readonly [number, number] | null = null;
    element.addEventListener('pointerdown', (event) => {
      last = [event.clientX, event.clientY];
      element.setPointerCapture(event.pointerId);
      element.toggleAttribute('data-grabbed', true);
      send({ type: 'drag', id, phase: 'start', dx: 0, dy: 0 });
    });
    element.addEventListener('pointermove', (event) => {
      if (last === null) return;
      send({
        type: 'drag',
        id,
        phase: 'move',
        dx: event.clientX - last[0],
        dy: event.clientY - last[1],
      });
      last = [event.clientX, event.clientY];
    });
    const release = (): void => {
      if (last === null) return;
      last = null;
      element.toggleAttribute('data-grabbed', false);
      send({ type: 'drag', id, phase: 'end', dx: 0, dy: 0 });
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
  };

  // The orb, wherever its still is.
  for (const still of document.querySelectorAll<HTMLImageElement>('img[data-orb]')) {
    const canvas = document.createElement('canvas');
    const pixels = Math.max(1, Math.round(still.width * density(2)));
    canvas.width = pixels;
    canvas.height = pixels;
    canvas.className = still.className;
    canvas.setAttribute('aria-hidden', 'true');
    if (still.className === '') {
      canvas.style.width = `${still.width}px`;
      canvas.style.height = `${still.height}px`;
    }
    // The still's parent stays in place when the canvas takes the still's.
    const anchor = still.parentElement ?? still;
    add(canvas, { kind: 'orb' }, anchor, () => {
      still.replaceWith(canvas);
      // The canvas floats where its still did.
      if (still.hasAttribute('data-float')) float(canvas);
    });
  }

  /**
   * A canvas whose pixels follow its box: `fit` tells the worker the new size
   * when the layout gives the box one it has not had.
   */
  const fitted = (id: number, first: Size): ((next: Size, planet?: PlanetInit) => void) => {
    let held = first;
    return (next, planet) => {
      if (next[0] === 0 || next[1] === 0 || (next[0] === held[0] && next[1] === held[1])) {
        planet?.atlas.close();
        return;
      }
      held = next;
      send(
        { type: 'fit', id, width: next[0], height: next[1], planet: planet ?? null },
        planet === undefined ? [] : [planet.atlas],
      );
    };
  };

  // The liquid-metal icons and words.
  const mark = async (host: HTMLElement, name: string, box: () => Size): Promise<void> => {
    const url = MASKS[`./marks/${name}.webp`];
    if (url === undefined) throw new Error(`site: no mask for the ${name} mark`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`site: the ${name} mask answered ${response.status}`);
    const mask = await createImageBitmap(await response.blob());
    // The mask holds the shape and its height side by side; never draw past its detail.
    const detail = mask.width / 2;
    const pixels = ([width, height]: Size): Size => {
      const scale = Math.min(density(2), detail / width);
      return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
    };
    const canvas = document.createElement('canvas');
    let size = box();
    const place = (): void => {
      canvas.style.width = `${size[0]}px`;
      canvas.style.height = `${size[1]}px`;
    };
    [canvas.width, canvas.height] = pixels(size);
    place();
    canvas.setAttribute('aria-hidden', 'true');
    const seed = ([...name].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 17) * 0.37;
    let shown = false;
    const id = add(canvas, { kind: 'mark', mask, seed }, host, () => {
      host.append(canvas);
      host.toggleAttribute('data-drawn', true);
      shown = true;
    });
    const fit = fitted(id, [canvas.width, canvas.height]);
    refits.push({
      // The still decides the box, so it goes back while the box is read.
      release: () => host.toggleAttribute('data-drawn', false),
      measure: () => {
        size = box();
      },
      apply: () => {
        if (shown) host.toggleAttribute('data-drawn', true);
        if (size[0] === 0 || size[1] === 0) return;
        place();
        fit(pixels(size));
      },
    });
    const under = host.closest<HTMLElement>('[data-tilt]') ?? host;
    under.addEventListener('pointermove', (event) => {
      const box = under.getBoundingClientRect();
      send({
        type: 'pointer',
        id,
        at: [
          (event.clientX - box.left) / box.width - 0.5,
          (event.clientY - box.top) / box.height - 0.5,
        ],
      });
    });
    under.addEventListener('pointerleave', () => send({ type: 'pointer', id, at: null }));
  };
  for (const host of document.querySelectorAll<HTMLElement>('[data-liquid-icon]')) {
    void mark(host, `icon-${host.dataset.liquidIcon ?? ''}`, () => [
      host.clientWidth,
      host.clientHeight,
    ]);
  }
  for (const host of document.querySelectorAll<HTMLElement>('[data-liquid]')) {
    const name = host.dataset.liquid ?? '';
    const drawn = (marks as Record<string, { width: number; height: number; size: number }>)[name];
    if (drawn === undefined) throw new Error(`site: no box for the ${name} mark`);
    // The still is set at the size its layout gives it; the mark takes the same share.
    void mark(host, `word-${name}`, () => {
      const scale = parseFloat(getComputedStyle(host).fontSize) / drawn.size;
      return [drawn.width * scale, drawn.height * scale];
    });
  }

  // The orb's line across the page for an address with nothing at it. The
  // markup's stars and dotted line stay; the canvas takes the place of the
  // orb held at the top of the loop, and of the light and the tail behind it.
  for (const host of document.querySelectorAll<HTMLElement>('[data-retrograde]')) {
    const canvas = host.querySelector('canvas');
    const line = host.querySelector('[data-retrograde-line]');
    const orb = host.querySelector('img');
    const word = host.querySelector<HTMLElement>('[data-retrograde-word]');
    if (canvas === null || line === null || orb === null || word === null) {
      throw new Error('site: the retrograde sky is missing a part');
    }
    const scale = density(2);
    /** Where the stylesheet has set the line and the orb, from the canvas's corner. */
    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const run = line.getBoundingClientRect();
      return {
        pixels: [Math.round(box.width * scale), Math.round(box.height * scale)] satisfies Size,
        sky: {
          scale,
          left: run.left - box.left,
          run: run.width,
          level: run.bottom - box.top,
          rise: run.height,
          orb: orb.width,
        } satisfies RetrogradeSky,
      };
    };
    let placed = measure();
    [canvas.width, canvas.height] = placed.pixels;
    let shown = false;
    const id = add(canvas, { kind: 'retrograde', sky: placed.sky }, host, () => {
      host.toggleAttribute('data-drawn', true);
      shown = true;
    });
    // The word shows from the moment the orb turns back until it sets out again.
    whenBackwards.set(id, (on) => {
      animateMini(word, { opacity: on ? [0, 1] : [1, 0] }, { duration: 0.4, ease: 'easeInOut' });
    });
    refits.push({
      // The still's orb says how large the layout wants it, so it goes back to be read.
      release: () => host.toggleAttribute('data-drawn', false),
      measure: () => {
        placed = measure();
      },
      apply: () => {
        if (shown) host.toggleAttribute('data-drawn', true);
        const [width, height] = placed.pixels;
        if (width === 0 || height === 0) return;
        send({ type: 'lay', id, width, height, sky: placed.sky });
      },
    });
  }

  // The boxes.
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-boxes]')) {
    const pixels = (): Size => {
      const scale = density(1.5);
      return [Math.round(canvas.clientWidth * scale), Math.round(canvas.clientHeight * scale)];
    };
    let size = pixels();
    [canvas.width, canvas.height] = size;
    const id = add(canvas, { kind: 'boxes' }, canvas, () =>
      canvas.parentElement?.toggleAttribute('data-drawn', true),
    );
    draggable(canvas, id);
    const fit = fitted(id, size);
    refits.push({
      release: () => {},
      measure: () => {
        size = pixels();
      },
      apply: () => fit(size),
    });
  }

  // The planet, in the mono face's own glyphs.
  /** The planet's grid and glyph atlas for the box the layout gives its canvas now. */
  const grid = async (
    canvas: HTMLCanvasElement,
  ): Promise<{ readonly pixels: Size; readonly init: PlanetInit }> => {
    const size = matchMedia('(max-width: 719px)').matches ? 8 : 10;
    const font = `500 ${size}px 'JetBrains Mono'`;
    await document.fonts.load(font, PLANET_GLYPHS);
    const scale = density(2);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const measure = document.createElement('canvas').getContext('2d');
    if (measure === null) throw new Error('site: no 2D context to measure the planet with');
    measure.font = font;
    const cellWidth = measure.measureText('M').width;
    const cellHeight = Math.round(size * 1.22);
    const atlas = document.createElement('canvas');
    atlas.width = Math.round(PLANET_GLYPHS.length * cellWidth * scale);
    atlas.height = Math.round(cellHeight * scale);
    const pen = atlas.getContext('2d');
    if (pen === null) throw new Error('site: no 2D context to draw the planet glyphs with');
    pen.scale(atlas.width / (PLANET_GLYPHS.length * cellWidth), scale);
    pen.font = font;
    pen.textBaseline = 'top';
    pen.fillStyle = '#fff';
    for (const [index, glyph] of [...PLANET_GLYPHS].entries()) {
      pen.fillText(glyph, index * cellWidth, 0);
    }
    return {
      pixels: [Math.round(width * scale), Math.round(height * scale)],
      init: {
        kind: 'planet',
        atlas: await createImageBitmap(atlas, { premultiplyAlpha: 'none' }),
        cellWidth,
        cellHeight,
        width,
        height,
        scale,
      },
    };
  };
  const planet = async (canvas: HTMLCanvasElement): Promise<void> => {
    const first = await grid(canvas);
    [canvas.width, canvas.height] = first.pixels;
    const id = add(canvas, first.init, canvas, () =>
      canvas.parentElement?.toggleAttribute('data-drawn', true),
    );
    draggable(canvas, id);

    // The planet turns as the page carries it through the window: none of the
    // turn as it comes in at the bottom, all of it as it leaves at the top.
    let top = 0;
    let height = 0;
    const find = (): void => {
      const box = canvas.getBoundingClientRect();
      top = box.top + window.scrollY;
      height = box.height;
    };
    const turn = (): void => {
      const through = (window.scrollY + window.innerHeight - top) / (window.innerHeight + height);
      send({ type: 'turn', id, by: Math.max(0, Math.min(1, through)) * SCROLL_TURN });
    };
    onScreen(canvas, (on) => {
      window.removeEventListener('scroll', turn);
      if (!on) return;
      find();
      turn();
      window.addEventListener('scroll', turn, { passive: true });
    });

    const fit = fitted(id, first.pixels);
    let box: Size = [canvas.clientWidth, canvas.clientHeight];
    let asked = 0;
    refits.push({
      release: () => {},
      measure: () => {
        box = [canvas.clientWidth, canvas.clientHeight];
      },
      apply: () => {
        if (box[0] === 0 || box[1] === 0) return;
        asked += 1;
        const mine = asked;
        void grid(canvas).then(({ pixels, init }) => {
          // A later width asked for its own grid while this one was being drawn.
          if (mine !== asked) {
            init.atlas.close();
            return;
          }
          fit(pixels, init);
          find();
        });
      },
    });
  };
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-ascii]')) {
    void planet(canvas);
  }

  // The pictures follow the layout, and the layout follows the window's width
  // alone: a phone's address bar changes the height as the page scrolls.
  let windowWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === windowWidth) return;
    windowWidth = window.innerWidth;
    for (const refit of refits) refit.release();
    for (const refit of refits) refit.measure();
    for (const refit of refits) refit.apply();
  });
}
