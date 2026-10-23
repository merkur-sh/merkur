#!/usr/bin/env python3
"""Kernel regression for EIM mapping ownership and strict endpoint filtering.

This mechanism check runs in its own topology before the authenticated session suite.
It never substitutes UDP delivery for the native session's cryptographic proof.
"""

import json
import os
from pathlib import Path
import queue
import selectors
import socket
import subprocess
import sys
import threading
import time


def worker(inside, ports):
    sockets = []
    selector = selectors.DefaultSelector()
    for index, port in enumerate(ports):
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.bind((inside, port))
        udp.setblocking(False)
        selector.register(udp, selectors.EVENT_READ, index)
        sockets.append(udp)
    selector.register(sys.stdin, selectors.EVENT_READ, None)
    print(json.dumps(dict(ready=[list(udp.getsockname()) for udp in sockets])), flush=True)
    pending = b''
    try:
        while True:
            for selected, _ in selector.select():
                if selected.data is None:
                    chunk = os.read(sys.stdin.fileno(), 4096)
                    if not chunk:
                        return
                    pending += chunk
                    while b'\n' in pending:
                        line, pending = pending.split(b'\n', 1)
                        command = json.loads(line)
                        sockets[command['socket']].sendto(command['payload'].encode(), tuple(command['target']))
                else:
                    data, source = selected.fileobj.recvfrom(4096)
                    print(json.dumps(dict(socket=selected.data, source=list(source),
                                          payload=data.decode())), flush=True)
    finally:
        selector.close()
        for udp in sockets:
            udp.close()


class Lab:
    def __init__(self):
        self.events = queue.Queue()
        self.pending = []
        self.processes = []

    def actor(self, role, namespace, inside, ports):
        command = [sys.executable, __file__, 'worker', inside, *map(str, ports)]
        if namespace is not None:
            command = ['ip', 'netns', 'exec', namespace, *command]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   text=True, bufsize=1)
        self.processes.append(process)

        def read():
            for line in process.stdout:
                self.events.put((role, json.loads(line)))
            self.events.put((role, dict(exited=process.wait())))

        threading.Thread(target=read, daemon=True).start()
        ready = self.wait(role, lambda event: 'ready' in event)
        assert ready['ready'] == [[inside, port] for port in ports], ready
        return process

    def wait(self, role, predicate):
        deadline = time.monotonic() + 5
        while True:
            for index, (owner, event) in enumerate(self.pending):
                if owner == role and predicate(event):
                    self.pending.pop(index)
                    return event
                if 'exited' in event:
                    raise AssertionError(f'{owner} exited before boundary proof: {event}')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f'{role}: expected kernel delivery absent; pending={self.pending}')
            try:
                self.pending.append(self.events.get(timeout=remaining))
            except queue.Empty:
                raise AssertionError(f'{role}: expected kernel delivery absent') from None

    def receive(self, role, index, source, payload):
        event = self.wait(role, lambda event: event.get('payload') == payload)
        assert event == dict(socket=index, source=list(source), payload=payload), event
        return event

    def observed(self, role, index, source_ip, payload):
        event = self.wait(role, lambda event: event.get('payload') == payload)
        assert event['socket'] == index and event['source'][0] == source_ip, event
        return event

    @staticmethod
    def send(actor, index, target, payload):
        actor.stdin.write(json.dumps(dict(socket=index, target=list(target), payload=payload)) + '\n')
        actor.stdin.flush()

    def close(self):
        for process in self.processes:
            process.stdin.close()
        for process in self.processes:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def kernel(namespace, *command):
    return subprocess.check_output(['ip', 'netns', 'exec', namespace, *command], text=True)


def counter(namespace, name):
    data = json.loads(kernel(namespace, 'nft', '-j', 'list', 'counter', 'inet', 'natlab', name))
    entries = [item['counter'] for item in data['nftables'] if 'counter' in item]
    assert len(entries) == 1, entries
    return entries[0]['packets']


def dropped(namespace, name, before):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        current = counter(namespace, name)
        if current > before:
            return current
        # The counter, rather than elapsed time, is the packet-drop witness.
        time.sleep(0.01)
    raise AssertionError(f'{namespace}: {name} never witnessed the rejected packet')


