import unittest
from unittest.mock import patch
from release_inventory import configuration, assert_configuration


class InventoryTests(unittest.TestCase):
    def test_reservation_rejects_destination_changes(self):
        environment = dict(SERVER_ORIGIN='https://merkur.example', OPAQUE_PIN='opaque',
                           MERKUR_RELEASE_MLDSA87_PUBLIC_KEY='release', MINIMUM_SEQUENCE='1',
                           RAILWAY_PROJECT_ID='project', RAILWAY_ENVIRONMENT_ID='production', RAILWAY_SERVICE_ID='server',
                           STUN_APPS='test-stun')
        with patch.dict('os.environ', environment, clear=True):
            entry = {'configuration': configuration()}
            assert_configuration(entry)
            with patch.dict('os.environ', {'RAILWAY_SERVICE_ID': 'other'}):
                with self.assertRaises(ValueError): assert_configuration(entry)
            with patch.dict('os.environ', {'MINIMUM_SEQUENCE': ''}):
                with self.assertRaises(ValueError): configuration()
