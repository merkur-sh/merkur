"""Read retained inputs from the same original native build, never a source superset.

The generated source collector supplies causal byte custody, not native retention.
Full runtime admission remains unavailable until genuine LTO and Bun-nightly
rebuilt standard-library collectors can join these exact same-build artifacts.
"""

import argparse
import hashlib
import importlib.util
import io
import tarfile
import json
from pathlib import Path
import struct
import sys


def load(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


def build_namespace(configuration, published, linked, licenses):
    """Only the original recorded cwd determines relocation to its actual Tree."""
    original = Path(configuration['cfg']['cwd'])
    if not original.is_absolute() or '..' in original.parts:
        raise ValueError('Original native source namespace must be exact')
    published = Path(published).resolve(strict=True)
    if not published.is_dir():
        raise ValueError('Original native build must be its declared TreeArtifact')

    def relative(value):
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('Original native input path is not exact')
        if not path.is_relative_to(original):
            raise linked.PendingLinkedSource('Selected native input has no published original namespace: ' + str(path))
        result = path.relative_to(original).as_posix()
        if result != '.':
            licenses.relative(result)
        return result

    def path(value):
        return str(published / relative(value))

    def read(value):
        return licenses.read_regular(published, relative(value), require_text=False)

    return original, published, path, read


def dependency_archive(raw, pin, licenses):
    """The original archive defines its single stripped root; no name inference."""
    if hashlib.sha256(raw).hexdigest() != pin['sha256']:
        raise ValueError('Original native dependency archive bytes changed')
    with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
        prefixes = set()
        for entry in archive:
            name = licenses.relative(entry.name.rstrip('/'))
            prefixes.add(name.split('/')[0])
    if len(prefixes) != 1:
        raise ValueError('Original native source archive has no unique source root')
    prefix = next(iter(prefixes))
    return {'source': {'sha256': pin['sha256'], 'prefix': prefix}}


def dependency_relations(configuration, specification, build_pins):
    files = specification['dependency_files']
    pins = build_pins['dependencies']
    if not isinstance(files, dict) or set(files) != set(pins):
        raise ValueError('Native dependency Files differ from their original pinned closure')
    relations = configuration.get('dependencySources')
    if not isinstance(relations, list):
        raise ValueError('Original native dependency acquisition relations are absent')
    expected = {**pins, 'webkit': {'kind': 'prebuilt', **specification['webkit']}}
    archive_files = {**files, 'webkit': specification['webkit']['file']}
    consumed, directories = set(), set()
    result = []
    for relation in relations:
        if not isinstance(relation, dict) or set(relation) != {'name', 'kind', 'url', 'directory'}:
            raise ValueError('Original native acquisition relation is malformed')
        name = relation['name']
        if not isinstance(name, str) or name not in expected or name in consumed:
            raise ValueError('Original native acquisition relation is repeated or foreign')
        pin = expected[name]
        url = pin['original_url'] if 'original_url' in pin else pin['url']
        if relation['url'] != url or relation['kind'] != pin['kind']:
            raise ValueError('Native acquisition relation differs from original source identity')
        directory = relation['directory']
        if not isinstance(directory, str) or directory in directories:
            raise ValueError('Original native source destination is absent or ambiguous')
        consumed.add(name)
        directories.add(directory)
        result.append((relation, pin, archive_files[name]))
    if consumed != set(expected):
        raise ValueError('Original native dependency acquisition closure is incomplete')
    return result


def native_dependency_origins(configuration, specification, build_pins, pins,
                              published, linked, custody, licenses):
    """Extend the existing archive origins with actual same-action source suppliers."""
    if build_pins['bun_commit'] != pins['commit']:
        raise ValueError('Native source suppliers belong to another original Bun commit')
    _, _, relocate, _ = build_namespace(configuration, published, linked, licenses)
    declared = specification['declared_files']
    if not isinstance(declared, list) or any(not isinstance(file, str) for file in declared):
        raise ValueError('Native original action File closure is malformed')
    result = []
    for relation, pin, file in dependency_relations(configuration, specification, build_pins):
        if not isinstance(file, str) or file not in declared:
            raise ValueError('Original dependency archive is absent from its native action Files')
        namespace = relation['directory']
        directory = Path(relocate(namespace))
        original = Path(file).resolve(strict=True)
        raw = licenses.read_regular(original.parent, original.name, require_text=False)
        if hashlib.sha256(raw).hexdigest() != pin['sha256']:
            raise ValueError('Original native dependency archive bytes changed')
        if relation['kind'] == 'prebuilt':
            # WebKit LTO/native binaries are not original source suppliers.
            # Their missing C++/generated input closure remains mandatory pending.
            continue
        archive_pin = dependency_archive(raw, pin, licenses)
        component = relation['name'] + '@' + pin['revision']
        result.append(linked.archive_origin(component, namespace, directory, raw,
                      archive_pin, custody, licenses))
    return result


def retained_native_inputs(configuration, published, runtime, target, origins,
                           linked, licenses, sections, mapper, generated=None, generator_runtime=None):
    """Component collector only: actual maps/objects/deps select original bytes.

    This function supplies no embedded-runtime admission. The admission reader
    below always invokes the mandatory embedded-input gate first.
    """
    original, published, relocate, read = build_namespace(configuration, published, linked, licenses)
    native_runtime = read(configuration['runtime'])
    runtime = Path(runtime).resolve(strict=True)  # Actual declared File may have a Bazel carrier.
    if licenses.read_regular(runtime.parent, runtime.name, require_text=False) != native_runtime:
        raise ValueError('Embedded runtime differs from the same source-built runtime File')
    output = configuration['output']['exe']
    binary = read(output)
    maps = configuration['linkerMaps']
    if not isinstance(maps, list) or len(maps) != 1:
        raise ValueError('Original Linux/macOS release requires its exact single linker map')
    raw = read(maps[0])
    if target.endswith('-apple-darwin'):
        retained = linked.macho_retained(raw, target, output, sections.loaded_image(binary), mapper)
    elif target.endswith('-unknown-linux-gnu'):
        retained = linked.elf_retained(raw, target, binary, sections)
    else:
        raise ValueError('Original Bun runtime requires a declared native Linux/macOS target')
    build = configuration['cfg']['buildDir']
    commands = linked.compiler_commands(read(str(Path(build) / 'compile_commands.json')))
    dependencies = linked.ninja_dependencies(read(str(Path(build) / 'original-compiler-deps.txt')), build)
    # Configured but unbuilt source paths are not selected. Rebase object outputs
    # now; source paths only after actual retained-object selection below.
    objects = {relocate(output): source for output, source in commands.items()}
    deps = {relocate(output): values for output, values in dependencies.items()}
    records, archives = [], {}
    for record in retained:
        member = ''
        if record.endswith(')') and '(' in record:
            record, member = record.rsplit('(', 1)
            member = '(' + member
        file = str(Path(build) / record)
        moved = relocate(file)
        records.append(moved + member)
        if member:
            archives[moved] = read(file)
    selected = linked.selected_archive_inputs(records, objects, deps, relocate(build), archives, mapper, licenses)
    relocated_origins = []
    for origin in origins:
        relocated_origins.append({**origin, 'namespace': relocate(origin['namespace']),
                                  'directory': Path(relocate(origin['namespace']))})
    selected = [relocate(source) for source in selected]
    generated_facts = []
    if 'codegenDir' in configuration['cfg']:
        header = relocate(str(Path(configuration['cfg']['codegenDir']) / 'json_byte_class.h'))
        if header in selected:
            if generated is None:
                raise linked.PendingLinkedSource('Selected JSON header needs original generator source reproduction')
            generated_facts = generated.json_byte_class_inputs(published, header, generator_runtime,
                relocated_origins, linked, licenses)
            selected.remove(header)
    facts = linked.bind_original_inputs(selected, relocated_origins, licenses)
    for fact in generated_facts:
        if fact not in facts:
            facts.append(fact)
    return facts


def retained_builtin_inputs(configuration, published, runtime, target, origins,
                            linked, generated, licenses, sections, mapper, generator_patch=None, generator_runtime=None,
                            private_sources=None, closure=None, deployment=None):
    """Join original module/function compiler inputs to the actual loaded blob.

    This is one generated-data component, not full runtime attribution. Other
    embedded generators, native LTO inputs and rebuilt nightly std remain pending.
    """
    if not target.endswith('-apple-darwin'):
        raise linked.PendingLinkedSource('Original ELF builtin-symbol retention remains pending')
    original, published, relocate, read = build_namespace(configuration, published, linked, licenses)
    native_runtime = read(configuration['runtime'])
    runtime = Path(runtime).resolve(strict=True)
    if licenses.read_regular(runtime.parent, runtime.name, require_text=False) != native_runtime:
        raise ValueError('Embedded runtime differs from the same source-built runtime File')
    maps = configuration['linkerMaps']
    if not isinstance(maps, list) or len(maps) != 1:
        raise ValueError('Original builtin retention requires its exact single linker map')
    output = read(configuration['output']['exe'])
    if output != native_runtime:
        raise ValueError('Builtin native image differs from the same source-built runtime File')
    image = sections.loaded_image(native_runtime)
    _, symbols = linked.macho_map_selection(read(maps[0]), target,
        configuration['output']['exe'], image, mapper)
    selected = {}
    for name in ('_bun_internal_modules_header', '_bun_internal_modules_data'):
        rows = [row for row in symbols if row['name'] == name]
        if len(rows) != 1:
            raise linked.PendingLinkedSource('Original builtin live symbol is absent/ambiguous: ' + name)
        selected[name] = rows[0]
    codegen = Path(configuration['cfg']['codegenDir'])
    blob = read(str(codegen / 'InternalModuleRegistryConstants.bin'))
    if len(blob) < 48 or blob[:8] != b'BUNBLTNS':
        raise ValueError('Original generated builtin blob header is absent')
    version, _, _, _, _, _, data_offset, data_size, reserved0, reserved1 = struct.unpack_from('<10I', blob, 8)
    if version != 1 or reserved0 or reserved1 or data_offset < 48 or data_offset + data_size != len(blob):
        raise ValueError('Original generated builtin blob layout differs from its pinned producer')
    header, data = [selected[name] for name in ('_bun_internal_modules_header', '_bun_internal_modules_data')]
    # Original ld64 emits a zero-sized live assembly label for the header.
    # Its extent comes from the next original symbol and the producer offset,
    # not from treating that legitimate alias as a dead/missing definition.
    if (header['object'] != data['object'] or header['size'] not in (0, data_offset) or
            data['address'] != header['address'] + data_offset or data['size'] < data_size):
        raise ValueError('Original builtin symbol spans differ from their generated assembly')
    matches = [segment for segment in image.mappings if segment.name == '__TEXT' and
               segment.permissions[-1] & 1 and not segment.permissions[-1] & 2 and
               segment.address <= header['address'] and
               header['address'] + len(blob) <= segment.address + len(segment.contents)]
    if len(matches) != 1:
        raise ValueError('Original builtin blob is outside its read-only loaded native bytes')
    loaded = sections.bounded(matches[0].contents, header['address'] - matches[0].address, len(blob))
    if loaded != blob:
        raise ValueError('Loaded builtin bytes differ from the original generated blob')
    build = Path(configuration['cfg']['buildDir'])
    try:
        commands = linked.compiler_commands(read(str(build / 'compile_commands.json')))
    except FileNotFoundError as error:
        raise linked.PendingLinkedSource('Original selected builtin assembly compiler relation is absent') from error
    object_file = str(build / header['object'])
    assembly = str(codegen / 'InternalModuleRegistryConstants.S')
    if commands.get(object_file) != assembly:
        raise linked.PendingLinkedSource('Original selected builtin object has no exact assembly compiler relation')
    relocated_origins = [{**origin, 'namespace': relocate(origin['namespace']),
                          'directory': Path(relocate(origin['namespace']))} for origin in origins]
    generator_sources = generated.builtin_assembly_inputs(published, Path(relocate(str(codegen))), blob,
        data_offset, relocated_origins, linked, licenses)
    if generator_patch is None or generator_runtime is None:
        raise linked.PendingLinkedSource('Actual builtin instrumentation patch/generator Files are required')
    patch = Path(generator_patch).resolve(strict=True)
    generator = Path(generator_runtime).resolve(strict=True)
    patch_bytes = licenses.read_regular(patch.parent, patch.name, require_text=False)
    generator_bytes = licenses.read_regular(generator.parent, generator.name, require_text=False)
    original_generator = read(str(codegen / 'compiler-inputs/original-generators/src/codegen/bundle-modules.ts'))
    consumed_generator = read(str(original / 'src/codegen/bundle-modules.ts'))
    if generated.instrumented_builtin_source(original_generator, patch_bytes) != consumed_generator:
        raise ValueError('Consumed builtin generator differs from the exact original and maintained patch')
    function_name = 'src/codegen/bundle-functions.ts'
    original_functions = read(str(codegen / 'compiler-inputs/original-generators' / function_name))
    consumed_functions = read(str(original / function_name))
    if generated.instrumented_builtin_source(original_functions, patch_bytes, function_name) != consumed_functions:
        raise ValueError('Consumed builtin function generator differs from the exact original and maintained patch')
    namespace = relocate(str(codegen / 'compiler-inputs/original-generators'))
    function_origins = [{**origin, 'namespace': namespace, 'directory': Path(namespace)}
                        for origin in relocated_origins if origin['namespace'] == str(published)]
    generator_sources += linked.bind_original_inputs([str(Path(namespace) / function_name)], function_origins, licenses)
    # These exact original imports are executed by the pinned function generator;
    # they are not the application inputs selected by each Bun.build metafile.
    function_imports = (['src/codegen/' + name for name in
                         ['builtin-parser.ts', 'client-js.ts', 'generate-js2native.ts', 'replacements.ts']] +
                        ['src/jsc/bindings/ErrorCode.ts', 'src/jsc/bindings/js_classes.ts'])
    generator_sources += linked.bind_original_inputs(
        [str(published / name) for name in function_imports], relocated_origins, licenses)
    consumed_imports = [(name, read(str(original / name))) for name in function_imports]
    registry_sources, registry_inputs = generated.internal_module_registry_inputs(
        published, Path(relocate(str(codegen))), generator, struct.unpack_from('<I', blob, 16)[0],
        relocated_origins, linked, licenses)
    for fact in registry_sources:
        if fact not in generator_sources:
            generator_sources.append(fact)
    if not generator_bytes or not generator.stat().st_mode & 0o111:
        raise ValueError('Builtin generator runtime must be its actual executable File')
    if private_sources is None or closure is None or deployment is None:
        raise linked.PendingLinkedSource('Actual maintained patch private workspace SourceFiles are required')
    patch_component = generated.private_builtin_patch(patch_bytes, private_sources, closure, deployment)
    if Path(private_sources['patch']['input']).resolve(strict=True) != patch:
        raise ValueError('Builtin patch ownership differs from its actual consumed File')
    generated_inputs = [
        {'path': str(original / 'src/codegen/bundle-modules.ts'), 'size': len(consumed_generator),
         'sha256': hashlib.sha256(consumed_generator).hexdigest()},
        {'path': str(patch), 'size': len(patch_bytes), 'sha256': hashlib.sha256(patch_bytes).hexdigest()},
        {'path': str(generator), 'size': len(generator_bytes), 'sha256': hashlib.sha256(generator_bytes).hexdigest()},
        {'path': str(original / function_name), 'size': len(consumed_functions),
         'sha256': hashlib.sha256(consumed_functions).hexdigest()},
    ] + [{'path': str(original / name), 'size': len(body),
          'sha256': hashlib.sha256(body).hexdigest()} for name, body in consumed_imports]
    for fact in registry_inputs:
        input_fact = {**fact, 'path': str(original / Path(fact['path']).relative_to(published))}
        if input_fact not in generated_inputs:
            generated_inputs.append(input_fact)
    value = configuration.get('embeddedCompilerInputs')
    if (not isinstance(value, dict) or not isinstance(value.get('compilerInputs'), list) or
            not isinstance(value.get('pending'), list) or not isinstance(value.get('sources'), list) or
            not isinstance(value.get('licenses'), list) or
            any(not isinstance(row, dict) for row in value['compilerInputs'] + value['pending'])):
        raise linked.PendingLinkedSource('Original builtin compiler source partition is absent')
    metadata_root = codegen / 'compiler-inputs'
    metadata = [str(metadata_root.relative_to(original) / 'modules.json')]
    functions = Path(relocate(str(metadata_root / 'functions')))
    metadata += [str((metadata_root / 'functions' / file.name).relative_to(original))
                 for file in sorted(functions.glob('*.json')) if not file.name.endswith('.sources.json')]
    if len(metadata) == 1:
        raise linked.PendingLinkedSource('Original builtin function compiler metadata is absent')
    if any(row.get('metadata') in metadata for row in value['pending']):
        raise linked.PendingLinkedSource('Original selected builtin source authority remains pending')
    sources = {}
    for name in metadata:
        records = [row for row in value['compilerInputs'] if row.get('metadata') == name]
        if len(records) != 1 or set(records[0]) != {'metadata', 'inputs', 'sources'}:
            raise linked.PendingLinkedSource('Original builtin invocation source partition is absent/ambiguous')
        file = original / name
        raw = json.loads(read(str(file)))
        relations = json.loads(read(str(file.with_name(file.stem + '.sources.json'))))
        relations = {relocate(key): relocate(source) for key, source in relations.items()}
        # Absolute original metafile paths and source relations keep the exact
        # recorded producer namespace after relocation of its published Tree.
        def moved(name):
            return relocate(name) if Path(name).is_absolute() else name
        raw['inputs'] = {moved(name): fact for name, fact in raw['inputs'].items()}
        for output in raw['outputs'].values():
            output['inputs'] = {moved(name): fact for name, fact in output['inputs'].items()}
        selected_sources, input_facts = generated.compiler_input_records(
            json.dumps(raw).encode(), published, published, relations, licenses)
        bound = linked.bind_original_inputs(selected_sources, relocated_origins, licenses)
        if input_facts != records[0]['inputs'] or bound != records[0]['sources']:
            raise ValueError('Original builtin compiler partition differs from same-action selected source bytes')
        for fact in bound:
            if fact not in value.get('sources', []):
                raise ValueError('Original builtin source partition differs from captured source union')
            sources[(fact['component'], fact['path'], fact['source_path'])] = fact
    notices = []
    for component in sorted({fact['component'] for fact in sources.values()}):
        origins_for_component = [origin for origin in relocated_origins if origin['component'] == component]
        if len(origins_for_component) != 1:
            raise ValueError('Original builtin component license namespace is absent/ambiguous')
        origin = origins_for_component[0]
        for text in licenses.collect(origin['directory']):
            body = licenses.read_regular(origin['directory'], text['path'], require_text=True)
            fact = {'path': text['path'], 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
            if origin['members'].get(text['path']) != body or fact not in value['licenses']:
                raise ValueError('Original builtin license differs from same-action original archive bytes')
            notices.append({'component': component, **text})
    return {'blob': {'size': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()},
            'sources': [sources[key] for key in sorted(sources)],
            'generated_sources': generator_sources, 'generated_inputs': generated_inputs, 'licenses': notices,
            'generated_components': [patch_component],
            # Original function-generator source imports are joined; this does
            # not provide the bootstrap runtime/tool implementation attribution.
            'pending_sources': [str(generator)]}


def read_selected_runtime(configuration, published, runtime, target, origins,
                          linked, generated, licenses, sections, mapper, generator_patch=None, generator_runtime=None,
                          private_sources=None, closure=None, deployment=None):
    # Ordering is intentional: maps and native bytes cannot bypass unresolved
    # original same-action generated/npm compiler input authority.
    generated.require_embedded_inputs(configuration, linked, licenses)
    builtins = retained_builtin_inputs(configuration, published, runtime, target,
        origins, linked, generated, licenses, sections, mapper, generator_patch, generator_runtime,
        private_sources, closure, deployment)
    facts = retained_native_inputs(configuration, published, runtime, target,
                                   origins, linked, licenses, sections, mapper, generated, generator_runtime)
    # Causal compiler inputs cannot establish native generated-data retention,
    # whole-program LTO source selection, or the independently rebuilt nightly
    # standard library. No stock-workspace compiler/source authority is accepted.
    raise linked.PendingLinkedSource(
        'Selected original runtime still requires other same-build generated-data retention, '
        'LTO/DWARF and rebuilt Bun-nightly standard-library authority; '
        + str(len(facts)) + ' native source inputs have exact byte custody; '
        + str(len(builtins['sources'])) + ' builtin sources join the original loaded blob')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('request', type=Path)
    parser.add_argument('output', type=Path)
    arguments = parser.parse_args()
    request = json.loads(arguments.request.read_bytes())
    modules = {name: load('bun_selected_' + name, request[name]) for name in
               ['linked', 'generated', 'licenses', 'sections', 'mapper', 'custody', 'closure', 'deployment']}
    configuration = json.loads(Path(request['configuration']).read_bytes())
    pins = json.loads(Path(request['pins']).read_bytes())
    source = Path(configuration['cfg']['cwd'])
    origin = modules['linked'].archive_origin('bun@' + pins['version'], source,
        request['published'], Path(request['archive']).read_bytes(), pins,
        modules['custody'], modules['licenses'])
    native_specification = json.loads(Path(request['native_request']).read_bytes())
    build_pins = json.loads(Path(request['build_pins']).read_bytes())
    origins = [origin] + native_dependency_origins(configuration, native_specification, build_pins,
        pins, request['published'], modules['linked'], modules['custody'], modules['licenses'])
    # Full selected-runtime facts may only be written after every mandatory
    # authority has joined. Today unresolved full-runtime scopes always refuse.
    facts = read_selected_runtime(configuration, request['published'], request['runtime'],
        request['target'], origins, modules['linked'], modules['generated'],
        modules['licenses'], modules['sections'], modules['mapper'], request['generator_patch'], request['generator_runtime'],
        request['private_sources'], modules['closure'], modules['deployment'])
    arguments.output.write_text(json.dumps(facts) + '\n')


if __name__ == '__main__':
    main()
