// Shared by the proof harnesses through `include!`, like `seeds.rs`.

/// Runs `check` on every input of at most `N` bytes. Under Kani that is `N`
/// symbolic bytes and a symbolic length: Bolero's own Kani engine always builds
/// a 256-byte symbolic buffer whatever the bound, which kept a 6-byte record
/// proof from finishing in its budget. Every other engine draws the inputs
/// through Bolero.
pub fn bounded<const N: usize>(check: impl Fn(&[u8]) + std::panic::RefUnwindSafe) {
    #[cfg(kani)]
    {
        let bytes: [u8; N] = kani::any();
        let len: usize = kani::any();
        kani::assume(len <= N);
        check(&bytes[..len]);
    }
    #[cfg(not(kani))]
    bolero::check!()
        .with_max_len(N)
        .for_each(|bytes: &[u8]| check(bytes));
}
