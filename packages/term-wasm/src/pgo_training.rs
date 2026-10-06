// Training hooks included in the terminal's root module: placing the direct
// calls in another module changes cross-codegen-unit visibility and therefore
// LLVM's profile names for otherwise internal production functions.
//
// The fixture stream repeats records of
// `[u32 frame length LE][u16 cols LE][u16 rows LE][u8 snapshot][frame]`: a
// snapshot resizes the grid and applies as authoritative state; every other
// frame goes through the production ingress path (reserve, copy, stage,
// validate, apply, release), with presentation commit and geometry every
// fourth frame, as the terminal worker's render cadence interleaves them.
// `train` refuses to report success unless every frame applied, so a fixture
// the terminal rejects cannot quietly train the error paths instead.

use std::cell::RefCell;

thread_local! {
    static PROFILE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn merkur_pgo_alloc(len: usize) -> *mut u8 {
    let mut buffer = vec![0u8; len];
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

/// Replays the fixture stream `rounds` times; returns the frames applied, or
/// zero when any frame was refused.
///
/// # Safety
/// `font` and `frames` must point at `font_len` and `frames_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn merkur_pgo_train(
    font: *const u8,
    font_len: usize,
    frames: *const u8,
    frames_len: usize,
    rounds: u32,
) -> u32 {
    // SAFETY: the caller passes regions this module allocated and filled.
    let (font, stream) = unsafe {
        (
            std::slice::from_raw_parts(font, font_len),
            std::slice::from_raw_parts(frames, frames_len),
        )
    };
    let mut terminal = crate::init_regular(1200.0, 720.0, font, 14.0, 1.2, 1.0);
    let mut applied = 0u32;
    let mut seq = 1u32;
    for _ in 0..rounds {
        let mut at = 0;
        while at < stream.len() {
            let Some(record) = stream.get(at..at + 9) else {
                return 0;
            };
            let len = u32::from_le_bytes([record[0], record[1], record[2], record[3]]) as usize;
            let cols = u16::from_le_bytes([record[4], record[5]]);
            let rows = u16::from_le_bytes([record[6], record[7]]);
            let snapshot = record[8] == 1;
            let Some(frame) = stream.get(at + 9..at + 9 + len) else {
                return 0;
            };
            at += 9 + len;
            if snapshot {
                terminal.resize(cols, rows);
                if !terminal.apply_state_seq(frame, 0) {
                    return 0;
                }
                terminal.commit_presentation_state();
                terminal.build_geometry();
                applied += 1;
                continue;
            }
            let Ok(frame_len) = u32::try_from(frame.len()) else {
                return 0;
            };
            let pointer = terminal.reserve_display_frame_input(frame_len);
            if pointer == 0 {
                return 0;
            }
            // SAFETY: the terminal just reserved `frame_len` writable bytes there.
            unsafe {
                std::ptr::copy_nonoverlapping(frame.as_ptr(), pointer as *mut u8, frame.len())
            };
            let handle = terminal.stage_display_frame_input(frame_len);
            let accepted = handle != 0
                && terminal.validate_staged_frame(handle)
                && terminal.apply_staged_delta_seq(handle, seq);
            terminal.release_staged_frame(handle);
            if !accepted {
                return 0;
            }
            applied += 1;
            seq = seq.wrapping_add(1).max(1);
            if seq.is_multiple_of(4) {
                terminal.commit_presentation_state();
                terminal.build_geometry();
            }
        }
    }
    applied
}

/// Captures the LLVM profile counters into a module-owned buffer; returns its length.
#[unsafe(no_mangle)]
pub extern "C" fn merkur_pgo_capture_profile() -> usize {
    PROFILE.with(|profile| {
        let mut buffer = Vec::new();
        // SAFETY: this module is single-threaded; nothing else touches the counters.
        unsafe { minicov::capture_coverage(&mut buffer) }.expect("profile capture");
        let len = buffer.len();
        *profile.borrow_mut() = buffer;
        len
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn merkur_pgo_profile_ptr() -> *const u8 {
    PROFILE.with(|profile| profile.borrow().as_ptr())
}
