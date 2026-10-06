import { describe, expect, test } from 'bun:test';

import { documentTitle } from './document-title';
import type { Route } from './navigation';

const DEVICES: Route = { k: 'devices' };
const TERMINAL: Route = { k: 'terminal', deviceId: 'device-1' };

describe('documentTitle', () => {
  test('names the app alone before the shell exists', () => {
    expect(documentTitle('bootstrapping', DEVICES, '')).toBe('Merkur');
    expect(documentTitle('auth', DEVICES, '')).toBe('Merkur');
  });

  test('ignores the route until the shell is the phase', () => {
    // The stack is reset to the device route on the way out of the shell, but
    // a title read mid-transition must not describe a screen nothing is on.
    expect(documentTitle('auth', TERMINAL, 'workshop')).toBe('Merkur');
  });

  test('leads with the machine name inside a terminal', () => {
    expect(documentTitle('shell', TERMINAL, 'workshop')).toBe('workshop — Merkur');
  });

  test('falls back to a generic terminal before the device name resolves', () => {
    expect(documentTitle('shell', TERMINAL, '')).toBe('Terminal — Merkur');
    expect(documentTitle('shell', TERMINAL, '   ')).toBe('Terminal — Merkur');
  });

  test('trims a machine name rather than titling the tab with its padding', () => {
    expect(documentTitle('shell', TERMINAL, '  workshop  ')).toBe('workshop — Merkur');
  });

  test('names each shell route in the words the keybinds use', () => {
    expect(documentTitle('shell', DEVICES, '')).toBe('Machines — Merkur');
    expect(documentTitle('shell', { k: 'settings', tab: 'sessions' }, '')).toBe(
      'Sessions settings — Merkur',
    );
    expect(documentTitle('shell', { k: 'settings', tab: 'terminal' }, '')).toBe(
      'Terminal settings — Merkur',
    );
  });

  test('does not let a selected machine name leak into a non-terminal route', () => {
    expect(documentTitle('shell', DEVICES, 'workshop')).toBe('Machines — Merkur');
  });
});
