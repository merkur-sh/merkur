"""Bind actual original embedded compiler inputs; no retained-runtime provider.

Raw compiler metafiles and temporary-to-original relations must come from the
same declared original generator action. Ninja invalidators are not consumed
source facts. Final native retention and other generator inputs remain distinct.
"""

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


def compiler_input_records(raw, working_directory, source_root, original_sources, licenses,
                           preserved_inputs=None):
    value = json.loads(raw)
    if (not isinstance(value, dict) or set(value) != {'inputs', 'outputs'} or
            not isinstance(value['inputs'], dict) or not value['inputs'] or
            not isinstance(value['outputs'], dict) or not value['outputs']):
        raise ValueError('Original embedded compiler metadata is absent/malformed')
    root, directory = Path(source_root).absolute(), Path(working_directory).absolute()
    relations = {}
    if not isinstance(original_sources, dict):
        raise ValueError('Original generated compiler source relations must be literal')
    for temporary, original in original_sources.items():
        if not isinstance(temporary, str) or not isinstance(original, str):
            raise ValueError('Original generated compiler source relation is malformed')
        if not Path(temporary).is_absolute() or not Path(original).is_absolute():
            raise ValueError('Original generated compiler source relation must be exact')
        relations[temporary] = original
    preserved = {} if preserved_inputs is None else preserved_inputs
    if not isinstance(preserved, dict):
        raise ValueError('Preserved generated compiler inputs must be literal')
    for temporary, copy in preserved.items():
        if (not isinstance(temporary, str) or not isinstance(copy, str) or
                not Path(temporary).is_absolute() or not Path(copy).is_absolute() or
                not Path(temporary).is_relative_to(root) or not Path(copy).is_relative_to(root)):
            raise ValueError('Preserved compiler input escaped its declared source namespace')
    selected, inputs = set(), []
    for name, facts in value['inputs'].items():
        if (not isinstance(name, str) or not isinstance(facts, dict) or
                type(facts.get('bytes')) is not int or facts['bytes'] < 0 or
                not isinstance(facts.get('imports'), list)):
            raise ValueError('Original embedded compiler input record is malformed')
        logical = Path(os.path.normpath(directory / name))
        if not logical.is_relative_to(root):
            raise ValueError('Embedded compiler input escaped its declared original source namespace')
        captured = Path(preserved.get(str(logical), str(logical)))
        relative = captured.relative_to(root).as_posix()
        body = licenses.read_regular(root, relative, require_text=False)
        if len(body) != facts['bytes']:
            raise ValueError('Embedded compiler input differs from its original consumed byte count')
        original = relations.get(str(logical), str(logical))
        if not Path(original).is_relative_to(root):
            raise ValueError('Generated compiler input escaped its original source relation')
        selected.add(original)
        inputs.append({'path': logical.relative_to(root).as_posix(),
                       'captured_path': relative, 'size': len(body),
                       'sha256': hashlib.sha256(body).hexdigest()})
    for output in value['outputs'].values():
        if (not isinstance(output, dict) or not isinstance(output.get('inputs'), dict) or
                any(name not in value['inputs'] for name in output['inputs'])):
            raise ValueError('Original embedded compiler output has a foreign input relation')
    # Metafile byte counts do not prove compiler-consumed byte hashes or native
    # retention. These facts only bind causal original inputs inside the same
    # generator action; callers must not admit them as complete attribution.
    # This is the same pinned original byte authority as native compiler inputs.
    # Unmapped generated sources and dependency namespaces remain pending.
    return sorted(selected), sorted(inputs, key=lambda fact: fact['path'])


def compiler_input_sources(raw, working_directory, source_root, original_sources, origins, linked, licenses,
                           preserved_inputs=None):
    selected, _ = compiler_input_records(raw, working_directory, source_root,
                                        original_sources, licenses, preserved_inputs)
    return linked.bind_original_inputs(selected, origins, licenses)


