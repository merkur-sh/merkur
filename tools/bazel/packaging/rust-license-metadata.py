"""Validate original Cargo licenses and bind them to the actual native compiler."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import tomllib


def effective(manifest, workspace=None):
    parsed = tomllib.loads(manifest.decode('utf8'))
    package = parsed.get('package')
    if not isinstance(package, dict):
        raise ValueError('Declared source has no Cargo package')
    shared = None
    inherited = []
    def field(name, optional=False):
        nonlocal shared
        value = package.get(name)
        if value is None and optional:
            return None
        if isinstance(value, dict):
            if value != {'workspace': True} or name == 'name' or workspace is None:
                raise ValueError('Unresolved Cargo workspace metadata')
            if shared is None:
                parsed_workspace = tomllib.loads(workspace.decode('utf8'))
                table = parsed_workspace.get('workspace')
                shared = table.get('package') if isinstance(table, dict) else None
            if not isinstance(shared, dict) or name not in shared:
                raise ValueError('Declared workspace has no inherited package field')
            value = shared[name]
            inherited.append(name)
        if not isinstance(value, str) or not value.strip() or value != value.strip():
            raise ValueError('Invalid Cargo package metadata')
        return value
    result = {name: field(name, name in ['license', 'repository', 'license-file'])
              for name in ['name', 'version', 'license', 'repository', 'license-file']}
    result['license_file'] = result.pop('license-file')
    if result['license'] is None and result['license_file'] is None:
        raise ValueError('Declared Cargo package has neither license nor license-file')
    return result, sorted(inherited)


def validate(expected, manifest, workspace=None):
    actual, inherited = effective(manifest, workspace)
    for key, value in actual.items():
        if key not in expected or expected[key] != value:
            raise ValueError('Captured Cargo metadata disagrees with declared manifest: ' + key)
    return inherited


def publisher_licenses(package, root, manifest_label, sources, inputs):
    """Join exact published crate VCS facts to original Git archive license Files."""
    if package.get('license_file') is not None or any(
            re.match(r'^(licen[cs]e|copying|notice|unlicense)', entry.name, re.I)
            for entry in Path(root).iterdir()):
        raise ValueError('Publisher attachments cannot replace package-owned license text')
    required = {'catalog', 'archive', 'vcs', 'manifest', 'workspace_manifest', 'package_manifest'}
    if not isinstance(sources, dict) or not required.issubset(sources) or not any(name.startswith('license:') for name in sources):
        raise ValueError('Publisher licenses require the original source File closure')
    if any(name not in required and not name.startswith('license:') for name in sources):
        raise ValueError('Unknown publisher license File role')
    data, facts = {}, {}
    for role, original in sources.items():
        facts[role] = file_fact(original, inputs)
        data[role] = declared_bytes(original['input'], inputs)
        if facts[role]['sha256'] != hashlib.sha256(data[role]).hexdigest() or facts[role]['size'] != len(data[role]):
            raise ValueError('Publisher source File changed during collection')
    catalog = json.loads(data['catalog'])
    if not isinstance(catalog, dict) or set(catalog) != {'packages', 'sources'}:
        raise ValueError('Invalid original publisher license catalog')
    entry = catalog['packages'].get(package['id'])
    fields = {'archive_sha256', 'license', 'licenses', 'manifest', 'source', 'source_archive', 'vcs_file', 'vcs_path', 'vcs_sha256', 'workspace_manifest'}
    if not isinstance(entry, dict) or set(entry) != fields:
        raise ValueError('Publisher catalog lacks the exact selected crate identity')
    if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index' or package['archive_checksum'] != entry['archive_sha256'] or package['license'] != entry['license']:
        raise ValueError('Publisher source belongs to a different original crate')
    if sources['package_manifest']['label'] != manifest_label:
        raise ValueError('Publisher crate manifest ownership differs')
    original_manifest = Path(sources['package_manifest']['input']).resolve(strict=True)
    original_vcs = Path(sources['vcs']['input']).resolve(strict=True)
    if original_manifest.name != 'Cargo.toml' or original_vcs != original_manifest.parent / '.cargo_vcs_info.json':
        raise ValueError('Publisher VCS File belongs to another original crate tree')
    if data['package_manifest'] != inputs.read_regular(root, 'Cargo.toml'):
        raise ValueError('Publisher source manifest differs from the selected crate')
    vcs = json.loads(data['vcs'])
    if hashlib.sha256(data['vcs']).hexdigest() != entry['vcs_sha256'] or not isinstance(vcs, dict) or set(vcs) != {'git', 'path_in_vcs'}:
        raise ValueError('Publisher crate VCS bytes differ from the original publication')
    source = catalog['sources'].get(entry['source'])
    if not isinstance(source, dict) or set(source) != {'commit', 'members', 'prefix', 'repository', 'sha256', 'url'}:
        raise ValueError('Original publisher archive has no pinned source identity')
    if vcs['git'] != {'sha1': source['commit']} or vcs['path_in_vcs'] != entry['vcs_path']:
        raise ValueError('Publisher source commit/path differs from the original crate VCS')
    repository = 'https://github.com/' + source['repository']
    if source['url'] != 'https://codeload.github.com/' + source['repository'] + '/tar.gz/' + source['commit'] or package['repository'] not in {repository, repository + '/tree/main/' + entry['vcs_path']}:
        raise ValueError('Publisher archive does not belong to the crate repository')
    if len(source['commit']) != 40 or any(character not in '0123456789abcdef' for character in source['commit']) or source['prefix'] != source['repository'].split('/')[-1] + '-' + source['commit']:
        raise ValueError('Publisher archive prefix differs from its original Git commit')
    for role, field in [('archive', 'source_archive'), ('vcs', 'vcs_file'), ('manifest', 'manifest'), ('workspace_manifest', 'workspace_manifest')]:
        if sources[role]['label'] != entry[field]:
            raise ValueError('Publisher source File ownership differs: ' + role)
    if facts['archive']['sha256'] != source['sha256']:
        raise ValueError('Publisher Git archive bytes differ from the original pin')
    licenses = entry['licenses']
    if not isinstance(licenses, dict) or not licenses or {name.removeprefix('license:') for name in sources if name.startswith('license:')} != set(licenses):
        raise ValueError('Publisher license member inventory differs')
    selected = {'Cargo.toml': 'workspace_manifest', entry['vcs_path'] + '/Cargo.toml': 'manifest'}
    selected.update({member: 'license:' + member for member in licenses})
    if len(selected) != len(licenses) + 2:
        raise ValueError('Publisher manifests/license members overlap')
    archive_members = {}
    with tarfile.open(fileobj=io.BytesIO(data['archive']), mode='r:gz') as archive:
        names = set()
        for member in archive:
            name = member.name
            logical = PurePosixPath(name)
            if logical.is_absolute() or '..' in logical.parts or str(logical) != name or name in names:
                raise ValueError('Publisher archive has an invalid or duplicate original member')
            names.add(name)
            prefix = source['prefix'] + '/'
            if name.startswith(prefix) and name[len(prefix):] in selected:
                if not member.isfile():
                    raise ValueError('Publisher license/manifest member is not an ordinary original File')
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError('Original publisher archive member is unreadable')
                archive_members[name[len(prefix):]] = stream.read()
    if set(archive_members) != set(selected):
        raise ValueError('Publisher archive omits a selected original member')
    texts = []
    for member, role in sorted(selected.items()):
        content = archive_members[member]
        pinned = source['members'].get(member)
        if not isinstance(pinned, dict) or set(pinned) != {'size', 'sha256'} or type(pinned['size']) is not int or pinned['size'] != len(content) or pinned['sha256'] != hashlib.sha256(content).hexdigest() or content != data[role]:
            raise ValueError('Publisher source member differs from its original archive: ' + member)
        if role.startswith('license:'):
            if sources[role]['label'] != licenses[member] or not content.strip():
                raise ValueError('Publisher license File ownership/text differs')
            texts.append({'path': member, 'label': licenses[member], 'size': len(content),
                          'sha256': pinned['sha256'], 'text': content.decode('utf8')})
    if inputs.read_regular(root, 'Cargo.toml.orig', require_text=False) != data['manifest']:
        raise ValueError('Published crate original manifest differs from its recorded Git source')
    original_metadata, _ = effective(data['manifest'], data['workspace_manifest'])
    if any(original_metadata[name] != package[name] for name in ['name', 'version', 'license', 'repository']):
        raise ValueError('Original publisher manifest identity differs from the selected crate')
    return texts, {'source': entry['source'], 'commit': source['commit'], 'path_in_vcs': entry['vcs_path'],
                   'files': [facts[role] for role in sorted(facts)]}


def maintained_patch(package, root, sources, workspace_license, inputs):
    """Bind one maintained build.rs patch to its original crate and compiler File."""
    if not isinstance(sources, dict) or set(sources) != {'archive', 'patch', 'source', 'vcs'}:
        raise ValueError('Maintained build.rs patch lacks its original File closure')
    facts = {role: file_fact(value, inputs) for role, value in sources.items()}
    data = {role: declared_bytes(value['input'], inputs) for role, value in sources.items()}
    if any(facts[role]['sha256'] != hashlib.sha256(content).hexdigest() or facts[role]['size'] != len(content) for role, content in data.items()):
        raise ValueError('Maintained patch File changed during collection')
    if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index' or facts['archive']['sha256'] != package['archive_checksum']:
        raise ValueError('Maintained patch original crate checksum differs')
    if not sources['patch']['label'].startswith('//'):
        raise ValueError('Maintained patch is not an authored workspace File')
    prefix = package['name'] + '-' + package['version']
    wanted = {prefix + '/' + name for name in ['build.rs', 'Cargo.toml', '.cargo_vcs_info.json']}
    originals, names = {}, set()
    with tarfile.open(fileobj=io.BytesIO(data['archive']), mode='r:gz') as archive:
        for member in archive:
            name = member.name
            logical = PurePosixPath(name)
            if logical.is_absolute() or '..' in logical.parts or str(logical) != name or name in names:
                raise ValueError('Maintained patch original archive member is invalid or duplicated')
            names.add(name)
            if name in wanted:
                if not member.isfile():
                    raise ValueError('Maintained patch original member is not an ordinary File')
                originals[name] = archive.extractfile(member).read()
    if set(originals) != wanted or originals[prefix + '/Cargo.toml'] != inputs.read_regular(root, 'Cargo.toml') or originals[prefix + '/.cargo_vcs_info.json'] != data['vcs']:
        raise ValueError('Maintained patch original manifest/VCS member differs')
    if data['source'] != inputs.read_regular(root, 'build.rs', require_text=False) or data['vcs'] != inputs.read_regular(root, '.cargo_vcs_info.json', require_text=False):
        raise ValueError('Maintained patch source/VCS differs from its selected package')
    vcs = json.loads(data['vcs'])
    if not isinstance(vcs, dict) or set(vcs) != {'git', 'path_in_vcs'} or not isinstance(vcs['git'], dict) or set(vcs['git']) != {'sha1'} or not re.fullmatch('[0-9a-f]{40}', vcs['git']['sha1']):
        raise ValueError('Maintained patch original VCS revision is invalid')
    original = originals[prefix + '/build.rs']
    lines = data['patch'].splitlines(keepends=True)
    member = 'registry/' + prefix + '/build.rs'
    if lines[:2] != [('--- a/' + member + '\n').encode(), ('+++ b/' + member + '\n').encode()]:
        raise ValueError('Maintained patch targets another original member')
    old, output, cursor, position, hunks = original.splitlines(keepends=True), [], 0, 2, 0
    while position < len(lines):
        header = re.fullmatch(rb'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n', lines[position])
        if header is None:
            raise ValueError('Maintained patch has an invalid hunk header')
        start, count, new_start, new_count = [int(value) if value is not None else 1 for value in header.groups()]
        start -= 1
        if start < cursor or start > len(old):
            raise ValueError('Maintained patch original hunk overlaps or escapes')
        output.extend(old[cursor:start])
        cursor = start
        if new_start != len(output) + 1:
            raise ValueError('Maintained patch new hunk location differs')
        position += 1
        consumed, produced = 0, 0
        while position < len(lines) and not lines[position].startswith(b'@@ '):
            line = lines[position]
            if line[:1] not in {b' ', b'+', b'-'}:
                raise ValueError('Maintained patch contains unsupported member metadata')
            if line[:1] != b'+':
                if cursor >= len(old) or old[cursor] != line[1:]:
                    raise ValueError('Maintained patch does not match exact original member bytes')
                cursor += 1
                consumed += 1
            if line[:1] != b'-':
                output.append(line[1:])
                produced += 1
            position += 1
        if (consumed, produced) != (count, new_count):
            raise ValueError('Maintained patch hunk member counts differ')
        hunks += 1
    output.extend(old[cursor:])
    if not hunks or b''.join(output) != data['source'] or data['source'] == original:
        raise ValueError('Actual compiler source differs from the maintained original patch')
    license = file_fact({'input': str(workspace_license), 'label': '//:LICENSE'}, inputs)
    license_bytes = declared_bytes(str(workspace_license), inputs)
    if not license_bytes.strip() or license['sha256'] != hashlib.sha256(license_bytes).hexdigest():
        raise ValueError('Maintained workspace patch license changed')
    return {'files': facts, 'original': {'member': prefix + '/build.rs', 'size': len(original), 'sha256': hashlib.sha256(original).hexdigest()},
            'revision': vcs['git']['sha1'], 'path_in_vcs': vcs['path_in_vcs'], 'license': 'AGPL-3.0-only', 'license_file': license}, {
                'path': sources['patch']['label'] + ' -> LICENSE', 'label': '//:LICENSE', 'size': len(license_bytes),
                'sha256': license['sha256'], 'text': license_bytes.decode('utf8')}


def validate_compiler_graph(descriptor, records, root, target, profile_flags, manifests, custom_cfg, source_patches=None):
    """Compare configured compiler attributes, not only the descriptor's name."""
    if descriptor.get('roots') != [root] or descriptor.get('configuration', {}).get('target') != target:
        raise ValueError('Compiled Rust root differs from the original release descriptor')
    actual = {}
    for value in records:
        record = json.loads(value) if isinstance(value, str) else value
        if not isinstance(record, dict) or record.get('unit') in actual:
            raise ValueError('Duplicate or invalid configured compiler unit')
        actual[record['unit']] = record
    expected = descriptor.get('units')
    if not isinstance(expected, dict) or set(actual) != set(expected):
        raise ValueError('Actual compiler graph differs from the selected Cargo closure')
    for identity, unit in expected.items():
        supplied = actual[identity]
        dependencies = [edge['unit'] for edge in unit['dependencies']]
        if supplied.get('dependencies') != sorted(dependencies) or supplied.get('features') != sorted(unit['features']):
            raise ValueError('Compiled Rust dependency or feature configuration differs')
        package = descriptor['packages'][unit['pkg_id']]
        manifest = manifests[unit['pkg_id']]
        directory = Path(manifest).parent.as_posix()
        cargo = {'CARGO_PKG_NAME': package['name'], 'CARGO_PKG_AUTHORS': ':'.join(package.get('authors', [])),
                 'CARGO_PKG_DESCRIPTION': package.get('description') or '',
                 'CARGO_PKG_HOMEPAGE': package.get('homepage') or '',
                 'CARGO_PKG_REPOSITORY': package.get('repository') or '',
                 'CARGO_PKG_LICENSE': package.get('license') or '',
                 'CARGO_PKG_RUST_VERSION': package.get('rust_version') or ''}
        environment = {**cargo, **unit.get('compiler_env', {})}
        compiler = supplied.get('compiler')
        if compiler != {'version': unit['compiler'], 'target': unit['platform'] or unit['execution_host']}:
            raise ValueError('Actual declared compiler version or platform differs')
        if supplied.get('version') != package['version']:
            raise ValueError('Compiled Rust package version differs')
        if unit['mode'] == 'run-custom-build':
            if supplied.get('rule') != 'cargo_build_script' or supplied.get('package_name') != package['name']:
                raise ValueError('Original Cargo build-script producer differs')
            environment.update(custom_cfg(unit['rust_flags']))
            if source_patches and unit['pkg_id'] in source_patches:
                if package['name'] != 'wasm-bindgen-shared':
                    raise ValueError('Unknown maintained build-script revision environment')
                environment['MERKUR_WASM_BINDGEN_REVISION'] = source_patches[unit['pkg_id']]['revision']
            environment.update({'CARGO_MANIFEST_DIR': directory,
                                'OPT_LEVEL': unit['profile']['opt_level'],
                                'PROFILE': 'release' if unit['profile']['name'] == 'release' else 'debug',
                                'DEBUG': 'false' if unit['profile']['debuginfo'] == 0 else 'true'})
            if supplied.get('environment') != environment or supplied.get('rundir') != directory:
                raise ValueError('Actual build-script environment or source directory differs')
            if supplied.get('rustc_flags') != unit['rust_flags']:
                raise ValueError('Actual build-script target flags differ')
            continue
        if unit['mode'] != 'build' or supplied.get('crate_name') != unit['target']['name'].replace('-', '_') or supplied.get('edition') != unit['target']['edition']:
            raise ValueError('Actual compiler crate identity differs')
        crate_type = ('cdylib' if unit['emit_cdylib'] else 'proc-macro' if 'proc-macro' in unit['target']['kind']
                      else 'bin' if 'bin' in unit['target']['crate_types'] or 'custom-build' in unit['target']['kind'] else 'rlib')
        if supplied.get('crate_type') != crate_type:
            raise ValueError('Actual compiler crate type differs')
        flags = supplied.get('rustc_flags')
        base = profile_flags(unit['profile'])
        if not isinstance(flags, list) or flags[:len(base)] != base:
            raise ValueError('Actual compiler profile differs from the selected Cargo unit')
        rest = flags[len(base):]
        check_cfg = '--check-cfg=cfg(feature,values(' + ','.join(json.dumps(feature) for feature in sorted(package['features'])) + '))'
        required = [check_cfg] + unit['rust_flags']
        expected_flags = required + ([] if supplied.get('lint_config') is not None else ['--cap-lints=allow'])
        if rest != expected_flags:
            raise ValueError('Actual compiler flags differ from the selected Cargo unit')
        aliases = {edge['unit']: edge['extern_crate_name'] for edge in unit['dependencies']
                   if expected[edge['unit']]['mode'] != 'run-custom-build'}
        if supplied.get('aliases') != aliases:
            raise ValueError('Actual compiler dependency alias differs')
        environment['CARGO_MANIFEST_DIR'] = '$${pwd}/' + directory
        if supplied.get('environment') != environment:
            raise ValueError('Actual compiler environment differs')
        original_manifest = package.get('manifest')
        relative = Path(unit['target']['src_path'])
        if original_manifest is not None:
            relative = relative.relative_to(Path(original_manifest).parent)
        if supplied.get('root') != (Path(manifest).parent / relative).as_posix():
            raise ValueError('Actual crate root differs from its original source package')
    selected = expected[root]
    crate_type = actual[root].get('crate_type')
    wasm = target == 'wasm32-unknown-unknown'
    kinds = selected['target']['kind']
    allowed = (selected['emit_cdylib'] and crate_type == 'cdylib' if wasm else
               crate_type == 'bin' and selected['target']['crate_types'] == ['bin'] or
               crate_type == 'proc-macro' and kinds == ['proc-macro'])
    if selected['mode'] != 'build' or selected['profile']['name'] != 'release' or not allowed:
        raise ValueError('Rust attribution requires its actual release binary, proc-macro or WASM cdylib')
    return actual


