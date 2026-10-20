use merkur_codec::mz::{MzEncoder, MzReference};
use merkur_codec::{
    DISPLAY_HEADER_FLAG_COMPRESSED_MZ, DISPLAY_HEADER_FLAGS_OFFSET, FRAME_HEADER_BODY_BYTES,
    MSG_TYPE_DISPLAY_PATCH, STREAM_HEADER_BYTES,
};
use std::time::{Duration, Instant};

pub struct Compressor {
    mz: MzEncoder,
    references: Vec<Option<MzReference>>,
    /// Profiling-only accumulator around the complete compression stage,
    /// including validation and rejected outputs. Disabled in normal operation,
    /// so an unprofiled attempt pays one predictable false branch and no clock.
    timing_enabled: bool,
    timed_compression: Duration,
    #[cfg(test)]
    display_frame_compression_attempts: usize,
}

/// Measurement arms only: `mz_census` runs the same replay with MZ off to
/// price it against raw frames, and `mz_train_model` counts every frame MZ
/// codes.
#[cfg(test)]
pub(crate) static MZ_DISABLED_FOR_CENSUS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// CPU the compression attempts took, for `mz_census`.
#[cfg(test)]
pub(crate) static CENSUS_MZ_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(test)]
pub(crate) static MZ_TRAINER: std::sync::Mutex<Option<merkur_codec::mz::train::MzTrainer>> =
    std::sync::Mutex::new(None);

/// What one successful compression produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompressedFrame {
    /// Bytes saved against the frame as given.
    pub saved_bytes: usize,
    /// At least one entry is a reference. A receiver that cannot resolve one
    /// refuses the frame; losing it retires the references the peer's index
    /// holds.
    pub references: bool,
}

impl Compressor {
    pub fn new() -> Self {
        Self {
            mz: MzEncoder::default(),
            references: Vec::new(),
            timing_enabled: false,
            timed_compression: Duration::ZERO,
            #[cfg(test)]
            display_frame_compression_attempts: 0,
        }
    }

    /// Start one display-preparation timing scope.
    pub(crate) fn begin_timing(&mut self, enabled: bool) {
        self.timing_enabled = enabled;
        self.timed_compression = Duration::ZERO;
    }

    /// End the current scope and return time spent inside compression attempts.
    pub(crate) fn take_timed_compression(&mut self) -> Duration {
        self.timing_enabled = false;
        std::mem::take(&mut self.timed_compression)
    }

    /// Compress a display frame into `out`, the caller's buffer, returning the
    /// bytes saved when compression applies and `None` when it does not (the
    /// frame has no row payload, is already compressed, is not a display patch,
    /// its rows do not parse, or it would not shrink). The payload is the MZ
    /// coding of the rows ([`merkur_codec::mz`]), behind the envelope's
    /// row-body length. There is no material-savings threshold: after MZ runs,
    /// the planner decides from the complete actual packet cost. `out` holds
    /// the compressed frame on `Some` and is cleared otherwise; both display
    /// arms pass a pooled frame, so a successful compression allocates nothing.
    pub fn compress_display_frame_into(
        &mut self,
        frame: &[u8],
        out: &mut Vec<u8>,
    ) -> Option<usize> {
        self.compress_display_rows_into(frame, std::iter::empty(), out)
            .map(|compressed| compressed.saved_bytes)
    }

