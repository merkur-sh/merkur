//! Invoke the pinned libFuzzer harness over an immutable, declared corpus snapshot.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const RUNS: u64 = 10000;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn portable_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if value.is_empty()
        || value.contains('\\')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("corpus member must have a portable relative namespace path".into());
    }
    Ok(path)
}

fn declared_runfile(value: &str) -> Result<PathBuf, String> {
    // Bazel presents external repositories alongside _main in the runfiles root.
    if let Some(external) = value.strip_prefix("../") {
        return Ok(PathBuf::from("..").join(portable_path(external)?));
    }
    portable_path(value)
}

fn instrumentation(stderr: &str) -> Result<(), String> {
    let mut counters = None;
    let mut pcs = None;
    for line in stderr.lines() {
        if let Some(value) = line.strip_prefix("INFO: Loaded 1 modules   (") {
            counters = value
                .split_once(" inline 8-bit counters)")
                .and_then(|(n, _)| n.parse::<u64>().ok());
        }
        if let Some(value) = line.strip_prefix("INFO: Loaded 1 PC tables (") {
            pcs = value
                .split_once(" PCs)")
                .and_then(|(n, _)| n.parse::<u64>().ok());
        }
    }
    if counters.is_none_or(|value| value == 0) || counters != pcs {
        return Err(
            "libFuzzer did not establish instrumented counters and matching PC tables".into(),
        );
    }
    Ok(())
}

fn evidence(stderr: &str, runs: u64) -> Result<(), String> {
    instrumentation(stderr)?;
    let done = stderr
        .lines()
        .any(|line| line.starts_with(&format!("#{runs}\tDONE   cov: ")));
    let total = stderr.lines().any(|line| {
        line.starts_with(&format!("Done {runs} runs in ")) && line.ends_with(" second(s)")
    });
    if !done || !total {
        return Err("libFuzzer did not establish the complete campaign execution count".into());
    }
    Ok(())
}

fn replay_evidence(stderr: &str, paths: &[String]) -> Result<(), String> {
    instrumentation(stderr)?;
    let mut running = Vec::new();
    let mut executed = Vec::new();
    let expected_count = format!(": Running {} inputs 1 time(s) each.", paths.len());
    let mut summary = 0;
    for line in stderr.lines() {
        if line.ends_with(&expected_count) {
            summary += 1;
        }
        if let Some(path) = line.strip_prefix("Running: ") {
            running.push(path.to_owned());
        }
        if let Some(value) = line.strip_prefix("Executed ") {
            let (path, milliseconds) = value
                .rsplit_once(" in ")
                .ok_or("malformed engine replay completion")?;
            if !milliseconds
                .strip_suffix(" ms")
                .is_some_and(|value| value.parse::<u64>().is_ok())
            {
                return Err("malformed engine replay duration".into());
            }
            executed.push(path.to_owned());
        }
    }
    if paths.is_empty() || summary != 1 || running != paths || executed != paths {
        return Err("libFuzzer did not establish exactly one completed replay of every declared corpus File".into());
    }
    Ok(())
}

fn copy_snapshot(manifest: &Value, root: &Path, destination: &Path) -> Result<Value, String> {
    let members = manifest["corpus"]
        .as_array()
        .ok_or("missing declared corpus snapshot")?;
    let mut paths = BTreeSet::new();
    let mut inventory = Vec::new();
    for member in members {
        let source = member["source"]
            .as_str()
            .ok_or("corpus member has no declared File")?;
        let name = member["path"]
            .as_str()
            .ok_or("corpus member has no namespace path")?;
        let relative = portable_path(name)?;
        if !paths.insert(name) {
            return Err("duplicate corpus namespace path".into());
        }
        // Runfiles symlinks are Bazel's presentation of the original declared File.
        let bytes = fs::read(root.join(declared_runfile(source)?)).map_err(|e| e.to_string())?;
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().ok_or("corpus member has no parent")?)
            .map_err(|e| e.to_string())?;
        fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        inventory.push(json!({"path": name, "size": bytes.len(), "sha256": digest(&bytes)}));
    }
    inventory.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!(inventory))
}

fn retained_inventory(root: &Path) -> Result<Value, String> {
    fn visit(root: &Path, directory: &Path, rows: &mut Vec<Value>) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                visit(root, &entry.path(), rows)?;
            } else if kind.is_file() {
                let path = entry.path();
                let name = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("non-UTF8 retained corpus path")?;
                portable_path(name)?;
                let bytes = fs::read(&path).map_err(|e| e.to_string())?;
                rows.push(json!({"path": name, "size": bytes.len(), "sha256": digest(&bytes)}));
            } else {
                return Err(
                    "engine corpus or crash output is not a regular File or directory".into(),
                );
            }
        }
        Ok(())
    }
    let mut rows = Vec::new();
    visit(root, root, &mut rows)?;
    rows.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!(rows))
}

