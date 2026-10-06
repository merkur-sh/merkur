"""Original release registration/refusal controls; no configured providers are synthesized."""
import ast
from pathlib import Path
import types
import unittest


class Label:
    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        return isinstance(other, Label) and self.value == other.value


class File:
    def __init__(self, basename):
        self.basename = basename
        self.is_directory = False


def fail(message):
    raise ValueError(message)


def original(path, names, namespace):
    parsed = ast.parse(path.read_text())
    body = [row for row in parsed.body if
            isinstance(row, ast.FunctionDef) and row.name in names or
            isinstance(row, ast.Assign) and any(isinstance(key, ast.Name) and key.id in names for key in row.targets)]
    exec(compile(ast.Module(body=body, type_ignores=[]), str(path), 'exec'), namespace)


def fixture():
    calls = []
    namespace = {'Label': Label, 'fail': fail, 'struct': lambda **kw: types.SimpleNamespace(**kw),
                 'type': lambda value: 'dict' if isinstance(value, dict) else type(value).__name__,
                 'complete_release_notices': lambda **kw: calls.append(kw),
                 'transition': lambda **kw: object()}
    directory = Path(__file__).parent
    original(directory / 'native-release.bzl',
             {'NATIVE_RELEASE_PLATFORMS', 'NATIVE_RELEASE_TARGETS', '_DAEMON_FILES', 'native_release_layout'}, namespace)
    namespace.update({name: object() for name in ['_darwin_arm64', '_darwin_x64', '_linux_arm64', '_linux_x64']})
    original(directory / 'release-notices.bzl',
             {'_OUTPUTS', '_TRANSITIONS', '_require_release_inputs', 'unsigned_release_projection_error', 'declare_complete_release_notices'}, namespace)
    suppliers = {'merkur-daemon-' + platform: '//tools/bazel/packaging:merkur-daemon-' + platform
                 for platform in namespace['NATIVE_RELEASE_PLATFORMS']}
    suppliers.update({'verify-' + platform: '//tools/bazel/packaging:verify-' + platform
                      for platform in ['linux-arm64', 'linux-x64']})
    return namespace, suppliers, calls


def register(namespace, suppliers):
    namespace['declare_complete_release_notices'](
        deployment='//tools/bazel/packaging:deployment_notices',
        edge_image='//tools/bazel/packaging:edge_image_unsigned',
        stun_image='//tools/bazel/packaging:stun_image_unsigned',
        native_suppliers=suppliers, name='unsigned_complete')


def context(value):
    attrs = {field + '_daemon': [] for field in ['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64']}
    attrs.update({field + '_utilities': [] for field in ['linux_arm64', 'linux_x64']})
    attrs.update(value)
    return types.SimpleNamespace(attr=types.SimpleNamespace(**attrs))


class Controls(unittest.TestCase):
    def test_registered_deployment_and_images_do_not_hide_missing_native_inputs(self):
        namespace, _, calls = fixture()
        register(namespace, {})
        value = calls[0]
        self.assertEqual(value['deployment'], '//tools/bazel/packaging:deployment_notices')
        self.assertEqual(value['unsigned_deployment'], '//tools/bazel/packaging:deployment_unsigned')
        self.assertEqual(value['images'], ['//tools/bazel/packaging:edge_image_unsigned', '//tools/bazel/packaging:stun_image_unsigned'])
        self.assertEqual(value['name'], 'unsigned_complete')
        with self.assertRaisesRegex(ValueError, 'missing real configured inputs: darwin-arm64 daemon'):
            namespace['_require_release_inputs'](context(value))
        self.assertFalse(any(key.endswith('_daemon') for key in value))

    def test_complete_original_registration_preserves_six_roles_and_platforms(self):
        namespace, suppliers, calls = fixture()
        register(namespace, suppliers)
        value = calls[0]
        namespace['_require_release_inputs'](context(value))
        labels = []
        for field in namespace['_TRANSITIONS']:
            platform = field.replace('_', '-')
            self.assertEqual(value[field + '_daemon'], suppliers['merkur-daemon-' + platform])
            labels.append(value[field + '_daemon'])
            if platform.startswith('linux-'):
                self.assertEqual(value[field + '_utilities'], [suppliers['verify-' + platform]])
                labels += value[field + '_utilities']
        self.assertEqual(len(set(labels)), 6)

    def test_each_missing_or_foreign_role_refuses_before_registration(self):
        namespace, suppliers, calls = fixture()
        for role in suppliers:
            bad = dict(suppliers)
            del bad[role]
            with self.assertRaisesRegex(ValueError, 'exactly six'):
                register(namespace, bad)
        for role in ['verify-darwin-arm64', 'merkur-daemon-linux-riscv64']:
            bad = dict(suppliers)
            bad[role] = '//tools/bazel/packaging:' + role
            with self.assertRaisesRegex(ValueError, 'exactly six'):
                register(namespace, bad)
        self.assertEqual(calls, [])

    def test_each_foreign_producer_or_repository_refuses_before_registration(self):
        namespace, suppliers, calls = fixture()
        for role in suppliers:
            for foreign in ['//foreign:' + role, '@foreign//tools/bazel/packaging:' + role,
                            '//tools/bazel/packaging:merkur-daemon-linux-riscv64']:
                bad = dict(suppliers)
                bad[role] = foreign
                with self.assertRaisesRegex(ValueError, 'original registered native supplier'):
                    register(namespace, bad)
        self.assertEqual(calls, [])

    def test_exact_ten_file_projection_preserves_original_contract(self):
        namespace, _, _ = fixture()
        artifacts = [namespace['native_release_layout'](kind, platform).artifact
                     for platform in namespace['NATIVE_RELEASE_PLATFORMS']
                     for kind in (['daemon', 'verify'] if platform.startswith('linux-') else ['daemon'])]
        files = [File(name) for name in artifacts + ['deployment.tar.gz', 'edge-image.tar.gz', 'stun-image.tar.gz', 'NOTICES.txt']]
        error = namespace['unsigned_release_projection_error']
        self.assertIsNone(error(files))
        for index in range(len(files)):
            self.assertIsNotNone(error(files[:index] + files[index + 1:]))
        self.assertIsNotNone(error(files + [File('signing-inputs.json')]))
        self.assertIsNotNone(error(files + [files[0]]))


if __name__ == '__main__':
    unittest.main()
