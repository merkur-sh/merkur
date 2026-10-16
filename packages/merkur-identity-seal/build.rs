use std::{env, path::PathBuf, process::Command};

fn selected(args: &[&str]) -> String {
    let result = Command::new("/usr/bin/xcrun")
        .args(args)
        .output()
        .expect(
            "macOS identity build requires Xcode Command Line Tools with the macOS 26 SDK \
             (CryptoKit's SecureEnclave.MLDSA87): xcode-select --install",
        );
    assert!(
        result.status.success(),
        "Xcode Command Line Tools failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout)
        .expect("UTF-8 tool path")
        .trim()
        .to_owned()
}

fn main() {
    println!("cargo::rerun-if-changed=src/macos.swift");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let swift = PathBuf::from(selected(&["--find", "swiftc"]));
    let toolchain = swift
        .parent()
        .and_then(|p| p.parent())
        .expect("Swift toolchain path")
        .to_path_buf();
    let sdk = PathBuf::from(selected(&["--show-sdk-path"]));
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS architecture"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("merkur_identity_seal.o");
    let status = Command::new(&swift)
        .args([
            "-module-cache-path",
            out.join("swift-module-cache").to_str().expect("module cache path"),
            "-parse-as-library",
            "-O",
            "-emit-object",
        ])
        .arg("-sdk")
        .arg(&sdk)
        .args(["-target", &format!("{arch}-apple-macos11.0"), "src/macos.swift", "-o"])
        .arg(&object)
        .status()
        .expect("swiftc");
    assert!(
        status.success(),
        "Secure Enclave Swift bridge compilation failed"
    );
    // A fixed archive date keeps the archive's bytes, and every action keyed on them, stable.
    assert!(
        Command::new("/usr/bin/ar")
            .env("ZERO_AR_DATE", "1")
            .arg("crs")
            .arg(out.join("libmerkur_identity_seal.a"))
            .arg(object)
            .status()
            .expect("ar")
            .success()
    );
    println!("cargo::rustc-link-search=native={}", out.display());
    println!("cargo::rustc-link-lib=static=merkur_identity_seal");
    for framework in ["CryptoKit", "Foundation", "Security"] {
        println!("cargo::rustc-link-lib=framework={framework}");
    }
    println!(
        "cargo::rustc-link-search=native={}",
        toolchain.join("lib/swift/macosx").display()
    );
    println!("cargo::rustc-link-search=native={}", sdk.join("usr/lib/swift").display());
    println!("cargo::rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo::metadata=swift_runtime_path=/usr/lib/swift");
}
