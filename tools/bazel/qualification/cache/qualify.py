"""Qualify real Bazel test-cache revocation with independent, isolated clients.

This fixture proves cache primitives, not production ledger/controller admission.
Hosted qualification requires the existing local credential File/helper. Disk
qualification is an explicit separate mode and is never reported as hosted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import subprocess
import time
from urllib.parse import unquote, urlparse


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def reserve(root, prefix):
    nonce = prefix + secrets.token_hex(32)[1:]
    bank = root / 'epochs' / nonce
    bank.mkdir(parents=True)
    with (bank / 'probe.nonce').open('x') as stream:
        stream.write(nonce + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    (bank / 'BUILD.bazel').write_text(
        'load("@merkur//tools/bazel/verification:test-nonce.bzl", "test_epochs")\n'
        'test_epochs(name = "epochs", nonces = {":probe.nonce": "//:probe"}, visibility = ["//visibility:public"])\n')
    (bank / 'WORKSPACE').write_text('')
    directory = os.open(bank, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    assert (bank / 'probe.nonce').read_text() == nonce + '\n'
    return nonce, bank


def events(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def result(path):
    results = [event['testResult'] for event in events(path) if 'testResult' in event]
    if len(results) != 1:
        raise ValueError('Exactly one genuine Bazel TestRunner result required')
    return results[0]


def execution(path):
    remaining = Path(path).read_text().strip()
    decoder = json.JSONDecoder()
    records = []
    while remaining:
        record, length = decoder.raw_decode(remaining)
        records.append(record)
        remaining = remaining[length:].strip()
    return records


def snapshot_result(row, nonce, directory):
    outputs = [item for item in row.get('testActionOutput', []) if item.get('name') == 'test.log']
    if len(outputs) != 1:
        raise ValueError('Exactly one genuine engine test log required')
    uri = urlparse(outputs[0]['uri'])
    if uri.scheme != 'file' or uri.netloc:
        raise ValueError('Cache fixture requires its actual local TestRunner output File')
    data = Path(unquote(uri.path)).read_bytes()
    (directory / 'test.log').write_bytes(data)
    observed = [line for line in data.decode().splitlines() if line.startswith('QUALIFICATION_NONCE=')]
    if observed != ['QUALIFICATION_NONCE=' + nonce]:
        raise ValueError('Actual test output does not prove its selected epoch ran')
    return hashlib.sha256(data).hexdigest()


def cached(row):
    return row.get('cachedLocally', False) or row.get('executionInfo', {}).get('cachedRemotely', False)


def wait_marker(marker, process):
    deadline = time.monotonic() + 45
    while not marker.is_file():
        if process.poll() is not None:
            raise RuntimeError('Bazel exited before its actual test barrier')
        if time.monotonic() >= deadline:
            raise RuntimeError('Actual test barrier was not observed during this attempt')
        time.sleep(.02)


class Fixture:
    def __init__(self, options):
        self.options = options
        self.root = options.output.resolve()
        if self.root.exists():
            raise ValueError('Qualification output must be a new owned directory')
        self.root.mkdir(parents=True)
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.barriers = self.root / 'barriers'
        self.barriers.mkdir()
        self.environment = {'PATH': '/__no_ambient_cache_qualification_tools__',
                            'HOME': str(self.root), 'TMPDIR': str(self.root),
                            'DYLD_FALLBACK_LIBRARY_PATH': str(options.shell.parent.parent / 'lib')}
        for name in ('bazel', 'python', 'shell'):
            tool = getattr(options, name)
            if not tool.is_absolute() or not tool.is_file() or not os.access(tool, os.X_OK):
                raise ValueError('Exact declared executable File required: ' + name)
        self.tool_namespace = self.root / 'test-tools'
        self.tool_namespace.mkdir()
        selected = {'bash': options.shell}
        core = ('whoami', 'dirname', 'mkdir', 'date', 'sort', 'cat', 'rm')
        build = ('sed', 'find', 'grep')
        for sdk, names in ((options.core_utils_sdk, core), (options.build_utils_sdk, build)):
            if not sdk.is_absolute() or not sdk.is_dir():
                raise ValueError('Exact original utility SDK directory required')
            for name in names:
                selected[name] = sdk / 'bin' / name
        for name, tool in selected.items():
            if not tool.is_file() or not os.access(tool, os.X_OK):
                raise ValueError('Required declared TestRunner tool is missing: ' + name)
            (self.tool_namespace / name).symlink_to(tool.resolve(strict=True))
        (self.tool_namespace / 'WORKSPACE').write_text('')
        (self.tool_namespace / 'BUILD.bazel').write_text(
            'filegroup(name = "runtime", srcs = glob(["*"], exclude = ["BUILD.bazel", "WORKSPACE"]), visibility = ["//visibility:public"])\n')
        self.selected_tools = {name: {'input': str(tool.resolve(strict=True)), 'sha256': sha(tool)}
                               for name, tool in selected.items()}
        self.source = Path(__file__).resolve().parent
        package = self.workspace / 'tools/bazel/qualification/cache'
        package.mkdir(parents=True)
        for name in ('fixture.bzl', 'probe.py', 'generate.py'):
            shutil.copyfile(self.source / name, package / name)
        (package / 'BUILD.bazel').write_text('exports_files(["fixture.bzl", "probe.py", "generate.py"])\n')
        nonce_rule = self.workspace / 'tools/bazel/verification'
        nonce_rule.mkdir(parents=True)
        shutil.copyfile(options.nonce_rule, nonce_rule / 'test-nonce.bzl')
        (nonce_rule / 'BUILD.bazel').write_text('exports_files(["test-nonce.bzl"])\n')
        first, self.initial_bank = reserve(self.root, 'a')
        self.initial_nonce = first
        python_sdk = options.python.parent.parent
        (self.workspace / 'MODULE.bazel').write_text(
            'module(name = "merkur")\n'
            'local_repository = use_repo_rule("@bazel_tools//tools/build_defs/repo:local.bzl", "local_repository")\n'
            'local_repository(name = "qualification_python", path = ' + json.dumps(str(python_sdk)) + ')\n'
            'local_repository(name = "qualification_shell", path = ' + json.dumps(str(options.shell.parent.parent)) + ')\n'
            'local_repository(name = "qualification_test_tools", path = ' + json.dumps(str(self.tool_namespace)) + ')\n'
            'local_repository(name = "qualification_core_utilities", path = ' + json.dumps(str(options.core_utils_sdk)) + ')\n'
            'local_repository(name = "qualification_build_utilities", path = ' + json.dumps(str(options.build_utils_sdk)) + ')\n'
            'local_repository(name = "verification_revocations", path = ' + json.dumps(str(self.initial_bank)) + ')\n')
        (self.workspace / 'BUILD.bazel').write_text(
            'load("//tools/bazel/qualification/cache:fixture.bzl", "cache_probe_test")\n'
            'cache_probe_test(name = "probe", python = "@qualification_python//:bin/python3", '
            'python_sdk = "@qualification_python//:runtime", shell_sdk = "@qualification_shell//:runtime", utility_sdks = ["@qualification_core_utilities//:runtime", "@qualification_build_utilities//:runtime"], tool_namespace = "@qualification_test_tools//:runtime", python_absolute = ' + json.dumps(str(options.python)) +
            ', barriers = ' + json.dumps(str(self.barriers)) + ')\n')
        self.cache_flags = []
        if options.cache_kind == 'hosted':
            if options.auth_file is None or not options.auth_file.is_absolute() or not options.auth_file.is_file():
                raise ValueError('Hosted cache requires the existing explicit local credential File')
            if options.credential_source is None or not options.credential_source.is_absolute() or not options.credential_source.is_file():
                raise ValueError('Hosted cache requires the original declared credential helper source File')
            if options.bun is None or not options.bun.is_absolute() or not options.bun.is_file():
                raise ValueError('Hosted credential helper requires the declared Bun File')
            helper = self.root / 'credential-helper'
            helper.write_text('#!' + str(options.shell) + '\nexec ' + shlex.join([
                str(options.bun), '--no-install', '--no-env-file', str(options.credential_source), 'get']) + '\n')
            helper.chmod(0o700)
            self.environment['MERKUR_BUILDBUDDY_AUTH_FILE'] = str(options.auth_file)
            self.cache_flags = ['--remote_cache=grpcs://remote.buildbuddy.io',
                                '--credential_helper=remote.buildbuddy.io=' + str(helper),
                                '--remote_timeout=60', '--remote_upload_local_results=true']
        else:
            self.cache_flags = ['--disk_cache=' + str(self.root / 'shared-cache')]
        self.records = []
        self.running = []

    def command(self, client, bank, name, command='test', extra=()):
        directory = self.root / name
        directory.mkdir()
        argv = [str(self.options.bazel), '--batch', '--nosystem_rc', '--noworkspace_rc', '--nohome_rc',
                '--output_base=' + str(self.root / ('client-' + client)), command, '//:probe',
                '--override_repository=verification_revocations=' + str(bank), '--color=no', '--curses=no',
                '--shell_executable=' + str(self.options.shell)]
        if command == 'test':
            argv += self.cache_flags + ['--test_output=all', '--test_timeout=60', '--test_env=PATH=' + str(self.tool_namespace), '--test_env=DYLD_FALLBACK_LIBRARY_PATH=' + str(self.options.shell.parent.parent / 'lib'),
                                       '--build_event_json_file=' + str(directory / 'events.json'),
                                       '--execution_log_json_file=' + str(directory / 'execution.json')]
        else:
            argv += ['--output=jsonproto']
        argv += list(extra)
        output, errors = (directory / 'stdout').open('w'), (directory / 'stderr').open('w')
        process = subprocess.Popen(argv, cwd=self.workspace, env=self.environment,
                                   stdout=output, stderr=errors, start_new_session=True)
        invocation = (process, directory, output, errors, (bank / 'probe.nonce').read_text().strip())
        self.running.append(invocation)
        return invocation

    def finish(self, invocation, expected=None):
        process, directory, output, errors, nonce = invocation
        try:
            code = process.wait(timeout=90)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError('Bazel did not complete normally during this attempt')
        finally:
            output.close()
            errors.close()
        if expected is not None and code != expected:
            raise RuntimeError('Unexpected actual Bazel exit for ' + directory.name + ': ' + str(code))
        self.running.remove(invocation)
        record = {'name': directory.name, 'exitCode': code, 'nonce': nonce}
        if (directory / 'events.json').exists():
            rows = [event['testResult'] for event in events(directory / 'events.json') if 'testResult' in event]
            if not rows and expected is None and code != 0:
                record.update(status='NO_TEST_RESULT', cached=False)
            else:
                row = result(directory / 'events.json')
                record.update(status=row.get('status'), cached=cached(row), executionInfo=row.get('executionInfo', {}),
                              testLogSha256=snapshot_result(row, nonce, directory))
            if (directory / 'execution.json').is_file():
                actions = execution(directory / 'execution.json')
                test = [action for action in actions if action.get('mnemonic') == 'TestRunner' and
                        any(argument.endswith('/probe.test') for argument in action.get('commandArgs', []))]
                if len(test) != 1 and expected is not None:
                    raise ValueError('Exactly one genuine test spawn cache digest required')
                if test:
                    record['testActionDigest'] = test[0]['digest']['hash']
                    record['testInputNonces'] = [item for item in test[0].get('inputs', []) if item['path'].endswith('/probe.nonce')]
        self.records.append(record)
        return record

    def cleanup(self):
        for process, directory, output, errors, nonce in self.running:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGINT)
                try:
                    process.wait(timeout=45)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise RuntimeError('Owned qualification client could not retire normally')
            output.close()
            errors.close()
        self.running.clear()

    def key(self, client, bank, name):
        invocation = self.command(client, bank, name, 'aquery')
        self.finish(invocation, 0)
        document = json.loads((invocation[1] / 'stdout').read_text())
        keys = [action['actionKey'] for action in document.get('actions', []) if action['mnemonic'] == 'CacheQualificationBinary']
        if len(keys) != 1:
            raise ValueError('Exactly one genuine binary producer action key required')
        return keys[0]

    def qualify(self):
        initial_key = self.key('a', self.initial_bank, 'initial-binary-key')
        first = self.finish(self.command('a', self.initial_bank, 'first-pass'), 0)
        assert first['status'] == 'PASSED' and not first['cached'], first
        shared = self.finish(self.command('b', self.initial_bank, 'independent-shared-pass'), 0)
        assert shared['status'] == 'PASSED' and shared['executionInfo'].get('cachedRemotely'), shared
        assert shared['testActionDigest'] == first['testActionDigest']
        failed_nonce, failed_bank = reserve(self.root, 'f')
        assert self.key('b', failed_bank, 'failed-binary-key') == initial_key
        failed = self.finish(self.command('b', failed_bank, 'forced-failure'), 3)
        assert failed['status'] == 'FAILED' and not failed['cached'], failed
        assert failed['testActionDigest'] != first['testActionDigest']
        local = self.finish(self.command('b', failed_bank, 'failure-local-retry'), 3)
        remote = self.finish(self.command('a', failed_bank, 'failure-independent-retry'), 3)
        assert local['status'] == remote['status'] == 'FAILED'
        assert local['testActionDigest'] == remote['testActionDigest'] == failed['testActionDigest']
        old_nonce, old_bank = reserve(self.root, 'b')
        older = self.command('a', old_bank, 'old-inflight-pass')
        wait_marker(self.barriers / (old_nonce + '.started'), older[0])
        race_nonce, race_bank = reserve(self.root, 'f')
        raced = self.finish(self.command('b', race_bank, 'new-epoch-fails-before-old-upload'), 3)
        assert raced['status'] == 'FAILED'
        (self.barriers / (old_nonce + '.release')).write_text('release original old run')
        old = self.finish(older, 0)
        assert old['status'] == 'PASSED'
        reused = self.finish(self.command('b', old_bank, 'old-key-remains-cached'), 0)
        assert reused['status'] == 'PASSED' and reused['executionInfo'].get('cachedRemotely'), reused
        assert reused['testActionDigest'] == old['testActionDigest']
        after = self.finish(self.command('a', race_bank, 'new-epoch-after-old-upload'), 3)
        assert after['status'] == 'FAILED', after
        assert after['testActionDigest'] == raced['testActionDigest'] != old['testActionDigest']
        cancel_nonce, cancel_bank = reserve(self.root, 'c')
        cancelled = self.command('a', cancel_bank, 'forced-cancellation')
        wait_marker(self.barriers / (cancel_nonce + '.started'), cancelled[0])
        os.killpg(cancelled[0].pid, signal.SIGINT)
        cancellation = self.finish(cancelled)
        assert cancellation['exitCode'] != 0 and cancellation.get('status') != 'PASSED'
        (self.barriers / (cancel_nonce + '.started')).unlink()
        retry = self.command('b', cancel_bank, 'cancelled-independent-retry')
        wait_marker(self.barriers / (cancel_nonce + '.started'), retry[0])
        (self.barriers / (cancel_nonce + '.release')).write_text('complete the freshly observed retry')
        retried = self.finish(retry, 0)
        assert retried['status'] == 'PASSED' and not retried['cached'], retried
        assert self.key('b', cancel_bank, 'cancelled-binary-key') == initial_key
        report = {'cacheKind': self.options.cache_kind, 'qualified': True,
                  'scope': 'Actual Bazel cache primitive; private epochs, no production controller/ledger admission',
                  'binaryActionKey': initial_key, 'sourceSha256': {p.name: sha(p) for p in self.source.iterdir() if p.is_file()},
                  'nonceRuleSha256': sha(self.options.nonce_rule), 'selectedTools': self.selected_tools,
                  'invocations': self.records}
        (self.root / 'qualification.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('output', 'bazel', 'python', 'shell', 'nonce-rule', 'core-utils-sdk', 'build-utils-sdk'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--cache-kind', choices=['disk', 'hosted'], required=True)
    for name in ('auth-file', 'bun', 'credential-source'):
        parser.add_argument('--' + name, type=Path)
    options = parser.parse_args()
    fixture = Fixture(options)
    try:
        fixture.qualify()
    finally:
        fixture.cleanup()


if __name__ == '__main__':
    main()
