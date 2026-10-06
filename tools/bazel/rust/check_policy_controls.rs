//! Exercise the exact native policy interpreters against isolated metadata fixtures.
use serde_json::{Value, json};
use std::{
    env, fs,
    path::Path,
    process::{Command, Output},
};

fn write(path: impl AsRef<Path>, value: impl AsRef<[u8]>) -> Result<(), String> {
    fs::write(path, value).map_err(|e| e.to_string())
}

fn invoke(program: &str, args: &[String], root: &Path) -> Result<Output, String> {
    Command::new(program)
        .args(args)
        .current_dir(root)
        .env("CARGO", "/nonexistent/metadata-must-be-declared")
        .env("CARGO_HOME", root.join("cargo-home"))
        .env("HOME", root.join("home"))
        .env("CARGO_NET_OFFLINE", "true")
        .env("NO_COLOR", "1")
        .output()
        .map_err(|e| e.to_string())
}

fn pass(output: Output) -> Result<Output, String> {
    if !output.status.success() {
        return Err(format!(
            "unexpected policy setup/positive failure: {}\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

fn refused(output: Output, expected: &str) -> Result<Output, String> {
    if output.status.success()
        || !String::from_utf8_lossy(&output.stdout).contains(expected)
            && !String::from_utf8_lossy(&output.stderr).contains(expected)
    {
        return Err(format!(
            "control did not establish its intended {expected} policy failure: {}\n{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

fn deny_evidence(output: Output, expected: Option<&str>) -> Result<Output, String> {
    let mut errors = 0;
    for stream in [&output.stdout, &output.stderr] {
        for line in std::str::from_utf8(stream)
            .map_err(|e| e.to_string())?
            .lines()
        {
            let report: Value = serde_json::from_str(line)
                .map_err(|e| format!("invalid policy diagnostic: {e}"))?;
            if report["type"] == "diagnostic"
                && matches!(report["fields"]["severity"].as_str(), Some("error" | "bug"))
            {
                errors += 1;
                if expected.is_none() || report["fields"]["code"].as_str() != expected {
                    return Err(format!(
                        "policy control failed for an unrelated diagnostic: {report}"
                    ));
                }
            } else if report["type"] == "log" && report["fields"]["level"] == "ERROR" {
                return Err(format!("policy interpreter setup failed: {report}"));
            }
        }
    }
    if expected.is_some() {
        if output.status.success() || errors == 0 {
            return Err("policy did not establish an intended coded refusal".into());
        }
    } else if !output.status.success() || errors != 0 {
        return Err("positive policy fixture did not pass cleanly".into());
    }
    Ok(output)
}

fn fixture(
    root: &Path,
    template: &Value,
    dep_name: &str,
    license: &str,
    source: Option<&str>,
    wildcard: bool,
) -> Result<Value, String> {
    for dir in ["src", "dependency/src", "home", "cargo-home"] {
        fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
    }
    write(root.join("src/lib.rs"), "")?;
    write(root.join("dependency/src/lib.rs"), "")?;
    let requirement = if wildcard {
        "*"
    } else if source.is_some() {
        "=1.0.4"
    } else {
        "*"
    };
    write(
        root.join("Cargo.toml"),
        format!(
            "[package]\nname = \"merkur-policy-control\"\nversion = \"0.1.0\"\nedition = \"2024\"\nlicense = \"AGPL-3.0-only\"\npublish = false\n[workspace]\n[dependencies]\n{dep_name} = {}\n",
            if source.is_some() {
                format!("\"{requirement}\"")
            } else {
                "{ path = \"dependency\" }".to_string()
            }
        ),
    )?;
    write(
        root.join("dependency/Cargo.toml"),
        format!(
            "[package]\nname = \"{dep_name}\"\nversion = \"{}\"\nedition = \"2024\"\nlicense = \"{license}\"\npublish = false\n",
            if source.is_some() { "1.0.4" } else { "0.1.0" }
        ),
    )?;
    write(root.join("Cargo.lock"), "version = 4\n")?;
    let root_id = format!("path+file://{}#merkur-policy-control@0.1.0", root.display());
    let dep_id = source.map_or_else(
        || format!("path+file://{}/dependency#{dep_name}@0.1.0", root.display()),
        |s| format!("{s}#{dep_name}@1.0.4"),
    );
    let mut package = template["packages"]
        .as_array()
        .ok_or("missing package template")?
        .iter()
        .find(|p| p["name"] == "merkur-wire")
        .ok_or("missing first-party fixture template")?
        .clone();
    package["name"] = json!("merkur-policy-control");
    package["id"] = json!(root_id);
    package["version"] = json!("0.1.0");
    package["manifest_path"] = json!(root.join("Cargo.toml"));
    package["source"] = Value::Null;
    package["license"] = json!("AGPL-3.0-only");
    package["license_file"] = Value::Null;
    package["features"] = json!({});
    package["metadata"] = json!({});
    package["targets"] = json!([{"kind":["lib"],"crate_types":["lib"],"name":"merkur_policy_control","src_path":root.join("src/lib.rs"),"edition":"2024","doc":true,"doctest":true,"test":true}]);
    package["dependencies"] = json!([{"name":dep_name,"source":source,"req":requirement,"kind":null,"rename":null,"optional":false,"uses_default_features":true,"features":[],"target":null,"registry":null,"path":if source.is_none(){Some(root.join("dependency"))}else{None}}]);
    let mut dep = package.clone();
    dep["name"] = json!(dep_name);
    dep["id"] = json!(dep_id);
    dep["version"] = json!(if source.is_some() { "1.0.4" } else { "0.1.0" });
    dep["source"] = json!(source);
    dep["license"] = json!(license);
    dep["manifest_path"] = json!(root.join("dependency/Cargo.toml"));
    dep["dependencies"] = json!([]);
    dep["targets"] = json!([{"kind":["lib"],"crate_types":["lib"],"name":dep_name.replace('-',"_"),"src_path":root.join("dependency/src/lib.rs"),"edition":"2024","doc":true,"doctest":true,"test":true}]);
    let index = if source == Some("registry+https://github.com/rust-lang/crates.io-index") {
        json!([{"name": dep_name, "version": "1.0.4", "features": {}}])
    } else {
        json!([])
    };
    let result = json!({"packages":[package,dep],"workspace_members":[root_id],"workspace_default_members":[root_id],"resolve":{"root":root_id,"nodes":[{"id":root_id,"dependencies":[dep_id],"deps":[{"name":dep_name.replace('-',"_"),"pkg":dep_id,"dep_kinds":[{"kind":null,"target":null}]}],"features":[]},{"id":dep_id,"dependencies":[],"deps":[],"features":[]}]},"target_directory":root.join("target"),"workspace_root":root,"metadata":{},"version":1,"merkur_registry_index": index});
    write(
        root.join("metadata.json"),
        serde_json::to_vec(&result).map_err(|e| e.to_string())?,
    )?;
    Ok(result)
}

fn run() -> Result<(), String> {
    let args: Vec<_> = env::args().collect();
    if args.get(1).is_some_and(|value| value == "--graph") {
        return graph(&args);
    }
    if args.len() != 6 {
        return Err("expected control, deny, vet, policy and captured production graph".into());
    }
    let control = &args[1];
    let deny = fs::canonicalize(&args[2]).map_err(|e| e.to_string())?;
    let vet = fs::canonicalize(&args[3]).map_err(|e| e.to_string())?;
    let policy = fs::canonicalize(&args[4]).map_err(|e| e.to_string())?;
    let snapshot: Value = serde_json::from_slice(&fs::read(&args[5]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let template = &snapshot["metadata"];
    let root =
        fs::canonicalize(env::var_os("TEST_TMPDIR").ok_or("missing test temporary directory")?)
            .map_err(|e| e.to_string())?;
    let registry = "registry+https://github.com/rust-lang/crates.io-index";
    let (name, license, source, wildcard, checks, failure) = match control.as_str() {
        "current_policy" => (
            "control-dep",
            "MIT",
            None,
            false,
            vec!["bans", "licenses", "sources"],
            None,
        ),
        "license" => (
            "control-dep",
            "GPL-3.0-only",
            None,
            false,
            vec!["licenses"],
            Some("rejected"),
        ),
        "tls_backend" => ("openssl", "MIT", None, false, vec!["bans"], Some("banned")),
        "wildcard" => (
            "cfg-if",
            "MIT",
            Some(registry),
            true,
            vec!["bans"],
            Some("wildcard"),
        ),
        "git_source" => (
            "control-dep",
            "MIT",
            Some("git+file:///declared-policy-control#0000000000000000000000000000000000000000"),
            false,
            vec!["sources"],
            Some("source-not-allowed"),
        ),
        "registry_source" => (
            "control-dep",
            "MIT",
            Some("registry+https://policy-control.invalid/index"),
            false,
            vec!["sources"],
            Some("source-not-allowed"),
        ),
        "patches_first_party" | "exact_exemption" | "other_version" => {
            ("cfg-if", "MIT", Some(registry), false, vec![], None)
        }
        _ => return Err("unknown policy control".into()),
    };
    fixture(&root, template, name, license, source, wildcard)?;
    let metadata = root.join("metadata.json");
    if !checks.is_empty() {
        let mut command = vec![
            "deny".into(),
            "--format=json".into(),
            "--offline".into(),
            "--config".into(),
            policy.to_string_lossy().into_owned(),
            "--metadata-path".into(),
            metadata.to_string_lossy().into_owned(),
            "check".into(),
        ];
        command.extend(checks.into_iter().map(str::to_string));
        let result = invoke(deny.to_str().ok_or("non-UTF8 deny path")?, &command, &root)?;
        deny_evidence(result, failure)?;
    } else {
        let store = root.join("supply-chain");
        fs::create_dir_all(&store).map_err(|e| e.to_string())?;
        write(store.join("audits.toml"), "[audits]\n")?;
        write(store.join("imports.lock"), "")?;
        write(
            store.join("config.toml"),
            format!(
                "[cargo-vet]\nversion = \"0.10\"\n[[exemptions.cfg-if]]\nversion = \"{}\"\ncriteria = \"safe-to-deploy\"\nnotes = \"Synthetic policy test exemption, not a source certification.\"\n",
                if control == "other_version" {
                    "1.0.3"
                } else {
                    "1.0.4"
                }
            ),
        )?;
        pass(invoke(
            vet.to_str().ok_or("non-UTF8 vet path")?,
            &[
                "vet".into(),
                "fmt".into(),
                "--metadata-path".into(),
                metadata.to_string_lossy().into_owned(),
                "--store-path".into(),
                store.to_string_lossy().into_owned(),
            ],
            &root,
        )?)?;
        let mut command = vec![
            "vet".into(),
            "--metadata-path".into(),
            metadata.to_string_lossy().into_owned(),
            "--store-path".into(),
            store.to_string_lossy().into_owned(),
            "--locked".into(),
            "--frozen".into(),
            "--output-format".into(),
            "json".into(),
        ];
        if control == "patches_first_party" {
            let mut actual = template.clone();
            actual["workspace_root"] = json!(&root);
            write(
                &metadata,
                serde_json::to_vec(&actual).map_err(|e| e.to_string())?,
            )?;
            command.insert(1, "dump-graph".into());
            command.extend(["--depth".into(), "full".into()]);
            let result = pass(invoke(
                vet.to_str().ok_or("non-UTF8 vet path")?,
                &command,
                &root,
            )?)?;
            let graph: Vec<Value> =
                serde_json::from_slice(&result.stdout).map_err(|e| e.to_string())?;
            let patches = [
                "alacritty_terminal",
                "fontdue",
                "quinn",
                "quinn-proto",
                "vte",
                "wtransport",
            ];
            for patch in patches {
                let nodes: Vec<_> = graph.iter().filter(|node| node["name"] == patch).collect();
                if nodes.is_empty() || nodes.iter().any(|node| node["is_third_party"] != false) {
                    return Err(format!(
                        "modified production patch must remain first-party: {patch}"
                    ));
                }
            }
        } else {
            command.push("--no-minimize-exemptions".into());
            let result = invoke(vet.to_str().ok_or("non-UTF8 vet path")?, &command, &root)?;
            if control == "other_version" {
                let result = refused(result, "fail (vetting)")?;
                let report: Value =
                    serde_json::from_slice(&result.stdout).map_err(|e| e.to_string())?;
                if !report["error"].is_null()
                    || report["failures"]
                        .as_array()
                        .is_none_or(|items| items.len() != 1)
                {
                    return Err("vet control reported setup or unrelated failures".into());
                }
                if !report["failures"]
                    .as_array()
                    .ok_or("missing vetting failure inventory")?
                    .iter()
                    .any(|item| {
                        item["name"] == "cfg-if"
                            && item["version"] == "1.0.4"
                            && item["missing_criteria"]
                                .as_array()
                                .is_some_and(|values| values.iter().any(|v| v == "safe-to-deploy"))
                    })
                {
                    return Err("incorrect exact-version exemption failure".into());
                }
            } else {
                pass(result)?;
            }
        }
    }
    println!("{control}: real pinned policy interpreter established its intended result");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn graph(args: &[String]) -> Result<(), String> {
    if args.len() != 7 {
        return Err("expected graph, deny, vet, snapshot and declared source mapping".into());
    }
    let root = fs::canonicalize(env::var_os("TEST_TMPDIR").ok_or("missing test directory")?)
        .map_err(|e| e.to_string())?;
    let runfiles =
        env::var_os("MERKUR_POLICY_RUNFILES_ROOT").ok_or("missing declared runfiles root")?;
    let runfiles = Path::new(&runfiles);
    let mapping: Value = serde_json::from_slice(&fs::read(&args[6]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for item in mapping
        .as_array()
        .ok_or("invalid declared source mapping")?
    {
        let source = item["source"].as_str().ok_or("missing source")?;
        let destination = item["dest"].as_str().ok_or("missing destination")?;
        if Path::new(destination).is_absolute()
            || Path::new(destination)
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("declared policy source escaped its isolated tree".into());
        }
        let destination = root.join(destination);
        fs::create_dir_all(destination.parent().ok_or("missing destination parent")?)
            .map_err(|e| e.to_string())?;
        let bytes = fs::read(runfiles.join(source))
            .map_err(|e| format!("missing declared policy source {source}: {e}"))?;
        if destination.exists() && fs::read(&destination).map_err(|e| e.to_string())? != bytes {
            return Err("conflicting declared policy sources".into());
        }
        write(destination, bytes)?;
    }
    let workspace = root.join("workspace");
    for directory in ["home", "cargo-home"] {
        fs::create_dir_all(workspace.join(directory)).map_err(|e| e.to_string())?;
    }
    let snapshot: Value = serde_json::from_slice(&fs::read(&args[5]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fn relocate(value: &mut Value, root: &Path) {
        match value {
            Value::Object(map) => map.values_mut().for_each(|value| relocate(value, root)),
            Value::Array(array) => array.iter_mut().for_each(|value| relocate(value, root)),
            Value::String(text) => {
                *text = text
                    .replace(
                        "__MERKUR_WORKSPACE__",
                        &root.join("workspace").to_string_lossy(),
                    )
                    .replace(
                        "__MERKUR_REGISTRY__",
                        &root.join("registry").to_string_lossy(),
                    );
            }
            _ => {}
        }
    }
    let mut metadata = snapshot["metadata"].clone();
    relocate(&mut metadata, &root);
    for package in metadata["packages"]
        .as_array()
        .ok_or("missing policy packages")?
    {
        let manifest = package["manifest_path"]
            .as_str()
            .ok_or("missing package manifest")?;
        if !Path::new(manifest).is_file() {
            return Err(format!(
                "missing source for policy package {}: {manifest}",
                package["name"]
            ));
        }
        if package["source"].is_null() {
            for target in package["targets"]
                .as_array()
                .ok_or("missing first-party targets")?
            {
                let source = target["src_path"]
                    .as_str()
                    .ok_or("missing first-party target source")?;
                if !Path::new(source).is_file() {
                    return Err(format!("missing first-party policy source: {source}"));
                }
            }
        }
    }
    let metadata_path = root.join("metadata.json");
    write(
        &metadata_path,
        serde_json::to_vec(&metadata).map_err(|e| e.to_string())?,
    )?;
    deny_evidence(
        invoke(
            &args[3],
            &[
                "deny".into(),
                "--format=json".into(),
                "--offline".into(),
                "--config".into(),
                workspace.join("deny.toml").to_string_lossy().into_owned(),
                "--metadata-path".into(),
                metadata_path.to_string_lossy().into_owned(),
                "check".into(),
                "bans".into(),
                "licenses".into(),
                "sources".into(),
            ],
            &workspace,
        )?,
        None,
    )?;
    let output = pass(invoke(
        &args[4],
        &[
            "vet".into(),
            "--metadata-path".into(),
            metadata_path.to_string_lossy().into_owned(),
            "--store-path".into(),
            workspace
                .join("supply-chain")
                .to_string_lossy()
                .into_owned(),
            "--locked".into(),
            "--frozen".into(),
            "--no-minimize-exemptions".into(),
            "--output-format".into(),
            "json".into(),
        ],
        &workspace,
    )?)?;
    let report: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    if !report["error"].is_null() || !report["failures"].is_null() {
        return Err(format!(
            "policy graph has incomplete vetting evidence: {report}"
        ));
    }
    println!(
        "Declared {} graph passed native offline bans/licenses/sources and vetting",
        args[2]
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::deny_evidence;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    fn report(success: bool, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(if success { 0 } else { 256 }),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    const REFUSAL: &str =
        "{\"type\":\"diagnostic\",\"fields\":{\"severity\":\"error\",\"code\":\"wildcard\"}}\n";

    #[test]
    fn intended_refusal_requires_a_failed_process_and_exact_diagnostic() {
        assert!(deny_evidence(report(false, REFUSAL), Some("wildcard")).is_ok());
        assert!(deny_evidence(report(true, REFUSAL), Some("wildcard")).is_err());
        assert!(deny_evidence(report(false, ""), Some("wildcard")).is_err());
        assert!(deny_evidence(report(false, REFUSAL), Some("banned")).is_err());
    }

    #[test]
    fn setup_error_cannot_hide_behind_an_intended_policy_refusal() {
        let error = "{\"type\":\"log\",\"fields\":{\"level\":\"ERROR\",\"message\":\"missing registry graph\"}}\n";
        assert!(
            deny_evidence(
                report(false, &format!("{REFUSAL}{error}")),
                Some("wildcard")
            )
            .is_err()
        );
        assert!(deny_evidence(report(true, error), None).is_err());
    }

    #[test]
    fn positive_verdict_requires_no_error_diagnostics() {
        assert!(deny_evidence(report(true, ""), None).is_ok());
        assert!(deny_evidence(report(true, REFUSAL), None).is_err());
        assert!(deny_evidence(report(false, ""), None).is_err());
    }
}
