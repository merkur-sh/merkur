import type { Command } from '../components/CommandPalette';
import { keybindScopes } from '../hooks/createKeybinds';
import type { AppController } from './createAppController';

/**
 * What the command palette offers.
 *
 * Actions are read out of the keybind registry rather than listed again here,
 * so a binding's label, its keys, and what it does are declared once, on the
 * screen that owns it. The palette then adds the one thing bindings cannot
 * express — an entry per machine, which is what makes it a way to *get*
 * somewhere rather than a menu of verbs.
 *
 * Read inside the palette's own render, so it re-derives when the machine list
 * or the route changes underneath it.
 */
export function shellCommands(controller: AppController): readonly Command[] {
  const machines: Command[] = controller.devices().map((device) => ({
    id: `machine:${device.id}`,
    title: device.status === 'offline' ? `Start ${device.name}` : `Connect to ${device.name}`,
    subtitle:
      device.status === 'offline'
        ? `${device.platform} · stopped`
        : device.status === 'degraded'
          ? `${device.platform} · down`
          : device.platform,
    section: 'Machines',
    run: () => {
      if (device.status === 'offline') void controller.onStartDevice(device.id);
      else void controller.onDeviceSelected(device);
    },
  }));

  const actions: Command[] = keybindScopes()
    .filter((scope) => scope.active())
    .flatMap((scope) =>
      scope.bindings
        .filter((binding) => binding.keyOnly !== true)
        .map((binding) => ({
          id: `${scope.title}:${binding.keys}`,
          title: binding.label,
          section: scope.title === 'Machines' ? 'Actions' : scope.title,
          keys: binding.keys,
          run: binding.run,
        })),
    );

  // Leaving the terminal cannot come from the keybind registry: every bare key
  // on that route belongs to the shell, so there is no binding to read a label
  // off. It sits after the machines, because switching to another machine is
  // the commoner reason to open this from a terminal than closing one.
  const leaveTerminal: readonly Command[] = controller.isTerminal()
    ? [
        {
          id: 'go:devices',
          title: 'Machines',
          subtitle: 'Close this terminal and go back to the list',
          section: 'Go to',
          // `onBack`, not `onGoToDevices`: popping the route alone would leave
          // the session holding its PTY, its transport and the wake lock.
          run: () => void controller.onBack(),
        },
      ]
    : [];

  return [
    ...machines,
    ...leaveTerminal,
    ...actions,
    {
      id: 'account:logout',
      title: 'Log out',
      section: 'Account',
      run: () => void controller.onLogout(),
    },
  ];
}
