//! Expected failures count only after a successful native model compilation.
use std::{fs, path::PathBuf, process::Command};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        4,
        "usage: check-model-failure BINARY EXACT_TEST EXPECTED_ASSERTION"
    );
    let output = Command::new(&args[1])
        .args(["--exact", &args[2], "--nocapture", "--test-threads=1"])
        .output()
        .expect("launch declared negative-control binary");
    let mut bytes = output.stdout;
    bytes.extend_from_slice(&output.stderr);
    let text = String::from_utf8(bytes).expect("UTF-8 model diagnostic");
    let directory = PathBuf::from(
        std::env::var_os("TEST_UNDECLARED_OUTPUTS_DIR").expect("Bazel evidence directory"),
    );
    fs::write(directory.join("model.log"), &text).expect("retain model failure evidence");
    let intended_result = text.lines().any(|line| {
        line.starts_with(
            "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 4 filtered out;",
        )
    });
    assert!(
        output.status.code() == Some(101) && intended_result && text.contains(&args[3]),
        "negative control must fail the intended invariant; setup failures and unrelated failures are rejected:\n{text}"
    );
    println!(
        "{}: intended ownership invariant failure established",
        args[2]
    );
}
