#!/usr/bin/env python3
"""Deterministic kernel interventions for the isolated real-client NAT lab."""

import ipaddress
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import time

STATE = Path('/tmp/merkur-native-topology')


def run(namespace, *args, check=True, input=None):
    return subprocess.run(['ip', 'netns', 'exec', namespace, *args], input=input,
                          text=True, capture_output=True, check=check)


def cpe(role):
    if role not in ('daemon', 'client'):
        raise ValueError('role must be daemon or client')
    return f'merkur-natlab-{role}-cpe'


def lifecycle(**updates):
    path = STATE / 'lifecycle.json'
    value = json.loads(path.read_text()) if path.exists() else {}
    value.update(updates)
    path.write_text(json.dumps(value) + '\n')
    return value


def current_ip():
    return lifecycle().get('currentPrivateIP', '10.20.2.2')


def tuples(text):
    for line in text.splitlines():
        groups = [{}]
        for field in line.split():
            if '=' not in field:
                continue
            key, value = field.split('=', 1)
            if key == 'src' and 'src' in groups[-1]:
                groups.append({})
            groups[-1][key] = value
        if len(groups) >= 2:
            yield groups[0], groups[1]


def select_rebind(text, inside):
    candidates = set()
    used = set()
    for original, reply in tuples(text):
        if reply.get('dst') == '198.51.100.2':
            used.add(int(reply['dport']))
        if (original.get('src'), original.get('dst'), original.get('dport')) != (
                inside, '198.51.100.1', '51000'):
            continue
        if reply.get('dst') == '198.51.100.2':
            candidates.add((int(original['sport']), int(reply['dport'])))
    if len(candidates) != 1:
        raise ValueError(f'port rebind needs one live native peer socket, found {sorted(candidates)}')
    local, previous = candidates.pop()
    external = next((port for port in range(20000, 25000) if port not in used), None)
    if external is None:
        raise ValueError('reserved port-rebind range exhausted')
    return dict(privateIP=inside, localPort=local, previousExternalPort=previous,
                currentExternalPort=external, peerIP='198.51.100.1', peerPort=51000)


def snapshot(prefix):
    for role in ('daemon', 'client'):
        (STATE / f'{prefix}-{role}-conntrack.txt').write_text(
            run(cpe(role), 'conntrack', '-L', '-p', 'udp', '-o', 'extended').stdout)
        (STATE / f'{prefix}-{role}-nft.json').write_text(
            run(cpe(role), 'nft', '-j', 'list', 'ruleset').stdout)


def eim_mapping_state(ruleset):
    maps = {value['name']: value for obj in ruleset.get('nftables', [])
            if (value := obj.get('map')) and value.get('table') == 'natlab' and value.get('family') == 'ip'}
    sets = {value['name']: value for obj in ruleset.get('nftables', [])
            if (value := obj.get('set')) and value.get('table') == 'natlab' and value.get('family') == 'ip'}
    if set(maps) != {'inside', 'ordinary', 'reverse_ordinary'} or set(sets) != {'reverse_ports'}:
        raise ValueError('port-only rebinding requires exact EIM maps and inverse-domain set')
    forward = dict(maps['ordinary'].get('elem', []))
    reverse = dict(maps['reverse_ordinary'].get('elem', []))
    guard = sets['reverse_ports']
    ports = set(guard.get('elem', []))
    if (guard.get('type') != 'inet_service' or guard.get('flags')
            or len(reverse) != len(forward) or reverse != {value: key for key, value in forward.items()}
            or ports != set(reverse)):
        raise ValueError('EIM forward, inverse and inverse-domain ownership disagree')
    return forward, reverse, ports


