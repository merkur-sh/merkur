//! The worker owns every path in this policy; no host runtime discovery is admitted.
use serde_core::de::{self, MapAccess, Visitor};
use serde_core::{Deserialize, Deserializer};
use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub struct Runtime {
    pub input: PathBuf,
    pub path: PathBuf,
}

#[derive(Debug)]
pub struct Policy {
    pub workspace: PathBuf,
    pub incremental: PathBuf,
    pub root: PathBuf,
    pub scratch: PathBuf,
    pub inputs: Vec<PathBuf>,
    pub outputs: Vec<PathBuf>,
    pub runtime: Vec<Runtime>,
    pub leaf: bool,
}

fn take<'de, A: MapAccess<'de>, T: Deserialize<'de>>(
    map: &mut A,
    value: &mut Option<T>,
    field: &'static str,
) -> Result<(), A::Error> {
    if value.is_some() {
        return Err(de::Error::duplicate_field(field));
    }
    *value = Some(map.next_value()?);
    Ok(())
}
impl<'de> Deserialize<'de> for Runtime {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Runtime;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("exact declared runtime mapping")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let (mut input, mut path) = (None, None);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "input" => take(&mut map, &mut input, "input")?,
                        "path" => take(&mut map, &mut path, "path")?,
                        _ => return Err(de::Error::unknown_field(&key, &["input", "path"])),
                    }
                }
                Ok(Runtime {
                    input: input.ok_or_else(|| de::Error::missing_field("input"))?,
                    path: path.ok_or_else(|| de::Error::missing_field("path"))?,
                })
            }
        }
        decoder.deserialize_map(Fields)
    }
}
impl<'de> Deserialize<'de> for Policy {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Policy;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("exact owned Linux compiler policy")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let (mut workspace, mut incremental, mut root, mut scratch) =
                    (None, None, None, None);
                let (mut inputs, mut outputs, mut runtime, mut leaf) = (None, None, None, None);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "workspace" => take(&mut map, &mut workspace, "workspace")?,
                        "incremental" => take(&mut map, &mut incremental, "incremental")?,
                        "root" => take(&mut map, &mut root, "root")?,
                        "scratch" => take(&mut map, &mut scratch, "scratch")?,
                        "inputs" => take(&mut map, &mut inputs, "inputs")?,
                        "outputs" => take(&mut map, &mut outputs, "outputs")?,
                        "runtime" => take(&mut map, &mut runtime, "runtime")?,
                        "leaf" => take(&mut map, &mut leaf, "leaf")?,
                        _ => {
                            return Err(de::Error::unknown_field(
                                &key,
                                &[
                                    "workspace",
                                    "incremental",
                                    "root",
                                    "scratch",
                                    "inputs",
                                    "outputs",
                                    "runtime",
                                    "leaf",
                                ],
                            ));
                        }
                    }
                }
                Ok(Policy {
                    workspace: workspace.ok_or_else(|| de::Error::missing_field("workspace"))?,
                    incremental: incremental
                        .ok_or_else(|| de::Error::missing_field("incremental"))?,
                    root: root.ok_or_else(|| de::Error::missing_field("root"))?,
                    scratch: scratch.ok_or_else(|| de::Error::missing_field("scratch"))?,
                    inputs: inputs.ok_or_else(|| de::Error::missing_field("inputs"))?,
                    outputs: outputs.ok_or_else(|| de::Error::missing_field("outputs"))?,
                    runtime: runtime.ok_or_else(|| de::Error::missing_field("runtime"))?,
                    leaf: leaf.ok_or_else(|| de::Error::missing_field("leaf"))?,
                })
            }
        }
        decoder.deserialize_map(Fields)
    }
}

fn confined(path: &Path, absolute: bool) -> bool {
    !path.as_os_str().is_empty()
        && path.is_absolute() == absolute
        && path.components().all(|part| {
            matches!(part, Component::Normal(_)) || (absolute && part == Component::RootDir)
        })
        && path.to_str().is_some_and(|value| {
            !value.chars().any(|c| c.is_control())
                && value
                    .split('/')
                    .skip(usize::from(absolute))
                    .all(|part| !part.is_empty() && part != "." && part != "..")
        })
}

fn disjoint(left: &Path, right: &Path) -> bool {
    !left.starts_with(right) && !right.starts_with(left)
}