def no_public_original(namespace):
    text = kernel(namespace, 'conntrack', '-L', '-p', 'udp', '-o', 'extended')
    for line in text.splitlines():
        first_source = next((field[4:] for field in line.split() if field.startswith('src=')), None)
        assert first_source not in ('198.51.100.1', '198.51.100.2'), line
    return text


def proof(output):
    lab = Lab()
    daemon_cpe, client_cpe = 'merkur-natlab-daemon-cpe', 'merkur-natlab-client-cpe'
    witnessed = []
    try:
        daemon = lab.actor('daemon', 'merkur-natlab-daemon', '10.20.1.2', (24400, 40007))
        client = lab.actor('client', 'merkur-natlab-client', '10.20.2.2', (40021, 40022))
        observer = lab.actor('observer', None, '198.51.100.10', (3478,))
        impostor = lab.actor('impostor', None, '198.51.100.254', (52022,))
        # Every binding first contacts infrastructure; peer delivery must use the same map.
        for role, actor, index, public_port in (
                ('daemon', daemon, 0, 51000), ('daemon', daemon, 1, 51007),
                ('client', client, 0, 52021), ('client', client, 1, 52022)):
            public = '198.51.100.1' if role == 'daemon' else '198.51.100.2'
            marker = f'observe-{role}-{index}'
            lab.send(actor, index, ('198.51.100.10', 3478), marker)
            witnessed.append(lab.receive('observer', 0, (public, public_port), marker))

        # Deliberately deliver each side's first packet before its opposite socket sends.
        before = counter(daemon_cpe, 'peer_drop')
        lab.send(client, 0, ('198.51.100.1', 51007), 'client-first-dropped')
        dropped(daemon_cpe, 'peer_drop', before)
        no_public_original(daemon_cpe)
        lab.send(daemon, 1, ('198.51.100.2', 52021), 'daemon-second-delivered')
        witnessed.append(lab.receive('client', 0, ('198.51.100.1', 51007), 'daemon-second-delivered'))
        lab.send(client, 0, ('198.51.100.1', 51007), 'client-retransmit-delivered')
        witnessed.append(lab.receive('daemon', 1, ('198.51.100.2', 52021), 'client-retransmit-delivered'))

        before = counter(client_cpe, 'peer_drop')
        lab.send(daemon, 0, ('198.51.100.2', 52022), 'daemon-first-dropped')
        dropped(client_cpe, 'peer_drop', before)
        no_public_original(client_cpe)
        lab.send(client, 1, ('198.51.100.1', 51000), 'client-second-delivered')
        witnessed.append(lab.receive('daemon', 0, ('198.51.100.2', 52022), 'client-second-delivered'))
        lab.send(daemon, 0, ('198.51.100.2', 52022), 'daemon-retransmit-delivered')
        witnessed.append(lab.receive('client', 1, ('198.51.100.1', 51000), 'daemon-retransmit-delivered'))

        before = counter(daemon_cpe, 'peer_drop')
        lab.send(client, 0, ('198.51.100.1', 51000), 'wrong-source-port')
        dropped(daemon_cpe, 'peer_drop', before)
        before = counter(daemon_cpe, 'other_drop')
        lab.send(impostor, 0, ('198.51.100.1', 51000), 'wrong-source-address')
        dropped(daemon_cpe, 'other_drop', before)

        # Both live mappings still deliver to their own private sockets after rejected tuples.
        lab.send(daemon, 0, ('198.51.100.2', 52022), 'surviving-first-binding')
        lab.send(daemon, 1, ('198.51.100.2', 52021), 'surviving-second-binding')
        witnessed.append(lab.receive('client', 1, ('198.51.100.1', 51000), 'surviving-first-binding'))
        witnessed.append(lab.receive('client', 0, ('198.51.100.1', 51007), 'surviving-second-binding'))
        conntrack = {role: no_public_original(namespace) for role, namespace in (
            ('daemon', daemon_cpe), ('client', client_cpe))}
        evidence = dict(result='pass', deliveries=witnessed, conntrack=conntrack,
                        rejected=dict(daemon=counter(daemon_cpe, 'peer_drop'),
                                      client=counter(client_cpe, 'peer_drop'),
                                      address=counter(daemon_cpe, 'other_drop')))
        Path(output).write_text(json.dumps(evidence, indent=2) + '\n')
        print('NATIVE_CPE_BOUNDARY=PASS', flush=True)
    finally:
        lab.close()


