import type { DisplayLinkDefinition } from '@merkur/protocol';

/**
 * The URIs the daemon's OSC 8 link ids name, for the session on screen.
 *
 * Display cells carry only ids; the daemon delivers `id → URI` on the reliable
 * control lane. Ids are never reused within one daemon session, so an id a row
 * still shows either resolves to its own URI or not at all. A reset replaces the
 * whole table, which is what bounds it: the daemon resets whenever it retires
 * links, on every snapshot, and on every new Noise session.
 */
export interface LinkDefinitions {
  apply(reset: boolean, links: readonly DisplayLinkDefinition[]): void;
  uri(id: number): string | undefined;
  /** Forget every definition: a session to another daemon names its own ids. */
  clear(): void;
}

export function createLinkDefinitions(): LinkDefinitions {
  const uris = new Map<number, string>();
  return {
    apply(reset, links) {
      if (reset) uris.clear();
      for (const link of links) uris.set(link.id, link.uri);
    },
    uri(id) {
      return uris.get(id);
    },
    clear() {
      uris.clear();
    },
  };
}
