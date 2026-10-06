"""Exercise the original build controller, then compile without running identity code."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile


FIXTURE = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char** argv) {
  FILE* log = fopen(getenv("CONTROL_LOG"), "a");
  if (!log) return 8;
  fprintf(log, "%s\n", argv[0]);
  char* frontend = getenv("SWIFT_DRIVER_SWIFT_FRONTEND_EXEC");
  fprintf(log, "frontend=%s\n", frontend ? frontend : "");
  char* epoch = getenv("ZERO_AR_DATE");
  fprintf(log, "zero_ar_date=%s\n", epoch ? epoch : "");
  for (int i=1;i<argc;i++) fprintf(log, "arg=%s\n", argv[i]);
  fclose(log);
  if (getenv("CONTROL_FAIL")) return 13;
  if (argc>2 && strcmp(argv[1],"crs")==0) {
    FILE* archive=fopen(argv[2],"w"); if(!archive)return 9;
    fputs("declared-archive",archive);fclose(archive);return 0;
  }
  for(int i=1;i<argc-1;i++) if(strcmp(argv[i],"-o")==0) {
    FILE* object=fopen(argv[i+1],"w");if(!object)return 10;
    fputs("declared-object",object);fclose(object);return 0;
  }
  return 11;
}
'''


def input_file(root, logical, executable=False):
    path = Path(logical)
    if path.is_absolute() or not path.parts or '..' in path.parts:
        raise ValueError('Identity control input requires an exact declared runfile')
    path = root / path
    if not path.is_file() or (executable and not os.access(path, os.X_OK)):
        raise ValueError('Identity control declared input File is missing: ' + logical)
    return path


def controller(specification, runfiles, temporary):
    script = input_file(runfiles, specification['build_script'], True)
    compiler = input_file(runfiles, specification['tools']['compiler'], True)
    archiver = input_file(runfiles, specification['tools']['archiver'], True)
    swift = input_file(runfiles, specification['swiftc'], True)
    input_file(runfiles, specification['frontend'], True)
    sdk = runfiles / specification['sdk_runfile_root']
    for value in [specification['sysroot'], specification['toolchain']]:
        path = Path(value)
        if path.is_absolute() or '..' in path.parts or not (sdk / path).is_dir():
            raise ValueError('Identity control requires the original declared SDK directory')
    environment = {'PATH': '', 'HOME': str(temporary), 'TMPDIR': str(temporary), 'LC_ALL': 'C'}

    def flags(values):
        original = specification['sdk_exec_root']
        result = []
        for value in values:
            if value.startswith(original + '/'):
                value = str(sdk) + value[len(original):]
            else:
                for prefix in ['--ld-path=', '--sysroot=', '-fuse-ld=']:
                    if value.startswith(prefix + original + '/'):
                        value = prefix + str(sdk) + value[len(prefix + original):]
                        break
            result.append(value)
        return result

    synthetic_source = temporary / 'controller-fixture.c'
    synthetic_source.write_text(FIXTURE)
    synthetic_tool = temporary / 'controller-fixture'
    subprocess.run([str(compiler), *flags(specification['compile_flags']),
                    *flags(specification['link_flags']), str(synthetic_source), '-o', str(synthetic_tool)],
                   env=environment, check=True, capture_output=True)
    count = 0

    def run(name, override, expected, source=None):
        nonlocal count
        work = temporary / name
        work.mkdir()
        output = work / 'out'
        output.mkdir()
        log = output / 'tools.log'
        env = {**environment, 'CARGO_CFG_TARGET_OS': 'macos', 'CARGO_CFG_TARGET_ARCH': 'aarch64',
               'OUT_DIR': str(output), 'CONTROL_LOG': str(log), 'MERKUR_SWIFTC': str(synthetic_tool),
               'MERKUR_SWIFT_SDK': str(temporary / 'sdk'),
               'MERKUR_SWIFT_TOOLCHAIN': str(temporary / 'toolchain'), 'AR': str(synthetic_tool)}
        for key, value in override.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        if source is not None:
            (work / 'src').mkdir()
            shutil.copyfile(source, work / 'src/macos.swift')
        result = subprocess.run([str(script)], cwd=work, env=env, capture_output=True, text=True)
        if (result.returncode == 0) != expected:
            raise AssertionError((name, result.returncode, result.stdout, result.stderr))
        count += 1
        return output, result, log

    output, _, log = run('nonmac-no-tools', {'CARGO_CFG_TARGET_OS': 'linux', 'MERKUR_SWIFTC': None,
                                           'MERKUR_SWIFT_SDK': None, 'MERKUR_SWIFT_TOOLCHAIN': None,
                                           'AR': None}, True)
    assert not log.exists()
    for key in ['MERKUR_SWIFTC', 'MERKUR_SWIFT_SDK', 'MERKUR_SWIFT_TOOLCHAIN', 'AR']:
        _, result, log = run('missing-' + key, {key: None}, False)
        assert 'requires declared ' + key in result.stderr and not log.exists()
    _, result, log = run('relative-swift', {'MERKUR_SWIFTC': 'swiftc'}, False)
    assert 'requires absolute MERKUR_SWIFTC' in result.stderr and not log.exists()
    output, _, _ = run('declared-compiler-failure', {'CONTROL_FAIL': '1'}, False)
    assert not (output / 'libmerkur_identity_seal.a').exists()
    for arch, triple in [('aarch64', 'arm64'), ('x86_64', 'x86_64')]:
        output, result, log = run('declared-' + arch, {'CARGO_CFG_TARGET_ARCH': arch}, True)
        captured = log.read_text()
        assert 'arg=' + triple + '-apple-macos11.0\n' in captured
        assert 'arg=' + str(temporary / 'sdk') + '\n' in captured
        assert 'arg=' + str(temporary / 'toolchain/lib/swift') + '\n' in captured
        assert 'frontend=' + str(temporary / 'toolchain/bin/swift-frontend') + '\n' in captured
        assert 'arg=-Xfrontend\narg=-disable-incremental-llvm-codegen\n' in captured
        assert 'zero_ar_date=1\narg=crs\n' in captured
        assert (output / 'libmerkur_identity_seal.a').read_text() == 'declared-archive'
        assert all('cargo::rustc-link-lib=framework=' + name in result.stdout
                   for name in ['CryptoKit', 'Foundation', 'Security'])
        assert 'cargo::metadata=swift_runtime_path=/usr/lib/swift' in result.stdout
    assert count == 9

    native_arch, cpu = {'aarch64': ('aarch64', 0x0100000C),
                        'x86_64': ('x86_64', 0x01000007)}[specification['execution_cpu']]
    genuine = {'CARGO_CFG_TARGET_ARCH': native_arch, 'MERKUR_SWIFTC': str(swift),
               'MERKUR_SWIFT_SDK': str(sdk / specification['sysroot']),
               'MERKUR_SWIFT_TOOLCHAIN': str(sdk / specification['toolchain']), 'AR': str(archiver)}
    for role in ['fixture', 'source']:
        source = input_file(runfiles, specification[role])
        facts = []
        for index in range(2):
            output, result, log = run(role + '-' + str(index), genuine, True, source)
            assert not log.exists(), 'Genuine Swift compilation called a synthetic controller tool'
            object_file = output / 'merkur_identity_seal.o'
            archive = output / 'libmerkur_identity_seal.a'
            data = object_file.read_bytes()
            assert len(data) >= 32 and data[:4] == b'\xcf\xfa\xed\xfe'
            assert struct.unpack_from('<I', data, 4)[0] == cpu
            assert archive.read_bytes().startswith(b'!<arch>\n')
            members = subprocess.run([str(archiver), '-t', str(archive)], env=environment,
                                     check=True, capture_output=True, text=True).stdout
            assert members == '__.SYMDEF SORTED\nmerkur_identity_seal.o\n'
            assert 'cargo::rustc-link-lib=static=merkur_identity_seal\n' in result.stdout
            facts.append(tuple(hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in [object_file, archive]))
        assert facts[0] == facts[1], (role, 'Original controller output differs between owned roots', facts)
        print(role + ': genuine unsigned object/archive two-root byte equality; identity code not executed')
    print('PASS original nine compiled identity-controller controls and genuine public Swift compilation')


if __name__ == '__main__':
    specification = json.loads(Path(sys.argv[1]).read_text())
    runfiles = Path(sys.argv[2]).absolute()
    with tempfile.TemporaryDirectory(prefix='merkur-swift-identity-control-') as temporary:
        controller(specification, runfiles, Path(temporary))