def port_rebind():
    if (STATE / 'case').read_text().strip() != 'eim-pdf':
        raise ValueError('port-only rebinding requires the supported EIM mapping domain')
    if 'portReboundAtNs' in lifecycle():
        raise ValueError('port-only rebinding already applied to this topology')
    snapshot('before-port-rebind')
    info = select_rebind((STATE / 'before-port-rebind-client-conntrack.txt').read_text(), current_ip())
    ruleset = json.loads((STATE / 'before-port-rebind-client-nft.json').read_text())
    forward, _, _ = eim_mapping_state(ruleset)
    controlled = set(range(30000, 35000)) | set(range(40000, 50000))
    reserved = set(range(20000, 25000))
    if (set(forward) != controlled or not set(forward.values()).isdisjoint(controlled | reserved)
            or forward.get(info['localPort']) != info['previousExternalPort']):
        raise ValueError('port-only rebinding found an unsupported or conflicting EIM mapping domain')
    lifecycle(portRebindStartedAtNs=time.time_ns(), portRebind=info)
    local, external = info['localPort'], info['currentExternalPort']
    # One netlink transaction replaces only this socket's controlled SNAT entry.
    rules = (f'delete element ip natlab ordinary {{ {local} }}\n'
             f'add element ip natlab ordinary {{ {local} : {external} }}\n'
             f'delete element ip natlab reverse_ordinary {{ {info["previousExternalPort"]} }}\n'
             f'add element ip natlab reverse_ordinary {{ {external} : {local} }}\n'
             f'delete element ip natlab reverse_ports {{ {info["previousExternalPort"]} }}\n'
             f'add element ip natlab reverse_ports {{ {external} }}\n')
    run(cpe('client'), 'nft', '-f', '-', input=rules)
    run(cpe('client'), 'conntrack', '-D', '-p', 'udp', '--orig-src', info['privateIP'],
        '--sport', str(local))
    lifecycle(portReboundAtNs=time.time_ns())
    snapshot('after-port-rebind')
    updated, _, _ = eim_mapping_state(json.loads((STATE / 'after-port-rebind-client-nft.json').read_text()))
    if updated.get(local) != external:
        raise ValueError('kernel did not publish the replacement EIM ownership')


def impairment(clear):
    if clear:
        stats = {}
        loss = {}
        for role in ('daemon', 'client'):
            stats[role] = dict(qdisc=json.loads(run(cpe(role), 'tc', '-s', '-j', 'qdisc', 'show', 'dev', 'wan0').stdout),
                               filters=json.loads(run(cpe(role), 'tc', '-s', '-j', 'filter', 'show', 'dev', 'wan0', 'parent', '1:').stdout))
            loss[role] = json.loads(run(cpe(role), 'nft', '-j', 'list', 'table', 'inet', 'natlab_impairment').stdout)
        (STATE / 'impairment-qdisc.json').write_text(json.dumps(stats) + '\n')
        (STATE / 'impairment-nft.json').write_text(json.dumps(loss) + '\n')
        for role in ('daemon', 'client'):
            run(cpe(role), 'tc', 'qdisc', 'del', 'dev', 'wan0', 'root', 'handle', '1:')
            run(cpe(role), 'nft', 'delete', 'table', 'inet', 'natlab_impairment')
        lifecycle(impairmentClearedAtNs=time.time_ns())
        return
    for role, peer in [('daemon', '198.51.100.2'), ('client', '198.51.100.1')]:
        run(cpe(role), 'tc', 'qdisc', 'add', 'dev', 'wan0', 'root', 'handle', '1:',
            'prio', 'bands', '3', 'priomap', *(['0'] * 16))
        run(cpe(role), 'tc', 'qdisc', 'add', 'dev', 'wan0', 'parent', '1:3', 'handle', '30:',
            'netem', 'limit', '1000', 'delay', '40ms', 'duplicate', '100%')
        run(cpe(role), 'tc', 'filter', 'add', 'dev', 'wan0', 'protocol', 'ip', 'parent', '1:',
            'pref', '10', 'flower', 'ip_proto', 'udp', 'dst_ip', peer, 'classid', '1:3')
        run(cpe(role), 'nft', '-f', '-', input=f'''table inet natlab_impairment {{
 counter peer_loss {{ }}
 chain forward {{
  type filter hook forward priority -15; policy accept;
  ip daddr {peer} meta l4proto udp numgen inc mod 7 0 counter name peer_loss drop
 }}
}}
''')
    lifecycle(impairedAtNs=time.time_ns(), impairment=dict(delayMs=40, duplicatePercent=100, lossEvery=7))


