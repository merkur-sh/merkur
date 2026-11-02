import { afterAll, beforeAll, describe, test } from 'bun:test';

import { type Capabilities, scenariosFor } from './conformance';
import { installIndexedDb, installStorage, removeGlobal, restoreGlobals } from './test-environment';

// The same scenarios `engines.test.ts` runs in real browsers, here against
// `fake-indexeddb` and in-memory web storage: a page, and a worker without web storage.
const REALMS: readonly { readonly name: string; readonly capabilities: Capabilities }[] = [
  { name: 'page', capabilities: { indexedDB: true, webStorage: true } },
  { name: 'worker', capabilities: { indexedDB: true, webStorage: false } },
];

for (const realm of REALMS) {
  describe(`conformance in a ${realm.name}`, () => {
    beforeAll(() => {
      installIndexedDb();
      if (realm.capabilities.webStorage) {
        installStorage('localStorage');
        installStorage('sessionStorage');
      } else {
        removeGlobal('localStorage');
        removeGlobal('sessionStorage');
      }
    });
    afterAll(restoreGlobals);

    for (const scenario of scenariosFor(realm.capabilities)) {
      // A scenario throws, naming what it saw, when the behaviour differs.
      test(scenario.name, () => scenario.run());
    }
  });
}
