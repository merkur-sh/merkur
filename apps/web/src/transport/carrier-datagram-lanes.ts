// Outgoing datagrams, one lane per carrier.
//
// A carrier takes one native write at a time, in the order the session emitted
// them. The session's I/O drain offers a datagram and moves on. A WebTransport
// that died while the page was suspended can stay open with a write that never
// settles; such a write holds that carrier's later datagrams and nothing else,
// so the dial that replaces the carrier is never queued behind it.

interface DatagramCarrier {
  datagram(payload: Uint8Array): Promise<void>;
}

interface Lane<C> {
  readonly carrier: C;
  /** The datagram the carrier is writing, and the input it covers. */
  payload: Uint8Array | null;
  inputTop: number;
  readonly queuedPayloads: Uint8Array[];
  readonly queuedInputTops: number[];
  retired: boolean;
  readonly written: () => void;
  readonly refused: () => void;
}

export interface CarrierDatagramLanes<C> {
  /**
   * Send `payload` on `carrier` after `conn`'s earlier datagrams. The lanes
   * own the payload from here and zero it once the carrier settles its write
   * or the lane is retired.
   */
  offer(conn: bigint, carrier: C, payload: Uint8Array, inputTop: number): void;
  /** Forget `conn`: its unwritten datagrams are dropped and nothing of it settles. */
  retire(conn: bigint): void;
  clear(): void;
}

/**
 * `settled` hears each datagram a live lane's carrier took (`sent`) or refused,
 * with the input sequence it covered, its channel and its length.
 */
export function createCarrierDatagramLanes<C extends DatagramCarrier>(
  settled: (
    conn: bigint,
    carrier: C,
    sent: boolean,
    inputTop: number,
    channel: number,
    byteLength: number,
  ) => void,
): CarrierDatagramLanes<C> {
  const lanes = new Map<bigint, Lane<C>>();

  function write(lane: Lane<C>, payload: Uint8Array, inputTop: number): void {
    lane.payload = payload;
    lane.inputTop = inputTop;
    lane.carrier.datagram(payload).then(lane.written, lane.refused);
  }

  function finish(conn: bigint, lane: Lane<C>, sent: boolean): void {
    const payload = lane.payload;
    if (payload === null) return;
    const channel = payload[0] ?? 0;
    payload.fill(0);
    lane.payload = null;
    if (lane.retired) return;
    settled(conn, lane.carrier, sent, lane.inputTop, channel, payload.byteLength);
    // `settled` may have retired the lane, or offered it a datagram.
    if (lane.retired || lane.payload !== null) return;
    const next = lane.queuedPayloads.shift();
    if (next !== undefined) write(lane, next, lane.queuedInputTops.shift() ?? 0);
  }

  function retire(conn: bigint): void {
    const lane = lanes.get(conn);
    if (lane === undefined) return;
    lanes.delete(conn);
    lane.retired = true;
    for (const payload of lane.queuedPayloads) payload.fill(0);
    lane.queuedPayloads.length = 0;
    lane.queuedInputTops.length = 0;
  }

  return {
    offer(conn, carrier, payload, inputTop): void {
      let lane = lanes.get(conn);
      if (lane === undefined) {
        const created: Lane<C> = {
          carrier,
          payload: null,
          inputTop: 0,
          queuedPayloads: [],
          queuedInputTops: [],
          retired: false,
          written: () => finish(conn, created, true),
          refused: () => finish(conn, created, false),
        };
        lanes.set(conn, created);
        lane = created;
      }
      if (lane.payload !== null) {
        lane.queuedPayloads.push(payload);
        lane.queuedInputTops.push(inputTop);
        return;
      }
      write(lane, payload, inputTop);
    },

    retire,

    clear(): void {
      for (const conn of [...lanes.keys()]) retire(conn);
    },
  };
}
