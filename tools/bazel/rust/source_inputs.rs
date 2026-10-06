//! Refresh-only Rust macro input discovery. Compiler actions never walk a checkout.
use proc_macro2::{TokenStream, TokenTree};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn value(tokens: TokenStream, manifest: &Path) -> Result<Option<String>> {
    if let Ok(literal) = syn::parse2::<syn::LitStr>(tokens.clone()) {
        return Ok(Some(literal.value()));
    }
    let expression = syn::parse2::<syn::ExprMacro>(tokens)?;
    if expression.mac.path.is_ident("env") {
        let name = syn::parse2::<syn::LitStr>(expression.mac.tokens)?.value();
        return match name.as_str() {
            "CARGO_MANIFEST_DIR" => Ok(Some(manifest.to_string_lossy().into_owned())),
            // OUT_DIR is provided by the owning declared build-script action.
            "OUT_DIR" => Ok(None),
            _ => Err(format!("unmodeled include environment: {name}").into()),
        };
    }
    if !expression.mac.path.is_ident("concat") {
        return Err("include argument must be a literal or declared concat/env expression".into());
    }
    use syn::parse::Parser;
    let expressions = syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated
        .parse2(expression.mac.tokens)?;
    let mut output = String::new();
    for expression in expressions {
        use quote::ToTokens;
        let Some(part) = value(expression.into_token_stream(), manifest)? else {
            return Ok(None);
        };
        output.push_str(&part);
    }
    Ok(Some(output))
}

fn macros(
    tokens: TokenStream,
    source: &Path,
    manifest: &Path,
    root: &Path,
    inputs: &mut BTreeSet<String>,
    included_sources: &mut BTreeMap<String, String>,
) -> Result<()> {
    let tokens: Vec<_> = tokens.into_iter().collect();
    for (index, token) in tokens.iter().enumerate() {
        if let TokenTree::Ident(name) = token {
            if matches!(
                name.to_string().as_str(),
                "include" | "include_str" | "include_bytes"
            ) && matches!(tokens.get(index + 1), Some(TokenTree::Punct(p)) if p.as_char() == '!')
            {
                let Some(TokenTree::Group(argument)) = tokens.get(index + 2) else {
                    return Err("include macro has no argument group".into());
                };
                if let Some(path) = value(argument.stream(), manifest)? {
                    let unresolved = source
                        .parent()
                        .ok_or("source has no parent")?
                        .join(path);
                    let path = unresolved.canonicalize().map_err(|error| {
                        format!(
                            "cannot resolve {name}! input {} referenced from {}: {error}",
                            unresolved.display(),
                            source.display(),
                        )
                    })?;
                    let relative = path.strip_prefix(root)?.to_string_lossy().into_owned();
                    let newly_included = inputs.insert(relative.clone());
                    if newly_included {
                        let bytes = fs::read(&path)?;
                        included_sources
                            .insert(relative, format!("{:x}", Sha256::digest(&bytes)));
                        if name.to_string() == "include" {
                            macros(
                                String::from_utf8(bytes)?.parse()?,
                                &path,
                                manifest,
                                root,
                                inputs,
                                included_sources,
                            )?;
                        }
                    }
                }
            }
        }
        if let TokenTree::Group(group) = token {
            macros(
                group.stream(),
                source,
                manifest,
                root,
                inputs,
                included_sources,
            )?;
        }
    }
    Ok(())
}

