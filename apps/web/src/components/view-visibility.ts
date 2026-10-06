import { type Accessor, createContext, useContext } from 'solid-js';

/**
 * Whether the screen an element sits on is showing.
 *
 * Every route stays mounted, so an inactive screen is still in the document,
 * still intersects the viewport, and is merely at opacity zero behind the one in
 * front. Geometry therefore cannot tell an animation to stop; the route can.
 * `ViewLayer` provides this: true from the moment its screen becomes current
 * until its leaving transition has actually finished, so a mark keeps moving
 * for the length of its own exit and then stops. Outside any layer (the boot
 * splash, sign-in) a mounted element is showing, which the default says.
 */
export const ViewShownContext = createContext<Accessor<boolean>>(() => true);

export function useViewShown(): Accessor<boolean> {
  return useContext(ViewShownContext);
}