def bake_original_inputs(name, first_raw, relation, captured, directory, source, licenses, linked):
    """Join the actual first output to the actual second compiler input bytes."""
    if name not in ('client', 'server', 'error'):
        raise ValueError('Original Bake generator invocation identity changed')
    first = json.loads(first_raw)
    if not isinstance(first, dict) or set(first) != {'inputs', 'outputs'} or not isinstance(first['outputs'], dict):
        raise ValueError('Original Bake first compiler metadata is malformed')
    # This is the original producer's mandatory single-output assertion.
    if len(first['outputs']) != 1 or not isinstance(relation, dict) or len(relation) != 1:
        raise linked.PendingLinkedSource('Original Bake first compiler output relation is absent/ambiguous')
    output, facts = next(iter(first['outputs'].items()))
    if not isinstance(output, str) or Path(output).is_absolute() or '..' in Path(output).parts:
        raise ValueError('Original Bake virtual output identity is not an exact relative compiler path')
    licenses.relative(Path(output).as_posix())
    if set(relation) != {output}:
        raise ValueError('Original Bake first output belongs to another compiler invocation')
    saved = Path(relation[output])
    if not saved.is_absolute() or '..' in saved.parts or not saved.is_relative_to(source):
        raise ValueError('Original Bake first output escaped its declared source namespace')
    body = licenses.read_regular(source, saved.relative_to(source).as_posix(), require_text=False)
    if not isinstance(facts, dict) or type(facts.get('bytes')) is not int or facts['bytes'] != len(body):
        raise ValueError('Original Bake first output differs from actual compiler byte facts')
    code = body.decode('utf8')
    names = ['unloadedModuleRegistry', 'config']
    if name == 'server':
        names += ['server_exports', '$separateSSRGraph', '$importMeta']
    # Exact unchanged combined_source expression from the pinned original
    # bake-codegen.ts producer, joining its preserved original first JS output.
    expected = code if name == 'error' else (
        '\n            __marker__;\n            let ' + ','.join(names) + ';\n'
        '            __marker__(' + ','.join(names) + ');\n'
        '            ' + code + ';\n          ')
    # Exact writeIfNotChanged normalization in original src/codegen/helpers.ts.
    expected = expected.replace('\r\n', '\n').strip() + '\n'
    if captured != expected.encode('utf8'):
        raise ValueError('Original Bake second input differs from its actual first output/producer transformation')


def preserve_builtin_generators(source, codegen, archive, pins, custody, licenses):
    """Keep these actual original producing Files before instrumentation changes them."""
    source, codegen = Path(source), Path(codegen)
    if not source.is_absolute() or not codegen.is_absolute() or not codegen.is_relative_to(source):
        raise ValueError('Original builtin generator preservation namespace is not exact')
    members, _ = custody.source_members(Path(archive).read_bytes(), pins, licenses.relative)
    original = codegen / 'compiler-inputs/original-generators'
    for name in ['src/codegen/bundle-modules.ts', 'src/codegen/helpers.ts', 'src/codegen/bundle-functions.ts']:
        body = licenses.read_regular(source, name, require_text=True)
        if members.get(name) != body:
            raise ValueError('Builtin generator preservation differs from its original archive File')
        output = original / name
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('xb') as stream:
            stream.write(body)


def instrumented_builtin_source(original, patch, name='src/codegen/bundle-modules.ts'):
    """Apply only either immutable maintained builtin-generator patch, without fuzzy matches."""
    if hashlib.sha256(patch).hexdigest() != '587d10d5e64ebac472b3131495da181815d45bc54b87f24708953af745935f70':
        raise ValueError('Builtin instrumentation patch differs from the exact maintained File')
    hunks = {'src/codegen/bundle-modules.ts': 5, 'src/codegen/bundle-functions.ts': 3}
    if name not in hunks:
        raise ValueError('Original builtin instrumentation generator identity differs')
    prefix = ('--- a/' + name + '\n+++ b/' + name + '\n').encode('utf8')
    if patch.count(prefix) != 1:
        raise ValueError('Original builtin instrumentation patch source relation differs')
    section = patch.split(prefix, 1)[1].split(b'--- a/', 1)[0]
    chunks = section.split(b'@@ ')
    if chunks[0] or len(chunks) != hunks[name] + 1:
        raise ValueError('Original builtin instrumentation patch hunk identity differs')
    result = original
    for chunk in chunks[1:]:
        header, body = chunk.split(b'\n', 1)
        if not header.endswith(b' @@'):
            raise ValueError('Original builtin instrumentation patch header differs')
        before, after = [], []
        for line in body.splitlines(keepends=True):
            if line[:1] not in (b' ', b'+', b'-'):
                raise ValueError('Original builtin instrumentation patch body differs')
            if line[:1] != b'+':
                before.append(line[1:])
            if line[:1] != b'-':
                after.append(line[1:])
        old = b''.join(before)
        if not old or result.count(old) != 1:
            raise ValueError('Original builtin instrumentation patch requires exact unique original bytes')
        result = result.replace(old, b''.join(after), 1)
    return result


