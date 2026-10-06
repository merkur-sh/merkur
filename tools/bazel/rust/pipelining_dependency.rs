#![no_std]

pub fn mix<const N: usize>(input: &[u64; N]) -> u64 {
    input
        .iter()
        .fold(0, |state, value| state.rotate_left(7) ^ value)
}
