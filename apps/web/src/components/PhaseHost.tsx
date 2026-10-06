import { animate } from 'motion';
import {
  type Accessor,
  type Component,
  createEffect,
  createSignal,
  type Element,
  For,
  onCleanup,
  onSettled,
} from 'solid-js';

import type { AppPhase } from '../app/navigation';
import { ariaBool } from '../lib/aria';
import {
  dissolveTransition,
  hintMotion,
  PHASE_SPRING,
  prefersReducedMotion,
  springTransition,
} from '../lib/motion';

/**
 * The switch between the three app phases: splash, login, shell.
 *
 * A phase change cannot be a layer that stays mounted the way a route is. The
 * login screen holds a password field that must not outlive the login, and the
 * shell must not exist before there is a session for it to show. So the
 * departing phase is kept alive here, and only here, for exactly as long as its
 * exit takes — the same trick `OverlayHost` plays with dialogs, and for the
 * same reason: app state must never wait on an animation.
 *
 * The two phases overlap while that happens, which is the entire point. A hard
 * swap between full-screen surfaces is the single loudest tell that something
 * is a web page. Boot and auth dissolve into each other with a matched scale;
 * the shell stays on the physical pixel plane because it can contain the live
 * terminal canvas.
 *
 * Signing in and signing out are the two moves that are not a dissolve. The
 * orb and wordmark on the sign-in card and the orb and wordmark in the machine
 * list header are the same mark and the same name, so the move between auth
 * and shell runs as a view transition with both as shared elements: the
 * browser snapshots both states and carries the pair from the middle of the
 * card to their slots in the header while the surfaces cross-fade under it,
 * and signing out plays the same move backwards, header to card. They are the
 * app's one orchestrated entrance and its reverse, and after them nothing
 * moves that the user did not move. Both layers skip Motion for that move —
 * the leaving one is already in the old snapshot, so it is dropped at once,
 * and the arriving one is painted in place for the new snapshot. Under
 * reduced motion, or where the API is missing, the move is the dissolve.
 */

/**
 * Depth into the app. Direction is read from this rather than passed in, so
 * logging out reverses the movement that logging in made without anything
 * having to remember which way it went.
 */
const PHASE_RANK: Record<AppPhase, number> = { bootstrapping: 0, auth: 1, shell: 2 };

/**
 * How far the surface travels in depth. Small on purpose: scaling resamples
 * every glyph on the screen, and past a percent or two the text visibly
 * softens on the way through.
 */
const NEAR_SCALE = 0.985;
const FAR_SCALE = 1.015;

/**
 * One length for both halves of a dissolve, and the same 200 ms the browser
 * gives the view transition's own root cross-fade, so the fallback and the
 * real move are one shape. Linear rather than `OUT_EASE`, because a swap of
 * two full-bleed surfaces on a front-loaded curve is three-quarters done two
 * frames in and reads as a cut.
 */
const DISSOLVE_S = 0.2;

interface Entry {
  readonly phase: AppPhase;
  /**
   * The first phase the app ever shows, which arrives from nothing and must not
   * animate — the same rule `ViewLayer` keeps for the route already showing when
   * the shell mounts. It matters more here than it reads: the shell's boot
   * splash is already on screen and fully painted when Solid takes over, so
   * fading this layer up from zero over it dims an identical picture.
   */
  readonly initial: boolean;
  /**
   * Arrives through the sign-in or sign-out view transition rather than
   * through Motion: painted in place, because the browser is animating the
   * snapshots.
   */
  readonly shared: boolean;
  /**
   * True from the moment a shared arrival is created until the transition's
   * own `finished` promise settles. The layer wears it as a class, and the
   * preflight keeps the machine list's contents invisible while it is on, so
   * the orb and the name land in an empty frame and the list appears after
   * them rather than under them. The sign-in card has no such rule: the pair
   * lands at its top and the form below is where it is going. Read from the
   * transition, never from a timer: it is the browser's fact about when the
   * move ended.
   */
  readonly arriving: Accessor<boolean>;
  settleArriving(): void;
  readonly exiting: Accessor<boolean>;
  beginExit(): void;
  /**
   * Direction of the move this layer belongs to. Written when the layer is
   * created and rewritten when it starts leaving, because a phase entered
   * going forward can still be left going back.
   */
  forward: boolean;
  /**
   * Leaves through the sign-in or sign-out view transition: the old snapshot
   * already holds this layer, so it is unmounted the moment the new one exists.
   */
  sharedExit: boolean;
}