def load_compiled_modules():
    """Load only the explicitly declared producer helpers under isolated Python."""
    def load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    directory = Path(__file__).absolute().parent
    rust = directory.parent / 'rust'
    for name in ['configured_parity', 'license_metadata', 'native_receipts']:
        load(name, rust / (name + '.py'))
    return load('declared_compiler_units', rust / 'units.py'), load('rust-notices', directory / 'rust-notices.py'), load('license-closure', directory / 'license-closure.py'), load('linked_stock_stdlib', rust / 'stdlib_attribution.py')


def declared_bytes(value, inputs):
    """Resolve Bazel's input carrier, then read the admitted ordinary File."""
    if not isinstance(value, str) or not value:
        raise ValueError('Missing declared compiler input')
    physical = Path(value).resolve(strict=True)
    return inputs.read_regular(physical.parent, physical.name, require_text=False)


def file_fact(value, inputs):
    if not isinstance(value, dict) or set(value) != {'input', 'label'}:
        raise ValueError('Invalid declared Rust input File')
    content = declared_bytes(value['input'], inputs)
    return {'path': value['input'], 'label': value['label'], 'size': len(content),
            'sha256': hashlib.sha256(content).hexdigest()}


def compiler_input_facts(records, inputs, configuration):
    """Retain actual Files while comparing sandbox Trees to their original producer."""
    specification = importlib.util.spec_from_file_location(
        'compiled_input_custody', Path(__file__).absolute().with_name('deployment-pack.py'))
    deployment = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(deployment)
    owned = deployment.DeclaredInputs()
    facts, admitted = {}, set()
    try:
        namespace = deployment.original_namespace(configuration, owned)
        for record in records.values():
            for value in record['inputs']:
                if not isinstance(value, dict) or set(value) != {'input', 'label', 'tree'}:
                    raise ValueError('Invalid actual compiler input record')
                if type(value['tree']) is not bool:
                    raise ValueError('Invalid compiler input kind')
                admission = (value['input'], value['label'], value['tree'])
                if admission in admitted:
                    continue
                admitted.add(admission)
                if not value['tree']:
                    fact = file_fact({key: value[key] for key in ['input', 'label']}, inputs)
                    key = (fact['path'], fact['label'])
                    if key in facts and facts[key] != fact:
                        raise ValueError('Compiler input changed during source collection')
                    facts[key] = fact
                    continue
                entries = deployment.declared_tree(
                    {key: value[key] for key in ['input', 'label']}, 'compiler', namespace, owned,
                    allow_empty=True)
                for name, (_, pinned, size) in sorted(entries.items()):
                    member = name[len('compiler/'):]
                    content = owned.read(pinned)
                    fact = {'path': value['input'] + '/' + member, 'label': value['label'],
                            'size': size, 'sha256': hashlib.sha256(content).hexdigest()}
                    key = (fact['path'], fact['label'])
                    if key in facts and facts[key] != fact:
                        raise ValueError('Generated compiler input changed during source collection')
                    facts[key] = fact
        owned.verify()
        return [facts[key] for key in sorted(facts)]
    finally:
        owned.close()


