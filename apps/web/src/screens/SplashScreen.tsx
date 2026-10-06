import type { Component } from 'solid-js';

import MerkurOrb from '../components/MerkurOrb';

/**
 * No entrance of its own. The phase layer this sits in already fades and scales
 * the whole surface in, and a second fade nested inside the first multiplies
 * into a slower, softer one than either was written to be.
 *
 * `orb-rest` puts the captured still under this orb, and only this one. The
 * shell's boot splash is removed the moment Solid mounts, while WebGL2 takes a
 * frame or two more to draw — measured at ~80 ms of empty background where the
 * orb had been. The still covers exactly that gap. It carries the shader's own
 * alpha, so it sits on whatever the page body shows — the desk on a desktop,
 * flat ground on a phone — exactly as the live orb does, and the
 * handoff changes nothing behind the mark either.
 */
const SplashScreen: Component = () => (
  <section class="flex flex-col items-center justify-center gap-4">
    <MerkurOrb size={96} class="orb-rest" />
    <p class="wordmark">Merkur</p>
  </section>
);

export default SplashScreen;
