import type { WorkerCommand } from '../terminal-worker-protocol';

export const MAX_WORKER_CONTROL_QUEUE_DEPTH = 32;

export interface WorkerControlQueue {
  /** False means a non-superseding ownership command exceeded the hard bound. */
  push(command: WorkerCommand): boolean;
  shift(): WorkerCommand | undefined;
  clear(): void;
  size(): number;
  highWater(): number;
  /** Display/prediction may not overtake one of these commands. */
  hasDataPlaneBarrier(): boolean;
}

type SupersedingClass =
  | 'display-available'
  | 'display-env'
  | 'font-family'
  | 'font-metrics'
  | 'health'
  | 'preedit'
  | 'render-refresh'
  | 'resize'
  | 'rtt'
  | 'theme';

function supersedingClass(command: WorkerCommand): SupersedingClass | null {
  switch (command.kind) {
    case 'display_available':
      return 'display-available';
    case 'display_env':
      return 'display-env';
    case 'font_family_update':
      return 'font-family';
    case 'font_update':
      return 'font-metrics';
    case 'worker_health_check':
      return 'health';
    case 'set_preedit':
      return 'preedit';
    case 'render_refresh':
      return 'render-refresh';
    case 'resize':
      return 'resize';
    case 'rtt_sample':
    case 'srtt_reset':
      return 'rtt';
    case 'theme_update':
      return 'theme';
    default:
      return null;
  }
}

function isObservationBarrier(command: WorkerCommand): boolean {
  switch (command.kind) {
    // These commands either change authenticated ownership or observe/reply
    // from the exact state at their queue position. A later setter must not be
    // moved in front of them while superseding an older setter.
    case 'init':
    case 'session_epoch':
    case 'get_viewport_rows':
    case 'profiling_read_display_ring_boundary':
    case 'profiling_force_display_resync':
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

export function workerControlCommandBlocksDataPlane(command: WorkerCommand): boolean {
  return command.kind === 'init' || command.kind === 'session_epoch' || command.kind === 'shutdown';
}

/**
 * Bounded, allocation-stable control mailbox.
 *
 * State setters are last-writer-wins inside an ownership/observation segment.
 * The old entry is moved to the tail in place, preserving the latest setter's
 * order relative to every other class without `splice`'s removed-item array.
 * Non-superseding commands stay exact; exceeding the fixed bound fails closed
 * rather than retaining an unbounded queue behind an initialization barrier.
 */
export function createWorkerControlQueue(
  capacity = MAX_WORKER_CONTROL_QUEUE_DEPTH,
): WorkerControlQueue {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError('worker control queue capacity must be a positive integer');
  }
  const commands: WorkerCommand[] = [];
  let start = 0;
  let highWater = 0;

  function size(): number {
    return commands.length - start;
  }

  function compact(): void {
    if (start === 0) return;
    if (start >= commands.length) {
      commands.length = 0;
      start = 0;
      return;
    }
    commands.copyWithin(0, start);
    commands.length -= start;
    start = 0;
  }

  function removeAndAppend(index: number, command: WorkerCommand): void {
    commands.copyWithin(index, index + 1);
    commands[commands.length - 1] = command;
  }

  return {
    push(command): boolean {
      if (command.kind === 'shutdown') {
        // Shutdown owns the worker lifetime, so no queued observation or state
        // setter may keep it out of the bounded mailbox. The active async
        // command finishes, then cleanup runs next.
        commands.length = 0;
        start = 0;
        commands.push(command);
        highWater = Math.max(highWater, 1);
        return true;
      }
      const nextClass = supersedingClass(command);
      if (nextClass !== null) {
        for (let index = commands.length - 1; index >= start; index -= 1) {
          const candidate = commands[index];
          if (candidate === undefined) continue;
          if (isObservationBarrier(candidate)) break;
          if (supersedingClass(candidate) === nextClass) {
            removeAndAppend(index, command);
            return true;
          }
        }
      }

      if (size() >= capacity) return false;
      // Keep storage itself bounded too: consumed prefixes cannot be allowed to
      // grow the backing array forever under alternating enqueue/drain traffic.
      if (commands.length >= capacity) compact();
      commands.push(command);
      highWater = Math.max(highWater, size());
      return true;
    },

    shift(): WorkerCommand | undefined {
      if (start >= commands.length) return undefined;
      const command = commands[start];
      start += 1;
      if (start >= commands.length) compact();
      return command;
    },

    clear(): void {
      commands.length = 0;
      start = 0;
    },

    size,

    highWater(): number {
      return highWater;
    },

    hasDataPlaneBarrier(): boolean {
      for (let index = start; index < commands.length; index += 1) {
        const command = commands[index];
        if (command !== undefined && workerControlCommandBlocksDataPlane(command)) return true;
      }
      return false;
    },
  };
}
