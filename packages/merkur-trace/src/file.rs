//! The capture file, `.mtrace`: little-endian `u64` words after an 8-byte magic. A string is
//! its byte length then its UTF-8 bytes, zero-padded to a word. In order:
//!
//! 1. `MRKTRACE`
//! 2. owner, observation epoch, dropped, stale, discontinuous (0 or 1), clock domain
//!    (1 = macOS `CLOCK_UPTIME_RAW`, 2 = Linux `CLOCK_MONOTONIC`), the origin on that
//!    clock in nanoseconds, the clock mapping's error bound in nanoseconds
//! 3. peer id, session id
//! 4. site count, then each site's name by id from 1 (empty for an unclaimed id)
//! 5. evidence count, then per record: ordinal, nanoseconds since origin, site, 16 fields
//! 6. span count, then per event: the writing thread's system id, site with the phase in
//!    bits 32..40 (1 begin, 2 end, 3 mark), nanoseconds since origin, value
//!
//! `tools/profile/src/mtrace.ts` reads it; `testdata/capture.mtrace` pins both sides.

use std::io::{self, Write};

use crate::clock;
use crate::recorder::Snapshot;

const MAGIC: &[u8; 8] = b"MRKTRACE";

impl Snapshot {
    /// Writes the capture. Cold work: the caller buffers `out`.
    pub fn write_to(&self, out: &mut impl Write) -> io::Result<()> {
        out.write_all(MAGIC)?;
        for word in [
            self.owner.owner,
            u64::from(self.owner.observation_epoch),
            self.dropped,
            self.stale,
            u64::from(self.discontinuous),
            clock::DOMAIN,
            self.origin_anchor_ns,
            self.clock_error_ns,
        ] {
            write_word(out, word)?;
        }
        write_string(out, &self.owner.peer_id)?;
        write_string(out, &self.owner.session_id)?;
        write_word(out, self.sites.len() as u64)?;
        for site in &self.sites {
            write_string(out, site.unwrap_or(""))?;
        }
        write_word(out, self.evidence.len() as u64)?;
        for record in &self.evidence {
            for word in [record.ordinal, record.at_ns, u64::from(record.site)] {
                write_word(out, word)?;
            }
            for field in record.fields {
                write_word(out, field)?;
            }
        }
        write_word(out, self.spans.len() as u64)?;
        for event in &self.spans {
            for word in [
                event.thread,
                u64::from(event.site) | (u64::from(event.phase) << 32),
                event.at_ns,
                event.arg,
            ] {
                write_word(out, word)?;
            }
        }
        Ok(())
    }
}

fn write_word(out: &mut impl Write, word: u64) -> io::Result<()> {
    out.write_all(&word.to_le_bytes())
}

fn write_string(out: &mut impl Write, value: &str) -> io::Result<()> {
    write_word(out, value.len() as u64)?;
    out.write_all(value.as_bytes())?;
    let padding = (8 - value.len() % 8) % 8;
    out.write_all([0; 8].get(..padding).unwrap_or(&[]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recorder::{Evidence, Owner, SpanEvent};

    /// One capture of every record class, fixed so the TypeScript reader's test reads the
    /// same bytes. Regenerate with `MERKUR_TRACE_BLESS=1` after a format change, and move
    /// `tools/profile/src/mtrace.test.ts` with it.
    fn fixture() -> Snapshot {
        Snapshot {
            owner: Owner {
                owner: 7,
                peer_id: "peer-a".to_owned(),
                session_id: "session-12345678".to_owned(),
                observation_epoch: 3,
            },
            evidence: vec![
                Evidence {
                    ordinal: 11,
                    at_ns: 1_500,
                    site: 1,
                    fields: [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, u64::MAX >> 11],
                },
                Evidence {
                    ordinal: 12,
                    at_ns: 2_999,
                    site: 2,
                    fields: [0; 16],
                },
            ],
            spans: vec![
                SpanEvent {
                    thread: 1_001,
                    site: 3,
                    phase: 1,
                    at_ns: 1_000,
                    arg: 0,
                },
                SpanEvent {
                    thread: 1_001,
                    site: 3,
                    phase: 2,
                    at_ns: 4_000,
                    arg: 0,
                },
                SpanEvent {
                    thread: 1_002,
                    site: 4,
                    phase: 3,
                    at_ns: 2_500,
                    arg: 640,
                },
            ],
            dropped: 1,
            stale: 2,
            discontinuous: false,
            sites: vec![
                Some("display_member"),
                Some("quic_datagram"),
                Some("display.flush"),
                Some("channel.hop"),
                None,
            ],
            origin_anchor_ns: 235_904_375_849_958,
            clock_error_ns: 84,
        }
    }

    #[test]
    fn the_capture_file_matches_the_pinned_fixture() {
        let mut bytes = Vec::new();
        fixture().write_to(&mut bytes).unwrap();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/capture.mtrace");
        if std::env::var_os("MERKUR_TRACE_BLESS").is_some() {
            std::fs::write(path, &bytes).unwrap();
        }
        // The pinned bytes name macOS's clock domain; Linux writes its own.
        let mut expected = include_bytes!("../testdata/capture.mtrace").to_vec();
        expected[8 + 5 * 8..8 + 6 * 8].copy_from_slice(&clock::DOMAIN.to_le_bytes());
        assert_eq!(bytes, expected);
        assert_eq!(bytes.len() % 8, 0);
    }
}
