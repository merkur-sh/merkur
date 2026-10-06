#![no_std]

pub fn exercise(input: &[u64; 4]) -> u64 {
    pipeline_dependency::mix(input)
}