impl Policy {
    pub fn parse(value: &str) -> io::Result<Self> {
        let policy: Self = serde_json::from_str(value).map_err(io::Error::other)?;
        let fail = || io::Error::other("invalid owned Linux compiler policy");
        let absolute = [
            &policy.workspace,
            &policy.incremental,
            &policy.root,
            &policy.scratch,
        ];
        if absolute
            .iter()
            .any(|p| !confined(p, true) || p.parent().is_none())
            || !disjoint(&policy.workspace, &policy.incremental)
            || !disjoint(&policy.root, &policy.workspace)
            || !disjoint(&policy.root, &policy.incremental)
            || !policy.scratch.starts_with(&policy.workspace)
            || policy.scratch == policy.workspace
            || policy.inputs.is_empty()
            || policy.outputs.is_empty()
        {
            return Err(fail());
        }
        let mut inputs = BTreeSet::new();
        for input in &policy.inputs {
            if !confined(input, false)
                || !inputs.insert(input)
                || !disjoint(&policy.workspace.join(input), &policy.scratch)
            {
                return Err(fail());
            }
        }
        let mut outputs: Vec<&PathBuf> = Vec::new();
        for output in &policy.outputs {
            if !confined(output, false)
                || outputs.iter().any(|prior| !disjoint(prior, output))
                || inputs.iter().any(|input| !disjoint(input, output))
                || !disjoint(&policy.workspace.join(output), &policy.scratch)
            {
                return Err(fail());
            }
            outputs.push(output);
        }
        let mut destinations: Vec<&PathBuf> = Vec::new();
        for runtime in &policy.runtime {
            if !inputs.contains(&runtime.input)
                || !confined(&runtime.path, true)
                || runtime.path.parent().is_none()
                || absolute.iter().any(|root| !disjoint(root, &runtime.path))
                || destinations
                    .iter()
                    .any(|prior| !disjoint(prior, &runtime.path))
            {
                return Err(fail());
            }
            destinations.push(&runtime.path);
        }
        Ok(policy)
    }

    // Output files may be atomically renamed and have compiler temporaries beside them.
    // Each such parent is a separate mountpoint; an input-only child stays read-only.
    pub fn writable(&self) -> BTreeSet<PathBuf> {
        self.outputs
            .iter()
            .map(|p| self.workspace.join(p).parent().unwrap().to_owned())
            .chain([self.scratch.clone()])
            .collect()
    }

    pub fn readonly(&self) -> BTreeSet<PathBuf> {
        let writable = self.writable();
        let mut protected = BTreeSet::new();
        for input in &self.inputs {
            let full = self.workspace.join(input);
            if !writable.iter().any(|root| full.starts_with(root)) {
                continue;
            }
            let candidates: Vec<_> = full
                .ancestors()
                .take_while(|p| p.starts_with(&self.workspace))
                .collect();
            for candidate in candidates.into_iter().rev() {
                if writable.iter().any(|root| candidate.starts_with(root))
                    && !writable.iter().any(|root| root.starts_with(candidate))
                {
                    protected.insert(candidate.to_owned());
                    break;
                }
            }
        }
        protected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value() -> serde_json::Value {
        serde_json::json!({"workspace":"/private/slot/execroot","incremental":"/private/slot/incremental/key","root":"/private/slot/confinement","scratch":"/private/slot/execroot/.scratch","inputs":["src/lib.rs","bin/deps/lib.rlib","external/sdk/bin/rustc"],"outputs":["bin/main.rlib"],"runtime":[],"leaf":false})
    }
    #[test]
    fn exact_protected_mounts_preserve_input_only_subtrees() {
        let policy = Policy::parse(&value().to_string()).unwrap();
        assert_eq!(
            policy.readonly(),
            BTreeSet::from([PathBuf::from("/private/slot/execroot/bin/deps")])
        );
        assert!(!policy.writable().contains(&policy.workspace));
        let mut v = value();
        v["outputs"] = serde_json::json!(["main.rlib"]);
        let policy = Policy::parse(&v.to_string()).unwrap();
        assert_eq!(
            policy.readonly(),
            BTreeSet::from(["src", "bin", "external"].map(|p| policy.workspace.join(p)))
        );
    }
    #[test]
    fn coherent_overlap_and_foreign_runtime_refuse() {
        for (field, replacement) in [
            ("inputs", serde_json::json!(["../foreign"])),
            ("inputs", serde_json::json!(["src/lib.rs", "src/lib.rs"])),
            ("outputs", serde_json::json!(["bin"])),
            ("outputs", serde_json::json!(["src/lib.rs"])),
            ("outputs", serde_json::json!([".scratch/file"])),
            ("root", serde_json::json!("/private/slot/execroot/root")),
            (
                "runtime",
                serde_json::json!([{"input":"foreign","path":"/lib/ld.so"}]),
            ),
            (
                "runtime",
                serde_json::json!([{"input":"src/lib.rs","path":"/private/slot/execroot/ld.so"}]),
            ),
        ] {
            let mut v = value();
            v[field] = replacement;
            assert!(Policy::parse(&v.to_string()).is_err(), "{field}");
        }
    }
    #[test]
    fn duplicate_fields_and_legacy_profiles_refuse() {
        let v = value().to_string();
        assert!(Policy::parse(&v.replacen('{', "{\"leaf\":true,", 1)).is_err());
        assert!(Policy::parse("(version 1) (allow default)").is_err());
        let mut v = value();
        v["ambient_runtime"] = serde_json::json!("/lib");
        assert!(Policy::parse(&v.to_string()).is_err());
    }
}
