"""Actual Bun release/source bytes; synthetic compiler-context custody controls."""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class BunSourceCustodyControls(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.specification = {
            'producer': '//apps/daemon:daemon', 'compile_target': 'bun-darwin-arm64',
            'configuration': str(self.root / 'context.json'),
            'runtime': str(self.root / 'bun'),
            'runtime_archive': str(self.root / 'runtime.zip'),
            'source_archive': str(self.root / 'source.tar.gz'),
        }
        self.context()
        Path(self.specification['runtime']).symlink_to(runtime)
        Path(self.specification['runtime_archive']).symlink_to(runtime_archive)
        Path(self.specification['source_archive']).symlink_to(source_archive)
        self.pins = copy.deepcopy(pins)

    def context(self, **changes):
        fields = {'producer': self.specification['producer'],
                  'compile_target': self.specification['compile_target'], **changes}
        Path(self.specification['configuration']).write_text(json.dumps(fields))

    def produce(self):
        originals = self.root / 'originals'
        helper.produce(self.specification, self.pins, originals, deployment, output_tree)
        return json.loads((originals / 'source-custody.json').read_bytes()), originals

    def refused(self, message):
        with self.assertRaisesRegex((ValueError, OSError), message):
            self.produce()
        self.assertFalse((self.root / 'originals').exists())

    def test_genuine_release_source_license_and_build_bytes_remain_custody_only(self):
        result, originals = self.produce()
        self.assertEqual(result['kind'], 'bun-runtime-source-custody')
        self.assertEqual(result['commit'], '744846f844374847c902b5e7fd59b4342a51ef99')
        self.assertEqual(result['runtime']['sha256'], helper.digest(runtime.read_bytes()))
        self.assertEqual(result['source_archive']['sha256'], pins['source']['sha256'])
        self.assertEqual(len(result['licenses']), 4)
        self.assertEqual(len(result['build_inputs']), 67)
        self.assertEqual(len(result['available_source_members']), 19_743)
        self.assertEqual(len(result['required_selection']), 3)
        self.assertNotIn('components', result)
        self.assertNotIn('pending_scopes', result)
        source_bytes = source_archive.read_bytes()
        members, _ = helper.source_members(source_bytes, pins, deployment.license_inputs.relative)
        for fact in result['licenses'] + result['build_inputs']:
            self.assertEqual((originals / fact['path']).read_bytes(), members[fact['path']])
            self.assertFalse((originals / fact['path']).is_symlink())

    def test_foreign_actual_runtime_file_cannot_impersonate_original_release(self):
        file = Path(self.specification['runtime'])
        file.unlink()
        file.write_bytes(b'foreign runtime')
        file.chmod(0o755)
        self.refused('differs from its original release member')

    def test_changed_source_archive_is_not_an_inferred_repository_selection(self):
        file = Path(self.specification['source_archive'])
        file.unlink()
        file.write_bytes(b'changed original source archive')
        self.refused('pinned original commit archive')

    def test_foreign_or_mismatched_original_compile_context_refuses(self):
        for changes in [{'producer': '//scripts:release_verifier'}, {'compile_target': 'bun-linux-arm64'}]:
            with self.subTest(changes=changes):
                self.context(**changes)
                self.refused('original compiler context')
        self.specification['compile_target'] = 'foreign-native-target'
        self.context()
        self.refused('four declared native runtimes')

    def test_original_other_platform_archive_is_not_the_selected_runtime(self):
        self.specification['compile_target'] = 'bun-linux-x64'
        self.context()
        self.refused('original publisher release')

    def test_missing_or_changed_original_license_and_build_members_refuse(self):
        self.pins['license_members']['LICENSE.md'] = '0' * 64
        self.refused('original declared license bytes')
        self.pins = copy.deepcopy(pins)
        self.pins['build_inputs'].append('missing-original-build-input.ts')
        self.refused('original build input is absent')

    def test_input_retarget_during_publication_retires_all_owned_outputs(self):
        write = output_tree.OutputTree.write
        changed = False
        def retarget(tree, name, data):
            nonlocal changed
            write(tree, name, data)
            if not changed:
                changed = True
                alias = Path(self.specification['source_archive'])
                alias.unlink()
                foreign = self.root / 'foreign-source.tar.gz'
                foreign.write_bytes(b'foreign source after capture')
                alias.symlink_to(foreign)
        with patch.object(output_tree.OutputTree, 'write', retarget):
            self.refused('presentation changed')

    def test_preexisting_original_output_is_never_erased(self):
        directory = self.root / 'originals'
        directory.mkdir()
        marker = directory / 'unrelated.txt'
        marker.write_bytes(b'unrelated output owner')
        with self.assertRaises(FileExistsError):
            self.produce()
        self.assertEqual(marker.read_bytes(), b'unrelated output owner')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', required=True)
    parser.add_argument('--deployment', required=True)
    parser.add_argument('--output-tree', required=True)
    parser.add_argument('--pins', required=True)
    parser.add_argument('--source-archive', required=True)
    parser.add_argument('--runtime-archive', required=True)
    args = parser.parse_args()
    global helper, deployment, output_tree, pins, source_archive, runtime_archive, runtime
    helper = load('bun_runtime_source_custody', args.helper)
    deployment = load('declared_deployment', args.deployment)
    output_tree = load('declared_output_tree', args.output_tree)
    pins = json.loads(Path(args.pins).read_bytes())
    source_archive, runtime_archive = Path(args.source_archive).resolve(), Path(args.runtime_archive).resolve()
    with tempfile.TemporaryDirectory() as directory:
        runtime = Path(directory, 'bun')
        with zipfile.ZipFile(runtime_archive) as archive:
            runtime.write_bytes(archive.read(pins['runtimes']['bun-darwin-arm64']['member']))
        runtime.chmod(0o755)
        unittest.main(argv=['bun-runtime-attribution-controls'])


if __name__ == '__main__':
    main()