    /// [`Self::compress_display_frame_into`], with `references` offering a
    /// reference for each of the frame's entries in order. Each is taken
    /// exactly when it codes smaller than its literal.
    pub fn compress_display_rows_into(
        &mut self,
        frame: &[u8],
        references: impl IntoIterator<Item = Option<MzReference>>,
        out: &mut Vec<u8>,
    ) -> Option<CompressedFrame> {
        let started_at = self.timing_enabled.then(Instant::now);
        self.references.clear();
        self.references.extend(references);
        #[cfg(test)]
        let census_started = Instant::now();
        let result = self.compress_mz(frame, out);
        if result.is_none() {
            out.clear();
        }
        #[cfg(test)]
        CENSUS_MZ_NS.fetch_add(
            census_started.elapsed().as_nanos() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        if let Some(started_at) = started_at {
            self.timed_compression += started_at.elapsed();
        }
        result
    }

    /// Code `frame`'s rows as MZ into `out`. `None` when the frame is not one
    /// to compress or MZ would not shrink it.
    fn compress_mz(&mut self, frame: &[u8], out: &mut Vec<u8>) -> Option<CompressedFrame> {
        out.clear();
        let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
        if frame.len() <= rows_offset
            || frame.len() > merkur_codec::MAX_DISPLAY_FRAME_BYTES
            || frame[0] != MSG_TYPE_DISPLAY_PATCH
            || frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_MZ != 0
        {
            return None;
        }
        let row_count = u16::from_be_bytes([
            frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
            frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
        ]);
        #[cfg(test)]
        {
            self.display_frame_compression_attempts += 1;
            if MZ_DISABLED_FOR_CENSUS.load(std::sync::atomic::Ordering::Relaxed) {
                return None;
            }
            if let Some(trainer) = MZ_TRAINER.lock().expect("trainer").as_mut() {
                trainer.add_rows(&frame[rows_offset..], row_count, &self.references);
            }
        }
        // The raw frame's capacity: the pooled buffer then carries this frame
        // raw when the planner's next choice is raw, and coding never grows it
        // until the output is already larger than raw.
        out.reserve(frame.len());
        out.extend_from_slice(&frame[..rows_offset]);
        out.extend_from_slice(&[0; 4]);
        let rows_len = self
            .mz
            .encode(&frame[rows_offset..], row_count, &self.references, out)?;
        let frame_len = out.len();
        if frame_len >= frame.len()
            || rows_offset + rows_len > merkur_codec::MAX_DISPLAY_FRAME_BYTES
        {
            return None;
        }
        out[rows_offset..rows_offset + 4].copy_from_slice(&(rows_len as u32).to_be_bytes());
        out[DISPLAY_HEADER_FLAGS_OFFSET] =
            frame[DISPLAY_HEADER_FLAGS_OFFSET] | DISPLAY_HEADER_FLAG_COMPRESSED_MZ;
        out[merkur_codec::DISPLAY_BODY_LENGTH_OFFSET..merkur_codec::DISPLAY_BODY_LENGTH_OFFSET + 4]
            .copy_from_slice(&((frame_len - STREAM_HEADER_BYTES) as u32).to_be_bytes());
        Some(CompressedFrame {
            saved_bytes: frame.len() - frame_len,
            references: self.mz.references_taken() > 0,
        })
    }

    #[cfg(test)]
    pub(crate) fn display_frame_compression_attempts(&self) -> usize {
        self.display_frame_compression_attempts
    }
}

/// Decode a compressed frame's MZ payload as the browser does. Production
/// decodes in term-wasm; this is the native harnesses' reading of the same
/// bytes, and it resolves no references.
#[cfg(test)]
pub(crate) fn decode_display_payload(frame: &[u8]) -> std::io::Result<Vec<u8>> {
    let invalid = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, what);
    struct NoReferences;
    impl merkur_codec::mz::MzResolve for NoReferences {
        fn resolve(
            &mut self,
            _: u16,
            _: MzReference,
            _: &mut Vec<u8>,
        ) -> Result<(), merkur_codec::mz::MzError> {
            Err(merkur_codec::mz::MzError::Unresolved)
        }
    }
    if frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_MZ == 0 {
        return Err(invalid("not a compressed frame"));
    }
    let length_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let declared = u32::from_be_bytes(
        frame
            .get(length_offset..length_offset + 4)
            .ok_or_else(|| invalid("compressed frame shorter than its envelope"))?
            .try_into()
            .expect("four bytes"),
    ) as usize;
    let row_count = u16::from_be_bytes([
        frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
        frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
    ]);
    let mut rows = Vec::new();
    merkur_codec::mz::decode_mz_rows(
        &frame[merkur_codec::DISPLAY_COMPRESSED_PAYLOAD_OFFSET..],
        row_count,
        declared,
        &mut NoReferences,
        &mut rows,
    )
    .map_err(|_| invalid("mz payload"))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_codec::{
        CellRepr, DISPLAY_HEADER_BODY_LENGTH_OFFSET, FrameHeader, FrameKind, RowRef,
        encode_frame_into,
    };

    const COLS: usize = 120;

    fn cell(c: char) -> CellRepr {
        CellRepr {
            codepoint: c as u32,
            ..CellRepr::BLANK
        }
    }

    fn row_cells(text: &str) -> Vec<CellRepr> {
        let mut cells: Vec<CellRepr> = text.chars().take(COLS).map(cell).collect();
        cells.resize(COLS, cell(' '));
        cells
    }

    /// A line from a realistic terminal workload: repetitive in structure but
    /// varying in detail.
    fn log_line(index: usize) -> String {
        const LEVELS: [&str; 3] = ["INFO", "WARN", "DEBUG"];
        const SCOPES: [&str; 4] = ["display", "transport", "session", "pty"];
        format!(
            "2026-08-05T08:{:02}:{:02}.{:03}Z {} scope={} peer=browser-{:02} seq={} bytes={}",
            index % 60,
            (index * 7) % 60,
            (index * 131) % 1000,
            LEVELS[index % LEVELS.len()],
            SCOPES[(index / 3) % SCOPES.len()],
            index % 8,
            1000 + index,
            256 + (index * 37) % 4096,
        )
    }

