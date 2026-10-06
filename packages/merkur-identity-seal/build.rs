use std::{env, path::PathBuf, process::Command};

const DECLARED_SWIFT: [&str; 3] = ["MERKUR_SWIFTC", "MERKUR_SWIFT_SDK", "MERKUR_SWIFT_TOOLCHAIN"];

fn declared_path(name: &str) -> PathBuf {
    let path = PathBuf::from(env::var_os(name).unwrap_or_else(|| {
        panic!("macOS identity build requires declared {name}")
    }));
    assert!(path.is_absolute(), "macOS identity build requires absolute {name}");
    path
}

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
    for name in DECLARED_SWIFT.into_iter().chain(["AR"]) {
        println!("cargo::rerun-if-env-changed={name}");
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    // A build that declares any Swift input uses exactly the declared set; a build that
    // declares none takes the selected Xcode's tools, as Cargo runs outside a declaring engine.
    let declared = DECLARED_SWIFT.iter().any(|name| env::var_os(name).is_some());
    let (swift, sdk, toolchain, ar) = if declared {
        (
            declared_path("MERKUR_SWIFTC"),
            declared_path("MERKUR_SWIFT_SDK"),
            declared_path("MERKUR_SWIFT_TOOLCHAIN"),
            declared_path("AR"),
        )
    } else {
        let swift = PathBuf::from(selected(&["--find", "swiftc"]));
        let toolchain = swift
            .parent()
            .and_then(|p| p.parent())
            .expect("Swift toolchain path")
            .to_path_buf();
        let sdk = PathBuf::from(selected(&["--show-sdk-path"]));
        (swift, sdk, toolchain, PathBuf::from("/usr/bin/ar"))
    };
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => panic!("unsupported macOS architecture"),
    };
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let object = out.join("merkur_identity_seal.o");
    let mut compile = Command::new(&swift);
    compile.args([
        "-module-cache-path",
        out.join("swift-module-cache").to_str().expect("module cache path"),
        "-parse-as-library",
        "-O",
        "-emit-object",
    ]);
    if declared {
        compile
            .env("SWIFT_DRIVER_SWIFT_FRONTEND_EXEC", toolchain.join("bin/swift-frontend"))
            .args(["-Xfrontend", "-disable-incremental-llvm-codegen"]);
    }
    compile.arg("-sdk").arg(&sdk);
    if declared {
        compile.arg("-resource-dir").arg(toolchain.join("lib/swift"));
    }
    let status = compile
        .args(["-target", &format!("{arch}-apple-macos11.0"), "src/macos.swift", "-o"])
        .arg(&object)
        .status()
        .expect("swiftc");
    assert!(
        status.success(),
        "Secure Enclave Swift bridge compilation failed"
    );
    let mut archive = Command::new(&ar);
    if declared {
        archive.env("ZERO_AR_DATE", "1");
    }
    assert!(
        archive
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