interface Props {
  readonly phase: AppPhase;
  readonly children: (phase: AppPhase) => Element;
  /**
   * A leaving layer is out of the document. Signing out waits for this before
   * it tears the shell down, so what the user sees leave — and what the
   * transition's old snapshot holds — is the shell as it was, not a list the
   * teardown had already emptied.
   */
  onDeparted(): void;
}

/** Whether a move between sign-in and shell can carry the orb as a shared element. */
function sharedElementsAvailable(): boolean {
  return typeof document.startViewTransition === 'function' && !prefersReducedMotion();
}

/** The two phases whose orb and wordmark are the same mark in different places. */
function carriesTheMark(from: AppPhase, to: AppPhase): boolean {
  return (from === 'auth' && to === 'shell') || (from === 'shell' && to === 'auth');
}

const PhaseHost: Component<Props> = (props) => {
  const [entries, setEntries] = createSignal<readonly Entry[]>([]);
  /**
   * Resolves the view transition's update once the arriving layer is in the
   * DOM. The browser captures the new state only after this settles, so it is
   * held until the layer's own mount says so rather than guessed with a frame.
   */
  let settleArrival: (() => void) | null = null;

  function createEntry(
    phase: AppPhase,
    forward: boolean,
    initial: boolean,
    shared: boolean,
  ): Entry {
    const [exiting, setExiting] = createSignal(false);
    const [arriving, setArriving] = createSignal(shared);
    return {
      phase,
      initial,
      shared,
      arriving,
      settleArriving: () => setArriving(false),
      exiting,
      beginExit: () => setExiting(true),
      forward,
      sharedExit: false,
    };
  }

  createEffect(
    () => props.phase,
    (phase) => {
      const current = entries();
      const leaving = current.find((entry) => !entry.exiting());
      const forward = leaving === undefined || PHASE_RANK[phase] >= PHASE_RANK[leaving.phase];
      // Only when the leaving phase is the sole layer: a layer still fading
      // out from a move a moment earlier carries the orb's name too, and two
      // elements with one name make the browser skip the transition.
      const shared =
        leaving !== undefined &&
        carriesTheMark(leaving.phase, phase) &&
        current.length === 1 &&
        sharedElementsAvailable();
      const arrival = createEntry(phase, forward, current.length === 0, shared);
      const apply = (): void => {
        if (leaving !== undefined) {
          leaving.forward = forward;
          leaving.sharedExit = shared;
          leaving.beginExit();
        }
        setEntries((now) => [...now, arrival]);
      };
      if (!shared) {
        apply();
        return;
      }
      const transition = document.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            settleArrival = resolve;
            apply();
          }),
      );
      // `finished` settles whether the move played or was skipped, so the
      // list is never left hidden.
      transition.finished.then(arrival.settleArriving, arrival.settleArriving);
    },
  );

  return (
    <For each={entries()}>
      {(entry) => (
        <PhaseLayer
          entry={entry}
          onArrived={() => {
            settleArrival?.();
            settleArrival = null;
          }}
          onExited={() => {
            setEntries((current) => current.filter((item) => item !== entry));
            props.onDeparted();
          }}
        >
          {props.children(entry.phase)}
        </PhaseLayer>
      )}
    </For>
  );
};

export default PhaseHost;

