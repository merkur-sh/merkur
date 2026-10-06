"""Verified acquisition of Kani and its matched compiler, never production Rust."""

_VERSION = "0.68.0"
_DATE = "2026-08-21"
_PINS = {
    "darwin_arm64": struct(triple = "aarch64-apple-darwin", cargo = "a5f614be4d41298087d4d37a7b71fdfca470290435e37ee59a072a59b7ed0311", kani = "a5d39a5d5e748253a553aa62f295c6c397287927a28e5e32691d7ff2eda0c398", rustc = "d9096c50eb2d844cc302398aa654e9d55a7a047d18e4e9d156a5276c3ff35fad", std = "737516996e2d61c6fa28230cbd1537b2eb53ea5856228623ff45435f27a41fa7"),
    "darwin_x64": struct(triple = "x86_64-apple-darwin", cargo = "90401120efb98d164866d2776d36b9538abb5a4cb9919d4316f6e9aa4d2a5a7a", kani = "b1367f694c1350abcae133701f78b3be3fd6e9beb66681a22ea0bcac0cc34808", rustc = "bfa3e16772558a5ac2c0ff2c13578c25b235a90a7e07270f1c9a6951faceee08", std = "78f0b7a53b2935ca2fbbaff996e6028510a8531e4888be95440412ad0bc606e5"),
    "linux_arm64": struct(triple = "aarch64-unknown-linux-gnu", cargo = "6f116a4062e6f0fc478da3f9728b2a48da1a6eb3589aa1315042d6197c3a36e0", kani = "0042d2688bf1550270def4a79c96aaeea138631818cb4ab5480120f2d51a942c", rustc = "1752c051596e4d63575f3c50939f76b680bebb412c249593d0f3231ea962bee4", std = "84ed3496bc95b017762d4c09a5c85f21f2cce62a27d963fb403d6beacfb4ad59"),
    "linux_x64": struct(triple = "x86_64-unknown-linux-gnu", cargo = "51306dcd70ad7ea807727fb313b6a0cbc6406934ad230b6c18db79a97c539c57", kani = "32e2b484d73ede0bbf64a2cf0879c4259422497d8aec4ee67d448de9ae7843d3", rustc = "e531815fa551362b5a485e0d286b6c96555312d49359c0b8fe9e8f34c45594b4", std = "52cd12570c6f967c3d04173e061fdab1cd44ab9613f53df8e04f7ce3b52ea3a3"),
}

def _kani_repository_impl(ctx):
    triple = ctx.attr.triple
    ctx.download_and_extract(
        url = "https://github.com/model-checking/kani/releases/download/kani-{v}/kani-{v}-{t}.tar.gz".format(v = _VERSION, t = triple),
        sha256 = ctx.attr.kani_sha256,
        stripPrefix = "kani-" + _VERSION,
    )
    # The release compiler embeds this nightly identity; the verification library
    # and compiler cannot be mixed with an ordinary production toolchain.
    for component, digest in [("rustc", ctx.attr.rustc_sha256), ("rust-std", ctx.attr.std_sha256)]:
        prefix = component + "-nightly-" + triple
        directory = "install-" + component
        ctx.download_and_extract(
            url = "https://static.rust-lang.org/dist/{d}/{p}.tar.xz".format(d = _DATE, p = prefix),
            sha256 = digest,
            output = directory,
            stripPrefix = prefix,
        )
        result = ctx.execute(["/bin/sh", directory + "/install.sh", "--prefix=" + str(ctx.path("toolchain")), "--disable-ldconfig"])
        if result.return_code:
            fail("matched Kani compiler installation failed: " + result.stderr)
        ctx.delete(directory)
    # Release-mode Kani selects this exact Cargo path internally. Keep its
    # complete original component and notices in the declared File closure.
    prefix = "cargo-nightly-" + triple
    ctx.download_and_extract(
        url = "https://static.rust-lang.org/dist/{d}/{p}.tar.xz".format(d = _DATE, p = prefix),
        sha256 = ctx.attr.cargo_sha256,
        output = "install-cargo",
        stripPrefix = prefix,
    )
    ctx.symlink("install-cargo/cargo/bin/cargo", "toolchain/bin/cargo")
    ctx.file("BUILD.bazel", """package(default_visibility = ["//visibility:public"])
exports_files(["bin/kani-driver", "toolchain/bin/cargo"])
filegroup(name = "files", srcs = glob(["**"], exclude = ["BUILD.bazel"]))
""")

_kani_repository = repository_rule(
    implementation = _kani_repository_impl,
    attrs = {
        "triple": attr.string(mandatory = True),
        "kani_sha256": attr.string(mandatory = True),
        "rustc_sha256": attr.string(mandatory = True),
        "std_sha256": attr.string(mandatory = True),
        "cargo_sha256": attr.string(mandatory = True),
    },
)

def _kani_extension_impl(_ctx):
    for platform, pins in _PINS.items():
        _kani_repository(name = "kani_" + platform, triple = pins.triple, kani_sha256 = pins.kani, rustc_sha256 = pins.rustc, std_sha256 = pins.std, cargo_sha256 = pins.cargo)

kani = module_extension(implementation = _kani_extension_impl)
