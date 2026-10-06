//! Input storage wipes every retired allocation, including capacity growth.

use zeroize::{Zeroize, Zeroizing};

pub(crate) fn append_text(value: &mut String, text: &str) {
    let needed = value
        .len()
        .checked_add(text.len())
        .expect("input length overflow");
    if needed > value.capacity() {
        let mut next = Zeroizing::new(String::with_capacity(
            needed.max(value.capacity().saturating_mul(2)),
        ));
        next.push_str(value);
        value.zeroize();
        #[cfg(test)]
        retired(value.as_ptr(), value.capacity());
        *value = std::mem::take(&mut *next);
    }
    value.push_str(text);
}

pub(crate) fn push_char(value: &mut String, character: char) {
    let mut bytes = Zeroizing::new([0; 4]);
    append_text(value, character.encode_utf8(&mut *bytes));
}

pub(crate) fn append_bytes(value: &mut Vec<u8>, bytes: &[u8]) {
    let needed = value
        .len()
        .checked_add(bytes.len())
        .expect("input length overflow");
    if needed > value.capacity() {
        let mut next = Zeroizing::new(Vec::with_capacity(
            needed.max(value.capacity().saturating_mul(2)),
        ));
        next.extend_from_slice(value);
        value.zeroize();
        #[cfg(test)]
        retired(value.as_ptr(), value.capacity());
        *value = std::mem::take(&mut *next);
    }
    value.extend_from_slice(bytes);
}

#[cfg(test)]
thread_local! {
    static RETIRED: std::cell::RefCell<Vec<Vec<u8>>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(test)]
fn retired(pointer: *const u8, capacity: usize) {
    // SAFETY: the old allocation is still live here. zeroize initializes its
    // entire capacity before this callback; no bytes are read after deallocation.
    let bytes = unsafe { std::slice::from_raw_parts(pointer, capacity) };
    RETIRED.with_borrow_mut(|retired| retired.push(bytes.to_vec()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check_retired() {
        RETIRED.with_borrow_mut(|retired| {
            assert!(retired.iter().any(|bytes| !bytes.is_empty()));
            assert!(retired.iter().flatten().all(|byte| *byte == 0));
            retired.clear();
        });
    }

    #[test]
    fn password_growth_erases_the_entire_old_allocation_before_freeing_it() {
        RETIRED.with_borrow_mut(Vec::clear);
        let mut password = Zeroizing::new(String::with_capacity(5));
        for c in "secret界🔑with-a-long-tail".chars() {
            push_char(&mut password, c);
        }
        assert_eq!(&*password, "secret界🔑with-a-long-tail");
        check_retired();
    }

    #[test]
    fn partial_paste_growth_erases_the_entire_old_allocation_before_freeing_it() {
        RETIRED.with_borrow_mut(Vec::clear);
        let mut paste = Zeroizing::new(Vec::with_capacity(3));
        append_bytes(&mut paste, b"prefix");
        append_bytes(&mut paste, b"-password-paste");
        assert_eq!(&**paste, b"prefix-password-paste");
        check_retired();
    }
}
