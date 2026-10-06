import importlib.util
import json
from pathlib import Path
import unittest

module = importlib.util.spec_from_file_location('admission', Path(__file__).with_name('bazel_admission.py'))
admission = importlib.util.module_from_spec(module)
module.loader.exec_module(admission)


class AdmissionControls(unittest.TestCase):
    def test_pending_and_malformed_never_admit(self):
        contract = {name: [] for name in admission.LANES | {'common'}}
        for lane in admission.LANES:
            contract['common'] = ['unqualified immutable snapshot']
            with self.assertRaises(ValueError): admission.require_ready(contract, lane)
            contract['common'] = []
            contract[lane] = ['missing native runtime producer']
            with self.assertRaises(ValueError): admission.require_ready(contract, lane)
            contract[lane] = []
        with self.assertRaises(ValueError): admission.require_ready(contract, 'invented')
        contract['source'] = 'not an inventory'
        with self.assertRaises(ValueError): admission.require_ready(contract, 'source')

    def test_exact_ci_selected_inventory(self):
        for native in (False, True):
            for integration in (False, True):
                plan = {'source': False, 'native': native, 'integration': integration}
                results = {'plan': {'result': 'success'}, 'source': {'result': 'success'},
                           'native': {'result': 'success' if native else 'skipped'},
                           'integration': {'result': 'success' if integration else 'skipped'},
                           'transport': {'result': 'success' if integration else 'skipped'}}
                admission.ci_results(plan, results)
                for name in results:
                    for status in ('cancelled', 'failure', 'missing', 'skipped'):
                        altered = json.loads(json.dumps(results))
                        altered[name]['result'] = status
                        if status != results[name]['result']:
                            with self.assertRaises(ValueError): admission.ci_results(plan, altered)
                results['extra'] = {'result': 'success'}
                with self.assertRaises(ValueError): admission.ci_results(plan, results)
        with self.assertRaises(ValueError): admission.ci_results({'source': 'false', 'native': False, 'integration': False}, {})

    def test_event_specific_assurance(self):
        for event in ('push', 'pull_request', 'schedule', 'workflow_dispatch'):
            campaign = event in ('schedule', 'workflow_dispatch')
            results = {name: {'result': 'success'} for name in ('controller', 'parser-smoke', 'ownership', 'bounded-proofs', 'simulation', 'kernel-tool')}
            results['fuzz-campaign'] = {'result': 'success' if campaign else 'skipped'}
            admission.assurance_results(event, results)
            results['fuzz-campaign']['result'] = 'skipped' if campaign else 'success'
            with self.assertRaises(ValueError): admission.assurance_results(event, results)
            del results['kernel-tool']
            with self.assertRaises(ValueError): admission.assurance_results(event, results)

    def test_bounded_proofs_is_required_for_every_assurance_event(self):
        for event in ('push', 'pull_request', 'schedule', 'workflow_dispatch'):
            expected = {name: {'result': 'success'} for name in ('controller', 'parser-smoke', 'ownership', 'bounded-proofs', 'simulation', 'kernel-tool')}
            expected['fuzz-campaign'] = {'result': 'success' if event in ('schedule', 'workflow_dispatch') else 'skipped'}
            admission.assurance_results(event, expected)
            for status in ('failure', 'cancelled', 'skipped', 'missing'):
                altered = json.loads(json.dumps(expected))
                altered['bounded-proofs']['result'] = status
                with self.assertRaises(ValueError): admission.assurance_results(event, altered)
            omitted = {name: result for name, result in expected.items() if name != 'bounded-proofs'}
            with self.assertRaises(ValueError): admission.assurance_results(event, omitted)
            extra = {**expected, 'unlisted-proof': {'result': 'success'}}
            with self.assertRaises(ValueError): admission.assurance_results(event, extra)

    def test_lane_statuses_cannot_hide_a_failed_or_missing_controller(self):
        for event in ('push', 'pull_request', 'schedule', 'workflow_dispatch'):
            results = {name: {'result': 'success'} for name in ('controller', 'parser-smoke', 'ownership', 'bounded-proofs', 'simulation', 'kernel-tool')}
            results['fuzz-campaign'] = {'result': 'success' if event in ('schedule', 'workflow_dispatch') else 'skipped'}
            admission.assurance_results(event, results)
            for status in ('failure', 'cancelled', 'skipped', 'missing'):
                altered = json.loads(json.dumps(results))
                altered['controller']['result'] = status
                with self.assertRaises(ValueError): admission.assurance_results(event, altered)
            del results['controller']
            with self.assertRaises(ValueError): admission.assurance_results(event, results)


    def test_simulation_is_required_for_every_assurance_event(self):
        # Matches the original and inactive workflow's required simulation job;
        # schedule/manual add a sweep inside that same job, never a new result.
        for event in ('push', 'pull_request', 'schedule', 'workflow_dispatch'):
            expected = {name: {'result': 'success'} for name in
                        ('controller', 'parser-smoke', 'ownership', 'bounded-proofs',
                         'simulation', 'kernel-tool')}
            expected['fuzz-campaign'] = {'result': 'success' if event in
                                        ('schedule', 'workflow_dispatch') else 'skipped'}
            admission.assurance_results(event, expected)
            for status in ('failure', 'cancelled', 'skipped', 'missing'):
                altered = json.loads(json.dumps(expected))
                altered['simulation']['result'] = status
                with self.subTest(event=event, status=status), self.assertRaises(ValueError):
                    admission.assurance_results(event, altered)
            omitted = {name: result for name, result in expected.items() if name != 'simulation'}
            with self.assertRaises(ValueError): admission.assurance_results(event, omitted)
            extra = {**expected, 'simulation-sweep': {'result': 'success'}}
            with self.assertRaises(ValueError): admission.assurance_results(event, extra)


if __name__ == '__main__':
    unittest.main()