fn sources(directory: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    let mut entries = fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort();
    for entry in entries {
        if matches!(
            entry.file_name().and_then(|name| name.to_str()),
            Some("target" | "node_modules" | "pkg" | "dist" | ".git")
        ) {
            continue;
        }
        if entry.is_dir() {
            sources(&entry, output)?
        } else if entry.extension().is_some_and(|extension| extension == "rs") {
            output.push(entry)
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let root = PathBuf::from(arguments.next().ok_or("expected repository root")?).canonicalize()?;
    let metadata = fs::read(arguments.next().ok_or("expected metadata inventory")?)?;
    let inventory: serde_json::Value = serde_json::from_slice(&metadata)?;
    if arguments.next().is_some() {
        return Err("unexpected arguments".into());
    }
    let mut output = BTreeMap::new();
    let mut source_hashes = BTreeMap::new();
    let mut included_sources = BTreeMap::new();
    for package in inventory["packages"]
        .as_array()
        .ok_or("missing package inventory")?
    {
        let Some(manifest) = package["manifest"].as_str() else {
            continue;
        };
        let manifest = root.join(manifest);
        let directory = manifest.parent().ok_or("manifest has no directory")?;
        let mut files = Vec::new();
        sources(directory, &mut files)?;
        let mut inputs = BTreeSet::new();
        for source in files {
            let text = fs::read_to_string(&source)?;
            source_hashes.insert(
                source.strip_prefix(&root)?.to_string_lossy().into_owned(),
                format!("{:x}", Sha256::digest(text.as_bytes())),
            );
            macros(
                text.parse()?,
                &source,
                directory,
                &root,
                &mut inputs,
                &mut included_sources,
            )?;
        }
        output.insert(
            manifest.strip_prefix(&root)?.to_string_lossy().into_owned(),
            inputs,
        );
    }
    let document = serde_json::json!({"macros": output, "sources": source_hashes, "included_sources": included_sources, "metadata_sha256": format!("{:x}", Sha256::digest(&metadata))});
    println!("{}", serde_json::to_string_pretty(&document)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "merkur-source-includes-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&root).unwrap();
            Self(root.canonicalize().unwrap())
        }

        fn discover(&self, text: &str) -> Result<(BTreeSet<String>, BTreeMap<String, String>)> {
            let mut inputs = BTreeSet::new();
            let mut included = BTreeMap::new();
            macros(
                text.parse()?,
                &self.0.join("main.rs"),
                &self.0,
                &self.0,
                &mut inputs,
                &mut included,
            )?;
            Ok((inputs, included))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn string_and_binary_macros_capture_original_bytes_without_token_parsing() {
        let fixture = Fixture::new();
        let xml = b"<?xml version=\"1.0\"?><root><value>original</value></root>";
        let binary = [0, 255, 128, 42];
        fs::write(fixture.0.join("pfsense.xml"), xml).unwrap();
        fs::write(fixture.0.join("payload.bin"), binary).unwrap();
        let (inputs, included) = fixture
            .discover("include_str!(\"pfsense.xml\"); include_bytes!(\"payload.bin\");")
            .unwrap();
        assert_eq!(inputs, BTreeSet::from(["payload.bin".into(), "pfsense.xml".into()]));
        assert_eq!(included["pfsense.xml"], format!("{:x}", Sha256::digest(xml)));
        assert_eq!(included["payload.bin"], format!("{:x}", Sha256::digest(binary)));
    }

    #[test]
    fn recursive_rust_include_keeps_nested_original_data_facts() {
        let fixture = Fixture::new();
        let rust = b"const DATA: &[u8] = include_bytes!(\"payload.bin\");";
        let binary = [255, 1];
        fs::write(fixture.0.join("nested.inc"), rust).unwrap();
        fs::write(fixture.0.join("payload.bin"), binary).unwrap();
        let (inputs, included) = fixture.discover("include!(\"nested.inc\");").unwrap();
        assert_eq!(inputs.len(), 2);
        assert_eq!(included["nested.inc"], format!("{:x}", Sha256::digest(rust)));
        assert_eq!(included["payload.bin"], format!("{:x}", Sha256::digest(binary)));
    }

    #[test]
    fn missing_and_foreign_macro_files_still_refuse() {
        let fixture = Fixture::new();
        assert!(fixture.discover("include_bytes!(\"missing.bin\");").is_err());
        let foreign = Fixture::new();
        fs::write(foreign.0.join("foreign.bin"), b"foreign").unwrap();
        let text = format!("include_bytes!({:?});", foreign.0.join("foreign.bin"));
        assert!(fixture.discover(&text).is_err());
    }
}
