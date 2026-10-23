#!/usr/bin/env python3
"""Execute the real matrix loop with isolated command/process boundary fixtures."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('native.sh')

# Fixtures replace external work, not the Bash loop, its status handling, or EXIT trap.
BOUNDARIES = r'''
LAB_DIR="$NATLAB_FIXTURE_ROOT"
evidence="$NATLAB_FIXTURE_ROOT/evidence"
mkdir -p "$evidence"
fixture_current=
fixture_record() {
  printf '%s|%s\n' "$1" "${2:-$fixture_current}" >> "$NATLAB_FIXTURE_TRACE"
}
stop_children() { fixture_record stop; children=(); captures=(); }
ready() {
  fixture_record ready
  [[ "$NATLAB_FIXTURE_FAILURE" != ready ]] || return 65
}
proxy() { fixture_record proxy; }
bash() {
  [[ "$1" == "$LAB_DIR/native-topology.sh" ]] || return 99
  case "$2" in
    setup)
      fixture_current=$3
      fixture_record setup
      [[ "$NATLAB_FIXTURE_FAILURE" != setup ]] || return 21
      ;;
    evidence)
      fixture_record evidence
      [[ "$NATLAB_FIXTURE_FAILURE" != evidence ]] || return 43
      printf 'collected\n' > "$3/fixture-evidence"
      ;;
    teardown)
      fixture_record teardown
      [[ "$NATLAB_FIXTURE_FAILURE" != teardown ]] || return 54
      ;;
    *) return 98 ;;
  esac
}
function /natlab/merkur-stun() { printf 'stun: listening\n'; }
tcpdump() { printf 'listening on fixture\n' >&2; }
ip() {
  [[ "$1" == netns && "$2" == exec ]] || return 97
  shift 3
  "$@"
}
bun() {
  fixture_record application
  printf 'application fixture %s\n' "$fixture_current"
  if [[ "$NATLAB_FIXTURE_FAILURE" == mixed && "$fixture_current" == eim-pdf ]]; then
    return 17
  fi
}
python3() {
  case "$1" in
    "$LAB_DIR/verify-native.py")
      fixture_record verifier
      if [[ "$NATLAB_FIXTURE_FAILURE" == mixed && "$fixture_current" == edm-pdf ]]; then
        return 23
      fi
      printf '{"fixture":"verified"}\n'
      ;;
    "$LAB_DIR/native-v6-gateway.py")
      if [[ "$2" == --wait-native-deleted ]]; then
        fixture_record native-delete
        [[ "$NATLAB_FIXTURE_FAILURE" != native-delete ]] || return 35
      else
        fixture_record preflight
        [[ "$NATLAB_FIXTURE_FAILURE" != preflight ]] || return 32
      fi
      ;;
    *) return 96 ;;
  esac
}
cases=("$@")
'''


class NativeAggregationTests(unittest.TestCase):
    def execute(self, failure, cases):
        source = SCRIPT.read_text()
        # Read the production declarations/trap and matrix loop verbatim. No branch is
        # duplicated here: changes to the actual runner are what these executions test.
        preamble = source.split('cases=("$@")', 1)[0]
        matrix = source[source.index('failed_cases=()\n'):]
        with tempfile.TemporaryDirectory(prefix='merkur aggregation ') as directory:
            root = Path(directory)
            trace = root / 'trace'
            trace.touch()
            fixture = root / 'runner.sh'
            fixture.write_text(preamble + BOUNDARIES + matrix)
            env = dict(os.environ, NATLAB_FIXTURE_ROOT=directory,
                       NATLAB_FIXTURE_TRACE=str(trace), NATLAB_FIXTURE_FAILURE=failure)
            result = subprocess.run(['bash', str(fixture), *cases], env=env,
                                    capture_output=True, text=True, timeout=10)
            events = [tuple(line.split('|', 1)) for line in trace.read_text().splitlines()]
            evidence = {case for case in cases if (root / 'evidence' / case / 'fixture-evidence').exists()}
        return result, events, evidence

    def test_application_and_verifier_failures_collect_evidence_and_continue_then_fail_once(self):
        cases = ['eim-pdf', 'blocked', 'edm-pdf', 'lan']
        result, events, evidence = self.execute('mixed', cases)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual([case for event, case in events if event == 'setup'], cases)
        self.assertEqual([case for event, case in events if event == 'application'], cases)
        self.assertEqual([case for event, case in events if event == 'verifier'], cases[1:])
        self.assertEqual(evidence, set(cases))
        for index, case in enumerate(cases):
            collected = events.index(('evidence', case))
            stopped = events.index(('stop', case), collected)
            torn_down = events.index(('teardown', case), stopped)
            self.assertLess(collected, stopped)
            self.assertLess(stopped, torn_down)
            if index + 1 < len(cases):
                self.assertLess(torn_down, events.index(('setup', cases[index + 1])))
        self.assertIn('NATIVE_NATLAB_CASE=FAIL case=eim-pdf status=17', result.stderr)
        self.assertIn('NATIVE_NATLAB_CASE=FAIL case=edm-pdf status=23', result.stderr)
        self.assertIn('NATIVE_NATLAB=FAIL cases=eim-pdf edm-pdf', result.stderr)
        self.assertNotIn('NATIVE_NATLAB=PASS', result.stdout)

    def test_all_success_includes_real_v6_branches_and_final_pass(self):
        cases = ['ipv6-client-pcp', 'ipv6-daemon-igd', 'lan']
        result, events, evidence = self.execute('none', cases)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(evidence, set(cases))
        self.assertEqual([case for event, case in events if event == 'preflight'], cases[:2])
        self.assertEqual([case for event, case in events if event == 'native-delete'], cases[:2])
        self.assertEqual([case for event, case in events if event == 'verifier'], cases)
        self.assertIn('NATIVE_NATLAB=PASS', result.stdout)
        self.assertNotIn('NATIVE_NATLAB=FAIL', result.stderr)

    def test_native_release_proof_failure_is_collected_before_continuing(self):
        cases = ['ipv6-client-pcp', 'lan']
        result, events, evidence = self.execute('native-delete', cases)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual([case for event, case in events if event == 'setup'], cases)
        self.assertEqual(evidence, set(cases))
        self.assertEqual([case for event, case in events if event == 'verifier'], ['lan'])
        self.assertIn('NATIVE_NATLAB_CASE=FAIL case=ipv6-client-pcp status=35', result.stderr)
        self.assertIn('NATIVE_NATLAB=FAIL cases=ipv6-client-pcp', result.stderr)

    def test_infrastructure_errors_abort_before_the_next_case_and_run_cleanup(self):
        statuses = {'setup': 21, 'preflight': 32, 'evidence': 43, 'teardown': 54, 'ready': 65}
        for failure, expected_status in statuses.items():
            with self.subTest(failure=failure):
                first = 'ipv6-client-pcp' if failure == 'preflight' else 'eim-pdf'
                result, events, evidence = self.execute(failure, [first, 'lan'])
                self.assertEqual(result.returncode, expected_status, result.stderr)
                self.assertEqual([case for event, case in events if event == 'setup'], [first])
                self.assertIn(('stop', first), events)
                self.assertIn(('teardown', first), events)
                self.assertNotIn('NATIVE_NATLAB=PASS', result.stdout)
                self.assertNotIn('NATIVE_NATLAB_CASE=FAIL', result.stderr)
                if failure in ('setup', 'preflight', 'ready'):
                    self.assertNotIn(('application', first), events)
                    self.assertFalse(evidence)
                elif failure == 'evidence':
                    self.assertNotIn(('verifier', first), events)
                    self.assertFalse(evidence)
                else:
                    self.assertEqual(evidence, {first})
                    self.assertIn(('verifier', first), events)


if __name__ == '__main__':
    unittest.main()
