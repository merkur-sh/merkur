"""Declaration controls; fixture origins never download or qualify Apple sources."""
load("@bazel_skylib//lib:unittest.bzl", "analysistest", "asserts", "unittest")
load(":darwin-extension.bzl", "darwin_compiler_requests")

_HOSTS = ["darwin_arm64", "darwin_x64", "linux_arm64", "linux_x64"]

def _read(label):
    if label.name == "python-pins.json":
        return json.encode({"platforms": {host: {"url": "https://example.invalid/nonexecuted-python-" + host + ".tar.gz", "sha256": "1" * 64} for host in _HOSTS}})
    return json.encode({"execution_cpu": "aarch64" if label.name == "arm64.json" else "x86_64"})

def _dev(tag):
    return tag.dev

def _tag(platform = "darwin_arm64", specification = "arm64.json", constraints = [Label("@platforms//os:osx")], dev = False):
    return struct(platform = platform, specification = Label("//:" + specification), executor_constraints = constraints, deployment_target = "15.0", dev = dev)

def _context(tags, name = "mac os x", arch = "aarch64", root = True):
    return struct(modules = [struct(is_root = root, tags = struct(compiler = tags))], os = struct(name = name, arch = arch), read = _read, is_dev_dependency = _dev)

def _positive(ctx):
    env = unittest.begin(ctx)
    asserts.equals(env, [], darwin_compiler_requests(_context([], name = "unsupported", arch = "unsupported")), "Absent compiler tags create no provider or host requirement")
    for os, cpu, host in [("mac os x", "aarch64", "darwin_arm64"), ("mac os x", "x86_64", "darwin_x64"), ("linux", "aarch64", "linux_arm64"), ("linux", "x86_64", "linux_x64")]:
        requests = darwin_compiler_requests(_context([_tag()], name = os, arch = cpu))
        asserts.equals(env, 1, len(requests), "One declared platform does not invent its absent counterpart")
        asserts.equals(env, "compiler_darwin_arm64", requests[0].name)
        asserts.equals(env, "https://example.invalid/nonexecuted-python-" + host + ".tar.gz", requests[0].python_url)
        asserts.equals(env, "1" * 64, requests[0].python_sha256)
        asserts.equals(env, [str(Label("@platforms//os:osx"))], requests[0].executor_constraints)
        asserts.false(env, requests[0].dev_dependency)
    x64 = darwin_compiler_requests(_context([_tag(platform = "darwin_x64", specification = "x64.json", dev = True)]))[0]
    asserts.equals(env, "compiler_darwin_x64", x64.name)
    asserts.true(env, x64.dev_dependency)
    return unittest.end(env)

darwin_extension_test = unittest.make(_positive)

def _probe(ctx):
    tags = [_tag(specification = "x64.json" if ctx.attr.failure == "cpu" else "arm64.json", constraints = [] if ctx.attr.failure == "constraints" else [Label("@platforms//os:osx")])]
    if ctx.attr.failure == "duplicate":
        tags.append(tags[0])
    darwin_compiler_requests(_context(tags, root = ctx.attr.failure != "dependency", arch = "unsupported" if ctx.attr.failure == "host" else "aarch64"))
    return [DefaultInfo()]

darwin_declaration_probe = rule(implementation = _probe, attrs = {"failure": attr.string(values = ["cpu", "constraints", "duplicate", "dependency", "host"], mandatory = True)})

def _negative(ctx):
    env = analysistest.begin(ctx)
    asserts.expect_failure(env, ctx.attr.message)
    return analysistest.end(env)

darwin_declaration_failure_test = analysistest.make(_negative, expect_failure = True, attrs = {"message": attr.string(mandatory = True)})
