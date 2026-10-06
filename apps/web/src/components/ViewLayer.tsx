import { animate } from 'motion';
import { type Component, createEffect, createSignal, type Element, onCleanup } from 'solid-js';

import { ariaBool } from '../lib/aria';
import { fadeTransition, hintMotion, NAV_SPRING, springTransition } from '../lib/motion';
import { ViewShownContext } from './view-visibility';

/**
 * One screen of the shell, positioned in the navigation stack.
 *
 * Every route stays mounted — the terminal in particular cannot be torn down
 * and rebuilt to change screens — so a layer is never absent, only resting
 * away from the front. `depth` is both its z-order and its place in the stack:
 * `base` is the shallowest, everything else sits over it.
 *
 * Screens move in depth, not sideways. A lateral push is a phone idiom and it
 * needs a screen edge to come from; on a desktop window the shell is a narrow
 * column in the middle of a wide field, so a sideways slide has no edge to
 * relate to and reads as the column being dragged around rather than as
 * navigation. Moving along z has an anchor at any window size, and it is the
 * same language `PhaseHost` already speaks, so the whole app moves one way.
 *
 * Direction falls out of `depth` alone. Going deeper, a non-terminal covering
 * screen arrives from just behind and the covered one recedes forward past the
 * viewer; coming back, both play in reverse. The terminal itself fades without
 * scaling so its canvas and DOM geometry remain exact.
 */

type ViewDepth = 'base' | 'raised' | 'terminal';

/**
 * How far a screen sits off the front plane when it is not the one showing.
 * Small on purpose: a scaling layer is resampled rather than re-rendered, and
 * past a couple of percent the text visibly softens on the way through.
 */
const NEAR_SCALE = 0.975;
const FAR_SCALE = 1.02;

/**
 * The two screens occupy the same place, so unlike a slide there is no
 * separation to keep them legible while they overlap. The outgoing one is gone
 * well before the incoming one is solid, which is what stops the pair reading
 * as a double image; every screen sits on the same background, so the moment
 * neither is opaque costs nothing.
 */
const ENTER_FADE_S = 0.14;
const EXIT_FADE_S = 0.08;

interface Props {
  readonly active: boolean;
  readonly children: Element;
  readonly depth: ViewDepth;
  /**
   * Fired once a *leaving* transition has actually finished, so an owner can
   * release what the layer was showing at the moment it stops being visible
   * rather than at the moment it stops being current. Never fired for a
   * transition that was interrupted — turning back mid-exit means the layer
   * never left, and an owner that tore its contents down on the strength of a
   * cancelled exit would blank the screen the user just returned to.
   */
  onHidden?: () => void;
}

const ViewLayer: Component<Props> = (props) => {
  let layerEl!: HTMLDivElement;
  let layerMotion: ReturnType<typeof animate> | null = null;
  let settled = false;
  /**
   * True while this layer's entrance is still playing. Worn as a class so the
   * preflight can hold back anything that must not appear until the screen
   * has fully arrived: the terminal's status card would otherwise show over
   * the machine list for the length of the cross-fade, which reads as the
   * card arriving before the screen it belongs to. Cleared by the entrance's
   * own `finished`, never by a timer.
   */
  const [arriving, setArriving] = createSignal(false);
  /**
   * On screen: current, or still leaving. Provided to the children as the
   * `ViewShownContext`, because an inactive layer is still mounted and still
   * intersects the viewport, so nothing inside it can learn from geometry that
   * it is behind another screen. Cleared by the exit's own `finished`, never by
   * a timer, and never by an exit that was interrupted (see `onHidden`).
   */
  const [shown, setShown] = createSignal(props.active);
  /**
   * Bumped by every transition. `finished` on a stopped Motion animation is
   * left unsettled rather than rejected, so an interrupted exit is already
   * silent — but that is a property of the library, not of this contract, and
   * `onHidden` firing late for a layer that is showing again would be a blank
   * screen. The counter makes the guarantee local.
   */
  let transition = 0;

  createEffect(
    () => props.active,
    (active) => {
      const restingScale = active ? 1 : props.depth === 'base' ? FAR_SCALE : NEAR_SCALE;
      const carriesTerminalSurface = props.depth === 'terminal';

      layerMotion?.stop();

      // The first run establishes the resting state rather than a transition:
      // the route that is already showing when the shell mounts must not move,
      // and the ones behind it must not be animated away from a place they
      // never occupied. Written through `animate` at zero duration rather than
      // by hand, so Motion owns the transform from the start and the first real
      // transition reads a value it put there itself.
      if (!settled) {
        settled = true;
        transition += 1;
        setShown(active);
        layerMotion = carriesTerminalSurface
          ? animate(layerEl, { opacity: active ? 1 : 0 }, { duration: 0 })
          : animate(layerEl, { scale: restingScale, opacity: active ? 1 : 0 }, { duration: 0 });
        return;
      }

      // Depth springs, opacity does not, and re-targeting a live spring carries
      // its velocity — so turning back mid-transition continues from where the
      // screen actually is rather than restarting a curve from a position it
      // has already left.
      const generation = ++transition;
      // A transformed canvas is resampled instead of rerendered. DOMRects below
      // it also scale while terminal cell metrics do not, which can size the
      // PTY from an in-between frame and makes pointer hit-testing inaccurate.
      // Keep terminal pixels on the physical plane; opacity still carries the
      // route transition.
      const next = carriesTerminalSurface
        ? animate(
            layerEl,
            { opacity: active ? 1 : 0 },
            { opacity: fadeTransition(active ? ENTER_FADE_S : EXIT_FADE_S) },
          )
        : animate(
            layerEl,
            { scale: restingScale, opacity: active ? 1 : 0 },
            {
              scale: springTransition(NAV_SPRING),
              opacity: fadeTransition(active ? ENTER_FADE_S : EXIT_FADE_S),
            },
          );
      layerMotion = next;
      hintMotion([layerEl], next, carriesTerminalSurface ? 'opacity' : undefined);

      if (active) {
        setShown(true);
        setArriving(true);
        const arrived = (): void => {
          if (generation !== transition) return;
          setArriving(false);
        };
        next.finished.then(arrived, arrived);
        return;
      }
      setArriving(false);
      const hidden = (): void => {
        if (generation !== transition) return;
        setShown(false);
        props.onHidden?.();
      };
      next.finished.then(hidden, hidden);
    },
  );

  onCleanup(() => layerMotion?.stop());

  return (
    <div
      ref={layerEl}
      class={[
        'absolute inset-0',
        {
          'z-0': props.depth === 'base',
          'z-10': props.depth === 'raised',
          'z-20': props.depth === 'terminal',
          'pointer-events-auto': props.active,
          'pointer-events-none': !props.active,
          'view-arriving': arriving(),
        },
      ]}
      aria-hidden={ariaBool(!props.active)}
      inert={!props.active}
    >
      <ViewShownContext value={shown}>{props.children}</ViewShownContext>
    </div>
  );
};

export default ViewLayer;