def same_ip_route():
    before = json.loads(run('merkur-natlab-client', 'ip', '-j', 'route', 'show', 'default').stdout)
    if len(before) != 1 or 'gateway' not in before[0]:
        raise ValueError('same-IP route change requires one exact default gateway')
    inside = current_ip()
    if before[0]['gateway'] == '10.20.2.254':
        raise ValueError('same-IP route intervention already applied')
    lifecycle(sameIPRouteStartedAtNs=time.time_ns(), sameIPRoute=dict(
        privateIP=inside, previousGateway=before[0]['gateway'], currentGateway='10.20.2.254'))
    (STATE / 'before-same-ip-route-address.json').write_text(run('merkur-natlab-client', 'ip', '-j', 'address', 'show', 'dev', 'eth0').stdout)
    run(cpe('client'), 'ip', 'address', 'add', '10.20.2.254/24', 'dev', 'lan0')
    run('merkur-natlab-client', 'ip', 'route', 'replace', 'default', 'via', '10.20.2.254', 'dev', 'eth0', 'src', inside)
    (STATE / 'after-same-ip-route-address.json').write_text(run('merkur-natlab-client', 'ip', '-j', 'address', 'show', 'dev', 'eth0').stdout)
    (STATE / 'after-same-ip-route.json').write_text(run('merkur-natlab-client', 'ip', '-j', 'route', 'show', 'default').stdout)
    lifecycle(sameIPRouteChangedAtNs=time.time_ns())
    snapshot('after-same-ip-route')


def epoch_packet(data, protocol):
    if protocol == 'natpmp' and len(data) == 12 and data[:4] == b'\0\x80\0\0':
        return struct.unpack('!I', data[4:8])[0]
    if protocol == 'pcp' and len(data) >= 24 and data[:4] == b'\x02\x80\0\0':
        return struct.unpack('!I', data[8:12])[0]
    return None


def epoch(protocol, inside, gateway, minimum):
    request = b'\0\0' if protocol == 'natpmp' else (
        b'\x02\0' + bytes(6) + ipaddress.IPv6Address(f'::ffff:{inside}').packed)
    deadline = time.monotonic() + 8
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.bind((inside, 0))
        udp.connect((gateway, 5351))
        udp.settimeout(0.2)
        while time.monotonic() < deadline:
            try:
                udp.send(request)
                result = epoch_packet(udp.recv(2048), protocol)
                if result is not None and result >= minimum:
                    print(result)
                    return
                # Poll the gateway's actual clock without flooding its protocol/log socket.
                time.sleep(0.05)
            except (TimeoutError, ConnectionRefusedError):
                pass
    raise RuntimeError('no successful gateway protocol epoch response within bounded observation')


def dynamic_chains(ruleset):
    return [dict(family=chain['family'], table=chain['table'], name=chain['name'])
            for obj in ruleset.get('nftables', []) if (chain := obj.get('chain'))
            and (chain['name'].endswith('_miniupnpd') or chain['name'] == 'miniupnpd')]


def ipv4_udp_grants(ruleset):
    result = []
    for obj in ruleset.get('nftables', []):
        rule = obj.get('rule', {})
        if rule.get('chain') != 'prerouting_miniupnpd':
            continue
        expressions = rule.get('expr', [])
        matches = [expr['match'] for expr in expressions if 'match' in expr]
        udp = False
        external = None
        incoming = False
        for match in matches:
            if match.get('op') != '==':
                continue
            left, right = match.get('left', {}), match.get('right')
            payload = left.get('payload', {})
            meta = left.get('meta', {})
            incoming |= meta.get('key') in ('iif', 'iifname') and right == 'wan0'
            udp |= ((meta.get('key') == 'l4proto' or
                     payload.get('protocol') == 'ip' and payload.get('field') == 'protocol')
                    and right in ('udp', 17))
            udp |= (payload.get('base') == 'nh' and payload.get('offset') == 72
                    and payload.get('len') == 8 and right == 17)
            if payload.get('protocol') in ('th', 'udp') and payload.get('field') == 'dport':
                external = right
        for expression in expressions:
            grant = expression.get('dnat', {})
            if (not udp or not incoming or grant.get('family') != 'ip'
                    or type(external) is not int or not 0 < external <= 65535
                    or type(grant.get('port')) is not int or not 0 < grant['port'] <= 65535):
                continue
            inside = str(ipaddress.IPv4Address(grant['addr']))
            result.append(dict(privateIP=inside, localPort=grant['port'], externalPort=external, rule=rule))
    return result


