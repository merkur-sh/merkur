import type { Plugin } from 'vite';

const MODULE_SCRIPT = /<script type="module"(?![^>]*fetchpriority)/g;

/**
 * Fetches a page's module scripts at low priority.
 *
 * Nothing they do is part of the first paint: `main.ts` wires the forms and
 * questions and leaves everything that moves until after `load`. At the
 * browser's default, high, each counts as a request the first paint waits on,
 * and every chunk it imports after `load` chains behind it. Vite writes the
 * entry's tag itself and drops the attribute from the page's own, so it is
 * set here, on the page Vite wrote.
 */
export function lowPriorityScripts(): Plugin {
  return {
    name: 'merkur-site-low-priority-scripts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, { path }) {
        const lowered = html.replace(MODULE_SCRIPT, '<script type="module" fetchpriority="low"');
        if (lowered === html) throw new Error(`site: ${path} has no module script`);
        return lowered;
      },
    },
  };
}