    /// Encode a display delta the way the daemon does: only the rows that
    /// changed, each trimmed to its changed span.
    fn delta_frame(rows: &[(u16, String)]) -> Vec<u8> {
        let header = FrameHeader {
            memory_only: false,
            kind: FrameKind::Delta,
            cols: COLS as u16,
            rows: 40,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 1,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: rows.len() as u16,
            frame_id: 1,
            presentation_id: 0,
            presentation_member_index: 0,
            presentation_member_count: 0,
            row_predecessor_presentation_id: 0,
            presentation_coherent: false,
            presentation_end: false,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let cells: Vec<Vec<CellRepr>> = rows.iter().map(|(_, text)| row_cells(text)).collect();
        let mut frame = Vec::new();
        encode_frame_into(
            &mut frame,
            &header,
            rows.iter().enumerate().map(|(index, (row, _))| RowRef {
                graphics: &[],
                row_index: *row,
                left: 0,
                cells: &cells[index],
            }),
        );
        frame[0] = MSG_TYPE_DISPLAY_PATCH;
        let body_len = frame.len() - STREAM_HEADER_BYTES;
        frame[DISPLAY_HEADER_BODY_LENGTH_OFFSET..DISPLAY_HEADER_BODY_LENGTH_OFFSET + 2]
            .copy_from_slice(&(body_len as u16).to_be_bytes());
        frame
    }

    /// What one compression attempt produced, for tests that read the frame.
    struct Attempt {
        frame: Vec<u8>,
        saved_bytes: usize,
    }

    /// Compress into a fresh buffer, the way the production arms compress into
    /// a pooled one.
    fn compress(compressor: &mut Compressor, frame: &[u8]) -> Option<Attempt> {
        let mut out = Vec::new();
        let saved_bytes = compressor.compress_display_frame_into(frame, &mut out)?;
        Some(Attempt {
            frame: out,
            saved_bytes,
        })
    }

    #[test]
    fn compress_display_frame_round_trips_and_reports_real_savings() {
        let frame = delta_frame(
            &(0..20)
                .map(|index| (index as u16, log_line(index)))
                .collect::<Vec<_>>(),
        );
        let attempt =
            compress(&mut Compressor::new(), &frame).expect("a 20-row log delta must compress");

        assert_eq!(attempt.frame.len() + attempt.saved_bytes, frame.len());
        assert_ne!(
            attempt.frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_MZ,
            0
        );
        assert_eq!(
            decode_display_payload(&attempt.frame).expect("browser-equivalent decode"),
            frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..]
        );
    }

    #[test]
    fn an_already_compressed_frame_is_not_recompressed() {
        let frame = delta_frame(&[(0, log_line(1))]);
        let mut compressor = Compressor::new();
        let once = compress(&mut compressor, &frame).expect("first pass compresses");
        assert!(compress(&mut compressor, &once.frame).is_none());
    }

    #[test]
    fn a_non_display_frame_or_header_only_frame_is_refused() {
        let mut compressor = Compressor::new();
        assert!(compress(&mut compressor, &[]).is_none());
        assert!(compress(&mut compressor, &[0u8; STREAM_HEADER_BYTES]).is_none());
        let mut wrong_type = delta_frame(&[(0, log_line(2))]);
        wrong_type[0] = 0x21;
        assert!(compress(&mut compressor, &wrong_type).is_none());
    }