def reacquired_grant(before, flushed, current):
    previous = ipv4_udp_grants(before)
    if len(previous) != 1 or ipv4_udp_grants(flushed):
        raise ValueError('gateway reset requires one previous native grant and an empty flushed gateway')
    matches = [grant for grant in ipv4_udp_grants(current)
               if (grant['privateIP'], grant['localPort']) ==
               (previous[0]['privateIP'], previous[0]['localPort'])]
    if len(matches) > 1:
        raise ValueError('gateway reset produced ambiguous replacement grants for one native binding')
    return dict(previous=previous[0], current=matches[0]) if matches else None


def inbound_lease_replied(grant, connections, public):
    for line in connections.splitlines():
        if '[UNREPLIED]' in line:
            continue
        for original, reply in tuples(line):
            if (original.get('dst') == public and original.get('dport') == str(grant['externalPort'])
                    and reply.get('src') == grant['privateIP'] and reply.get('sport') == str(grant['localPort'])
                    and reply.get('dst') == original.get('src') and reply.get('dport') == original.get('sport')):
                return True
    return False


def wait_lease(role):
    reboot = lifecycle().get('gatewayReboot', {})
    if reboot.get('role') != role:
        raise ValueError('lease reacquisition requires this role\'s completed real gateway reset')
    before = json.loads((STATE / f'before-gateway-reboot-{role}-nft.json').read_text())
    flushed = json.loads((STATE / f'flushed-gateway-reboot-{role}-nft.json').read_text())
    previous = ipv4_udp_grants(before)
    public = f'198.51.100.{1 if role == "daemon" else 2}'
    connections = (STATE / f'before-gateway-reboot-{role}-conntrack.txt').read_text()
    if len(previous) != 1 or not inbound_lease_replied(previous[0], connections, public):
        raise ValueError('gateway reset has no previously used inbound native lease binding')
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = json.loads(run(cpe(role), 'nft', '-j', 'list', 'ruleset').stdout)
        replacement = reacquired_grant(before, flushed, state)
        if replacement:
            (STATE / f'reacquired-{role}-nft.json').write_text(json.dumps(state) + '\n')
            (STATE / f'reacquired-{role}-lease.json').write_text(json.dumps(dict(
                role=role, protocol=reboot['protocol'], publicIP=public, observedAtNs=time.time_ns(),
                previousEpoch=reboot['previousEpoch'], currentEpoch=reboot['currentEpoch'],
                previousPid=reboot['previousPid'], currentPid=reboot['currentPid'],
                **replacement)) + '\n')
            lifecycle(leaseReacquiredAtNs=time.time_ns())
            return
        time.sleep(0.05)
    raise RuntimeError('no replacement native binding grant after the real gateway reset')


def observe_announcement(inside, gateway, path):
    # A passive multicast copy observes the actual gateway packet without taking ownership.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        udp.bind(('', 5350))
        udp.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                       socket.inet_aton('224.0.0.1') + socket.inet_aton(inside))
        Path(str(path) + '.ready').touch()
        udp.settimeout(8)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            data, sender = udp.recvfrom(2048)
            if sender != (gateway, 5351):
                continue
            for protocol in ('natpmp', 'pcp'):
                value = epoch_packet(data, protocol)
                if value is not None:
                    path.write_text(json.dumps(dict(protocol=protocol, epoch=value,
                        sender=list(sender), receivedAtNs=time.time_ns(), packet=data.hex())) + '\n')
                    return
    raise RuntimeError('real gateway restart announcement not observed')


