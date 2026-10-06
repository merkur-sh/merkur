//! Bazel action: extract exact production AST bodies from three declared inputs.
use quote::{ToTokens, quote};
use std::{fs, path::Path};
use syn::{File, ImplItem, Item, ItemImpl, Type};

fn one<T>(mut matches: impl Iterator<Item = T>, name: &str) -> T {
    let item = matches
        .next()
        .unwrap_or_else(|| panic!("missing production {name}"));
    assert!(matches.next().is_none(), "ambiguous production {name}");
    item
}

fn source(path: &str, role: &str, control: &str) -> File {
    let mut text = fs::read_to_string(path).expect("read declared production source");
    let mutation = match (control, role) {
        ("custody", "client") => Some((
            ".any(|(_, other)| merkur_e2e::lane_for_channel(*other) == Some(lane))",
            ".any(|(owner, other)| *owner == conn && merkur_e2e::lane_for_channel(*other) == Some(lane))",
        )),
        ("route_guard", "edge") => Some((
            "        match peers.sink_for(self.from_role.peer()) {",
            "        drop(peers);\n        let peers = self.peers.read();\n        match peers.sink_for(self.from_role.peer()) {",
        )),
        ("retirement", "edge") => Some((
            "[peers.browser.take(), peers.daemon.take()]",
            "{ let _ = &mut peers; [Option::<PeerSink>::None, Option::<PeerSink>::None] }",
        )),
        ("slot_drop", "edge") => Some((
            "        *self.peers.write() = SessionPeers::default();",
            "        let _ = self;",
        )),
        ("stale_detach", "edge") => Some((
            "        if sink\n            .as_ref()\n            .is_some_and(|current| current.attachment_id == attachment_id)",
            "        if sink\n            .as_ref()\n            .is_some_and(|_| true)",
        )),
        _ => None,
    };
    if let Some((original, replacement)) = mutation {
        assert_eq!(
            text.matches(original).count(),
            1,
            "negative control must match exactly one safeguard"
        );
        text = text.replacen(original, replacement, 1);
    }
    syn::parse_file(&text).expect("parse production source")
}

fn named_impl<'a>(file: &'a File, name: &str, trait_name: Option<&str>) -> &'a ItemImpl {
    one(file.items.iter().filter_map(|item| match item {
        Item::Impl(item)
            if matches!(&*item.self_ty, Type::Path(ty) if ty.qself.is_none() && ty.path.is_ident(name))
                && match (&item.trait_, trait_name) {
                    (None, None) => true,
                    (Some((_, path, _)), Some(expected)) => path.is_ident(expected),
                    _ => false,
                } => Some(item),
        _ => None,
    }), name)
}

fn emit(output: &Path, name: &str, tokens: impl ToTokens) {
    fs::write(output.join(name), tokens.to_token_stream().to_string())
        .expect("write extracted production AST");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert_eq!(
        args.len(),
        6,
        "usage: extractor E2E CLIENT EDGE OUTPUT_DIRECTORY CONTROL"
    );
    let control = args[5].as_str();
    assert!(
        matches!(
            control,
            "" | "custody" | "route_guard" | "retirement" | "slot_drop" | "stale_detach"
        ),
        "unknown negative control"
    );
    let output = Path::new(&args[4]);
    fs::create_dir_all(output).expect("create declared output directory");
    for (input, role, name, destination) in [
        (&args[1], "e2e", "lane_for_channel", "lanes.rs"),
        (
            &args[2],
            "client",
            "writer_lane_blocked",
            "writer_custody.rs",
        ),
    ] {
        let file = source(input, role, control);
        let function = one(
            file.items.iter().filter_map(|item| match item {
                Item::Fn(item) if item.sig.ident == name => Some(item),
                _ => None,
            }),
            name,
        );
        emit(output, destination, function);
    }
    let edge = source(&args[3], "edge", control);
    let structure = |name: &str| {
        one(
            edge.items.iter().filter_map(|item| match item {
                Item::Struct(item) if item.ident == name => Some(item),
                _ => None,
            }),
            name,
        )
    };
    let peers = structure("SessionPeers");
    let route = structure("DatagramRoute");
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
