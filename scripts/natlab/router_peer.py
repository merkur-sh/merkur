"""Bounded external peer for an explicitly owned physical-router experiment."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

COOKIE = 0x2112A442
AAD = b'merkur-owned-router-experiment'


def enc64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def dec64(data):
    return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4))


def seal(key, value):
    nonce = secrets.token_bytes(12)
    return enc64(nonce + AESGCM(key).encrypt(nonce, json.dumps(value).encode(), AAD))


def unseal(key, text):
    data = dec64(text.strip())
    return json.loads(AESGCM(key).decrypt(data[:12], data[12:], AAD))


def ticket_key(key):
    return hmac.digest(key, b'stun-key-a', 'sha256') + hmac.digest(key, b'stun-key-b', 'sha256')


def credential(key):
    deployment = ticket_key(key)
    prefix = b'\x01' + (int(time.time()) + 600).to_bytes(8, 'big') + secrets.token_bytes(16)
    ticket = prefix + hmac.digest(deployment, b'merkur-stun-ticket-v1' + prefix, 'sha256')[:16]
    integrity = hmac.digest(deployment, b'merkur-stun-message-integrity-v1' + ticket, 'sha256')
    return {'ticket': enc64(ticket), 'secret': enc64(integrity)}


def attribute(kind, value):
    return struct.pack('!HH', kind, len(value)) + value + b'\x00' * (-len(value) % 4)


def stun_response(data, peer, key):
    if len(data) < 56 or len(data) > 1200 or len(data) % 4:
        return None
    kind, length, cookie, tx = struct.unpack_from('!HHI12s', data)
    if kind != 1 or length != len(data) - 20 or cookie != COOKIE:
        return None
    cursor, username, tag, prefix = 20, None, None, None
    while cursor < len(data):
        if cursor + 4 > len(data) or tag is not None:
            return None
        kind, length = struct.unpack_from('!HH', data, cursor)
        value = data[cursor + 4:cursor + 4 + length]
        if len(value) != length:
            return None
        if kind == 6 and username is None:
            username = value
        elif kind == 0x001C and length == 32:
            tag, prefix = value, data[:cursor]
        elif kind == 3:
            # This one-address responder cannot prove CHANGE-REQUEST filtering.
            return None
        elif kind != 0x0026 and kind < 0x8000:
            return None
        cursor += 4 + ((length + 3) // 4) * 4
    if cursor != len(data) or username is None or tag is None:
        return None
    try:
        ticket = dec64(username.decode())
    except (ValueError, UnicodeError):
        return None
    deployment = ticket_key(key)
    if len(ticket) != 41 or ticket[0] != 1 or int.from_bytes(ticket[1:9], 'big') < time.time():
        return None
    expected = hmac.digest(deployment, b'merkur-stun-ticket-v1' + ticket[:25], 'sha256')[:16]
    if not hmac.compare_digest(ticket[25:], expected):
        return None
    integrity = hmac.digest(deployment, b'merkur-stun-message-integrity-v1' + ticket, 'sha256')
    if not hmac.compare_digest(tag, hmac.digest(integrity, prefix, 'sha256')):
        return None
    address = bytes(a ^ b for a, b in zip(socket.inet_aton(peer[0]), struct.pack('!I', COOKIE)))
    mapped = attribute(0x0020, struct.pack('!BBH', 0, 1, peer[1] ^ (COOKIE >> 16)) + address)
    prefix = struct.pack('!HHI12s', 0x0101, len(mapped) + 36, COOKIE, tx) + mapped
    return prefix + attribute(0x001C, hmac.digest(integrity, prefix, 'sha256'))


def observe(sock):
    host = socket.gethostbyname('stun.l.google.com')
    tx = secrets.token_bytes(12)
    sock.sendto(struct.pack('!HHI12s', 1, 0, COOKIE, tx), (host, 19302))
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not select.select([sock], [], [], max(0, deadline - time.monotonic()))[0]:
            break
        data, peer = sock.recvfrom(4096)
        if peer != (host, 19302) or len(data) < 20 or data[8:20] != tx:
            continue
        if struct.unpack_from('!HHI', data) != (0x0101, len(data) - 20, COOKIE):
            continue
        cursor = 20
        while cursor + 4 <= len(data):
            kind, size = struct.unpack_from('!HH', data, cursor)
            value = data[cursor + 4:cursor + 4 + size]
            if kind == 0x0020 and len(value) == 8 and value[:2] == b'\x00\x01':
                address = socket.inet_ntoa(bytes(a ^ b for a, b in zip(value[4:], struct.pack('!I', COOKIE))))
                return [address, struct.unpack_from('!H', value, 2)[0] ^ (COOKIE >> 16)]
            cursor += 4 + ((size + 3) // 4) * 4
    raise RuntimeError('external peer could not observe its UDP socket')


def run():
    key = dec64(os.environ['ROUTER_LAB_KEY'])
    url = os.environ['ROUTER_LAB_CONTROL_URL']
    label = os.environ['ROUTER_LAB_PEER']
    api = 'https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/check-runs'

    def check_update(path, method, body):
        request = urllib.request.Request(path, data=json.dumps(body).encode(), method=method,
            headers={'Authorization': 'Bearer ' + os.environ['GITHUB_TOKEN'],
                     'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    check = check_update(api, 'POST', {'name': 'Owned router peer ' + label,
        'head_sha': os.environ['GITHUB_SHA'], 'status': 'in_progress'})

    def acknowledge(result, complete=False):
        body = {'output': {'title': 'Encrypted router experiment acknowledgment',
                          'summary': seal(key, result)}}
        if complete:
            body.update(status='completed', conclusion='success')
        check_update(api + '/' + str(check['id']), 'PATCH', body)
    out = Path('router-peer-output')
    out.mkdir(exist_ok=True)
    logs, stop = [], threading.Event()
    started = time.monotonic()
    seen = set()
    control = None
    stun, client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM), socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    stun.bind(('0.0.0.0', 34780))
    client.bind(('0.0.0.0', 0))
    ready = {'stun': observe(stun), 'client': observe(client), 'started_unix': time.time(), 'label': label}
    (out / 'ready.enc').write_text(seal(key, ready))

    def serve():
        served = 0
        while not stop.is_set():
            if not select.select([stun], [], [], 0.2)[0]:
                continue
            data, peer = stun.recvfrom(2048)
            if control is None or peer[0] != control['owner_ip'] or served >= 100:
                continue
            response = stun_response(data, peer, key)
            if response is not None:
                stun.sendto(response, peer)
                served += 1
                logs.append({'event': 'stun_served', 'peer': peer, 'time': time.time()})
    worker = threading.Thread(target=serve)
    worker.start()
    try:
        # Ten minutes is the explicit experiment stop condition, not a reachability claim.
        while time.monotonic() - started < 600:
            try:
                request = urllib.request.Request(url + '?t=' + str(time.time_ns()), headers={'Cache-Control': 'no-cache'})
                with urllib.request.urlopen(request, timeout=10) as response:
                    document = json.load(response)
                command = unseal(key, document['files']['command.txt']['content'])
                if control is None:
                    control = command
                if command.get('peer', '*') not in (label, '*'):
                    time.sleep(15)
                    continue
                if command['owner_ip'] != control['owner_ip'] or command['id'] in seen:
                    time.sleep(15)
                    continue
                seen.add(command['id'])
                if command['expires'] < time.time():
                    continue
                result = {'id': command['id'], 'action': command['action'], 'started': time.time()}
                if command['action'] == 'stop':
                    logs.append(result)
                    acknowledge(result, complete=True)
                    break
                if command['action'] == 'udp':
                    target = (control['owner_ip'], int(command['port']))
                    payload = dec64(command['payload'])
                    if len(payload) > 512:
                        raise ValueError('oversized experiment packet')
                    result['echo'] = False
                    for _ in range(3):
                        client.sendto(payload, target)
                        if select.select([client], [], [], 0.4)[0]:
                            data, peer = client.recvfrom(2048)
                            if peer == target and data == payload:
                                result['echo'] = True
                                break
                elif command['action'] == 'dial':
                    coordinates = out / ('coordinates-' + str(len(seen)) + '.json')
                    coordinates.write_text(json.dumps(command['coordinates']))
                    destination = out / ('browser-' + str(len(seen)) + '.json')
                    completed = subprocess.run([sys.executable, str(Path(__file__).with_name('router_browser.py')),
                        '--coordinates', str(coordinates), '--host', control['owner_ip'],
                        '--port', str(int(command['port'])), '--output', str(destination), '--budget', '7000'],
                        capture_output=True, timeout=25)
                    result['exit'] = completed.returncode
                    if destination.exists():
                        result['browser'] = json.loads(destination.read_text())
                elif command['action'] != 'idle':
                    raise ValueError('unknown experiment action')
                result['finished'] = time.time()
                logs.append(result)
                acknowledge(result)
            except Exception as error:
                logs.append({'event': 'error', 'type': type(error).__name__, 'time': time.time()})
            # At most forty anonymous Gist API reads per peer in the ten-minute run.
            time.sleep(15)
    finally:
        stop.set()
        worker.join()
        (out / 'result.enc').write_text(seal(key, {'ready': ready, 'events': logs}))
        (out / 'done').touch()
        stun.close()
        client.close()


if __name__ == '__main__':
    run()