fn campaign(harness: &Path, manifest: &Value, root: &Path, outputs: &Path) -> Result<(), String> {
    let mode = manifest["mode"]
        .as_str()
        .ok_or("missing fuzz execution mode")?;
    let replay = match mode {
        "campaign" => false,
        "replay" => true,
        _ => return Err("unknown fuzz execution mode".into()),
    };
    let selector = manifest["selector"]
        .as_str()
        .ok_or("missing exact campaign selector")?;
    if ![
        "fuzz_wire",
        "fuzz_stun",
        "tests::fuzz::fuzz_display_ingress",
        "tests::fuzz::fuzz_display_zstd",
        "tests::fuzz::fuzz_display_roundtrip",
    ]
    .contains(&selector)
        || manifest["runs"] != if replay { 1 } else { RUNS }
        || manifest["max_length"] != 4096
    {
        return Err("fuzz execution must preserve the five-target inventory, exact mode execution count and 4096-byte bound".into());
    }
    let outputs = outputs.join(portable_path(&selector.replace("::", "/"))?);
    // A test owns a fresh destination. Restored, source-tree or previous-run corpus is never read.
    fs::create_dir(&outputs)
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                fs::create_dir_all(outputs.parent().ok_or(error)?)?;
                fs::create_dir(&outputs)
            } else {
                Err(error)
            }
        })
        .map_err(|e| e.to_string())?;
    let corpus = outputs.join("corpus");
    let crashes = outputs.join("crashes");
    fs::create_dir(&corpus).map_err(|e| e.to_string())?;
    fs::create_dir(&crashes).map_err(|e| e.to_string())?;
    if [&corpus, &crashes].iter().any(|p| {
        p.as_os_str()
            .to_string_lossy()
            .chars()
            .any(|c| c.is_whitespace() || c == '\'' || c == '"' || c == '\\')
    }) {
        return Err("libFuzzer corpus path cannot contain shell-word separators".into());
    }
    let input = copy_snapshot(manifest, root, &corpus)?;
    let members = input
        .as_array()
        .ok_or("missing captured corpus inventory")?;
    let mut replay_paths = Vec::new();
    if replay {
        if members.is_empty() {
            return Err("immutable replay requires a nonempty declared corpus".into());
        }
        for member in members {
            if member["size"].as_u64().is_none_or(|size| size > 4096) {
                return Err(
                    "replay input exceeds 4096 bytes; the engine would silently truncate it".into(),
                );
            }
            let name = member["path"]
                .as_str()
                .ok_or("missing captured corpus path")?;
            let path = corpus
                .join(portable_path(name)?)
                .to_str()
                .ok_or("non-UTF8 replay path")?
                .to_owned();
            if path.contains(' ') {
                return Err(
                    "libFuzzer replay File path cannot contain its argument separator".into(),
                );
            }
            replay_paths.push(path);
        }
    }
    let engine_args = if replay {
        format!(
            "{} -timeout=2 -seed=1 -runs=1 -max_len=4096 -rss_limit_mb=2048",
            replay_paths.join(" ")
        )
    } else {
        format!(
            "{} {} -artifact_prefix={}/ -timeout=2 -seed=1 -runs={RUNS} -max_len=4096 -rss_limit_mb=2048",
            corpus.display(),
            crashes.display(),
            crashes.display()
        )
    };
    let input_digest = digest(&serde_json::to_vec(&input).map_err(|e| e.to_string())?);
    let harness_digest = digest(&fs::read(harness).map_err(|e| e.to_string())?);
    fs::write(
        outputs.join("input-corpus.json"),
        serde_json::to_vec_pretty(&input).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut command = Command::new(harness);
    command
        .args([
            selector,
            "--exact",
            "--nocapture",
            "--quiet",
            "--test-threads",
            "1",
        ])
        .env("BOLERO_TEST_NAME", selector)
        .env("BOLERO_LIBTEST_HARNESS", "1")
        .env("BOLERO_LIBFUZZER_ARGS", engine_args);
    if replay {
        command.env_remove("MERKUR_FUZZ_CORPUS");
    } else {
        command.env("MERKUR_FUZZ_CORPUS", &corpus);
    }
    let output = command.output();
    let mut result = match output {
        Ok(output) => {
            fs::write(outputs.join("engine.stdout"), &output.stdout).map_err(|e| e.to_string())?;
            fs::write(outputs.join("engine.stderr"), &output.stderr).map_err(|e| e.to_string())?;
            let classification = if output.status.success() {
                std::str::from_utf8(&output.stderr)
                    .map_err(|e| e.to_string())
                    .and_then(|stderr| {
                        if replay {
                            replay_evidence(stderr, &replay_paths)
                        } else {
                            evidence(stderr, RUNS)
                        }
                    })
            } else {
                Err(format!(
                    "native libFuzzer campaign failed: {}",
                    output.status
                ))
            };
            (output.status.code(), classification)
        }
        Err(error) => (
            None,
            Err(format!("native libFuzzer engine could not start: {error}")),
        ),
    };
    // Both successful and failed engines publish corpus/crashes and diagnostic identity.
    let retained =
        json!({"corpus": retained_inventory(&corpus)?, "crashes": retained_inventory(&crashes)?});
    if replay && retained["corpus"] != input {
        result.1 = Err("immutable replay mutated its captured corpus".into());
    }
    let report = json!({"selector": selector, "harness_sha256": harness_digest, "input_corpus_sha256": input_digest, "input_corpus": input, "retained": retained, "exit_code": result.0, "mode": mode, "completed_executions": if result.1.is_ok() { Some(if replay { replay_paths.len() as u64 } else { RUNS }) } else { None }, "problem": result.1.as_ref().err()});
    fs::write(
        outputs.join("campaign.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    result.1?;
    println!("{selector}: native instrumented libFuzzer {mode} completed");
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args_os().collect();
    if args.len() != 4 {
        return Err("expected declared harness, corpus manifest and runfiles root".into());
    }
    let outputs = PathBuf::from(
        env::var_os("TEST_UNDECLARED_OUTPUTS_DIR")
            .ok_or("missing declared test output directory")?,
    );
    let harness = fs::canonicalize(&args[1]).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_slice(&fs::read(&args[2]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    campaign(&harness, &manifest, Path::new(&args[3]), &outputs)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_random_test_and_partial_engine_cannot_certify_campaign() {
        assert!(evidence("test result: ok. 1 passed", RUNS).is_err());
        let input = "INFO: Loaded 1 modules   (10 inline 8-bit counters):\nINFO: Loaded 1 PC tables (10 PCs):\n#10000\tDONE   cov: 8\nDone 10000 runs in 1 second(s)";
        assert!(evidence(input, RUNS).is_ok());
        assert!(evidence(&input.replace("10000", "99"), RUNS).is_err());
        assert!(evidence(&input.replace("(10 PCs)", "(9 PCs)"), RUNS).is_err());
        assert!(evidence(&input.replace("(10 inline", "(0 inline"), RUNS).is_err());
    }

    #[test]
    fn replay_requires_exact_engine_completion_for_each_declared_input() {
        let paths = vec![
            "/owned/tests/fuzz/seed-a".to_owned(),
            "/owned/tests/fuzz/seed-b".to_owned(),
        ];
        let log = "INFO: Loaded 1 modules   (10 inline 8-bit counters):\nINFO: Loaded 1 PC tables (10 PCs):\nharness: Running 2 inputs 1 time(s) each.\nRunning: /owned/tests/fuzz/seed-a\nExecuted /owned/tests/fuzz/seed-a in 0 ms\nRunning: /owned/tests/fuzz/seed-b\nExecuted /owned/tests/fuzz/seed-b in 1 ms";
        assert!(replay_evidence(log, &paths).is_ok());
        assert!(
            replay_evidence(
                &log.replace("Executed /owned/tests/fuzz/seed-b in 1 ms", ""),
                &paths
            )
            .is_err()
        );
        assert!(
            replay_evidence(
                &log.replace("2 inputs 1 time(s)", "2 inputs 2 time(s)"),
                &paths
            )
            .is_err()
        );
        assert!(replay_evidence(&log.replace("seed-b", "unselected"), &paths).is_err());
        assert!(replay_evidence(&log.replace("(10 PCs)", "(9 PCs)"), &paths).is_err());
        assert!(
            replay_evidence(
                &format!("{log}\nExecuted /owned/tests/fuzz/seed-a in 0 ms"),
                &paths
            )
            .is_err()
        );
        assert!(replay_evidence("test result: ok. 1 passed", &paths).is_err());
        assert!(replay_evidence(log, &[]).is_err());
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let index = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = env::temp_dir().join(format!(
                "fuzz-corpus-control-{}-{index}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("fresh fixture");
            Self(root)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove owned fixture");
        }
    }

    #[test]
    fn immutable_nested_snapshot_and_retained_bytes_have_same_digest() {
        let fixture = Fixture::new();
        let inputs = fixture.0.join("inputs");
        let output = fixture.0.join("output");
        fs::create_dir_all(inputs.join("tests/fuzz/display")).unwrap();
        fs::create_dir(&output).unwrap();
        let original = inputs.join("tests/fuzz/display/seed");
        fs::write(&original, b"declared regression bytes").unwrap();
        let manifest = json!({"corpus": [{"source": "tests/fuzz/display/seed", "path": "tests/fuzz/display/seed"}]});
        let snapshot = copy_snapshot(&manifest, &inputs, &output).unwrap();
        assert_eq!(snapshot, retained_inventory(&output).unwrap());
        assert_eq!(fs::read(&original).unwrap(), b"declared regression bytes");
        fs::write(output.join("tests/fuzz/display/seed"), b"engine mutation").unwrap();
        assert_eq!(fs::read(&original).unwrap(), b"declared regression bytes");
        assert_ne!(snapshot, retained_inventory(&output).unwrap());
        let duplicate =
            json!({"corpus": [manifest["corpus"][0].clone(), manifest["corpus"][0].clone()]});
        assert!(
            copy_snapshot(&duplicate, &inputs, &output)
                .unwrap_err()
                .contains("duplicate")
        );
        let escape =
            json!({"corpus": [{"source": "tests/fuzz/display/seed", "path": "../escape"}]});
        assert!(copy_snapshot(&escape, &inputs, &output).is_err());
    }

    #[test]
    fn failed_engine_start_retains_input_identity_and_never_reports_executions() {
        let fixture = Fixture::new();
        let harness = fixture.0.join("nonexecutable-harness");
        fs::write(&harness, b"declared fixture executable with invalid format").unwrap();
        let outputs = fixture.0.join("outputs");
        fs::create_dir(&outputs).unwrap();
        let manifest = json!({"mode": "campaign", "selector": "tests::fuzz::fuzz_display_ingress", "runs": 10000, "max_length": 4096, "corpus": []});
        assert!(
            campaign(&harness, &manifest, &fixture.0, &outputs)
                .unwrap_err()
                .contains("could not start")
        );
        let directory = outputs.join("tests/fuzz/fuzz_display_ingress");
        let report: Value =
            serde_json::from_slice(&fs::read(directory.join("campaign.json")).unwrap()).unwrap();
        assert!(report["completed_executions"].is_null());
        assert!(report["exit_code"].is_null());
        assert_eq!(
            report["harness_sha256"],
            digest(&fs::read(&harness).unwrap())
        );
        assert_eq!(report["input_corpus_sha256"], digest(b"[]"));
        assert_eq!(report["retained"]["corpus"], json!([]));
        assert!(
            report["problem"]
                .as_str()
                .unwrap()
                .contains("could not start")
        );
        assert!(
            campaign(&harness, &manifest, &fixture.0, &outputs).is_err(),
            "old output cannot become an ambient corpus"
        );
    }

    #[test]
    fn replay_refuses_empty_or_truncated_scope_before_engine_execution() {
        let fixture = Fixture::new();
        let outputs = fixture.0.join("outputs");
        fs::create_dir(&outputs).unwrap();
        let mut manifest = json!({"mode": "replay", "selector": "fuzz_wire", "runs": 1, "max_length": 4096, "corpus": []});
        let absent_harness = fixture.0.join("never-executed");
        assert!(
            campaign(&absent_harness, &manifest, &fixture.0, &outputs)
                .unwrap_err()
                .contains("nonempty")
        );
        fs::remove_dir_all(outputs.join("fuzz_wire")).unwrap();
        fs::write(fixture.0.join("oversize"), vec![0; 4097]).unwrap();
        manifest["corpus"] = json!([{"source": "oversize", "path": "tests/fuzz/oversize"}]);
        assert!(
            campaign(&absent_harness, &manifest, &fixture.0, &outputs)
                .unwrap_err()
                .contains("silently truncate")
        );
        assert_eq!(fs::read(fixture.0.join("oversize")).unwrap().len(), 4097);
    }

    #[cfg(unix)]
    #[test]
    fn retained_symlink_cannot_hide_or_upload_an_undeclared_crash() {
        let fixture = Fixture::new();
        let output = fixture.0.join("output");
        fs::create_dir(&output).unwrap();
        fs::write(fixture.0.join("secret"), b"outside").unwrap();
        std::os::unix::fs::symlink(fixture.0.join("secret"), output.join("crash")).unwrap();
        assert!(
            retained_inventory(&output)
                .unwrap_err()
                .contains("regular File")
        );
    }

    #[test]
    fn nested_namespace_paths_are_portable_and_cannot_escape() {
        assert!(portable_path("tests/fuzz/display/seed").is_ok());
        assert_eq!(
            declared_runfile("../retained_corpus/tests/fuzz/seed").unwrap(),
            PathBuf::from("../retained_corpus/tests/fuzz/seed")
        );
        assert!(declared_runfile("../../undeclared/seed").is_err());

        for path in [
            "",
            "/absolute",
            "../escape",
            "nested/../escape",
            "./seed",
            "nested//seed",
            "nested/",
            "nested\\seed",
        ] {
            assert!(portable_path(path).is_err(), "{path}");
        }
    }
}
