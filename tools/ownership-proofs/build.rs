//! Generate proof inputs from the actual production AST without changing shipped code.
use quote::{quote, ToTokens};
use std::{env, fs, path::Path};
use syn::{File, ImplItem, Item, ItemImpl, Type};

fn one<T>(mut matches: impl Iterator<Item = T>, name: &str) -> T {
    let item = matches
        .next()
        .unwrap_or_else(|| panic!("missing production {name}"));
    assert!(matches.next().is_none(), "ambiguous production {name}");
    item
}

fn source(root: &Path, path: &str) -> File {
    let path = root.join(path);
    println!("cargo:rerun-if-changed={}", path.display());
    syn::parse_file(&fs::read_to_string(path).expect("read production source"))
        .expect("parse production source")
}

fn named_impl<'a>(source: &'a File, name: &str, trait_name: Option<&str>) -> &'a ItemImpl {
    one(
        source.items.iter().filter_map(|item| match item {
            Item::Impl(item)
                if matches!(&*item.self_ty, Type::Path(ty) if ty.qself.is_none() && ty.path.is_ident(name))
                    && match (&item.trait_, trait_name) {
                        (None, None) => true,
                        (Some((_, path, _)), Some(expected)) => path.is_ident(expected),
                        _ => false,
                    } => Some(item),
            _ => None,
        }),
        name,
    )
}

fn emit(root: &Path, name: &str, tokens: impl ToTokens) {
    fs::write(root.join(name), tokens.to_token_stream().to_string())
        .expect("write extracted proof input");
}

fn main() {
    let manifest = env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory");
    let root = Path::new(&manifest).parent().unwrap().parent().unwrap();
    let output = env::var_os("OUT_DIR").expect("proof output directory");
    let output = Path::new(&output);
    for (path, name, destination) in [
        (
            "packages/merkur-e2e/src/lib.rs",
            "lane_for_channel",
            "lanes.rs",
        ),
        (
            "packages/merkur-client/src/session.rs",
            "writer_lane_blocked",
            "writer_custody.rs",
        ),
    ] {
        let file = source(root, path);
        let function = one(
            file.items.iter().filter_map(|item| match item {
                Item::Fn(item) if item.sig.ident == name => Some(item),
                _ => None,
            }),
            name,
        );
        emit(output, destination, function);
    }

    let edge = source(root, "apps/edge/src/splice.rs");
    let peers = one(
        edge.items.iter().filter_map(|item| match item {
            Item::Struct(item) if item.ident == "SessionPeers" => Some(item),
            _ => None,
        }),
        "SessionPeers",
    );
    let route = one(
        edge.items.iter().filter_map(|item| match item {
            Item::Struct(item) if item.ident == "DatagramRoute" => Some(item),
            _ => None,
        }),
        "DatagramRoute",
    );
    let peers_impl = named_impl(&edge, "SessionPeers", None);
    let route_impl = named_impl(&edge, "DatagramRoute", None);
    emit(
        output,
        "routing.rs",
        quote! { #peers #peers_impl #route #route_impl },
    );

    let mut membership = named_impl(&edge, "SessionSlot", None).clone();
    let methods = ["set", "detach", "retire"];
    for name in methods {
        one(
            membership
                .items
                .iter()
                .filter(|item| matches!(item, ImplItem::Fn(method) if method.sig.ident == name)),
            name,
        );
    }
    membership.items.retain(|item| {
        matches!(item, ImplItem::Fn(method) if methods.iter().any(|name| method.sig.ident == name))
    });
    let drop_impl = named_impl(&edge, "SessionSlot", Some("Drop"));
    emit(output, "membership.rs", quote! { #membership #drop_impl });
}
