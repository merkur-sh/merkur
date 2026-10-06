"""Explicit standing executor platforms; operator values are required, never inferred."""

def _sha256(value):
    if type(value) != "string" or len(value) != 64:
        return False
    for index in range(len(value)):
        if value[index] not in "0123456789abcdef":
            return False
    return True

def standing_execution_platform(name, os, arch, pool, image_digest, sdk_digest, container_image = None, registered = False):
    if os not in ["linux", "darwin"] or arch not in ["amd64", "arm64"]:
        fail("Standing execution requires a native Linux/macOS amd64/arm64 platform")
    if type(pool) != "string" or not _sha256(image_digest) or not _sha256(sdk_digest):
        fail("Actual pool, OS/image and SDK identities are required")
    # An explicitly supplied empty string names the default pool; never omit the property.
    properties = {
        "OSFamily": os,
        "Arch": arch,
        "Pool": pool,
        "use-self-hosted-executors": "true" if registered else "false",
    }
    if os == "linux":
        if registered or not container_image or not container_image.endswith("@sha256:" + image_digest):
            fail("Hosted Linux requires an exact digest-pinned container image")
        properties["container-image"] = container_image
    elif container_image != None:
        fail("Standing macOS execution does not use a Linux container")
    elif arch == "amd64" and not registered:
        fail("Intel Mac execution requires an actually registered physical standing pool")
    # OS/SDK identities must also be checked against actual worker/toolchain evidence.
    native.platform(
        name = name,
        constraint_values = [
            "@platforms//os:" + ("linux" if os == "linux" else "osx"),
            "@platforms//cpu:" + ("x86_64" if arch == "amd64" else "aarch64"),
        ],
        exec_properties = properties,
    )
