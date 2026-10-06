"""Native standalone Bun attribution from the actual selected compiler inputs.

The native packager retains the original executable basename in artifact facts
and independently names the archive destination (merkur or verify).
These actions publish first-party and npm scopes only. Their pending scope
inventories require separate genuine WASM and embedded-runtime providers.
"""

load("//tools/bazel/packaging:notices.bzl", "first_party_attribution", "npm_attribution")

_NATIVE_PRODUCERS = [
    Label("//apps/daemon:daemon"),
    Label("//scripts:release_verifier"),
]

def native_bun_attributions(name, producer, packages, registry = "//tools/bazel/bun:npm-inventory.json", **kwargs):
    """Declare two selected scopes, each bound to the original native producer.

    `packages` is the complete declared authored source inventory, consumed by
    the existing compiler-selected first-party collector. Npm sources come from
    the producer's genuine BunNpmAttributionInfo; no package resolver is run.
    Native release consumers require all remaining pending providers separately.
    """
    if Label(producer) not in _NATIVE_PRODUCERS:
        fail("Native Bun attribution requires daemon or release_verifier")
    first_party_attribution(
        name = name + "_first_party",
        producer = producer,
        packages = packages,
        **kwargs
    )
    npm_attribution(
        name = name + "_npm",
        producer = producer,
        registry = registry,
        **kwargs
    )
