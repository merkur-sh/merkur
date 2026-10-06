"""Reject cache evidence that cannot prove the actual selected epoch executed."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile


def controls(qualifier, candidate):
    specification = importlib.util.spec_from_file_location('cache_qualifier', qualifier)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    candidate = Path(candidate)
    report = json.loads((candidate / 'qualification.json').read_text())
    selected = next(row for row in report['invocations'] if row['name'] == 'cancelled-independent-retry')
    row = module.result(candidate / 'cancelled-independent-retry/events.json')
    with tempfile.TemporaryDirectory(prefix='merkur-cache-metadata-controls-') as temporary:
        root = Path(temporary)
        # The actual untouched engine log is still the client's latest test log.
        digest = module.snapshot_result(row, selected['nonce'], root)
        assert digest == selected['testLogSha256']
        cases = [('wrong selected nonce', row, 'a' * 64)]
        missing = dict(row, testActionOutput=[])
        cases.append(('missing engine test log', missing, selected['nonce']))
        duplicate = dict(row, testActionOutput=row['testActionOutput'] + row['testActionOutput'])
        cases.append(('duplicate engine test log', duplicate, selected['nonce']))
        foreign = copy.deepcopy(row)
        next(item for item in foreign['testActionOutput'] if item['name'] == 'test.log')['uri'] = 'https://example.invalid/test.log'
        cases.append(('foreign test-log authority', foreign, selected['nonce']))
        for name, changed, nonce in cases:
            try:
                module.snapshot_result(changed, nonce, root)
            except ValueError:
                pass
            else:
                raise AssertionError('Cache qualifier admitted ' + name)
    try:
        module.result(candidate / 'forced-cancellation/events.json')
    except ValueError:
        pass
    else:
        raise AssertionError('Interrupted invocation invented a completed test result')
    actions = module.execution(candidate / 'first-pass/execution.json')
    binary = [action for action in actions if action['mnemonic'] == 'CacheQualificationBinary']
    assert len(binary) == 1
    assert not any(item['path'].endswith('/probe.nonce') for item in binary[0]['inputs'])
    tests = [action for action in actions if action['mnemonic'] == 'TestRunner' and
             any(argument.endswith('/probe.test') for argument in action['commandArgs'])]
    assert len(tests) == 1
    assert len([item for item in tests[0]['inputs'] if item['path'].endswith('/probe.nonce')]) == 1
    print('Actual cache evidence controls: genuine log/nonce, four false-pass cases, missing cancelled result, binary nonce exclusion and test nonce inclusion passed')


if __name__ == '__main__':
    controls(*sys.argv[1:])