def private_builtin_patch(patch_bytes, sources, closure, deployment):
    """Join only the actual maintained patch to its authored private root package."""
    labels = {'patch': '//tools/bazel/bun:bun-runtime-build-embedded-inputs.patch',
              'manifest': '//:package.json', 'license': '//:LICENSE'}
    if not isinstance(sources, dict) or set(sources) != set(labels):
        raise ValueError('Builtin patch requires original private workspace SourceFiles')
    owned = deployment.DeclaredInputs()
    try:
        facts, physical, bodies = {}, {}, {}
        for role, label in labels.items():
            item = sources[role]
            if (not isinstance(item, dict) or set(item) != {'input', 'label', 'tree', 'authored'}
                    or item['label'] != label or item['tree'] is not False or item['authored'] is not True):
                raise ValueError('Builtin patch source is not its original main-workspace SourceFile')
            deployment.descriptor({key: item[key] for key in ('input', 'label')})
            logical = Path(item['input']).absolute()
            if '..' in logical.parts:
                raise ValueError('Builtin patch SourceFile has no exact workspace namespace')
            physical[role] = owned.presentation(logical)
            pinned, size, digest = owned.file(physical[role])
            bodies[role] = owned.read(pinned)
            facts[role] = {'input': item['input'], 'label': label, 'size': size, 'sha256': digest}
        root = physical['manifest'].parent
        if (physical['manifest'].name != 'package.json' or physical['license'] != root / 'LICENSE'
                or physical['patch'] != root / 'tools/bazel/bun/bun-runtime-build-embedded-inputs.patch'):
            raise ValueError('Builtin patch/license belongs to another original workspace')
        if bodies['patch'] != patch_bytes:
            raise ValueError('Builtin patch SourceFile differs from its actual consumed bytes')
        component = {'id': 'merkur#//:package.json', 'name': 'merkur', 'version': None,
                     'private': True, 'source': None, 'repository': None, 'license': 'AGPL-3.0-only',
                     'license_file': 'LICENSE', 'source_label': '//:package.json'}
        closure.validate({'producer': labels['patch'], 'configuration': 'original-builtin-generator',
                          'source_digest': facts['patch']['sha256'], 'components': [component]})
        closure.validate_private_manifest(component, bodies['manifest'])
        text = bodies['license'].decode('utf8')
        if not text.strip():
            raise ValueError('Original private workspace license text is empty')
        component['manifest'] = facts['manifest']
        component['source_members'] = [{'path': 'tools/bazel/bun/bun-runtime-build-embedded-inputs.patch',
                                        **facts['patch']}]
        component['texts'] = [{'path': 'LICENSE', **facts['license'], 'text': text}]
        owned.verify()
        return component
    finally:
        owned.close()


