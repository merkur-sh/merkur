//! Byte-renormalized rANS with one or two interleaved states.

use super::model::EncodeSymbol;

/// The lower bound of a normalized state.
pub(super) const RANS_L: u32 = 1 << 23;

/// Encode `coded`, each an index into `symbols`, symbol `i` with state
/// `i % ways`, into `out` (appended).
///
/// The output opens with the final states, big-endian, then the
/// renormalization bytes in the order the decoder reads them. Every state
/// starts at `RANS_L`, so a decoder that does not end there on every state, or
/// does not consume exactly the payload, has read a corrupt one.
pub(super) fn encode(
    symbols: &[EncodeSymbol],
    coded: &[u32],
    ways: usize,
    scratch: &mut Vec<u8>,
    out: &mut Vec<u8>,
) {
    scratch.clear();
    let mut states = [RANS_L; 2];
    let way_mask = ways - 1;
    for (index, &id) in coded.iter().enumerate().rev() {
        let symbol = &symbols[id as usize];
        let state = &mut states[index & way_mask];
        while *state >= symbol.x_max {
            scratch.push(*state as u8);
            *state >>= 8;
        }
        // `state / freq` by its reciprocal; exact for every state below
        // `x_max` (Giesen, "rANS with static probability distributions").
        let quotient =
            ((u64::from(*state) * u64::from(symbol.rcp_freq)) >> 32) as u32 >> symbol.rcp_shift;
        *state += symbol.bias + quotient * u32::from(symbol.cmpl_freq);
    }
    for state in &states[..ways] {
        out.extend_from_slice(&state.to_be_bytes());
    }
    out.extend(scratch.iter().rev());
}

pub(super) struct Decoder<'a> {
    states: [u32; 2],
    next: usize,
    /// `ways - 1`: the bit of `next` that picks the state.
    way_mask: usize,
    ways: usize,
    buf: &'a [u8],
    at: usize,
}

impl<'a> Decoder<'a> {
    pub(super) fn new(buf: &'a [u8], ways: usize) -> Option<Self> {
        let state = |at: usize| {
            buf.get(at..at + 4)
                .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
        };
        let first = state(0)?;
        let second = if ways == 2 { state(4)? } else { RANS_L };
        // A state below the bound never came from the encoder, and decoding
        // from one would read renormalization bytes it never wrote.
        if first < RANS_L || second < RANS_L {
            return None;
        }
        Some(Self {
            states: [first, second],
            next: 0,
            way_mask: ways - 1,
            ways,
            buf,
            at: 4 * ways,
        })
    }

    /// Decode one symbol with the table `handle` names in `slots` (see
    /// `DecodeModel`).
    #[inline(always)]
    pub(super) fn get(&mut self, slots: &[u32], handle: u32) -> usize {
        let way = self.next & self.way_mask;
        self.next += 1;
        let state = &mut self.states[way & 1];
        let bits = handle & 0xf;
        let mask = (1u32 << bits) - 1;
        // SAFETY: a handle names a table `DecodeModel::build` laid out as
        // `1 << bits` slots from `offset`, so the masked index is in the
        // arena. With the context index load beside it, the checked loads
        // cost a third of MZ decode time on recorded sessions; this is the
        // inner loop.
        let entry = unsafe { *slots.get_unchecked(((handle >> 4) + (*state & mask)) as usize) };
        let freq = ((entry >> 9) & 0x7ff) + 1;
        *state = freq * (*state >> bits) + (entry >> 20);
        // A state the slot left below the bound takes at most two bytes. Past
        // the payload's end it reads zeros, and `finish` refuses the frame.
        if *state < RANS_L {
            // A state at or above `RANS_L` leaves the step at least
            // `RANS_L >> PROB_BITS`, so two bytes always renormalize it.
            let byte = |at: usize| u32::from(self.buf.get(at).copied().unwrap_or(0));
            *state = (*state << 8) | byte(self.at);
            self.at += 1;
            if *state < RANS_L {
                *state = (*state << 8) | byte(self.at);
                self.at += 1;
            }
        }
        (entry & 0x1ff) as usize
    }

    /// Whether the decode ended exactly where the encoder began.
    pub(super) fn finish(&self) -> bool {
        self.at == self.buf.len()
            && self.states[..self.ways]
                .iter()
                .all(|&state| state == RANS_L)
    }
}
