"""Register native unsigned suppliers from actual caller-owned compiler contexts.

Every native role is required before registering any action. Existing selected
attribution and package rules establish File custody and completeness; this
factory neither manufactures providers nor supplies missing native contexts.
"""

load("//tools/bazel/bun:rules.bzl", "bun_npm_attribution")
load("//tools/bazel/wasm:selected-attribution.bzl", "selected_wasm_input_custody")
load(":native-release.bzl", "NATIVE_RELEASE_PLATFORMS", "NATIVE_RELEASE_TARGETS", "native_release_layout", "native_unsigned_release")
load(":notices.bzl", "first_party_attribution", "npm_attribution", "rust_attribution")
load(":rust-compiled.bzl", "compiled_rust_attribution")

_TARGETS = NATIVE_RELEASE_TARGETS

_RUST = {
    "//packages/merkur-image-worker:bin_merkur_image_worker": "merkur-image-worker",
    "//apps/tui:bin_merkur_tui": "merkur-tui",
}

def _rust(platform):
    roles = dict(_RUST)
    roles["//tools/bazel/rust/release_pgo/" + _TARGETS[platform] + ":dataplane_release"] = "merkur-dataplane"
    return roles

def _keys(value, expected, description):
    if type(value) != "dict" or sorted(value) != sorted(expected):
        fail("Native suppliers require exact " + description)

def _label(value):
    if type(value) != "string" or not value:
        fail("Native suppliers require an explicit original producer label")
    return Label(value)

def _packages(value, cargo):
    if (type(value) != "dict" if cargo else type(value) != "list") or not value:
        fail("Native suppliers require nonempty original package source providers")
    labels = value.keys() if cargo else value
    if len({_label(label): True for label in labels}) != len(labels):
        fail("Native suppliers have repeated package source providers")
    if cargo and (any([type(identity) != "string" or not identity for identity in value.values()]) or len({identity: True for identity in value.values()}) != len(value)):
        fail("Native suppliers require distinct original Cargo package identities")

def _wasm(value):
    _keys(value, ["rust_producers", "rust_attributions", "rust_packages", "generator_attributions"], "WASM compiler and complete source joins")
    producers = value["rust_producers"]
    attributions = value["rust_attributions"]
    for selected in [producers, attributions]:
        if type(selected) != "dict" or not selected:
            fail("Native WASM suppliers require nonempty original Rust joins")
        labels = {_label(label): True for label in selected}
        originals = {_label(original): True for original in selected.values()}
        if len(labels) != len(selected) or len(originals) != len(selected):
            fail("Native WASM suppliers require one original Rust join per package")
    if {_label(original): True for original in producers.values()} != {_label(original): True for original in attributions.values()}:
        fail("Native WASM compiler and compiled attribution packages differ")
    _packages(value["rust_packages"], True)
    _packages(value["generator_attributions"], False)

def _layouts():
    return [struct(platform = platform, kind = kind, layout = native_release_layout(kind, platform))
            for platform in NATIVE_RELEASE_PLATFORMS
            for kind in (["daemon", "verify"] if platform.startswith("linux-") else ["daemon"])]

def _validate(suppliers):
    layouts = _layouts()
    _keys(suppliers, [item.layout.name for item in layouts], "six native release roles")
    for item in layouts:
        value = suppliers[item.layout.name]
        _keys(value, ["bun", "rust"], "Bun and Rust supplier fields")
        bun = value["bun"]
        _keys(bun, ["producer", "packages", "registry", "wasm", "embedded_runtime"], "Bun compiler and required source scopes")
        expected_bun = "//apps/daemon:daemon" if item.kind == "daemon" else "//scripts:release_verifier"
        if _label(bun["producer"]) != Label(expected_bun):
            fail("Native supplier Bun compiler differs from its original release role")
        if _label(bun["registry"]) != Label("//tools/bazel/bun:npm-inventory.json"):
            fail("Native supplier registry differs from the original compiler selector")
        _packages(bun["packages"], False)
        _wasm(bun["wasm"])
        _label(bun["embedded_runtime"])
        rust = value["rust"]
        roles = _rust(item.platform) if item.kind == "daemon" else {}
        _keys(rust, roles.keys(), "selected Rust release members")
        for public_producer, spec in rust.items():
            _keys(spec, ["producer", "descriptor", "compiler_root", "packages", "stdlib_notices"], "original Rust compiler context")
            label = _label(spec["producer"])
            if not label.name.startswith("u_") or len(label.name) != 66 or any([character not in "0123456789abcdef" for character in label.name[2:].elems()]):
                fail("Native supplier requires the actual maintained Rust compiler unit")
            package = roles[public_producer]
            profile = "profile_use" if package == "merkur-dataplane" else "release"
            if spec["compiler_root"] != package + "/" + profile + "/" + _TARGETS[item.platform]:
                fail("Native supplier Rust context differs from its original native release role")
            if package == "merkur-dataplane" and (label.package != "tools/bazel/rust/release_pgo/" + _TARGETS[item.platform] or label.repo_name != Label(public_producer).repo_name):
                fail("Native dataplane supplier requires its original trained profile-use compiler")
            _label(spec["descriptor"])
            _label(spec["stdlib_notices"])
            _packages(spec["packages"], True)
    return layouts

