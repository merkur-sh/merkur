import { merkurVersion } from '@merkur/shared';

import { type PerfRow, perfEventToRow } from './perf-row';
import type { TerminalPerfEvent } from './terminal-latency';

/**
 * Turns decoded profiling events into shippable rows, stamping each one with
 * the envelope facts that describe the whole session rather than the event: the
 * Merkur session id it belongs to, and the build that emitted it.
 *
 * # Why they are resolved here
 *
 * Three places could carry them, and only this one is free.
 *
 * Putting them in every ring record would add a slot write to every emitter —
 * per keystroke, per display frame, per render — for values that change once
 * per session and once per build. Leaving them to be reconstructed at query
 * time would mean deriving the window between consecutive `session_start`
 * timestamps, and joining against release tag times, in every query that ever
 * touches this dataset, forever. Resolving them once, on the telemetry worker's
 * cold thread, over a batch that is already materialised and time-sorted, costs
 * neither.
 *
 * # Why the version is on every row rather than on `session_start`
 *
 * So that slicing a release is a `where`, not a join. Putting it on one row
 * kind would leave every query reconstructing the session window again, which
 * is the cost this module exists to remove. A constant string in a columnar
 * store is close to free to hold, and ~30 bytes per row is nothing against
 * `TELEMETRY_SESSION_BYTE_BUDGET`.
 *
 * # Ordering
 *
 * `session_bound` rides the ring rather than arriving by `postMessage` for the
 * same reason the string table does: a message is delivered on a task, so the
 * reader could drain rows past the announcement before it arrived. In the ring
 * it is ordered against the rows it describes by construction, which is what
 * makes a single forward pass correct.
 */
export interface PerfSessionStamper {
  stamp(batch: readonly TerminalPerfEvent[]): PerfRow[];
}

export function createPerfSessionStamper(): PerfSessionStamper {
  // Carried across batches: a session spans many drains, and only the batch
  // containing `session_bound` sees the id announced.
  let currentSessionId = '';
  // Read once per worker. It is a build-time constant folded into the bundle,
  // so re-reading it per row would be a property load for a value that cannot
  // change while this worker exists.
  const version = merkurVersion();

  return {
    stamp(batch: readonly TerminalPerfEvent[]): PerfRow[] {
      const rows = batch.map((event) => {
        const row = perfEventToRow(event);
        // Unconditional: unlike the session id, the build is known before the
        // first event, so no row is ever unattributed to a release.
        row.merkur_version = version;
        return row;
      });
      // First row of the namespace opened by the most recent `session_start`,
      // so the startup window can be back-filled once the id is known.
      let windowStart = 0;

      for (let index = 0; index < batch.length; index += 1) {
        const event = batch[index];
        if (event === undefined) continue;

        if (event.kind === 'session_start') {
          // A new namespace whose id does not exist yet. Clearing rather than
          // inheriting is the point: carrying the previous session's id forward
          // would attribute this session's rows to the wrong trace, which is
          // worse than leaving them unattributed.
          windowStart = index;
          currentSessionId = '';
        } else if (event.kind === 'session_bound') {
          currentSessionId = event.merkurSessionId;
          // Back-fill the ~600 ms startup phase. Those rows belong to this
          // session; the id simply did not exist when they were emitted, and
          // startup is exactly the part worth being able to attribute.
          for (let back = windowStart; back < index; back += 1) {
            const earlier = rows[back];
            if (earlier !== undefined && earlier.kind !== 'recovery_outcome')
              earlier.merkur_session_id = currentSessionId;
          }
        }

        if (event.kind === 'recovery_outcome') continue;
        if (currentSessionId !== '') {
          const row = rows[index];
          if (row !== undefined) row.merkur_session_id = currentSessionId;
        }
      }

      return rows;
    },
  };
}
