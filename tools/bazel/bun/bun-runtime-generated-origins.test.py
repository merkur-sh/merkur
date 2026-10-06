"""Original generator/compiler/npm archive controls, never native-retention proof."""

import argparse
import importlib.util
import json
from pathlib import Path
import sys
import stat
import unittest


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['runner', 'origins', 'builder', 'custody', 'deployment', 'output-tree', 'linked',
                 'licenses', 'archive', 'pins', 'patch', 'bun', 'git-sdk', 'npm', 'npm-spec',
                 'npm-pins', 'generator-controls', 'publisher-selector', 'publisher-pins', 'publisher-inputs']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--evidence', type=Path)
    arguments, remaining = parser.parse_known_args()
    controls = load('original_embedded_generator_controls', arguments.generator_controls)
    controls.arguments = arguments
    for name, argument in [('runner', 'runner'), ('builder', 'builder'), ('custody', 'custody'),
                           ('deployment', 'deployment'), ('outputs', 'output_tree'),
                           ('linked', 'linked'), ('licenses', 'licenses'), ('npm', 'npm')]:
        setattr(controls, name, load('original_embedded_' + name, getattr(arguments, argument)))
    runner, linked, licenses = controls.runner, controls.linked, controls.licenses
    origins = load('original_embedded_npm_origins', arguments.origins)
    publisher = load('original_npm_publisher_notices', arguments.publisher_selector)

    class GeneratedOriginControls(controls.GeneratedInputControls):
        @classmethod
        def setUpClass(cls):
            super().setUpClass()
            cls.packages = origins.npm_catalog(json.loads(arguments.npm_spec.read_bytes()),
                json.loads(arguments.npm_pins.read_bytes()), json.loads(arguments.pins.read_bytes()),
                controls.npm, controls.custody, controls.deployment)
            value = runner.capture_embedded_inputs({'cfg': {'codegenDir': str(cls.codegen)}}, cls.source,
                arguments.archive, json.loads(arguments.pins.read_bytes()), controls.custody, linked, licenses)
            cls.npm_selected = sorted({fact['source'] for fact in value['pending']
                                       if '/node_modules/' in fact.get('source', '')})

        def replace_owned_input(self, file, body):
            mode = stat.S_IMODE(file.stat().st_mode)
            file.unlink()
            file.write_bytes(body)
            file.chmod(mode)

        def original_notice(self, identity, directory):
            inputs = json.loads(arguments.publisher_inputs.read_bytes())
            if identity not in inputs:
                return None
            return publisher.from_files(identity, json.loads(arguments.publisher_pins.read_bytes()),
                json.loads(arguments.npm_pins.read_bytes()),
                {role: inputs[identity][role] for role in ['metadata', 'source']},
                json.loads(arguments.npm_spec.read_bytes())['archives'][identity],
                directory, directory, controls.custody, linked, licenses)

        def capture(self):
            def additional_source(file):
                return origins.bind_npm_source(file, self.source, self.packages, linked, licenses, self.original_notice)
            # The bridge is synthetic; actual original compiler/generator Files
            # and original locked npm source/license bytes are genuine.
            return runner.capture_embedded_inputs({'cfg': {'codegenDir': str(self.codegen)}}, self.source,
                arguments.archive, json.loads(arguments.pins.read_bytes()), controls.custody,
                linked, licenses, additional_source)

        def test_genuine_selected_npm_members_and_original_licenses_close_only_causal_joins(self):
            value = self.capture()
            self.assertTrue(self.npm_selected)
            npm_facts = [fact for fact in value['sources'] if fact['component'] != 'bun@1.4.2']
            self.assertTrue(npm_facts)
            self.assertEqual(value['pending'], [])
            for fact in npm_facts:
                body = self.packages[fact['component']][fact['source_path']]
                self.assertEqual(fact['size'], len(body))
                self.assertEqual(fact['path'], fact['source_path'])
            notices = [fact for fact in value['licenses'] if '/node_modules/' in fact['path']]
            self.assertTrue(notices)
            for notice in notices:
                self.assertEqual(len(licenses.read_regular(self.source, notice['path'])), notice['size'])
            if arguments.evidence:
                (arguments.evidence / 'causal-capture.json').write_text(json.dumps(value, indent=2) + '\n')
            # All supported original generator joins now have exact causal byte authority.
            self.assertFalse(any('.runtime-' in fact.get('source', '') for fact in value['pending']))
            self.assertEqual(runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses), value['sources'])

        def test_genuine_rust_enum_relation_binds_actual_original_producer_input(self):
            value = self.capture()
            self.assertFalse(any(fact.get('source', '').endswith('/generated.ts') for fact in value['pending']))
            self.assertTrue(any(fact['source_path'] == 'src/runtime/bake/dev_server/mod.rs'
                                for fact in value['sources']))

        def test_missing_original_rust_enum_relation_remains_pending(self):
            file = self.metadata / 'bake/rust-enum.sources.json'
            body = file.read_bytes()
            try:
                file.unlink()
                value = self.capture()
                self.assertTrue(any(fact['metadata'].endswith('/client.first.json') and
                                    'absent' in fact['reason'] for fact in value['pending']))
            finally:
                file.write_bytes(body)

        def test_changed_selected_npm_member_refuses_original_byte_authority(self):
            file = Path(self.npm_selected[0])
            body = file.read_bytes()
            try:
                self.replace_owned_input(file, b'foreign same-name npm source')
                with self.assertRaisesRegex(ValueError, 'differs from original archive bytes'):
                    origins.bind_npm_source(str(file), self.source, self.packages, linked, licenses)
            finally:
                self.replace_owned_input(file, body)

        def test_changed_original_npm_manifest_cannot_borrow_locked_identity(self):
            selected = Path(self.npm_selected[0])
            manifest = next(path / 'package.json' for path in selected.parents
                if (path / 'package.json').is_file() and
                json.loads((path / 'package.json').read_bytes()).get('name', '') + '@' +
                json.loads((path / 'package.json').read_bytes()).get('version', '') in self.packages)
            body = manifest.read_bytes()
            try:
                self.replace_owned_input(manifest, body + b' ')
                with self.assertRaises(linked.PendingLinkedSource):
                    origins.bind_npm_source(str(selected), self.source, self.packages, linked, licenses)
            finally:
                self.replace_owned_input(manifest, body)

        def test_changed_selected_npm_license_refuses_original_published_notice(self):
            selected = self.npm_selected[0]
            _, notices = origins.bind_npm_source(selected, self.source, self.packages, linked, licenses)
            file = self.source / notices[0]['path']
            body = file.read_bytes()
            try:
                self.replace_owned_input(file, b'foreign original notice')
                with self.assertRaisesRegex(ValueError, 'license differs from its original published archive bytes'):
                    origins.bind_npm_source(selected, self.source, self.packages, linked, licenses)
            finally:
                self.replace_owned_input(file, body)

        def test_changed_actual_publisher_readme_refuses_original_notice_authority(self):
            selected = next(file for file in self.npm_selected if '/asn1.js/' in file)
            _, notices = origins.bind_npm_source(selected, self.source, self.packages, linked,
                                                licenses, self.original_notice)
            file = self.source / notices[0]['path']
            body = file.read_bytes()
            try:
                self.replace_owned_input(file, body + b'foreign')
                with self.assertRaisesRegex(ValueError, 'differs from its original npm/publisher commit members'):
                    origins.bind_npm_source(selected, self.source, self.packages, linked,
                                            licenses, self.original_notice)
            finally:
                self.replace_owned_input(file, body)

        def test_actual_first_output_relation_absence_remains_mandatory_pending(self):
            file = self.metadata / 'bake/client.first.sources.json'
            body = file.read_bytes()
            try:
                file.unlink()
                value = self.capture()
                self.assertTrue(any(fact['metadata'].endswith('/client.second.json') and
                                    'source relation/File is absent' in fact['reason'] for fact in value['pending']))
                with self.assertRaises(linked.PendingLinkedSource):
                    runner.require_embedded_inputs({'embeddedCompilerInputs': value}, linked, licenses)
            finally:
                file.write_bytes(body)

        def test_foreign_first_output_relation_cannot_borrow_another_compiler_result(self):
            file = self.metadata / 'bake/client.first.sources.json'
            body = file.read_bytes()
            relation = json.loads(body)
            try:
                file.write_text(json.dumps({'./foreign.js': next(iter(relation.values()))}))
                with self.assertRaisesRegex(ValueError, 'belongs to another compiler invocation'):
                    self.capture()
            finally:
                file.write_bytes(body)

        def test_changed_actual_first_output_cannot_supply_second_input_authority(self):
            file = self.metadata / 'bake/client.first.generated.js'
            body = file.read_bytes()
            try:
                file.write_bytes(bytes([body[0] ^ 1]) + body[1:])
                with self.assertRaisesRegex(ValueError, 'differs from its actual first output/producer transformation'):
                    self.capture()
            finally:
                file.write_bytes(body)

        def test_changed_actual_second_input_cannot_borrow_original_first_output(self):
            file = self.metadata / 'bake/client.generated.ts'
            body = file.read_bytes()
            try:
                file.write_bytes(bytes([body[0] ^ 1]) + body[1:])
                with self.assertRaisesRegex(ValueError, 'differs from its actual first output/producer transformation'):
                    self.capture()
            finally:
                file.write_bytes(body)

        def test_original_npm_catalog_requires_complete_actual_locked_archives(self):
            specification = json.loads(arguments.npm_spec.read_bytes())
            del specification['archives'][next(iter(specification['archives']))]
            with self.assertRaisesRegex(ValueError, 'archive closure is incomplete or foreign'):
                origins.npm_catalog(specification, json.loads(arguments.npm_pins.read_bytes()),
                    json.loads(arguments.pins.read_bytes()), controls.npm, controls.custody, controls.deployment)

    unittest.main(argv=[sys.argv[0], *remaining])
