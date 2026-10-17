/**
 * UDP ports for the processes a test starts that take a port as configuration and bind it
 * themselves: the daemon's WebTransport server and the direct-network proxies.
 *
 * Asking the OS for a free port and handing it on races every bind in between, because the OS
 * gives the same port to the next socket that binds port 0: another worker's daemon, the edge,
 * a browser's QUIC socket. These ports sit below every OS's ephemeral range (Linux allocates
 * from 32768, macOS from 49152), so no port-0 bind is ever given one, and above the harnesses'
 * fixed ports (4433-4438, 24321-24352). Each Playwright worker owns a block of its own, by its
 * parallel index, and never hands out a port one of its processes still holds.
 */

const FIRST_PORT = 26_000;
const BLOCK = 400;
/** The first port of the ephemeral ranges, which no block may reach. */
const EPHEMERAL = 32_768;

/** The ports this worker's processes hold. */
const held = new Set<number>();
let cursor = 0;

function blockStart(): number {
  const index = Number(process.env.TEST_PARALLEL_INDEX);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('harness ports are handed out inside a Playwright worker');
  }
  const block = FIRST_PORT + index * BLOCK;
  if (block + BLOCK > EPHEMERAL) {
    throw new Error(`parallel index ${index} has no port block below the ephemeral range`);
  }
  return block;
}

/**
 * A port of this worker's block that none of its processes holds, held until
 * `releaseHarnessPort`. The block is walked in turn, so a released port is the last taken again.
 */
export function takeHarnessPort(): number {
  const block = blockStart();
  for (let step = 0; step < BLOCK; step += 1) {
    const offset = (cursor + step) % BLOCK;
    if (held.has(block + offset)) continue;
    cursor = (offset + 1) % BLOCK;
    held.add(block + offset);
    return block + offset;
  }
  throw new Error(`all ${BLOCK} ports of this worker's block are held`);
}

/** Returns a port once the process that bound it has exited. */
export function releaseHarnessPort(port: number): void {
  held.delete(port);
}
