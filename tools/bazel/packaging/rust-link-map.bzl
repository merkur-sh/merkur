"""Actual linker side output owned by the original Rust compile action."""

RustLinkMapInfo = provider(fields = ["artifact", "link_map", "stdlib", "target", "compiler", "rustc", "execution_host"])

_FORMATS = {
    "aarch64-apple-darwin": "-Clink-arg=-Wl,-map,%s",
    "x86_64-apple-darwin": "-Clink-arg=-Wl,-map,%s",
    "aarch64-unknown-linux-gnu": "-Clink-arg=-Wl,-Map,%s",
    "x86_64-unknown-linux-gnu": "-Clink-arg=-Wl,-Map,%s",
}

def declare_link_map(ctx, attr, crate, toolchain, build_metadata, use_cc_common_link):
    """Declare the selected linker's map in the full original rustc action."""
    native = getattr(attr, "native_link_map", False)
    wasm = getattr(attr, "wasm_link_map", False)
    if not native and not wasm:
        return None
    if native and wasm:
        fail("The original compiler action requires exactly one linker map kind")
    if crate.is_test or build_metadata or use_cc_common_link:
        fail("Link attribution requires the original full non-test Rust link action")
    triple = toolchain.target_triple.str
    if native:
        if crate.type not in ["bin", "proc-macro"] or triple not in _FORMATS:
            fail("native_link_map requires a declared native binary or proc-macro link action")
        flag = _FORMATS[triple]
        output_group = "native_link_map"
    else:
        if crate.type != "cdylib" or triple != "wasm32-unknown-unknown":
            fail("wasm_link_map requires the original wasm32-unknown-unknown cdylib link action")
        flag = "-Clink-arg=-Map=%s"
        output_group = "wasm_link_map"
    return struct(
        link_map = ctx.actions.declare_file(crate.output.basename + ".link-map.txt", sibling = crate.output),
        flag_format = flag,
        output_group = output_group,
    )

def link_map_info(declaration, crate, toolchain):
    """Keep exact declared SDK Files for joining the linker's actual input records."""
    return RustLinkMapInfo(
        artifact = crate.output,
        link_map = declaration.link_map,
        stdlib = toolchain.rust_std,
        target = toolchain.target_triple.str,
        compiler = toolchain.version,
        rustc = toolchain.rustc,
        execution_host = toolchain.exec_triple.str,
    )
