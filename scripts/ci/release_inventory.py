"""Validate the complete deployment inventory before privileged work."""
import json
import os
import re
from urllib.parse import urlsplit

NAME = re.compile(r'[a-z][a-z0-9-]{0,62}\Z')


def configuration():
    """Public deployment inputs are immutable for the lifetime of a reservation."""
    result = {key: os.environ[key] for key in (
        'SERVER_ORIGIN', 'OPAQUE_PIN', 'MERKUR_RELEASE_MLDSA87_PUBLIC_KEY',
        'MINIMUM_SEQUENCE', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID')}
    if not all(result.values()): raise ValueError('required public release configuration is empty')
    origin = urlsplit(result['SERVER_ORIGIN'])
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
        raise ValueError('production requires an HTTPS origin without credentials')
    if not re.fullmatch(r'[1-9][0-9]*', result['MINIMUM_SEQUENCE']):
        raise ValueError('minimum sequence must be a positive integer')
    apps =os.environ['STUN_APPS'].split()
    if not apps or not all(NAME.fullmatch(app) for app in apps) or len(apps) != len(set(apps)):
        raise ValueError('STUN_APPS must list unique app names')
    with open('apps/edge/replicas.json') as stream:
        edges = json.load(stream)['replicas']
    if set(apps) & {edge['app'] for edge in edges}:
        raise ValueError('edge and STUN applications must be distinct')
    result['stunApps'] = apps
    result['edges'] = edges
    return result


def assert_configuration(entry):
    if entry['configuration'] != configuration():
        raise ValueError('public deployment configuration changed since reservation')


if __name__ == '__main__':
    configuration()
