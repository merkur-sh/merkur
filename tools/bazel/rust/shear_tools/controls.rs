//! CargoShear behavior captured with the pinned resolver and original CLI.
use std::path::PathBuf;
use std::process::Command;

#[test]
fn upstream_parser_matches_the_original_cli() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("semantic-fixtures.json"))
        .expect("declared primary fixture metadata");
    let executable =
        PathBuf::from(std::env::var_os("MERKUR_SHEAR_ANALYZER").expect("declared analyzer"))
            .canonicalize()
            .expect("materialized analyzer");
    let base = PathBuf::from(std::env::var_os("TEST_TMPDIR").expect("engine-owned test directory"));
    for fixture in cases.as_array().expect("fixture cases") {
        let name = fixture["name"].as_str().expect("case name");
        let root = base.join(name);
        std::fs::create_dir(&root).expect("new private fixture root");
        std::fs::create_dir(root.join("src")).expect("source directory");
        std::fs::write(
            root.join("Cargo.toml"),
            fixture["manifest"].as_str().expect("manifest"),
        )
        .expect("fixture manifest");
        std::fs::write(
            root.join("src/lib.rs"),
            fixture["source"].as_str().expect("source"),
        )
        .expect("fixture source");
        if let Some(source) = fixture["included"].as_str() {
            std::fs::write(root.join("src/included.rs"), source).expect("literal include input");
        }
        let metadata = root.join("metadata.json");
        std::fs::write(
            &metadata,
            serde_json::to_string(&fixture["metadata"])
                .expect("metadata JSON")
                .replace("@fixture@", root.to_str().expect("UTF-8 fixture root"))
                .replace(
                    "@registry@",
                    root.join("registry")
                        .to_str()
                        .expect("UTF-8 registry placeholder"),
                ),
        )
        .expect("captured metadata input");
        let output = Command::new(&executable)
            .args([&metadata, &root])
            .current_dir(&root)
            .env_clear()
            .env("PATH", "")
            .env("HOME", &root)
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .output()
            .expect("declared analyzer execution");
        assert_eq!(
            output.status.code().map(i64::from),
            fixture["expected_exit"].as_i64(),
            "{name}"
        );
        assert_eq!(
            output.stdout,
            fixture["expected_stdout"]
                .as_str()
                .expect("baseline diagnostics")
                .as_bytes(),
            "{name}"
        );
        assert!(output.stderr.is_empty(), "{name}");
    }
}

#[test]
fn mismatched_metadata_source_root_is_refused() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("semantic-fixtures.json"))
        .expect("declared primary fixture metadata");
    let fixture = &cases[0];
    let root = PathBuf::from(std::env::var_os("TEST_TMPDIR").expect("engine-owned test directory"))
        .join("metadata-root-refusal");
    std::fs::create_dir(&root).expect("new private fixture root");
    let mut metadata = fixture["metadata"].clone();
    metadata["workspace_root"] =
        serde_json::Value::String(root.join("another-root").to_string_lossy().into_owned());
    let input = root.join("metadata.json");
    std::fs::write(
        &input,
        serde_json::to_string(&metadata)
            .expect("metadata JSON")
            .replace("@fixture@", root.to_str().expect("UTF-8 fixture root"))
            .replace(
                "@registry@",
                root.join("registry")
                    .to_str()
                    .expect("UTF-8 registry placeholder"),
            ),
    )
    .expect("metadata input");
    let output = Command::new(PathBuf::from(
        std::env::var_os("MERKUR_SHEAR_ANALYZER").expect("declared analyzer"),
    ))
    .args([&input, &root])
    .env_clear()
    .env("PATH", "")
    .output()
    .expect("declared analyzer execution");
    assert_eq!(output.status.code(), Some(2));
}
