// Only assurance targets include this module; the released crates never compile it.
#[cfg(all(merkur_libfuzzer, not(fuzzing_libfuzzer)))]
compile_error!("cargo-bolero libFuzzer instrumentation was not enabled");

pub fn persist(seeds: &[(&str, Vec<u8>)]) {
    let Some(directory) = std::env::var_os("MERKUR_FUZZ_CORPUS") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).expect("create target corpus");
    for (name, bytes) in seeds {
        std::fs::write(directory.join(name), bytes).expect("write encoder corpus seed");
        eprintln!("encoder seed {name}: {} bytes", bytes.len());
    }
}