def gateway_reboot():
    selected = (STATE / 'case').read_text().strip().split('-')
    if len(selected) != 3 or selected[1] != 'lease' or selected[2] not in ('pcp', 'natpmp'):
        raise ValueError('gateway epoch reset requires a PCP or NAT-PMP lease topology')
    role, _, protocol = selected
    number = 1 if role == 'daemon' else 2
    host, router = f'merkur-natlab-{role}', cpe(role)
    inside, gateway = f'10.20.{number}.2', f'10.20.{number}.1'
    previous = int(run(host, 'python3', __file__, 'epoch', protocol, inside, gateway, '2').stdout)
    snapshot('before-gateway-reboot')
    chains = dynamic_chains(json.loads(run(router, 'nft', '-j', 'list', 'ruleset').stdout))
    if not chains:
        raise ValueError('gateway has no actual miniupnpd chains to reset')
    pid_path = STATE / f'{role}-miniupnpd.pid'
    old_pid = int(pid_path.read_text())
    lifecycle(gatewayRebootStartedAtNs=time.time_ns())
    os.kill(old_pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if ':5351 ' not in run(router, 'ss', '-H', '-lun').stdout:
            break
        time.sleep(0.02)
    else:
        raise RuntimeError('owned gateway process did not release PCP/NAT-PMP socket')
    flush = ''.join(f'flush chain {item["family"]} {item["table"]} {item["name"]}\n' for item in chains)
    run(router, 'nft', '-f', '-', input=flush)
    run(router, 'conntrack', '-F')
    snapshot('flushed-gateway-reboot')
    announcement = STATE / 'gateway-announcement.json'
    observer = subprocess.Popen(['ip', 'netns', 'exec', host, 'python3', __file__,
        'observe', inside, gateway, str(announcement)])
    deadline = time.monotonic() + 3
    while not Path(str(announcement) + '.ready').exists():
        if observer.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError('gateway announcement observer failed to register')
        time.sleep(0.01)
    with (STATE / f'{role}-miniupnpd.log').open('a') as log:
        process = subprocess.Popen(['ip', 'netns', 'exec', router, 'miniupnpd', '-f',
            str(STATE / f'{role}-miniupnpd.conf'), '-d'], stdout=log, stderr=log)
    pid_path.write_text(str(process.pid) + '\n')
    current = int(run(host, 'python3', __file__, 'epoch', protocol, inside, gateway, '0').stdout)
    if current >= previous:
        raise RuntimeError('gateway restart did not reset the actual wire epoch')
    # miniupnpd's own SIGUSR1 handler emits NAT-PMP and PCP address-change notifications.
    os.kill(process.pid, signal.SIGUSR1)
    if observer.wait(timeout=10) != 0:
        raise RuntimeError('gateway did not emit a real restart announcement')
    notice = json.loads(announcement.read_text())
    if notice['epoch'] >= previous:
        raise RuntimeError('gateway multicast announcement did not prove epoch loss')
    lifecycle(gatewayRebootedAtNs=time.time_ns(), gatewayReboot=dict(role=role, protocol=protocol,
        previousEpoch=previous, currentEpoch=current, previousPid=old_pid, currentPid=process.pid,
        flushedChains=chains))
    snapshot('after-gateway-reboot')


def clear_peer_flows():
    for role, peer in [('client', '198.51.100.1'), ('daemon', '198.51.100.2')]:
        result = run(cpe(role), 'conntrack', '-D', '-p', 'udp', '--orig-dst', peer, check=False)
        if result.returncode not in (0, 1):
            raise RuntimeError(result.stderr)


def main():
    command = sys.argv[1]
    if command == 'epoch':
        epoch(*sys.argv[2:5], int(sys.argv[5]))
    elif command == 'observe':
        observe_announcement(sys.argv[2], sys.argv[3], Path(sys.argv[4]))
    elif command == 'port-rebind':
        port_rebind()
    elif command == 'impair-peer':
        impairment(False)
    elif command == 'clear-impair':
        impairment(True)
    elif command == 'same-ip-route':
        same_ip_route()
    elif command == 'gateway-reboot':
        gateway_reboot()
    elif command == 'wait-reacquired-lease':
        wait_lease(sys.argv[2])
    elif command == 'clear-peer-flows':
        clear_peer_flows()
    else:
        raise ValueError('unknown native fault command')


if __name__ == '__main__':
    main()