def module_linkage(standard, artifact, target, execution_host, records, inputs):
    """Require the existing same-action stdlib callback's concrete link inventory."""
    linkage = standard.get('linkage')
    if (not isinstance(linkage, dict) or linkage.get('kind') != 'linked-stdlib-source-attribution'
            or linkage.get('compiler') != '1.97.1' or linkage.get('target') != target
            or linkage.get('execution_host') != execution_host
            or linkage.get('artifact') != artifact or linkage.get('pending_scopes') != []):
        raise ValueError('Original same-action module/stdlib linkage inventory required')
    if not standard.get('sources') or not standard.get('components'):
        raise ValueError('Original linked stdlib source/license closure required')
    for name in ('rustc', 'link_map', 'source_archive', 'stdlib_archive', 'rustc_archive', 'graph'):
        fact = linkage.get(name)
        if not isinstance(fact, dict) or set(fact) != {'path', 'label', 'size', 'sha256'}:
            raise ValueError('Original compiler/linker/source File custody required')
        if file_fact({'input': fact['path'], 'label': fact['label']}, inputs) != fact:
            raise ValueError('Original module linker/compiler/source File changed')
    selected = linkage.get('selected_stdlib')
    if not isinstance(selected, list) or not selected:
        raise ValueError('Original linked stdlib archive members required')
    declared = {(file['input'], file['label']) for record in records.values() for file in record['stdlib']}
    keys = set()
    for fact in selected:
        if not isinstance(fact, dict) or set(fact) != {'path', 'label', 'size', 'sha256', 'members'}:
            raise ValueError('Original linker-selected stdlib File facts required')
        key = (fact['path'], fact['label'])
        if key not in declared or key in keys or not isinstance(fact['members'], dict) or not fact['members']:
            raise ValueError('Original linked stdlib member is absent or duplicated')
        if ('lib/rustlib/' + target + '/lib/') not in fact['path']:
            raise ValueError('Linked stdlib File differs from its original target namespace')
        current = file_fact({'input': fact['path'], 'label': fact['label']}, inputs)
        if current != {key: value for key, value in fact.items() if key != 'members'}:
            raise ValueError('Original linked stdlib File changed')
        keys.add(key)
    return linkage


