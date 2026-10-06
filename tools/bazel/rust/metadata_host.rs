//! Bind metadata acquisition to the declared native Cargo/rustc and source inventory.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io, path::Path, process::Command};
fn text<'a>(value: &'a Value, name: &str) -> io::Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| io::Error::other(format!("missing {name}")))
}
fn capture(executable: &str, args: &[&str]) -> io::Result<String> {
    let output = Command::new(executable)
        .args(args)
        .env_clear()
        .env("PATH", "")
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "declared metadata tool failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    String::from_utf8(output.stdout).map_err(io::Error::other)
}
fn main() -> io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err(io::Error::other(
            "metadata host requires descriptor and receipt paths",
        ));
    }
    let descriptor: Value =
        serde_json::from_slice(&fs::read(&args[0])?).map_err(io::Error::other)?;
    let release = text(&descriptor, "rust_release")?;
    let expected_host = text(&descriptor, "execution_host")?;
    let cargo = capture(text(&descriptor, "cargo")?, &["--version"])?;
    let rustc = capture(text(&descriptor, "rustc")?, &["-vV"])?;
    if !cargo.starts_with(&format!("cargo {release} "))
        || !rustc.starts_with(&format!("rustc {release} "))
        || !rustc
            .lines()
            .any(|line| line == format!("host: {expected_host}"))
    {
        return Err(io::Error::other(
            "declared metadata tools do not match the pinned native execution host/release",
        ));
    }
    let mut facts = Vec::new();
    let mut names = std::collections::BTreeSet::new();
    for input in descriptor["inputs"]
        .as_array()
        .ok_or_else(|| io::Error::other("missing declared inputs"))?
    {
        let path = text(input, "path")?;
        if !names.insert(path.to_owned()) {
            return Err(io::Error::other("duplicate metadata input"));
        }
        if !Path::new(path).is_file() {
            return Err(io::Error::other(format!(
                "metadata input is not a file: {path}"
            )));
        }
        facts.push(json!({"path":path,"role":text(input,"role")?,"sha256":format!("{:x}",Sha256::digest(fs::read(path)?))}));
    }
    facts.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let inventory_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&facts).map_err(io::Error::other)?)
    );
    fs::write(&args[1], serde_json::to_vec_pretty(&json!({
        "execution_host":expected_host,"rust_release":release,"cargo_identity":cargo.trim(),"rustc_identity":rustc.trim(),
        "targets":descriptor["targets"],"inputs":facts,"inventory_sha256":inventory_sha256,
        "configured_resolution_qualified":false,
        "pending":["Native Cargo unit graphs must be captured and compared on this execution host; a tool/source receipt does not qualify configured resolution"]
    })).map_err(io::Error::other)?)
}
