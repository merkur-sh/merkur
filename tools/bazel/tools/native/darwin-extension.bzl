"""Explicit Darwin compiler acquisitions and their toolchain registration."""
load(":darwin-compiler.bzl", "darwin_compiler_archive")

_PLATFORMS = {"darwin_arm64": "aarch64", "darwin_x64": "x86_64"}

def _host(os):
    cpu = "arm64" if os.arch in ["aarch64", "arm64"] else "x64" if os.arch in ["x86_64", "amd64"] else None
    system = "darwin" if os.name == "mac os x" else "linux" if os.name == "linux" else None
    if not cpu or not system:
        fail("Original Darwin compiler acquisition requires declared Darwin/Linux ARM64/x64 bootstrap Python")
    return system + "_" + cpu

def darwin_compiler_requests(module_ctx):
    """Resolve explicit source tags without downloading or registering toolchains."""
    tags = []
    for module in module_ctx.modules:
        if module.tags.compiler and not module.is_root:
            fail("Original Darwin compiler sources must be declared by the root module")
        tags.extend(module.tags.compiler)
    if not tags:
        return []
    python_pins = json.decode(module_ctx.read(Label("//tools/bazel/tools/native:python-pins.json")))["platforms"]
    host = _host(module_ctx.os)
    if sorted(python_pins.keys()) != sorted(["darwin_arm64", "darwin_x64", "linux_arm64", "linux_x64"]):
        fail("Original Darwin compiler bootstrap requires all four declared native Python pins")
    python = python_pins[host]
    requests = []
    seen = {}
    for tag in tags:
        if tag.platform not in _PLATFORMS or tag.platform in seen:
            fail("Each original Darwin compiler platform requires one exact source declaration")
        seen[tag.platform] = True
        specification = json.decode(module_ctx.read(tag.specification))
        if specification["execution_cpu"] != _PLATFORMS[tag.platform]:
            fail("Original Darwin compiler CPU differs from its declared platform")
        if not tag.executor_constraints:
            fail("Original Darwin compiler requires explicit qualified executor constraints")
        constraints = [str(label) for label in tag.executor_constraints]
        if len(constraints) != len({label: True for label in constraints}):
            fail("Original Darwin compiler executor constraints must be unique")
        requests.append(struct(
            name = "compiler_" + tag.platform,
            specification = json.encode(specification),
            deployment_target = tag.deployment_target,
            executor_constraints = constraints,
            python_url = python["url"],
            python_sha256 = python["sha256"],
            dev_dependency = module_ctx.is_dev_dependency(tag),
        ))
    return requests

def _registration_impl(ctx):
    toolchains = json.decode(ctx.attr.toolchains)
    ctx.file("BUILD.bazel", "\n".join([
        'package(default_visibility = ["//visibility:public"])',
        # The machine running Bazel is an executor for its own declared compiler only.
        'platform(name = "execution", parents = ["@platforms//host"], constraint_values = ' + repr(ctx.attr.host_constraints) + ")",
    ] + [
        "toolchain(name = " + repr(name) + ", toolchain = " + repr("@" + name + "//:cc") + ', toolchain_type = "@bazel_tools//tools/cpp:toolchain_type",' +
        " exec_compatible_with = " + repr(value["platform"] + value["executor_constraints"]) + ", target_compatible_with = " + repr(value["platform"]) + ")"
        for name, value in toolchains.items()
    ] + [""]))

# Registration lives apart from the compiler repositories, so toolchain resolution
# on a host without the Apple export never fetches it.
darwin_registration = repository_rule(
    implementation = _registration_impl,
    attrs = {"toolchains": attr.string(mandatory = True), "host_constraints": attr.string_list(mandatory = True)},
)

def _impl(module_ctx):
    direct = []
    dev = []
    toolchains = {}
    host_constraints = []
    for request in darwin_compiler_requests(module_ctx):
        darwin_compiler_archive(
            name = request.name,
            specification = request.specification,
            deployment_target = request.deployment_target,
            executor_constraints = request.executor_constraints,
            python_url = request.python_url,
            python_sha256 = request.python_sha256,
        )
        cpu = json.decode(request.specification)["execution_cpu"]
        toolchains[request.name] = {"platform": ["@platforms//os:osx", "@platforms//cpu:" + cpu], "executor_constraints": request.executor_constraints}
        if request.name == "compiler_" + _host(module_ctx.os):
            host_constraints = request.executor_constraints
        (dev if request.dev_dependency else direct).append(request.name)
    darwin_registration(name = "darwin_registration", toolchains = json.encode(toolchains), host_constraints = host_constraints)
    direct.append("darwin_registration")
    return module_ctx.extension_metadata(root_module_direct_deps = direct, root_module_direct_dev_deps = dev, reproducible = True)

darwin_compilers = module_extension(
    implementation = _impl,
    os_dependent = True,
    arch_dependent = True,
    tag_classes = {"compiler": tag_class(attrs = {
        "platform": attr.string(values = ["darwin_arm64", "darwin_x64"], mandatory = True),
        "specification": attr.label(mandatory = True),
        "deployment_target": attr.string(mandatory = True),
        "executor_constraints": attr.label_list(mandatory = True),
    })},
)