def proc_macro_sources(providers, records, closure, inputs):
    """Join every actually loaded host proc-macro to its complete original action."""
    expected = {}
    for identity, record in records.items():
        if record.get('crate_type') != 'proc-macro':
            continue
        artifact = record.get('artifact')
        if not isinstance(artifact, dict) or set(artifact) != {'input', 'label'}:
            raise ValueError('Actual proc-macro compiler output File is required')
        if artifact['label'].rsplit(':', 1)[-1] != 'u_' + identity:
            raise ValueError('Proc-macro artifact differs from its configured compiler unit')
        key = (artifact['input'], artifact['label'])
        if key in expected:
            raise ValueError('Duplicate original proc-macro artifact')
        expected[key] = (identity, record)
    if not isinstance(providers, list):
        raise ValueError('Original host proc-macro attribution list required')
    covered, origins, components = set(), [], {}
    fields = {'producer', 'artifact', 'configuration', 'source_inventory', 'inventory', 'notices'}
    for provider in providers:
        if not isinstance(provider, dict) or set(provider) != fields:
            raise ValueError('Original proc-macro attribution File closure required')
        artifact = file_fact(provider['artifact'], inputs)
        key = (provider['artifact']['input'], provider['artifact']['label'])
        if key not in expected or key in covered or provider['producer'] != artifact['label']:
            raise ValueError('Proc-macro attribution differs from the actual loaded compiler File')
        identity, record = expected[key]
        captures = {name: declared_bytes(provider[name]['input'], inputs)
                    for name in ('configuration', 'source_inventory', 'inventory', 'notices')}
        owners = set()
        for name in captures:
            file_fact(provider[name], inputs)
            owners.add(provider[name]['label'])
        if len(owners) != 1:
            raise ValueError('Proc-macro notice outputs differ from their original attribution action')
        configuration, source, inventory = [json.loads(captures[name]) for name in
                                            ('configuration', 'source_inventory', 'inventory')]
        pending = [identity]
        selected = set()
        while pending:
            member = pending.pop()
            if member in selected:
                continue
            selected.add(member)
            pending.extend(records[member]['dependencies'])
        original_records = [records[key] for key in sorted(selected)]
        if (configuration.get('kind') != 'configured-native-rust-release'
                or configuration.get('producer') != provider['producer']
                or configuration.get('target') != record['compiler']['target']
                or configuration.get('root') != identity or configuration.get('profile') != 'release'
                or configuration.get('units') != original_records):
            raise ValueError('Proc-macro original compiler configuration differs')
        if (inventory.get('kind') != 'selected-native-rust-attribution'
                or inventory.get('producer') != provider['producer']
                or inventory.get('target') != record['compiler']['target']
                or inventory.get('profile') != 'release' or inventory.get('pending_scopes') != []
                or inventory.get('configuration') != hashlib.sha256(captures['configuration']).hexdigest()
                or inventory.get('source_digest') != hashlib.sha256(captures['source_inventory']).hexdigest()
                or inventory.get('artifacts') != [{**artifact, 'path': Path(artifact['path']).name, 'mode': '0555'}]
                or source.get('producer') != provider['producer']
                or source.get('kind') != 'compiled-rust-source-inventory'
                or not source.get('standard_library') or not source.get('compiler_inputs')
                or not inventory.get('components') or captures['notices'] != closure.render(inventory)):
            raise ValueError('Complete original host proc-macro source/runtime notices required')
        module_linkage({'linkage': source.get('module_linkage'),
                        'sources': source['standard_library'], 'components': inventory['components']}, artifact,
                       record['compiler']['target'], record['compiler']['target'],
                       {key: records[key] for key in selected}, inputs)
        for fact in source['compiler_inputs']:
            actual = file_fact({'input': fact['path'], 'label': fact['label']}, inputs)
            if actual != fact:
                raise ValueError('Original proc-macro compiler source File changed')
        for component in inventory['components']:
            if component['id'] in components and closure.canonical(components[component['id']]) != closure.canonical(component):
                raise ValueError('Conflicting original proc-macro notice component')
            components[component['id']] = component
        origins.append({'artifact': artifact, 'configuration': configuration,
                        'source_inventory': source, 'inventory': file_fact(provider['inventory'], inputs),
                        'notices': file_fact(provider['notices'], inputs)})
        covered.add(key)
    if covered != set(expected):
        raise ValueError('Original host proc-macro attribution omits a loaded compiler artifact')
    return origins, [components[key] for key in sorted(components)]