def json_byte_class_inputs(source, header, runtime, origins, linked, licenses):
    """Reproduce only an actually selected original JSON table header."""
    source, header = Path(source), Path(header)
    if (not source.is_absolute() or not header.is_absolute() or
            '..' in source.parts or '..' in header.parts or not header.is_relative_to(source)):
        raise ValueError('Original JSON generator namespace must be exact')
    if runtime is None:
        raise linked.PendingLinkedSource('Original JSON generator needs its actual declared Bun runtime File')
    runtime = Path(runtime).resolve(strict=True)
    runtime_bytes = licenses.read_regular(runtime.parent, runtime.name, require_text=False)
    if not runtime_bytes or not runtime.stat().st_mode & 0o111:
        raise ValueError('Original JSON generator runtime is not executable')
    names = ['scripts/build/jsonByteClass.ts', 'scripts/build/fs.ts', 'package.json']
    originals = linked.bind_original_inputs([str(source / name) for name in names], origins, licenses)
    before = {name: licenses.read_regular(source, name, require_text=True) for name in names}
    expected = licenses.read_regular(source, header.relative_to(source).as_posix(), require_text=True)
    with tempfile.TemporaryDirectory(prefix='original-bun-json-byte-class-') as temporary:
        root = Path(temporary)
        config = root / 'bunfig.toml'
        config.write_bytes(b'')
        codegen = root / 'codegen'
        script = ('import {generateJsonByteClass} from ' + json.dumps(str(source / names[0]))
                  + ';generateJsonByteClass({codegenDir:' + json.dumps(str(codegen)) + '});')
        result = subprocess.run([str(runtime), '--no-install', '--no-env-file', '--config=' + str(config),
                                 '--eval', script], cwd=source,
            env={'PATH': '', 'HOME': str(root), 'TMPDIR': str(root), 'LC_ALL': 'C', 'CLAUDECODE': '1'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError('Original JSON byte-class generator failed: ' + result.stderr.decode('utf8'))
        if licenses.read_regular(codegen, 'json_byte_class.h') != expected:
            raise ValueError('Selected JSON header differs from the actual original generator output')
    for name in names:
        if licenses.read_regular(source, name, require_text=True) != before[name]:
            raise ValueError('Original JSON generator source changed during reproduction')
    if licenses.read_regular(source, header.relative_to(source).as_posix(), require_text=True) != expected:
        raise ValueError('Selected JSON header changed during reproduction')
    if licenses.read_regular(runtime.parent, runtime.name, require_text=False) != runtime_bytes:
        raise ValueError('Original JSON generator runtime changed during reproduction')
    return originals


def internal_module_registry_inputs(source, codegen, runtime, module_count, origins, linked, licenses):
    """Join only the actual original scanner, registry data and consumed members."""
    source, codegen = Path(source), Path(codegen)
    if not source.is_absolute() or not codegen.is_absolute() or not codegen.is_relative_to(source):
        raise ValueError('Original internal module registry namespace is not exact')
    matching = [origin for origin in origins if origin['namespace'] == str(source)]
    if len(matching) != 1:
        raise ValueError('Original internal module registry archive namespace is absent/ambiguous')
    members = matching[0]['members']
    # Exact names are data consumed by the unchanged original filesystem scanner.
    prefixes = ['src/js/' + name + '/' for name in ['bun', 'node', 'thirdparty', 'internal']]
    modules = sorted(name for name in members if any(name.startswith(prefix) for prefix in prefixes)
                     and (name.endswith('.js') or name.endswith('.ts') and not name.endswith('.d.ts')))
    modules += ['src/js/internal-for-testing.ts']
    names = ['src/codegen/internal-module-registry-scanner.ts', 'src/codegen/helpers.ts',
             'src/jsc/modules/NativeModuleList.h'] + modules
    facts = linked.bind_original_inputs([str(source / name) for name in names], origins, licenses)
    before = {name: licenses.read_regular(source, name, require_text=True) for name in names}
    runtime = Path(runtime).resolve(strict=True)
    runtime_bytes = licenses.read_regular(runtime.parent, runtime.name, require_text=False)
    if not runtime_bytes or not runtime.stat().st_mode & 0o111:
        raise ValueError('Original internal module registry runtime is not an executable File')
    with tempfile.TemporaryDirectory(prefix='bun-original-module-registry-') as temporary:
        root = Path(temporary)
        config = root / 'empty-bunfig.toml'
        config.write_bytes(b'')
        script = ('import {createInternalModuleRegistry} from ' + json.dumps(str(source / names[0])) +
                  ';const r=createInternalModuleRegistry(' + json.dumps(str(source / 'src/js')) +
                  ');process.stdout.write(JSON.stringify({modules:r.moduleList,nativeStart:r.nativeStartIndex}));')
        result = subprocess.run([str(runtime), '--no-install', '--no-env-file', '--config=' + str(config),
                                 '--eval', script], cwd=source,
            env={'PATH': '', 'HOME': str(root), 'TMPDIR': str(root), 'LC_ALL': 'C', 'CLAUDECODE': '1'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode:
            raise ValueError('Original internal module registry scanner failed: ' + result.stderr.decode('utf8'))
        registry = json.loads(result.stdout)
    expected_modules = [name.removeprefix('src/js/') for name in modules]
    if (set(registry) != {'modules', 'nativeStart'} or type(registry['nativeStart']) is not int or
            registry['nativeStart'] != len(modules) or not isinstance(registry['modules'], list) or
            registry['modules'][:registry['nativeStart']] != expected_modules):
        raise ValueError('Original internal module registry member inventory differs from its archive')
    if type(module_count) is not int or registry['nativeStart'] != module_count:
        raise ValueError('Original internal module registry differs from the actual loaded builtin count')
    # Exact original bundle-modules.ts output; helper normalization keeps this
    # two-line text unchanged. Its whole bytes must match, not only one macro.
    expected_header = ('#define BUN_INTERNAL_MODULE_COUNT ' + str(len(registry['modules'])) +
                       '\n#define BUN_NATIVE_MODULE_START_INDEX ' + str(registry['nativeStart']) + '\n').encode()
    header = codegen / 'InternalModuleRegistry+numberOfModules.h'
    if licenses.read_regular(source, header.relative_to(source).as_posix(), require_text=True) != expected_header:
        raise ValueError('Generated internal module count header differs from its original registry')
    for name, body in before.items():
        if licenses.read_regular(source, name, require_text=True) != body:
            raise ValueError('Original internal module registry source changed during reproduction')
    if licenses.read_regular(runtime.parent, runtime.name, require_text=False) != runtime_bytes:
        raise ValueError('Original internal module registry runtime changed during reproduction')
    return facts, [{'path': str(source / name), 'size': len(body),
                    'sha256': hashlib.sha256(body).hexdigest()} for name, body in before.items()]


def builtin_assembly_inputs(source, codegen, blob, data_offset, origins, linked, licenses):
    """Reproduce only the original selected assembly template, not its toolchain."""
    source, codegen = Path(source), Path(codegen)
    if not source.is_absolute() or not codegen.is_absolute() or not codegen.is_relative_to(source):
        raise ValueError('Original builtin assembly namespace is not exact')
    namespace = codegen / 'compiler-inputs/original-generators'
    matching = [origin for origin in origins if origin['namespace'] == str(source)]
    if len(matching) != 1:
        raise ValueError('Original builtin generator source archive namespace is absent/ambiguous')
    origin = {**matching[0], 'namespace': str(namespace), 'directory': namespace}
    generators = [str(namespace / name) for name in
                  ['src/codegen/bundle-modules.ts', 'src/codegen/helpers.ts']]
    facts = linked.bind_original_inputs(generators, [origin], licenses)
    original = licenses.read_regular(namespace, 'src/codegen/bundle-modules.ts', require_text=True).decode('utf8')
    consumed = licenses.read_regular(source, 'src/codegen/bundle-modules.ts', require_text=True).decode('utf8')
    marker = 'writeIfNotChanged(\n  path.join(CODEGEN_DIR, "InternalModuleRegistryConstants.S"),\n  `'
    if original.count(marker) != 1:
        raise ValueError('Original builtin assembly template is absent/ambiguous')
    if consumed.count(marker) != 1:
        raise ValueError('Consumed builtin assembly template is absent/ambiguous')
    template = original.split(marker)[1].split('`,\n);', 1)[0]
    if consumed.split(marker)[1].split('`,\n);', 1)[0] != template:
        raise ValueError('Consumed builtin assembly template differs from its original generator File')
    if (template.count('${blobDataOffset}') != 2 or
            '${' in template.replace('${blobDataOffset}', '') or '`' in template):
        raise ValueError('Original builtin assembly interpolation differs')
    helper = licenses.read_regular(namespace, 'src/codegen/helpers.ts', require_text=True)
    if licenses.read_regular(source, 'src/codegen/helpers.ts', require_text=True) != helper:
        raise ValueError('Consumed builtin assembly helper differs from its original archive File')
    helper = helper.decode('utf8')
    normalization = 'contents = contents.replaceAll("\\r\\n", "\\n").trim() + "\\n";'
    if helper.count(normalization) != 1:
        raise ValueError('Original builtin assembly text normalization differs')
    expected = template.replace('${blobDataOffset}', str(data_offset)).replace('\r\n', '\n').strip() + '\n'
    relative = (codegen / 'InternalModuleRegistryConstants.S').relative_to(source).as_posix()
    if licenses.read_regular(source, relative, require_text=True) != expected.encode('utf8'):
        raise ValueError('Generated builtin assembly differs from its exact original template/input')
    relative = (codegen / 'InternalModuleRegistryConstants.bin').relative_to(source).as_posix()
    if licenses.read_regular(source, relative, require_text=False) != blob:
        raise ValueError('Generated builtin assembly binary input differs from its loaded blob')
    return facts


def capture_embedded_inputs(configuration, source, archive, pins, custody, linked, licenses, additional_source=None):
    """Join real compiler inputs to original source bytes before private tree removal.

    The selected inputs are causal compiler facts. Native retention, generated
    producing-input authority and npm origins remain separate mandatory inputs.
    """
    source = Path(source).resolve(strict=True)
    codegen = Path(configuration['cfg']['codegenDir'])
    if not codegen.is_absolute() or not codegen.is_relative_to(source):
        raise ValueError('Original embedded codegen namespace escaped its native source root')
    members, facts = custody.source_members(Path(archive).read_bytes(), pins, licenses.relative)
    origin = {'component': 'bun@' + pins['version'], 'namespace': str(source),
              'directory': source, 'members': members,
              'aliases': {fact['path']: fact['target'] for fact in facts if fact['kind'] == 'symlink'}}
    license_facts = []
    for name, expected in sorted(pins['license_members'].items()):
        body = licenses.read_regular(source, name, require_text=True)
        if body != members[name] or hashlib.sha256(body).hexdigest() != expected:
            raise ValueError('Original embedded source license File bytes changed')
        license_facts.append({'path': name, 'size': len(body), 'sha256': expected})
    metadata = codegen / 'compiler-inputs'
    records = [(metadata / 'modules.json', source, metadata / 'modules.sources.json', None),
               (codegen / 'runtime.out.js.compiler-inputs.json', source, None, None),
               (codegen / 'bun-error/compiler-inputs.json', source / 'packages/bun-error', None, None)]
    pending, sources, compiler_inputs = [], {}, []
    functions = metadata / 'functions'
    # Both Files come from each actual original function generator invocation.
    # A surviving source relation still requires its consumed compiler metadata,
    # and surviving compiler metadata still requires its original source relation.
    function_names = {file.name.removesuffix('.sources.json') if file.name.endswith('.sources.json')
                      else file.name.removesuffix('.json') for file in functions.glob('*.json')}
    if not function_names:
        pending.append({'metadata': (metadata / 'functions').relative_to(source).as_posix(),
                        'reason': 'Original function compiler metadata is absent'})
    for name in sorted(function_names):
        records.append((functions / (name + '.json'), source,
                        functions / (name + '.sources.json'), None))
    for name in sorted(members):
        if name.startswith('src/js/eval/') and name.endswith('.ts') and name.count('/') == 3:
            records.append((metadata / ('eval.' + Path(name).name + '.json'), source, None, None))
        elif name.startswith('src/node-fallbacks/') and name.endswith('.js') and name.count('/') == 2:
            records.append((codegen / 'node-fallbacks' / (Path(name).name + '.compiler-inputs.json'),
                            source / 'src/node-fallbacks', None, None))
    records.append((codegen / 'node-fallbacks/react-refresh.js.compiler-inputs.json',
                    source / 'src/node-fallbacks', None, None))
    bake = metadata / 'bake'
    records.append((bake / 'overlay-css.json', source / 'src/codegen', None, None))
    bake_second = {}
    for name in ['client', 'server', 'error']:
        records.append((bake / (name + '.first.json'), source / 'src/runtime/bake',
                        bake / 'rust-enum.sources.json', None))
        second = bake / (name + '.second.json')
        records.append((second, source / 'src/runtime/bake', None, bake / (name + '.sources.json')))
        bake_second[second] = name
    for file, directory, relation, preserved in records:
        relative = file.relative_to(source).as_posix()
        try:
            raw = licenses.read_regular(source, relative, require_text=False)
            original = {} if relation is None else json.loads(
                licenses.read_regular(source, relation.relative_to(source).as_posix(), require_text=True))
            copies = {} if preserved is None else json.loads(
                licenses.read_regular(source, preserved.relative_to(source).as_posix(), require_text=True))
        except FileNotFoundError:
            pending.append({'metadata': relative, 'reason': 'Original compiler metadata/relation File is absent'})
            continue
        selected, inputs = compiler_input_records(raw, directory, source, original, licenses, copies)
        if file in bake_second:
            name = bake_second[file]
            try:
                first_raw = licenses.read_regular(source, (bake / (name + '.first.json')).relative_to(source).as_posix(), require_text=False)
                first_relation = json.loads(licenses.read_regular(source,
                    (bake / (name + '.first.sources.json')).relative_to(source).as_posix()))
                rust_relation = json.loads(licenses.read_regular(source,
                    (bake / 'rust-enum.sources.json').relative_to(source).as_posix()))
                expected = str(directory / ('.runtime-' + name + '.generated.ts'))
                if set(copies) != {expected} or selected != [expected]:
                    raise ValueError('Original Bake second compiler has a foreign generated-input relation')
                preserved_file = Path(copies[expected])
                captured = licenses.read_regular(source, preserved_file.relative_to(source).as_posix(), require_text=False)
                bake_original_inputs(name, first_raw, first_relation, captured, directory, source, licenses, linked)
                selected, _ = compiler_input_records(first_raw, directory, source, rust_relation, licenses)
            except FileNotFoundError:
                pending.extend({'metadata': relative, 'source': selected_file,
                                'reason': 'Original Bake first-output source relation/File is absent'}
                               for selected_file in selected)
                selected = []
            except linked.PendingLinkedSource as error:
                pending.extend({'metadata': relative, 'source': selected_file, 'reason': str(error)}
                               for selected_file in selected)
                selected = []
        record = {'metadata': relative, 'inputs': inputs, 'sources': []}
        compiler_inputs.append(record)
        for selected_file in selected:
            try:
                bound = linked.bind_original_inputs([selected_file], [origin], licenses)[0]
            except linked.PendingLinkedSource as error:
                if additional_source is None:
                    pending.append({'metadata': relative, 'source': selected_file, 'reason': str(error)})
                    continue
                try:
                    bound, notices = additional_source(selected_file)
                except linked.PendingLinkedSource as error:
                    pending.append({'metadata': relative, 'source': selected_file, 'reason': str(error)})
                    continue
                for notice in notices:
                    existing = [fact for fact in license_facts if fact['path'] == notice['path']]
                    if existing and existing != [notice]:
                        raise ValueError('Original embedded npm license byte facts disagree')
                    if not existing:
                        license_facts.append(notice)
            record['sources'].append(bound)
            key = (bound['component'], bound['path'], bound['source_path'])
            if key in sources and sources[key] != bound:
                raise ValueError('Original embedded source byte facts disagree')
            sources[key] = bound
    return {'sources': [sources[key] for key in sorted(sources)],
            'pending': pending, 'compilerInputs': compiler_inputs,
            # Original available license custody, not a selected notice scope.
            'licenses': sorted(license_facts, key=lambda fact: fact['path'])}


def require_embedded_inputs(configuration, linked, licenses):
    """Selected runtime admission must propagate every unresolved causal input."""
    value = configuration.get('embeddedCompilerInputs')
    if not isinstance(value, dict) or not isinstance(value.get('pending'), list):
        raise linked.PendingLinkedSource('Original same-action embedded compiler source custody is absent')
    if value['pending']:
        raise linked.PendingLinkedSource('Embedded original source authority remains pending: ' + repr(value['pending']))
    sources = value.get('sources')
    if not isinstance(sources, list) or not sources:
        raise linked.PendingLinkedSource('Original same-action embedded compiler source facts are absent')
    compiler_inputs, original_licenses = value.get('compilerInputs'), value.get('licenses')
    if not isinstance(compiler_inputs, list) or not compiler_inputs or not isinstance(original_licenses, list) or not original_licenses:
        raise linked.PendingLinkedSource('Original same-action compiler byte/license custody is absent')
    def byte_fact(fact, fields):
        if not isinstance(fact, dict) or set(fact) != fields:
            raise ValueError('Malformed original embedded compiler byte fact')
        if type(fact['size']) is not int or fact['size'] < 0 or not isinstance(fact['sha256'], str):
            raise ValueError('Malformed original embedded source size/digest')
        if len(fact['sha256']) != 64 or set(fact['sha256']) - set('0123456789abcdef'):
            raise ValueError('Malformed original embedded source digest')
        for name in ['path', 'source_path', 'captured_path']:
            if name in fields:
                licenses.relative(fact[name])
    for fact in sources:
        byte_fact(fact, {'component', 'path', 'source_path', 'size', 'sha256'})
        if not isinstance(fact['component'], str) or not fact['component']:
            raise ValueError('Original embedded source component owner is absent')
    for fact in original_licenses:
        byte_fact(fact, {'path', 'size', 'sha256'})
    for record in compiler_inputs:
        if (not isinstance(record, dict) or set(record) != {'metadata', 'inputs', 'sources'} or
                not isinstance(record['inputs'], list) or not record['inputs'] or
                not isinstance(record['sources'], list) or not record['sources']):
            raise ValueError('Original embedded compiler input byte custody is malformed')
        licenses.relative(record['metadata'])
        for fact in record['inputs']:
            byte_fact(fact, {'path', 'captured_path', 'size', 'sha256'})
        for fact in record['sources']:
            if fact not in sources:
                raise ValueError('Original generator source partition differs from captured source union')
    return sources