def edm_proof(filtering, output):
    lab = Lab()
    daemon_cpe = 'merkur-natlab-daemon-cpe'
    witnessed = []
    try:
        daemon = lab.actor('daemon', 'merkur-natlab-daemon', '10.20.1.2', (24400, 40007))
        client = lab.actor('client', 'merkur-natlab-client', '10.20.2.2', (40021, 40022))
        first = lab.actor('first', None, '198.51.100.10', (3478,))
        second = lab.actor('second', None, '198.51.100.11', (3478,))
        impostor = lab.actor('impostor', None, '198.51.100.254', (52022,))
        observers = []
        all_ports = set()
        for index in (0, 1):
            observed = []
            for role, target in (('first', '198.51.100.10'), ('second', '198.51.100.11')):
                marker = f'{filtering}-{role}-{index}'
                lab.send(daemon, index, (target, 3478), marker)
                event = lab.observed(role, 0, '198.51.100.1', marker)
                observed.append(event['source'][1])
                witnessed.append(event)
            marker = f'{filtering}-peer-{index}'
            lab.send(daemon, index, ('198.51.100.2', 52021 + index), marker)
            event = lab.observed('client', index, '198.51.100.1', marker)
            witnessed.append(event)
            public_ports = [*observed, event['source'][1]]
            assert len(set(public_ports)) == 3, public_ports
            assert all(port not in all_ports for port in public_ports), public_ports
            all_ports.update(public_ports)
            observers.append(observed[0])
        assert [event['source'][1] for event in witnessed[:3]] == [51110, 51120, 51130]

        # Same known peer IP, different source port, and an observer-owned destination
        # port: mapping dependence must never silently impose endpoint filtering.
        for index in (0, 1):
            sender = 1 - index
            marker = f'{filtering}-different-peer-port-{index}'
            lab.send(client, sender, ('198.51.100.1', observers[index]), marker)
            witnessed.append(lab.receive('daemon', index, ('198.51.100.2', 52021 + sender), marker))

        marker = f'{filtering}-uncontacted-address'
        before = counter(daemon_cpe, 'other_drop')
        lab.send(impostor, 0, ('198.51.100.1', observers[0]), marker)
        if filtering == 'adf':
            dropped(daemon_cpe, 'other_drop', before)
        else:
            witnessed.append(lab.receive('daemon', 0, ('198.51.100.254', 52022), marker))
            assert counter(daemon_cpe, 'other_drop') == before

        # Both simultaneous binding owners still invert correctly after that admission.
        for index in (0, 1):
            marker = f'{filtering}-still-owned-{index}'
            lab.send(client, 1 - index, ('198.51.100.1', observers[index]), marker)
            witnessed.append(lab.receive('daemon', index,
                ('198.51.100.2', 52022 - index), marker))
        Path(output).write_text(json.dumps(dict(result='pass', filtering=filtering,
            deliveries=witnessed, uniqueExternalPorts=sorted(all_ports),
            otherDrops=counter(daemon_cpe, 'other_drop')), indent=2) + '\n')
        print(f'NATIVE_CPE_BOUNDARY_EDM_{filtering.upper()}=PASS', flush=True)
    finally:
        lab.close()


if __name__ == '__main__':
    if sys.argv[1] == 'worker':
        worker(sys.argv[2], tuple(map(int, sys.argv[3:])))
    elif sys.argv[1] == 'pdf':
        proof(sys.argv[2])
    else:
        assert sys.argv[1] in ('eif', 'adf'), 'unknown boundary filtering profile'
        edm_proof(sys.argv[1], sys.argv[2])
