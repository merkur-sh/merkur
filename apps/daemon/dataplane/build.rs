// Swift runtime install names use @rpath. The shared custody crate publishes
// its runtime path as Cargo link metadata for the final executable.
fn main() {
    if let Ok(path) = std::env::var("DEP_MERKUR_IDENTITY_SEAL_SWIFT_RUNTIME_PATH") {
        println!("cargo::rustc-link-arg=-Wl,-rpath,{path}");
    }
}
