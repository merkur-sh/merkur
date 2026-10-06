fn main() {
    for name in [
        "MERKUR_VERSION",
        "MERKUR_PUBLIC_ORIGIN",
        "MERKUR_OPAQUE_SERVER_PUBLIC_KEY",
    ] {
        println!("cargo::rerun-if-env-changed={name}");
    }
    if let Ok(path) = std::env::var("DEP_MERKUR_IDENTITY_SEAL_SWIFT_RUNTIME_PATH") {
        println!("cargo::rustc-link-arg=-Wl,-rpath,{path}");
    }
}