def collect_compiled(spec, units, notices, closure, stdlib):
    """Reconcile actual compiler inputs/output with the original source notices."""
    required = {'producer', 'artifact', 'descriptor', 'intermediate', 'compiler_root', 'target',
                'units', 'packages', 'stdlib_notices', 'workspace_manifest', 'workspace_license'}
    wasm = isinstance(spec, dict) and spec.get('target') == 'wasm32-unknown-unknown'
    if wasm:
        required.add('proc_macro_notices')
    if not isinstance(spec, dict) or set(spec) != required or not closure.label(spec['producer']):
        raise ValueError('Invalid compiled Rust producer schema')
    descriptor_bytes = declared_bytes(spec['descriptor'], notices.license_inputs)
    descriptor = json.loads(descriptor_bytes)
    package_specs = spec['packages']
    if not isinstance(package_specs, dict) or set(package_specs) != set(descriptor['packages']):
        raise ValueError('Compiled Rust source package closure differs')
    materializations = {}
    package_files = {}
    for identity, package in sorted(package_specs.items()):
        fields = {'source_label', 'manifest_label', 'root', 'manifest', 'files'}
        if not isinstance(package, dict) or not fields.issubset(package) or set(package) - fields - {'publisher_sources', 'source_patches'}:
            raise ValueError('Invalid selected Rust package Files')
        materializations[identity] = {key: package[key] for key in ['root', 'source_label', 'manifest_label']}
        if 'publisher_sources' in package:
            materializations[identity]['publisher_sources'] = package['publisher_sources']
        if 'source_patches' in package:
            materializations[identity]['source_patches'] = package['source_patches']
        facts = [file_fact(value, notices.license_inputs) for value in package['files']]
        if not facts or len({(item['path'], item['label']) for item in facts}) != len(facts):
            raise ValueError('Missing or duplicate original package source File')
        package_files[identity] = sorted(facts, key=lambda value: (value['path'], value['label']))
    original = notices.collect({'descriptor': spec['descriptor'],
                                'compiler_root': descriptor['configuration']['compiler_root'],
                                'target': spec['target'], 'packages': materializations,
                                'workspace_manifest': spec['workspace_manifest'], 'workspace_license': spec['workspace_license']})
    patches = {item['id']: item['source_patch'] for item in original['components'] if 'source_patch' in item}
    records = validate_compiler_graph(descriptor, spec['units'], spec['compiler_root'], spec['target'], units.flags,
                                      {key: value['manifest'] for key, value in package_specs.items()}, units.custom_cfg_env, patches)
    if records[spec['compiler_root']].get('crate_type') == 'proc-macro' and records[spec['compiler_root']].get('artifact') != spec['artifact']:
        raise ValueError('Host proc-macro root differs from its actual compiler output File')
    supplied = json.loads(declared_bytes(spec['intermediate'], notices.license_inputs))
    if closure.canonical(supplied) != closure.canonical(original):
        raise ValueError('Original Rust notices differ from actual declared source bytes')
    artifact = file_fact(spec['artifact'], notices.license_inputs)
    if artifact['label'] != spec['producer'] or not artifact['size']:
        raise ValueError('Selected Rust artifact belongs to another compiler producer')
    physical = Path(spec['artifact']['input']).resolve(strict=True)
    if wasm:
        if not declared_bytes(spec['artifact']['input'], notices.license_inputs).startswith(b'\x00asm\x01\x00\x00\x00'):
            raise ValueError('Selected WASM compiler output requires its original binary module')
    elif not physical.stat().st_mode & 0o111:
        raise ValueError('Selected release compiler output is not executable')
    # The typed standard-library producer must prove actual linked members, not
    # assume that every SDK rlib entered this shipping executable.
    standard = stdlib(spec['stdlib_notices'], artifact, spec['target'], records, notices.license_inputs)
    linked = None
    if wasm or records[spec['compiler_root']].get('crate_type') == 'proc-macro':
        linked = module_linkage(standard, artifact, spec['target'],
                                descriptor['units'][spec['compiler_root']]['execution_host'],
                                records, notices.license_inputs)
    artifact['path'] = Path(spec['artifact']['input']).name
    artifact['mode'] = '0444' if wasm else '0555'
    configuration = {'kind': 'configured-wasm-rust-release' if wasm else 'configured-native-rust-release', 'producer': spec['producer'],
                     'target': spec['target'], 'profile': 'release', 'root': spec['compiler_root'],
                     'descriptor_sha256': hashlib.sha256(descriptor_bytes).hexdigest(),
                     'units': [records[key] for key in sorted(records)]}
    source = {'kind': 'compiled-rust-source-inventory', 'producer': spec['producer'],
              'packages': package_files, 'compiler_inputs': compiler_input_facts(records, notices.license_inputs, spec['intermediate']),
              'workspace': [file_fact({'input': spec[key], 'label': '//:' + name}, notices.license_inputs)
                            for key, name in [('workspace_manifest', 'Cargo.toml'), ('workspace_license', 'LICENSE')]],
              'standard_library': standard['sources']}
    if linked is not None:
        source['module_linkage'] = linked
    publishers = {item['id']: item['publisher_source'] for item in original['components'] if 'publisher_source' in item}
    if publishers:
        source['publisher_sources'] = publishers
    for patch in patches.values():
        actual = patch['files']['source']
        if not any(fact['path'] == actual['path'] and fact['size'] == actual['size'] and fact['sha256'] == actual['sha256'] for fact in source['compiler_inputs']):
            raise ValueError('Maintained patched source File is absent from actual compiler inputs')
    if patches:
        source['source_patches'] = patches
    host_components = []
    if wasm:
        source['host_proc_macros'], host_components = proc_macro_sources(
            spec['proc_macro_notices'], records, closure, notices.license_inputs)
    configuration_bytes, source_bytes = closure.canonical(configuration), closure.canonical(source)
    components = original['components'] + standard['components']
    if len({item['id'] for item in components}) != len(components):
        raise ValueError('Compiled attribution repeats a component identity')
    if wasm:
        merged = {item['id']: item for item in components}
        for component in host_components:
            if component['id'] in merged and closure.canonical(merged[component['id']]) != closure.canonical(component):
                raise ValueError('Conflicting module and host proc-macro notice component')
            merged[component['id']] = component
        components = [merged[key] for key in sorted(merged)]
    inventory = {'kind': 'selected-wasm-rust-attribution' if wasm else 'selected-native-rust-attribution', 'producer': spec['producer'],
                 'target': spec['target'], 'profile': 'release', 'pending_scopes': [],
                 'configuration': hashlib.sha256(configuration_bytes).hexdigest(),
                 'source_digest': hashlib.sha256(source_bytes).hexdigest(),
                 'artifacts': [artifact], 'components': components}
    return configuration_bytes, source_bytes, closure.canonical(inventory), closure.render(inventory)


if __name__ == '__main__':
    if len(sys.argv) != 7 or sys.argv[1] != '--compiled':
        raise SystemExit('Expected --compiled INPUTS CONFIGURATION SOURCES INVENTORY NOTICES')
    units, notices, closure, standard = load_compiled_modules()
    value = json.loads(declared_bytes(sys.argv[2], notices.license_inputs))
    payloads = collect_compiled(value, units, notices, closure, standard.collect_compiled_stdlib)
    notices.publish_bytes([(Path(path), content) for path, content in zip(sys.argv[3:], payloads, strict=True)])
