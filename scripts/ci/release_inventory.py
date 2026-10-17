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
        'MINIMUM_SEQUENCE')}
    if not all(result.values()): raise ValueError('required public release configuration is empty')
    origin = urlsplit(result['SERVER_ORIGIN'])
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
        raise ValueError('production requires an HTTPS origin without credentials')
    if not re.fullmatch(r'[1-9][0-9]*', result['MINIMUM_SEQUENCE']):
        raise ValueError('minimum sequence must be a positive integer')
    with open('deploy/service-hosts.json') as stream:
        manifest = json.load(stream)
    hosts, app = manifest['hosts'], manifest['app']
    names = [host['name'] for host in hosts] + [app['name']]
    if not hosts or not all(NAME.fullmatch(name) for name in names) or len(names) != len(set(names)):
        raise ValueError('deploy/service-hosts.json must list uniquely named hosts')
    result['serviceHosts'] = hosts
    result['appHost'] = app
    return result


def assert_configuration(entry):
    if entry['configuration'] != configuration():
        raise ValueError('public deployment configuration changed since reservation')


if __name__ == '__main__':
    configuration()
