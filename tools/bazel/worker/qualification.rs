//! Real stable-rustc local worker qualification input.
pub fn square(value: u32) -> u32 {
    value * value
}
#[cfg(test)]
mod tests {
    #[test]
    fn compiler_semantics() {
        assert_eq!(super::square(7), 49);
    }
}
