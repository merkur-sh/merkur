pub mod commands;
pub mod events;

use std::io::{self, Read, Write};

const FRAME_HEADER_BYTES: usize = 5;
const MAX_PAYLOAD_BYTES: usize = 512 * 1024;

pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    loop {
        let mut header = [0u8; FRAME_HEADER_BYTES];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let kind = header[0];
        let payload_len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if payload_len > MAX_PAYLOAD_BYTES {
            // Oversized frame. The writer should have rejected it before sending
            // (the TS side caps at MAX_SIDECAR_PAYLOAD_BYTES == MAX_PAYLOAD_BYTES),
            // so this is a mismatched/buggy parent. Rather than return a fatal
            // error — which made `main` tear down the whole IPC loop, leaving the
            // daemon alive but permanently deaf to resize / start-session /
            // shutdown — skip exactly the declared payload to stay frame-aligned
            // and continue with the next command.
            tracing::warn!(
                "ipc oversized frame skipped: kind=0x{kind:02x} payload_len={payload_len} max={MAX_PAYLOAD_BYTES}"
            );
            skip_exact(reader, payload_len)?;
            continue;
        }
        let mut payload = vec![0u8; payload_len];
        if payload_len > 0 {
            reader.read_exact(&mut payload)?;
        }
        return Ok(Some((kind, payload)));
    }
}

/// Discard exactly `n` bytes from `reader` in bounded chunks — skips an
/// oversized/garbled frame's payload without a giant allocation and without
/// desyncing the stream. A genuine stream failure (EOF mid-skip) propagates so
/// the caller can tear down cleanly.
fn skip_exact(reader: &mut impl Read, mut n: usize) -> io::Result<()> {
    let mut scratch = [0u8; 16 * 1024];
    while n > 0 {
        let want = n.min(scratch.len());
        reader.read_exact(&mut scratch[..want])?;
        n -= want;
    }
    Ok(())
}

pub fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let payload_len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "payload_too_large"))?;
    let mut header = [0u8; FRAME_HEADER_BYTES];
    header[0] = kind;
    header[1..5].copy_from_slice(&payload_len.to_be_bytes());
    writer.write_all(&header)?;
    if !payload.is_empty() {
        writer.write_all(payload)?;
    }
    Ok(())
}