/**
 * Frame for one phase.
 *
 * The shell fills the viewport and owns its own scrolling; splash and login are
 * centred cards, and centre them by scrolling *inside* the layer rather than by
 * letting the document scroll. That difference matters on a phone: with the
 * on-screen keyboard up the viewport shrinks under the login form, and a page
 * that centres from the body has nowhere to put the overflow.
 *
 * Every layer is transparent. The desk is the body's own pseudo-element and
 * the splash orb's still carries its own alpha, so nothing here paints a
 * ground — and nothing here may carry the desk either: a layer that scales on
 * entry and scrolls under the keyboard flashes its tiles white on iOS while
 * the texture is re-rasterised (see `uno.config.ts`).
 */
function phaseFrame(phase: AppPhase): string {
  return phase === 'shell' ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain';
}

interface LayerProps {
  readonly entry: Entry;
  readonly children: Element;
  /** The layer is in the DOM; the view transition may capture the new state. */
  onArrived(): void;
  onExited(): void;
}

const PhaseLayer: Component<LayerProps> = (props) => {
  let layerEl!: HTMLDivElement;
  let enterMotion: ReturnType<typeof animate> | null = null;
  let exitMotion: ReturnType<typeof animate> | null = null;

  onSettled(() => {
    // Forward, an arriving non-shell phase comes from behind and grows into
    // place; backward, it comes from in front and settles back. Only the scale
    // is a spring — the fade has to be over well before the movement is, or two
    // full-screen surfaces are both half-painted for most of the transition.
    const carriesTerminalSurface = props.entry.phase === 'shell';
    // Written through `animate` at zero duration rather than by hand, so Motion
    // owns the transform from the start and the exit below reads a value it put
    // there itself. A layer arriving through the view transition is painted in
    // place the same way the first phase is: the browser owns that move.
    const entrance =
      props.entry.initial || props.entry.shared
        ? animate(layerEl, carriesTerminalSurface ? { opacity: 1 } : { opacity: 1, scale: 1 }, {
            duration: 0,
          })
        : carriesTerminalSurface
          ? animate(layerEl, { opacity: [0, 1] }, { opacity: dissolveTransition(DISSOLVE_S) })
          : animate(
              layerEl,
              {
                opacity: [0, 1],
                scale: [props.entry.forward ? NEAR_SCALE : FAR_SCALE, 1],
              },
              {
                scale: springTransition(PHASE_SPRING),
                opacity: dissolveTransition(DISSOLVE_S),
              },
            );
    enterMotion = entrance;
    hintMotion([layerEl], entrance, carriesTerminalSurface ? 'opacity' : undefined);
    if (props.entry.shared) props.onArrived();
  });

  createEffect(
    () => props.entry.exiting(),
    (exiting) => {
      if (!exiting) return;

      enterMotion?.stop();
      if (props.entry.sharedExit) {
        props.onExited();
        return;
      }
      // Nothing springs on the way out. The layer is transparent long before a
      // spring would have settled, so the extra frames buy nothing and hold a
      // compositor layer for the whole app open while they run.
      const departure =
        props.entry.phase === 'shell'
          ? animate(layerEl, { opacity: 0 }, dissolveTransition(DISSOLVE_S))
          : animate(
              layerEl,
              { opacity: 0, scale: props.entry.forward ? FAR_SCALE : NEAR_SCALE },
              dissolveTransition(DISSOLVE_S),
            );
      exitMotion = departure;
      hintMotion([layerEl], departure, props.entry.phase === 'shell' ? 'opacity' : undefined);

      const finish = (): void => props.onExited();
      departure.finished.then(finish, finish);
    },
  );

  onCleanup(() => {
    enterMotion?.stop();
    exitMotion?.stop();
  });

  return (
    <div
      ref={layerEl}
      class={[
        'fixed inset-0',
        phaseFrame(props.entry.phase),
        {
          'pointer-events-none': props.entry.exiting(),
          'shared-arrival': props.entry.arriving(),
        },
      ]}
      aria-hidden={ariaBool(props.entry.exiting())}
      inert={props.entry.exiting()}
    >
      {props.entry.phase === 'shell' ? (
        props.children
      ) : (
        <div class="flex min-h-full items-center justify-center p-6">{props.children}</div>
      )}
    </div>
  );
};
