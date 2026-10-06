"""One immutable original Debian acquisition for natlab and service images."""

_REGISTRY = "https://registry-1.docker.io/v2/library/debian/"

def _impl(ctx):
    lock = json.decode(ctx.read(ctx.attr.lock))
    consumer = lock["consumers"][ctx.attr.consumer]
    platform = lock["distributions"][consumer["distribution"]]["platforms"][ctx.attr.architecture]
    selected = consumer["packages"][ctx.attr.architecture]
    # Docker Hub's public, anonymous pull token is protocol data, never a user
    # credential. Keep it transient; no login/keychain/config/PATH is consulted.
    ctx.download(
        url = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull",
        output = ".anonymous-pull.json",
    )
    token = json.decode(ctx.read(".anonymous-pull.json"))["token"]
    ctx.delete(".anonymous-pull.json")
    files = []
    for name, specification in platform["base"].items():
        output = "base_rootfs.tar.gz" if name == "rootfs" else "base_" + name + ".json"
        url = specification["url"]
        auth = {url: {"type": "pattern", "pattern": "Bearer <password>", "password": token}} if url.startswith(_REGISTRY) else {}
        ctx.download(
            url = url,
            sha256 = specification["sha256"],
            canonical_id = url,
            output = output,
            auth = auth,
            headers = {"Accept": ["application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"]},
        )
        files.append(output)
    archives = []
    for name in selected:
        specification = platform["packages"][name]
        output = name + ".deb"
        ctx.download(url = specification["url"], sha256 = specification["SHA256"], canonical_id = specification["url"], output = output)
        files.append(output)
        archives.append(output)
    ctx.file("BUILD.bazel", '\n'.join([
        'package(default_visibility = ["//visibility:public"])',
        'exports_files(' + repr(files) + ')',
        'filegroup(name = "packages", srcs = ' + repr(archives) + ')',
        'filegroup(name = "original_inputs", srcs = ' + repr(files) + ')',
        '',
    ]))
    ctx.file("defs.bzl", '\n'.join([
        'load("@@//tools/bazel/verification:natlab/debian.bzl", "debian_rootfs")',
        'def define_rootfs(name, **kwargs):',
        '    debian_rootfs(',
        '        name = name,',
        '        consumer = ' + repr(ctx.attr.consumer) + ',',
        '        architecture = ' + repr(ctx.attr.architecture) + ',',
        '        distribution = ' + repr(consumer["distribution"]) + ',',
        '        base_index_digest = ' + repr("sha256:" + platform["base"]["index"]["sha256"]) + ',',
        '        lock = Label(' + repr(str(ctx.attr.lock)) + '),',
        '        base = Label("//:base_rootfs.tar.gz"),',
        '        base_config = Label("//:base_config.json"),',
        '        base_index = Label("//:base_index.json"),',
        '        base_manifest = Label("//:base_manifest.json"),',
        '        packages = {' + ', '.join(['Label(' + repr("//:" + name + ".deb") + '): ' + repr(name) for name in selected]) + '},',
        '        **kwargs',
        '    )',
        '',
    ]))

debian_runtime_repository = repository_rule(
    implementation = _impl,
    attrs = {
        "lock": attr.label(allow_single_file = True, mandatory = True),
        "consumer": attr.string(values = ["natlab", "edge", "stun", "tpm"], mandatory = True),
        "architecture": attr.string(values = ["amd64", "arm64"], mandatory = True),
    },
)
