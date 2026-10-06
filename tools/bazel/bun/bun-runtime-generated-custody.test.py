"""Genuine generator source custody; native configuration bridge remains synthetic."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['runner', 'builder', 'custody', 'deployment', 'output-tree', 'linked', 'licenses',
                 'archive', 'pins', 'patch', 'bun', 'git-sdk', 'npm', 'npm-spec', 'npm-pins',
                 'generator-controls']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    controls = load('original_generator_controls', arguments.generator_controls)
    controls.arguments = arguments
    for name, argument in [('runner', 'runner'), ('builder', 'builder'), ('custody', 'custody'),
                           ('deployment', 'deployment'), ('outputs', 'output_tree'), ('linked', 'linked'),
                           ('licenses', 'licenses'), ('npm', 'npm')]:
        setattr(controls, name, load('generated_custody_' + name, getattr(arguments, argument)))
    runner, linked, licenses = controls.runner, controls.linked, controls.licenses

    class GeneratedCustodyControls(controls.GeneratedInputControls):
        def capture(self):
            # Original generators/compiler artifacts are genuine. Only this
            # minimal native-config bridge is synthetic while LLVM is pending.
            configuration = {'cfg': {'codegenDir': str(self.codegen)}}
            return runner.capture_embedded_inputs(configuration, self.source, arguments.archive,
                json.loads(arguments.pins.read_bytes()), controls.custody, linked, licenses)

        def test_same_action_original_byte_and_license_custody(self):
            value = self.capture()
            self.assertTrue(value['sources'])
            self.assertEqual({fact['component'] for fact in value['sources']}, {'bun@1.4.2'})
            for fact in value['sources']:
                body = self.origin['members'][fact['source_path']]
                self.assertEqual(fact['size'], len(body))
                self.assertEqual(fact['sha256'], hashlib.sha256(body).hexdigest())
            pins = json.loads(arguments.pins.read_bytes())
            self.assertEqual({fact['path']: fact['sha256'] for fact in value['licenses']}, pins['license_members'])
            original_files = {file.name for file in (self.source / 'src/node-fallbacks').glob('*.js')}
            captured = {record['metadata'] for record in value['compilerInputs']}
            self.assertTrue({(self.codegen / 'node-fallbacks' / (name + '.compiler-inputs.json')).relative_to(self.source).as_posix()
                            for name in original_files} <= captured)
            for record in value['compilerInputs']:
                for fact in record['inputs']:
                    body = licenses.read_regular(self.source, fact['captured_path'], require_text=False)
                    self.assertEqual(fact['size'], len(body))
                    self.assertEqual(fact['sha256'], hashlib.sha256(body).hexdigest())

        def test_generated_and_npm_authority_must_propagate_pending(self):
            value = self.capture()
            self.assertTrue(any('/node_modules/' in fact.get('source', '') for fact in value['pending']))
            # The original second pass now has causal first-output custody.
            # Removing that actual relation must still retire generated authority.
            file = self.metadata / 'bake/client.first.sources.json'
            body = file.read_bytes()
            try:
                file.unlink()
                missing = self.capture()
                self.assertTrue(any('.runtime-' in fact.get('source', '') for fact in missing['pending']))
                with self.assertRaises(linked.PendingLinkedSource):
                    runner.require_embedded_inputs({'embeddedCompilerInputs': missing}, linked, licenses)
            finally:
                file.write_bytes(body)
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'remains pending'):
                runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'custody is absent'):
                runner.require_embedded_inputs({}, linked, licenses)

        def test_missing_original_compiler_metadata_stays_pending(self):
            file = self.metadata / 'modules.json'
            body = file.read_bytes()
            try:
                file.unlink()
                value = self.capture()
                self.assertTrue(any(fact['metadata'].endswith('/modules.json') and 'absent' in fact['reason']
                                    for fact in value['pending']))
                with self.assertRaises(linked.PendingLinkedSource):
                    runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)
            finally:
                file.write_bytes(body)

        def test_malformed_or_missing_byte_custody_cannot_admit_source_facts(self):
            value = self.capture()
            value['pending'] = []  # Negative malformed-input control, no admission claim.
            value['sources'] = [None]
            with self.assertRaisesRegex(ValueError, 'Malformed'):
                runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)
            value = self.capture()
            value['pending'] = []
            del value['compilerInputs']
            with self.assertRaisesRegex(linked.PendingLinkedSource, 'byte/license custody is absent'):
                runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)

        def test_each_original_invocation_retains_its_selected_source_partition(self):
            value = self.capture()
            records = {row['metadata']: row for row in value['compilerInputs']}
            modules = records[str((self.metadata / 'modules.json').relative_to(self.source))]
            origin = {**self.origin, 'component': 'bun@' + json.loads(arguments.pins.read_bytes())['version']}
            expected = runner.compiler_input_sources(self.module_raw, self.source, self.source,
                self.module_relations, [origin], linked, licenses)
            self.assertEqual(modules['sources'], expected)
            for row in records.values():
                self.assertEqual(set(row), {'metadata', 'inputs', 'sources'})
                for source in row['sources']:
                    self.assertIn(source, value['sources'])

        def test_partition_cannot_borrow_an_unselected_source_union_member(self):
            value = self.capture()
            # Negative metadata-shape control; native admission remains absent.
            value['pending'] = []
            record = value['compilerInputs'][0]
            record['sources'].append(dict(value['sources'][0], path='foreign.rs'))
            with self.assertRaisesRegex(ValueError, 'source partition differs'):
                runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)

        def test_original_function_metadata_and_source_relation_are_reciprocal(self):
            directory = self.metadata / 'functions'
            metadata = directory / 'NodeModuleObject._initPaths.json'
            relation = directory / 'NodeModuleObject._initPaths.sources.json'
            for file in [metadata, relation]:
                body = file.read_bytes()
                try:
                    file.unlink()
                    value = self.capture()
                    expected = metadata.relative_to(self.source).as_posix()
                    self.assertTrue(any(fact['metadata'] == expected and 'absent' in fact['reason']
                                        for fact in value['pending']))
                    with self.assertRaises(linked.PendingLinkedSource):
                        runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)
                finally:
                    file.write_bytes(body)

        def test_original_source_and_license_mutations_refuse_before_publication(self):
            paths = [Path(next(iter(self.module_relations.values()))), self.source / 'LICENSE.md']
            for file in paths:
                body = file.read_bytes()
                try:
                    file.write_bytes(body + b'\n')
                    with self.assertRaisesRegex(ValueError, 'bytes changed|archive bytes'):
                        self.capture()
                finally:
                    file.write_bytes(body)

        def test_custody_cannot_be_rebuilt_from_post_cleanup_metadata(self):
            original = self.source
            removed = self.root / 'removed-private-source'
            original.rename(removed)
            try:
                with self.assertRaises(FileNotFoundError):
                    self.capture()
            finally:
                removed.rename(original)

    unittest.main(argv=[sys.argv[0], *remaining])