def declare_native_release_suppliers(suppliers):
    """Create six real package actions from exact caller-supplied native inputs.

    Rust contexts must include actual descriptor/package/linked-stdlib targets.
    Bun contexts bind each actual WASM package to its original compiled Rust
    and generator attributions. Embedded runtime scope remains a genuine target.
    Empty WASM joins refuse until compiler-selected absence is implemented.
    Missing dependencies refuse rather than creating an incomplete supplier.
    Call this in tools/bazel/packaging, where the global release join expects
    the original package action labels. Platform transitions remain owned by
    that existing join and compiler/provider rules.
    """
    if native.package_name() != "tools/bazel/packaging":
        fail("Native suppliers must retain the original package action namespace")
    layouts = _validate(suppliers)
    outputs = {}
    for item in layouts:
        layout = item.layout
        value = suppliers[layout.name]
        bun = value["bun"]
        prefix = layout.name + "_selected"
        constraints = NATIVE_RELEASE_PLATFORMS[item.platform]
        kwargs = {"target_compatible_with": constraints, "tags": ["manual", "unqualified-release-attribution"]}
        bun_npm_attribution(name = prefix + "_npm_sources", compiler = bun["producer"], **kwargs)
        first_party_attribution(name = prefix + "_first_party", producer = bun["producer"], packages = bun["packages"], **kwargs)
        npm_attribution(name = prefix + "_npm", producer = ":" + prefix + "_npm_sources", registry = bun["registry"], **kwargs)
        wasm = bun["wasm"]
        selected_wasm_input_custody(
            name = prefix + "_wasm",
            compiler = bun["producer"],
            rust_producers = wasm["rust_producers"],
            rust_attributions = wasm["rust_attributions"],
            rust_packages = wasm["rust_packages"],
            generator_attributions = wasm["generator_attributions"],
            **kwargs
        )
        attributions = [":" + prefix + "_first_party", ":" + prefix + "_npm", ":" + prefix + "_wasm", bun["embedded_runtime"]]
        for public_producer, spec in value["rust"].items():
            name = prefix + "_" + layout.files[public_producer]
            rust_attribution(name = name + "_sources", descriptor = spec["descriptor"], compiler_root = spec["compiler_root"], target_triple = _TARGETS[item.platform], packages = spec["packages"], **kwargs)
            compiled_rust_attribution(name = name, producer = spec["producer"], descriptor = spec["descriptor"], attribution = ":" + name + "_sources", target_triple = _TARGETS[item.platform], packages = spec["packages"], stdlib_notices = spec["stdlib_notices"], **kwargs)
            attributions.append(":" + name)
        native_unsigned_release(name = layout.name, kind = item.kind, platform = item.platform, files = layout.files, attributions = attributions, target_compatible_with = constraints, tags = ["manual"])
        outputs[layout.name] = ":" + layout.name
    return outputs

def declare_frontend_wasm_supplier(rust_attributions, rust_packages, generator_attributions):
    """Bind the shipped frontend's three actual package/compiler producers.

    All complete Rust and generator scopes remain mandatory caller inputs.
    The collector verifies the same-action artifacts and selected inputs; this
    registration never turns unfinished runtime metadata into attribution.
    """
    if native.package_name() != "tools/bazel/packaging":
        fail("Frontend WASM supplier must retain the original package namespace")
    value = {
        "rust_producers": {
            "//tools/bazel/rust/units:e2e_wasm__release_wasm": "//packages/e2e-wasm:wasm_artifacts",
            "//tools/bazel/rust/units:graphics_wasm__release_wasm": "//packages/graphics-wasm:wasm_artifacts",
            "//tools/bazel/rust/units:term_wasm__profile_use_wasm": "//packages/term-wasm:wasm_artifacts",
        },
        "rust_attributions": rust_attributions,
        "rust_packages": rust_packages,
        "generator_attributions": generator_attributions,
    }
    _wasm(value)
    selected_wasm_input_custody(
        name = "web_wasm_notices",
        compiler = "//apps/web:frontend_precompressed",
        rust_producers = value["rust_producers"],
        rust_attributions = rust_attributions,
        rust_packages = rust_packages,
        generator_attributions = generator_attributions,
        tags = ["manual", "unqualified-release-attribution"],
    )
    return ":web_wasm_notices"