    #[test]
    fn compression_writes_byte_exact_frames_into_reused_storage() {
        use crate::edge_tunnel::test_allocations;

        let mut compressor = Compressor::new();
        let mut out = Vec::new();
        for target in [65_536, 300, 4_096, 512, 16_384, 1_100] {
            let frame = benchmark_frame_of_at_least(target);
            let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
            let rows = &frame[rows_offset..];
            let row_count = u16::from_be_bytes([
                frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET],
                frame[merkur_codec::DISPLAY_ROW_COUNT_OFFSET + 1],
            ]);
            let mut expected = frame[..rows_offset].to_vec();
            expected.extend_from_slice(&(rows.len() as u32).to_be_bytes());
            let rows_len = MzEncoder::default()
                .encode(rows, row_count, &[], &mut expected)
                .expect("rows code");
            assert_eq!(rows_len, rows.len());
            expected[DISPLAY_HEADER_FLAGS_OFFSET] |= DISPLAY_HEADER_FLAG_COMPRESSED_MZ;
            let body_len = (expected.len() - STREAM_HEADER_BYTES) as u32;
            expected[2..6].copy_from_slice(&body_len.to_be_bytes());
            let saved = compressor.compress_display_frame_into(&frame, &mut out);
            assert_eq!(saved, Some(frame.len() - expected.len()));
            assert_eq!(out, expected);
            let pointer = out.as_ptr();
            let capacity = out.capacity();

            test_allocations::begin_thread();
            for _ in 0..128 {
                std::hint::black_box(compressor.compress_display_frame_into(&frame, &mut out));
            }
            let tally = test_allocations::end_thread();
            assert_eq!(tally.allocations, 0, "target={target}");
            assert_eq!(tally.allocated_bytes, 0, "target={target}");
            assert_eq!(out.as_ptr(), pointer);
            assert_eq!(out.capacity(), capacity);
            assert_eq!(out, expected);
        }
    }

    #[test]
    fn refused_compression_clears_output_and_preserves_reuse() {
        use crate::edge_tunnel::test_allocations;

        let frame = delta_frame(&[(0, log_line(1))]);
        let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
        let mut tiny = frame[..rows_offset].to_vec();
        tiny.push(0);
        // The compressor reads the envelope and the row layout. Random body
        // bytes are rows MZ cannot carry, refused as a jumbo incompressible
        // snapshot is, without constructing a terminal fixture.
        let mut oversized = frame[..rows_offset].to_vec();
        let mut random = 0x4d45_5243_u32;
        for _ in 0..131_072 {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            oversized.push(random as u8);
        }
        let mut compressor = Compressor::new();
        let mut out = Vec::new();
        for rejected in [&tiny, &oversized] {
            assert!(
                compressor
                    .compress_display_frame_into(&frame, &mut out)
                    .is_some()
            );
            assert!(
                compressor
                    .compress_display_frame_into(rejected, &mut out)
                    .is_none()
            );
            assert!(out.is_empty());
            test_allocations::begin_thread();
            let result = compressor.compress_display_frame_into(rejected, &mut out);
            let tally = test_allocations::end_thread();
            assert!(result.is_none());
            assert!(out.is_empty());
            assert_eq!(tally.allocations, 0);
            assert!(
                compressor
                    .compress_display_frame_into(&frame, &mut out)
                    .is_some()
            );
        }
    }

    /// Measure the sender-service and achieved-ratio surfaces consumed by the
    /// display planner.
    #[test]
    #[ignore = "benchmark"]
    fn production_compression_planner_surface_benchmark() {
        const TARGET_BYTES: [usize; 9] =
            [300, 512, 1_024, 1_100, 2_048, 4_096, 8_192, 16_384, 65_536];
        const ITERATIONS: usize = 400;
        const WARMUPS: usize = 100;

        println!(
            "\n{:>8}  {:>7}  {:>6}  {:>10}",
            "raw", "saved", "ratio", "us/call"
        );

        for target in TARGET_BYTES {
            let frame = benchmark_frame_of_at_least(target);
            let mut compressor = Compressor::new();
            let mut samples = Vec::with_capacity(ITERATIONS);
            let mut saved_bytes = 0usize;
            for index in 0..(WARMUPS + ITERATIONS) {
                let started = std::time::Instant::now();
                let attempt = compress(&mut compressor, &frame);
                let elapsed = started.elapsed();
                let attempt = attempt.expect("production frame must compress");
                std::hint::black_box(&attempt.frame);
                if index >= WARMUPS {
                    samples.push(elapsed.as_secs_f64() * 1_000.0);
                    saved_bytes = attempt.saved_bytes;
                }
            }
            samples.sort_by(f64::total_cmp);
            let measured_ms = samples[samples.len() / 2];
            println!(
                "{:>8}  {:>7}  {:>6.2}  {:>10.3}",
                frame.len(),
                saved_bytes,
                frame.len() as f64 / (frame.len() - saved_bytes) as f64,
                measured_ms * 1_000.0,
            );
            println!(
                "@@merkur-perf {{\"name\":\"compression-planner-sender-{}\",\"value\":{},\"unit\":\"ms/op\",\"direction\":\"lower\",\"percentile\":0.5,\"sampleSize\":{ITERATIONS}}}",
                frame.len(),
                measured_ms,
            );
        }
    }

    /// Grow a realistic delta until its encoded frame reaches `target`, so
    /// every measurement is on bytes the production encoder actually emits.
    fn benchmark_frame_of_at_least(target: usize) -> Vec<u8> {
        let mut rows = 1usize;
        loop {
            let frame = delta_frame(
                &(0..rows)
                    .map(|index| (index as u16, log_line(index)))
                    .collect::<Vec<_>>(),
            );
            if frame.len() >= target || rows > 4_096 {
                return frame;
            }
            rows += 1;
        }
    }
}
