import 'virtual:uno.css';
import { render } from '@solidjs/web';
import App from './App';
import { RegistryProvider } from './lib/atom-solid';

// One atom registry for the whole app: the device-events recovery loop and the
// state it publishes are atoms, and they must be the same atoms everything
// reads. `defaultIdleTTL` only affects atoms that are not kept alive.
render(
  () => (
    <RegistryProvider>
      <App />
    </RegistryProvider>
  ),
  document.body,
);

// The shell's boot splash has done its job the moment Solid's own splash is in
// the DOM. Removed after `render` rather than on a later edge because the two
// are laid out identically: anything that lets both exist across a paint shows
// the wordmark twice, and anything later leaves a static disc sitting over the
// live orb.
document.getElementById('boot-splash')?.remove();
