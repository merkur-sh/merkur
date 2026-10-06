/** Production SAB ingress into the authenticated Rust Session used by input benchmarks. */
import type { InputRingReader } from '../../apps/web/src/transport/input-ring';
import type { ClientSessionFixture } from './client-session-fixture';

export function createBenchPtyInputLane(peer: ClientSessionFixture, reader: InputRingReader) {
  let admittedThrough = 0;
  return {
    admit() {
      for (;;) {
        const ordinal = reader.tryReadNext();
        if (ordinal < 0) break;
        const length = reader.payloadLength(ordinal);
        const pointer = peer.session.reserve_ingress(length);
        if (pointer === 0) throw new Error('Rust input buffer refused');
        reader.copyPayload(ordinal, new Uint8Array(peer.memory.buffer, pointer, length), 0);
        if (
          !peer.session.input(
            peer.now(),
            reader.localSeq(ordinal),
            length,
            reader.shadowModelled(ordinal),
          )
        )
          throw new Error('Rust input admission refused');
        admittedThrough = ordinal + 1;
      }
    },
    async flush() {
      await peer.settle();
      // Only the authenticated core ACK releases the corresponding SAB slots.
      for (let ordinal = reader.releasedOrdinal(); ordinal < admittedThrough; ordinal++) {
        if (reader.localSeq(ordinal) > peer.session.input_ack_local()) break;
        reader.release(ordinal + 1);
      }
    },
  };
}
