//! The unresolved symbol is valid metadata and must never be linked by Check.
unsafe extern "C" {
    fn deliberately_absent_check_symbol() -> u32;
}

pub fn value() -> u32 {
    unsafe { deliberately_absent_check_symbol() }
}
