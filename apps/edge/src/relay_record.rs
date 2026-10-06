//! Validate record framing while retaining the received wire storage. No body
//! inspection, contiguous staging, or waiting for a body to complete a header.

use bytes::Bytes;

use super::{RELIABLE_RECORD_HEADER_BYTES, ReliableLaneError, reliable_body_len_from_header};

pub(super) struct RecordHead {
    header: [u8; RELIABLE_RECORD_HEADER_BYTES],
    header_len: usize,
    // A four-byte header spans at most four nonempty receive chunks. Its last
    // chunk also carries any already-received body prefix in the same admission.
    chunks: [Bytes; RELIABLE_RECORD_HEADER_BYTES],
    count: usize,
    body_len: usize,
    remaining: usize,
}

impl RecordHead {
    pub(super) fn new() -> Self {
        Self {
            header: [0; RELIABLE_RECORD_HEADER_BYTES],
            header_len: 0,
            chunks: [const { Bytes::new() }; RELIABLE_RECORD_HEADER_BYTES],
            count: 0,
            body_len: 0,
            remaining: 0,
        }
    }

    /// Consume header fragments and the final fragment's body prefix. Leave
    /// following records in `chunk`; never forward an unvalidated header.
    pub(super) fn push(&mut self, chunk: &mut Bytes) -> Result<bool, ReliableLaneError> {
        debug_assert!(!chunk.is_empty());
        debug_assert!(self.header_len < self.header.len());
        let header_bytes = chunk.len().min(self.header.len() - self.header_len);
        self.header[self.header_len..self.header_len + header_bytes]
            .copy_from_slice(&chunk[..header_bytes]);
        self.header_len += header_bytes;
        let complete = self.header_len == self.header.len();
        let body_bytes = if complete {
            self.body_len = reliable_body_len_from_header(&self.header)
                .ok_or(ReliableLaneError::InvalidLength)?;
            let body_bytes = self.body_len.min(chunk.len() - header_bytes);
            self.remaining = self.body_len - body_bytes;
            body_bytes
        } else {
            0
        };
        self.chunks[self.count] = chunk.split_to(header_bytes + body_bytes);
        self.count += 1;
        Ok(complete)
    }

    pub(super) fn body_len(&self) -> usize {
        self.body_len
    }

    pub(super) fn remaining(&self) -> usize {
        self.remaining
    }

    pub(super) fn chunks_mut(&mut self) -> &mut [Bytes] {
        &mut self.chunks[..self.count]
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "relay_record_profile.rs"]
mod profile;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::splice::MAX_RELIABLE_BODY;

    #[test]
    fn every_header_fragmentation_retains_exact_storage_and_following_record() {
        for body_len in [0usize, 1, 57, 1100, 16384] {
            let mut wire = Vec::new();
            wire.extend_from_slice(&(body_len as u32).to_be_bytes());
            wire.resize(4 + body_len, 0x5a);
            wire.extend_from_slice(b"next");
            let wire = Bytes::from(wire);
            // All eight partitions of a four-byte header, including a final
            // receive chunk containing this body and the next record's header.
            for cuts in 0..8 {
                let mut head = RecordHead::new();
                let mut start = 0;
                for end in 1..4 {
                    if cuts & (1 << (end - 1)) != 0 {
                        let mut chunk = wire.slice(start..end);
                        assert!(!head.push(&mut chunk).unwrap());
                        assert!(chunk.is_empty());
                        start = end;
                    }
                }
                let mut last = wire.slice(start..);
                assert!(head.push(&mut last).unwrap());
                assert_eq!(head.body_len(), body_len);
                assert_eq!(head.remaining(), 0);
                assert_eq!(&last[..], b"next");
                let mut offset = 0;
                for chunk in head.chunks_mut() {
                    assert_eq!(chunk.as_ptr(), wire[offset..].as_ptr());
                    assert_eq!(&chunk[..], &wire[offset..offset + chunk.len()]);
                    offset += chunk.len();
                }
                assert_eq!(offset, 4 + body_len);
            }
        }
    }

    #[test]
    fn header_does_not_wait_for_body_and_never_materializes_declared_length() {
        let wire = Bytes::copy_from_slice(&(MAX_RELIABLE_BODY as u32).to_be_bytes());
        let mut chunk = wire.clone();
        let mut head = RecordHead::new();
        assert!(head.push(&mut chunk).unwrap());
        assert_eq!(head.remaining(), MAX_RELIABLE_BODY);
        assert_eq!(head.chunks_mut().len(), 1);
        assert_eq!(head.chunks_mut()[0].as_ptr(), wire.as_ptr());
    }

    #[test]
    fn oversized_header_is_rejected_before_any_admission() {
        let mut chunk = Bytes::copy_from_slice(&((MAX_RELIABLE_BODY + 1) as u32).to_be_bytes());
        let mut head = RecordHead::new();
        assert_eq!(head.push(&mut chunk), Err(ReliableLaneError::InvalidLength));
        assert!(head.chunks_mut().is_empty());
    }

    #[test]
    fn partial_body_accounts_only_bytes_consumed_from_source() {
        let mut chunk = Bytes::from_static(b"\0\0\0\x09abc");
        let pointer = chunk.as_ptr();
        let mut head = RecordHead::new();
        assert!(head.push(&mut chunk).unwrap());
        assert_eq!(head.body_len(), 9);
        assert_eq!(head.remaining(), 6);
        assert_eq!(head.chunks_mut()[0].as_ptr(), pointer);
        assert_eq!(head.chunks_mut()[0].len(), 7);
        assert!(chunk.is_empty());
    }
}
