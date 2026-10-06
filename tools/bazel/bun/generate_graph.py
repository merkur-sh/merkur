"""Generate first-party JavaScript declarations from package manifests and source inventory."""

import argparse
import ast
import json
import re
import hashlib
import subprocess
import os
import tempfile
from pathlib import Path

IMPORTS = json.loads(Path("tools/bazel/bun/import-inventory.json").read_text())
CODE = {".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"}
IGNORED = {"node_modules", "dist", "target", "pkg", "test-results", ".codegraph", ".git", ".tools", ".cache", "coverage", ".vite"}
ENV_EXAMPLES = {".env.example", ".env.sample", ".env.template"}
# The srcs of //:js_configuration, which every Bun test already holds.
ROOT_CONFIGURATION = {"package.json", "bunfig.toml", "tsconfig.base.json", "tsconfig.json"}
TRACKED = set(subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0'))
# The exclusions name what .gitignore keeps out of the index; a glob cannot ask Git.
VERIFICATION = 'filegroup(name = "verification_inputs", srcs = glob(["**"], exclude = ["node_modules/**", "dist/**", "target/**", "pkg/**", "**/pkg/**", "**/__pycache__/**", "**/*.pyc", "test-results/**", ".git/**", ".codegraph/**", ".tools/**", ".cache/**", "coverage/**", ".vite/**", ".env", ".env.*", "**/.env", "**/.env.*", ".bazelrc.local", "**/.bazelrc.local", "**/.DS_Store", ".DS_Store", ".*", ".*/**", "**/.*", "**/.*/**"], allow_empty = True) + glob(["**/.env.example", "**/.env.sample", "**/.env.template"], allow_empty = True))'


def source_label(file):
    path = Path(file)
    directory = path.parent
    while directory != Path(".") and not (directory / "BUILD.bazel").exists():
        directory = directory.parent
    return "//" + (str(directory) if directory != Path(".") else "") + ":" + str(path.relative_to(directory))


def input_declaration(name, inventory):
    source_labels = set()
    for file in inventory["files"]:
        owner, source = source_label(file).split(":", 1)
        if file in {"packages/e2e-wasm/conformance.test.ts", "packages/graphics-wasm/conformance.test.ts"}:
            source_labels.add(owner + ":conformance_sources")
        else:
            source_labels.add(owner + ":source__" + source.replace("/", "__"))
    deps = sorted(source_labels | {"//" + item["directory"] + ":node_modules/" + item["name"] for item in inventory["packages"]} | {"//:js_configuration"})
    return "js_library(name = " + json.dumps(name) + ", deps = " + json.dumps(deps) + ")"


def file_declarations(files):
    return ['js_library(name = ' + json.dumps('source__' + file.replace('/', '__')) + ', srcs = [' + json.dumps(file) + '])' for file in files]


def registered_tests(template):
    """Read the explicit source owners from the actual standalone BUILD template."""
    owners = {}
    for statement in ast.parse(template).body:
        if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
            continue
        call = statement.value
        if not isinstance(call.func, ast.Name) or call.func.id != "bun_test":
            continue
        attributes = {item.arg: item.value for item in call.keywords}
        try:
            name = ast.literal_eval(attributes["name"])
            files = ast.literal_eval(attributes["test_files"])
        except (KeyError, ValueError, TypeError) as error:
            raise ValueError("Standalone source-test owners require literal names and test Files") from error
        if not isinstance(name, str) or not name or not isinstance(files, list) or len(files) != 1:
            raise ValueError("Standalone source-test owner must declare one exact test File")
        file = files[0]
        if not isinstance(file, str):
            raise ValueError("Standalone source-test owner has a nonliteral File")
        file = file.removeprefix("./")
        if not file.startswith("scripts/") or any(part in ("", ".", "..") for part in file.split("/")):
            raise ValueError("Standalone source-test owner File escapes scripts")
        if file in owners:
            raise ValueError("Competing standalone source-test owners: " + file)
        owners[file] = name
    return owners


def test_declarations(area, files, registered=None):
    lines = []
    for file in files:
        test = str(Path(area) / file)
        if registered and test in registered:
            # The original explicit rule retains its complete declared SDK/tools.
            # A second generated rule would duplicate this configured source owner.
            continue
        name = "test__" + file.replace("/", "__")
        inputs = "inputs__" + file.replace("/", "__")
        lines += [input_declaration(inputs, IMPORTS["tests"][test])]
        # The launcher materializes only declared files, so a pass is reusable for
        # the same inputs. Sharing a pass between hosts remains unqualified: the
        # result stays out of the remote cache.
        artifacts = sorted(set(IMPORTS["tests"][test]["artifacts"] + IMPORTS["preload"]["artifacts"]))
        tools = IMPORTS["tests"][test].get("tools", {})
        tool_environment = IMPORTS["tests"][test].get("toolEnvironment", {})
        environment_files = IMPORTS["tests"][test].get("environmentFiles", {})
        lines += ["bun_test(name = " + json.dumps(name) + ", test_files = [" + json.dumps("./" + test) + "], data = " + json.dumps([":" + inputs, ":runtime_assets", "//scripts:test_preload"] + artifacts) + ", tools = " + json.dumps(tools) + ", tool_environment = " + json.dumps(tool_environment) + ", environment_files = " + json.dumps(environment_files) + ", tags = [\"bun\", \"no-remote-cache\", \"manual\", \"unqualified-runtime-inputs\"])", ""]
    return lines


def render(manifest):
    directory = manifest.parent
    package = json.loads(manifest.read_text())
    nested_packages = [path.parent for path in directory.rglob("BUILD.bazel") if path.parent != directory and "node_modules" not in path.parts]
    source_files = sorted(
        str(path.relative_to(directory))
        for path in directory.rglob("*")
        if path.is_file()
        and not set(path.relative_to(directory).parts) & IGNORED
        and path.name not in {"BUILD.bazel", ".bazelrc.local", ".DS_Store"}
        and (not path.name.startswith(".env") or path.name in ENV_EXAMPLES)
        and (not any(part.startswith('.') for part in path.relative_to(directory).parts) or str(path) in TRACKED or path.name in ENV_EXAMPLES)
        and not any(path.is_relative_to(package) for package in nested_packages)
    )
    tests = [file for file in source_files if re.search(r"[._](test|spec)\.[cm]?[jt]sx?$", file)]
    dependency_paths = {json.loads(path.read_text())["name"]: str(path.parent) for pattern in ("apps/*/package.json", "packages/*/package.json") for path in Path(".").glob(pattern)}
    source_dependencies = ["//" + dependency_paths[name] + ":sources" for name in package.get("dependencies", {}) if name in dependency_paths]
    lines = [
        '# Generated by //tools/bazel/bun:generate_graph.py; do not edit.',
        'load("@aspect_rules_js//js:defs.bzl", "js_library")',
        'load("@aspect_rules_js//npm:defs.bzl", "npm_package")',
        'load("@npm//:defs.bzl", "npm_link_all_packages")',
        'load("//tools/bazel/bun:rules.bzl", "bun_bundle", "bun_compile", "bun_test", "brotli_precompress", "vite_build")',
        'load("//tools/bazel/wasm:rules.bzl", "project_wasm_package", "wasm_static_projection")',
        '',
        'package(default_visibility = ["//visibility:public"])',
        '',
        VERIFICATION.removesuffix(')') + ' + ' + json.dumps([file for file in source_files if any(part.startswith('.') for part in Path(file).parts) and Path(file).name not in ENV_EXAMPLES]) + ')',
        '',
        'npm_link_all_packages()',
        'exports_files(' + json.dumps(source_files) + ')',
        'js_library(name = "runtime_assets", srcs = ' + json.dumps([file for file in source_files if Path(file).suffix not in CODE]) + ')',
        '',
        'js_library(',
        '    name = "raw_sources",',
        '    srcs = ' + json.dumps(source_files, indent=4).replace('\n', '\n    ') + ',',
        ')',
        '',
        'npm_package(name = "npm_package", srcs = [":raw_sources"], package = ' + json.dumps(package['name']) + ')',
        '',
        'js_library(name = "sources", srcs = [":raw_sources"], deps = ' + json.dumps([":node_modules", "//:js_configuration"] + source_dependencies) + ')',
        '',
    ]
    lines += file_declarations(source_files)
    lines += test_declarations(directory, tests)
    if str(directory) == 'apps/daemon':
        lines += ['bun_compile(name = "daemon", entry_point = ":source__src__index.ts", data = [":sources", "//packages/e2e-wasm:wasm_artifacts"], daemon_identity = True, out = "merkur.bin", tags = ["manual", "unqualified-native-runtime"])', '']
    if str(directory) == 'apps/server':
        flags = json.dumps(['--conditions=workerd', '--define', 'process.env.NODE_ENV="production"'])
        lines += ['bun_compile(name = "server", entry_point = ":source__src__index.ts", data = [":sources", "//packages/e2e-wasm:wasm_artifacts", "//apps/web:frontend"], server_identity = True, require_release_key = True, flags = ' + flags + ', out = "server.bin", tags = ["manual", "unqualified-native-runtime"])', '']
        migrations = [file for file in source_files if file.startswith('migrations/') and file.endswith('.ts')]
        lines += ['bun_bundle(name = "migrations", entry_points = ' + json.dumps(migrations) + ', data = [":sources"], root = "apps/server/migrations", out = "migrations-built", tags = ["manual", "unqualified-release-inventory"])', '']
    if str(directory) == 'apps/web':
        for crate in ('term-wasm', 'e2e-wasm', 'graphics-wasm'):
            lines += ['project_wasm_package(name = ' + json.dumps(crate.replace('-', '_') + '_runtime') + ', package_tree = ' + json.dumps('//packages/' + crate + ':wasm_artifacts') + ', out = ' + json.dumps('src/' + crate + '/pkg') + ')']
        for crate in ('term-wasm', 'e2e-wasm', 'graphics-wasm'):
            module = crate.replace('-', '_')
            lines += ['wasm_static_projection(name = ' + json.dumps(module + '_static_sources') + ', package_tree = ' + json.dumps(':' + module + '_runtime') + ', module = ' + json.dumps(module) + ', logical_directory = ' + json.dumps('apps/web/src/' + crate + '/pkg') + ')']
        lines += ['filegroup(name = "generated_wasm_static_sources", srcs = [":term_wasm_static_sources", ":e2e_wasm_static_sources", ":graphics_wasm_static_sources"])', 'filegroup(name = "generated_wasm_static_manifests", srcs = [":term_wasm_static_sources", ":e2e_wasm_static_sources", ":graphics_wasm_static_sources"], output_group = "projection_manifest")']
        lines += ['vite_build(name = "frontend", project = "apps/web", data = [":sources", ":term_wasm_runtime", ":e2e_wasm_runtime", ":graphics_wasm_runtime", "//packages/e2e-wasm:wasm_artifacts"], out = "dist", tags = ["manual", "unqualified-frontend-runtime"])', '']
    if str(directory) == 'apps/web':
        lines += ['brotli_precompress(name = "frontend_precompressed", src = ":frontend", out = "dist-precompressed", tags = ["manual", "unqualified-release-inventory"])', '']
    return '\n'.join(lines)


TYPE_INVENTORY_START = '# Generated TypeScript project inventory.\n'
TYPE_INVENTORY_END = '# End generated TypeScript project inventory.\n'


def update_typescript_inventory(source, block):
    if source.count(TYPE_INVENTORY_START) != 1 or source.count(TYPE_INVENTORY_END) > 1:
        raise ValueError('ambiguous generated TypeScript inventory markers')
    prefix, section = source.split(TYPE_INVENTORY_START)
    if TYPE_INVENTORY_END in section:
        _, tail = section.split(TYPE_INVENTORY_END)
    else:
        # Bootstrap only the byte-exact original renderer output, never infer
        # ownership from target names or the handwritten tail's contents.
        original = block.removeprefix(TYPE_INVENTORY_START)
        if not section.startswith(original):
            raise ValueError('unmarked TypeScript inventory does not match its exact original rendering')
        tail = section[len(original):]
    if TYPE_INVENTORY_END in prefix or not block.startswith(TYPE_INVENTORY_START):
        raise ValueError('invalid generated TypeScript inventory boundary')
    return prefix + block + TYPE_INVENTORY_END + tail


def typescript_inventory():
    projects = sorted([str(path) for pattern in ('apps/*/tsconfig.json', 'packages/*/tsconfig.json') for path in Path('.').glob(pattern)] + ['scripts/tsconfig.json', 'tests/tsconfig.json', 'apps/server/scripts/tsconfig.json', 'tools/bazel/bun/tsconfig.json', 'tools/bazel/verification/tsconfig.json'])
    if projects != sorted(IMPORTS["types"]):
        raise SystemExit("stale TypeScript project membership; regenerate import inventory")
    # A package this generator renders declares one source target per file.
    rendered = {str(path.parent) for pattern in ("apps/*/package.json", "packages/*/package.json") for path in Path(".").glob(pattern)} | {"scripts", "tests"}
    block = '# Generated TypeScript project inventory.\n'
    type_labels = []
    for project in projects:
        name = project.replace('/', '__').removesuffix('.json')
        type_labels.append(':types__' + name)
        # The check reads what the compiler lists for the project, and no other source.
        inventory = IMPORTS["types"][project]
        owned = []
        files = []
        for file in inventory["files"]:
            owner, source = source_label(file).split(":", 1)
            if owner == "//":
                # A root source file has its own declared target; the configuration has one for all.
                if file not in ROOT_CONFIGURATION:
                    files.append("//:source__" + file)
            elif owner[2:] in rendered:
                owned.append(file)
            else:
                files.append(owner + ":" + source)
        block += input_declaration('types_inputs__' + name, {"files": owned, "packages": inventory["packages"]}) + '\n'
        block += 'bun_command_test(name = ' + json.dumps('types__' + name) + ', fixed_args = ["run", "tools/bazel/bun/native-typescript.ts", "--noEmit", "--noUnusedLocals", "--noUnusedParameters", "-p", ' + json.dumps(project) + '], bun_config = ":empty-bunfig.toml", data = ' + json.dumps([':types_inputs__' + name, ":native_typescript_runner"] + files + inventory["artifacts"]) + ', tools = {":native_typescript": "native-typescript"}, tool_environment = {"native-typescript": "MERKUR_NATIVE_TYPESCRIPT"}, tags = ["manual", "no-remote-cache", "unqualified-runtime-inputs"])\n'
    block += 'bun_operation_bindings(name = \"operation_bindings\", type_checks = ' + json.dumps(type_labels) + ', testonly = True, tags = [\"manual\"])\n'
    return block


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    scripts_template = Path('tools/bazel/bun/scripts.BUILD.template').read_text()
    standalone = registered_tests(scripts_template)
    for file in standalone:
        if file not in IMPORTS["tests"] or not Path(file).is_file():
            raise SystemExit("Explicit standalone source-test owner is missing from the current inventory: " + file)
    for file, expected in (IMPORTS["sourceHashes"] | IMPORTS["resolverHashes"]).items():
        if hashlib.sha256(Path(file).read_bytes()).hexdigest() != expected:
            raise SystemExit("stale compiler-parsed import inventory: " + file + "; regenerate with pinned //tools/bazel/bun:import_inventory")
    for directory, expected in IMPORTS.get("directoryInputs", {}).items():
        actual = sorted(str(file) for file in Path(directory).rglob("*") if file.is_file() and not any(part.startswith(".") for part in file.relative_to(directory).parts))
        if actual != expected:
            raise SystemExit("stale runtime directory membership: " + directory + "; regenerate import inventory")
    stale = []
    count = 0
    def write(output, expected):
        if args.check:
            if not output.exists() or output.read_text() != expected:
                stale.append(str(output))
        else:
            with tempfile.NamedTemporaryFile(mode='w', dir=output.parent, prefix='.' + output.name + '.', suffix='.tmp', delete=False) as temporary:
                temporary.write(expected)
                temporary_name = temporary.name
            os.chmod(temporary_name, output.stat().st_mode & 0o777 if output.exists() else 0o644)
            os.replace(temporary_name, output)
    for pattern in ('apps/*/package.json', 'packages/*/package.json'):
        for manifest in sorted(Path('.').glob(pattern)):
            if (manifest.parent / 'Cargo.toml').exists():
                raise SystemExit('Rust BUILD ownership requires a separate Bun macro: ' + str(manifest.parent))
            output = manifest.parent / 'BUILD.bazel'
            expected = render(manifest)
            write(output, expected)
            count += 1
    for area in ('packages/e2e-wasm', 'packages/graphics-wasm'):
        entry = area + '/conformance.test.ts'
        inventory = dict(IMPORTS['tests'][entry])
        inventory['files'] = [file for file in inventory['files'] if file != entry]
        declaration = input_declaration('conformance_dependencies', inventory)
        expected = '\n'.join([
            '# Generated by //tools/bazel/bun:generate_graph.py; do not edit.',
            'load("@aspect_rules_js//js:defs.bzl", "js_library")',
            '',
            'def declare_conformance_sources():',
            '    ' + declaration,
            '    js_library(name = "conformance_sources", srcs = ["conformance.test.ts"], deps = [":conformance_dependencies"])',
            '',
        ])
        write(Path(area) / 'bun_inputs.bzl', expected)
    for area in ('scripts', 'tests'):
        files = sorted(
            str(path.relative_to(area))
            for path in Path(area).rglob('*')
            if path.is_file()
            and not set(path.relative_to(area).parts) & IGNORED
            and path.suffix in {'.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json', '.png', '.txt', '.wasm', '.html', '.py', '.sh'}
        )
        tests = [file for file in files if re.search(r"[._](test|spec)\.[cm]?[jt]sx?$", file)]
        if area == 'scripts':
            initial = 'load("//tools/bazel/bun:rules.bzl", "bun_test")\n' + scripts_template
        else:
            initial = '\n'.join([
                'load("@aspect_rules_js//js:defs.bzl", "js_library")',
                'load("//tools/bazel/bun:rules.bzl", "bun_test")',
                '',
                'package(default_visibility = ["//visibility:public"])',
                VERIFICATION,
                '',
                'js_library(name = "raw_sources", srcs = ' + json.dumps(files, indent=4) + ')',
                'exports_files(' + json.dumps(files) + ')',
                'js_library(name = "sources", srcs = [":raw_sources"], deps = ["//scripts:sources", "//:node_modules", "//:js_configuration"])',
                '',
                '',
            ])
        block = '# Generated standalone Bun test inventory.\n'
        block += '\n'.join(file_declarations(files)) + '\n'
        block += 'js_library(name = "runtime_assets", srcs = ' + json.dumps([file for file in files if Path(file).suffix not in CODE]) + ')\n'
        if area == 'scripts':
            block += input_declaration("test_preload", IMPORTS["preload"]) + '\n'
        block += '\n'.join(test_declarations(area, tests, standalone))
        write(Path(area) / 'BUILD.bazel', initial + block)
    output = Path('tools/bazel/bun/BUILD.bazel')
    write(output, update_typescript_inventory(output.read_text(), typescript_inventory()))
    if stale:
        raise SystemExit('stale generated JavaScript graph: ' + ', '.join(stale))
    print(f'{count} manifest-derived JavaScript packages checked' if args.check else f'{count} JavaScript package declarations generated')


if __name__ == '__main__':
    main()
