"""Fail before engine execution while a requested integration lane lacks qualification."""
import json
from pathlib import Path
import sys


LANES = frozenset(('source', 'native', 'integration', 'transport', 'assurance',
                   'fuzz-campaign', 'dependency-audit', 'extended', 'unsigned-release'))


def require_ready(contract, lane):
    if not isinstance(contract, dict) or set(contract) != LANES | {'common'} or lane not in LANES:
        raise ValueError('CI qualification inventory is malformed or lane is unknown')
    for pending in contract.values():
        if not isinstance(pending, list) or any(not isinstance(item, str) or not item for item in pending):
            raise ValueError('CI qualification entries must be explicit strings')
    pending = contract['common'] + contract[lane]
    if pending:
        raise ValueError('Unqualified Bazel CI lane ' + lane + ':\n' + '\n'.join(pending))


def require_results(expected, results):
    if not isinstance(results, dict) or set(results) != set(expected):
        raise ValueError('required CI job inventory is incomplete or unexpected')
    for name, selected in expected.items():
        result = results[name]
        if not isinstance(result, dict) or result.get('result') != ('success' if selected else 'skipped'):
            raise ValueError('required CI job failed, cancelled, missing or incorrectly skipped: ' + name)


def ci_results(plan, results):
    if not isinstance(plan, dict) or set(plan) != {'source', 'native', 'integration'} or any(type(x) is not bool for x in plan.values()):
        raise ValueError('required CI plan must contain three exact booleans')
    require_results({'plan': True, 'source': True, 'native': plan['native'],
                     'integration': plan['integration'], 'transport': plan['integration']}, results)


def assurance_results(event, results):
    if event not in ('pull_request', 'push', 'schedule', 'workflow_dispatch'):
        raise ValueError('unexpected assurance event')
    require_results({'controller': True, 'parser-smoke': True, 'ownership': True, 'bounded-proofs': True, 'simulation': True, 'kernel-tool': True,
                     'fuzz-campaign': event in ('schedule', 'workflow_dispatch')}, results)


if __name__ == '__main__':
    if sys.argv[1] == 'ci-results':
        ci_results(json.loads(sys.argv[2]), json.loads(sys.argv[3]))
    elif sys.argv[1] == 'assurance-results':
        assurance_results(sys.argv[2], json.loads(sys.argv[3]))
    else:
        require_ready(json.loads(Path(sys.argv[1]).read_bytes()), sys.argv[2])
