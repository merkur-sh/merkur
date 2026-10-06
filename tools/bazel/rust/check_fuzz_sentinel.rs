//! Compile the actual production instrumentation sentinel with the pinned compiler.
use serde_json::Value;
use std::{env, fs, path::PathBuf, process::Command};

const SENTINEL: &str = "cargo-bolero libFuzzer instrumentation was not enabled";

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().collect();
    if args.len() < 4 {
        return Err("expected declared rustc, sysroot, source and instrumenting flags".into());
    }
    let output = PathBuf::from(
        env::var_os("TEST_UNDECLARED_OUTPUTS_DIR").ok_or("missing test output directory")?,
    );
    let rustc = fs::canonicalize(&args[1]).map_err(|e| e.to_string())?;
    let sysroot = fs::canonicalize(&args[2]).map_err(|e| e.to_string())?;
    let source = fs::canonicalize(&args[3]).map_err(|e| e.to_string())?;
    let instrumented = &args[4..];
    let mut negative = Vec::new();
    let mut index = 0;
    let mut removed = 0;
    while index < instrumented.len() {
        if instrumented[index] == "--cfg"
            && instrumented
                .get(index + 1)
                .is_some_and(|v| v == "fuzzing_libfuzzer")
        {
            removed += 1;
            index += 2;
        } else {
            negative.push(instrumented[index].clone());
            index += 1;
        }
    }
    if removed != 1 {
        return Err(
            "expected exactly one declared libFuzzer cfg in the actual configuration".into(),
        );
    }
    for (name, flags, expected_success) in [
        ("instrumented", instrumented, true),
        ("missing_engine_cfg", negative.as_slice(), false),
    ] {
        let result = Command::new(&rustc)
            .args([
                "--sysroot",
                sysroot.to_str().ok_or("non-UTF8 sysroot")?,
                "--edition=2024",
                "--crate-type=lib",
                "--emit=metadata",
                "--error-format=json",
                "--crate-name=fuzz_sentinel",
            ])
            .args(flags)
            .arg(&source)
            .arg("-o")
            .arg(output.join(format!("{name}.rmeta")))
            .env("RUSTC_BOOTSTRAP", "1")
            .output()
            .map_err(|e| e.to_string())?;
        fs::write(output.join(format!("{name}.stderr.jsonl")), &result.stderr)
            .map_err(|e| e.to_string())?;
        if result.status.success() != expected_success {
            return Err(format!(
                "sentinel configuration {name} produced unexpected status {}",
                result.status
            ));
        }
        if !expected_success {
            let mut intended = 0;
            for line in std::str::from_utf8(&result.stderr)
                .map_err(|e| e.to_string())?
                .lines()
            {
                let report: Value = serde_json::from_str(line)
                    .map_err(|e| format!("invalid compiler diagnostic: {e}"))?;
                if report["level"] == "error" {
                    if report["message"] == SENTINEL && report["code"].is_null() {
                        intended += 1;
                    } else if report["message"] != "aborting due to 1 previous error" {
                        return Err(
                            "sentinel control failed for an unrelated compilation or setup error"
                                .into(),
                        );
                    }
                }
            }
            if intended != 1 {
                return Err(
                    "compiler did not report exactly the intended missing-instrumentation error"
                        .into(),
                );
            }
        }
    }
    println!(
        "Actual instrumentation sentinel accepts the engine configuration and rejects its missing cfg"
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
