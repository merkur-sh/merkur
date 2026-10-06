import type { AppPhase, Route, SettingsTab } from './navigation';

/**
 * The browser tab's title, derived from navigation state.
 *
 * A terminal that lives in a tab competes for the tab strip with every other
 * page the user has open, and a title that is always "Merkur" makes the one
 * they want unfindable among them. Which machine, or which screen, leads —
 * tabs truncate from the end, so the distinguishing half has to come first.
 *
 * Pure and DOM-free for the same reason `navigation.ts` is: what is worth
 * testing here is the wording and the fallbacks, and neither needs a document.
 *
 * Connection status is deliberately absent. It transitions several times
 * across a rebind the app works hard to keep invisible — that is what the
 * overlay grace timers in the controller are for — and a title flickering
 * through "Reconnecting…" would announce in the tab strip exactly what they
 * exist to hide.
 */

const APP_NAME = 'Merkur';

/**
 * A machine is selected but its name has not resolved yet — the terminal route
 * is pushed from the command palette before the device record is in hand.
 */
const UNNAMED_TERMINAL = 'Terminal';

/** The tab bar's own words, so the title and the tab cannot drift apart. */
const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  terminal: 'Terminal',
  keyboard: 'Keyboard',
  sessions: 'Sessions',
  account: 'Account',
};

export function documentTitle(phase: AppPhase, route: Route, deviceName: string): string {
  // Splash and login are the whole page rather than a place within it, and the
  // login card carries no wordmark at all — the mark is the name. A verb here
  // would be the only place in the product that used one.
  if (phase !== 'shell') return APP_NAME;
  return `${routeLabel(route, deviceName)} — ${APP_NAME}`;
}

/**
 * The same words the "Go to" keybinds in `App.tsx` use for these routes. One
 * vocabulary: a screen the palette calls "Machines" must not be "Devices" in
 * the tab.
 */
function routeLabel(route: Route, deviceName: string): string {
  switch (route.k) {
    case 'devices':
      return 'Machines';
    // The tab names the settings tab, not just "Settings": four tabs open in
    // four browser tabs would otherwise be four identical titles.
    case 'settings':
      return `${SETTINGS_TAB_LABEL[route.tab]} settings`;
    case 'terminal': {
      // Never truncated here. The browser already elides a long tab title, and
      // it does so knowing the width this one actually got.
      const name = deviceName.trim();
      return name.length === 0 ? UNNAMED_TERMINAL : name;
    }
  }
}
