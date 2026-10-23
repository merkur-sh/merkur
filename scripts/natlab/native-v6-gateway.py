#!/usr/bin/env python3
"""Exercise real miniupnpd IPv6 control requests and their kernel firewall effect."""

import http.client
import ipaddress
import json
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET


# Outside the namespaces' declared ephemeral ranges and the daemon's 24400 listener.
PORT = 24021
SERVICE = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1"
GATEWAY_PORT = 5351


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def canonical(address):
    return str(ipaddress.ip_address(address.split("%", 1)[0]))


def pcp_request(local, nonce, lifetime):
    return (struct.pack("!BBHI", 2, 1, 0, lifetime)
            + ipaddress.IPv6Address(local).packed + nonce
            + struct.pack("!B3xHH", 17, PORT, PORT)
            + ipaddress.IPv6Address(local).packed)


def pcp_response(packet, nonce, local):
    require(len(packet) == 60, "PCP MAP response must contain exactly its fixed fields")
    require(packet[:4] == bytes([2, 129, 0, 0]), "PCP MAP did not return success")
    require(packet[24:36] == nonce, "PCP response changed the owning nonce")
    require(packet[36:40] == bytes([17, 0, 0, 0]), "PCP response changed the UDP protocol")
    require(struct.unpack_from("!HH", packet, 40) == (PORT, PORT),
            "an IPv6 pinhole must preserve the exact local port")
    require(packet[44:60] == ipaddress.IPv6Address(local).packed,
            "an IPv6 pinhole must preserve the actual local address")
    return {"lifetime": struct.unpack_from("!I", packet, 4)[0],
            "epoch": struct.unpack_from("!I", packet, 8)[0], "nonce": nonce.hex()}


class Pcp:
    def __init__(self, local, gateway):
        self.local = local
        self.gateway = gateway
        self.nonce = secrets.token_bytes(12)
        self.socket = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        self.socket.settimeout(5)
        self.socket.bind((local, 0))

    def change(self, lifetime):
        request = pcp_request(self.local, self.nonce, lifetime)
        sent = time.time_ns()
        self.socket.sendto(request, (self.gateway, GATEWAY_PORT))
        response, source = self.socket.recvfrom(1500)
        received = time.time_ns()
        require((canonical(source[0]), source[1]) == (self.gateway, GATEWAY_PORT),
                "PCP response came from another endpoint")
        facts = pcp_response(response, self.nonce, self.local)
        require((facts["lifetime"] > 0) == (lifetime > 0), "PCP lifetime verdict differs")
        return {**facts, "requestedLifetime": lifetime, "sentAtNs": sent,
                "receivedAtNs": received, "source": list(self.socket.getsockname()),
                "responder": list(source), "request": request.hex(), "response": response.hex()}

    def open(self, lifetime):
        return self.change(lifetime)

    def renew(self, lifetime):
        return self.change(lifetime)

    def delete(self):
        return self.change(0)


class Igd:
    def __init__(self, local, gateway):
        self.local = local
        self.gateway = gateway
        self.unique_id = None
        search = ("M-SEARCH * HTTP/1.1\r\nHOST: [ff02::c]:1900\r\n"
                  'MAN: "ssdp:discover"\r\nMX: 1\r\n'
                  f"ST: {SERVICE}\r\n\r\n").encode()
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as discovery:
            discovery.settimeout(5)
            discovery.bind((local, 0))
            discovery.sendto(search, (gateway, 1900))
            response, source = discovery.recvfrom(65535)
        require(canonical(source[0]) == gateway, "SSDP response came from another gateway")
        headers = dict(line.split(":", 1) for line in response.decode().split("\r\n")[1:]
                       if ":" in line)
        locations = [value.strip() for key, value in headers.items() if key.lower() == "location"]
        require(len(locations) == 1, "SSDP must identify one description location")
        self.description = locations[0]
        parsed = urllib.parse.urlsplit(self.description)
        require(parsed.scheme == "http" and parsed.hostname is not None,
                "SSDP description must use HTTP")
        self.host = urllib.parse.unquote(parsed.hostname)
        self.port = parsed.port or 80
        connection = self.connection()
        connection.request("GET", parsed.path or "/")
        fetched = connection.getresponse()
        body = fetched.read()
        require(fetched.status == 200, "gateway description request failed")
        connection.close()
        document = ET.fromstring(body)
        service = next((element for element in document.iter()
                        if element.tag.rsplit("}", 1)[-1] == "service"
                        and any(child.tag.rsplit("}", 1)[-1] == "serviceType"
                                and child.text == SERVICE for child in element)), None)
        require(service is not None, "real gateway did not advertise IPv6 firewall control")
        control = next(child.text for child in service
                       if child.tag.rsplit("}", 1)[-1] == "controlURL")
        endpoint = urllib.parse.urlsplit(urllib.parse.urljoin(self.description, control))
        require(endpoint.hostname == parsed.hostname and (endpoint.port or 80) == self.port,
                "firewall control changed the gateway endpoint")
        self.path = endpoint.path

    def connection(self):
        return http.client.HTTPConnection(self.host, self.port, timeout=5,
                                          source_address=(self.local, 0))

    def action(self, action, arguments):
        body = ('<?xml version="1.0"?>'
                '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
                's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
                f'<s:Body><u:{action} xmlns:u="{SERVICE}">{arguments}'
                f'</u:{action}></s:Body></s:Envelope>').encode()
        connection = self.connection()
        connection.connect()
        source = connection.sock.getsockname()
        responder = connection.sock.getpeername()
        sent = time.time_ns()
        connection.request("POST", self.path, body,
                           {"Content-Type": 'text/xml; charset="utf-8"',
                            "SOAPAction": f'"{SERVICE}#{action}"'})
        result = connection.getresponse()
        response = result.read()
        received = time.time_ns()
        require(result.status == 200, f"{action} failed: HTTP {result.status}: {response!r}")
        require(canonical(source[0]) == self.local, "SOAP changed the actual control source")
        connection.close()
        return {"action": action, "sentAtNs": sent, "receivedAtNs": received,
                "source": list(source), "responder": list(responder),
                "requestBody": body.decode(), "responseBody": response.decode()}

    def open(self, lifetime):
        facts = self.action("AddPinhole", '<RemoteHost></RemoteHost><RemotePort>0</RemotePort>'
                            f'<InternalClient>{self.local}</InternalClient>'
                            f'<InternalPort>{PORT}</InternalPort><Protocol>17</Protocol>'
                            f'<LeaseTime>{lifetime}</LeaseTime>')
        document = ET.fromstring(facts["responseBody"])
        unique_id = next(element.text for element in document.iter()
                         if element.tag.rsplit("}", 1)[-1] == "UniqueID")
        self.unique_id = int(unique_id)
        require(0 <= self.unique_id <= 65535, "gateway pinhole ID is not a u16")
        return {**facts, "uniqueId": self.unique_id, "requestedLifetime": lifetime}

    def renew(self, lifetime):
        return {**self.action("UpdatePinhole", f'<UniqueID>{self.unique_id}</UniqueID>'
                              f'<NewLeaseTime>{lifetime}</NewLeaseTime>'),
                "uniqueId": self.unique_id, "requestedLifetime": lifetime}

    def delete(self):
        return {**self.action("DeletePinhole", f'<UniqueID>{self.unique_id}</UniqueID>'),
                "uniqueId": self.unique_id}


def endpoint(protocol, local, gateway):
    with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as receiver:
        receiver.bind((local, PORT))
        receiver.settimeout(5)
        control = Pcp(local, gateway) if protocol == "pcp" else Igd(local, gateway)
        print(json.dumps({"ready": True, "local": list(receiver.getsockname())}), flush=True)
        for line in sys.stdin:
            command = json.loads(line)
            operation = command["operation"]
            if operation == "receive":
                data, source = receiver.recvfrom(1500)
                result = {"payload": data.hex(), "source": list(source)}
            else:
                result = getattr(control, operation)(*command.get("arguments", []))
            print(json.dumps(result), flush=True)


def kernel(namespace):
    result = subprocess.run(["ip", "netns", "exec", namespace, "nft", "-j", "-a", "list",
                             "table", "inet", "filter"], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def counters(ruleset):
    found = {entry["counter"]["name"]: entry["counter"]["packets"]
             for entry in ruleset["nftables"] if "counter" in entry}
    return {name: found[name] for name in ("pinhole_attempt", "pinhole_denied")}


def pinholes(ruleset, local, probe_only=True):
    result = []
    for entry in ruleset["nftables"]:
        rule = entry.get("rule", {})
        if rule.get("chain") != "miniupnpd":
            continue
        address, destination_port, udp = rule_tuple(rule)
        if (address == local and udp and isinstance(destination_port, int)
                and (destination_port == PORT if probe_only else destination_port != PORT)):
            require(any("accept" in expression for expression in rule["expr"]),
                    "gateway pinhole has no accept verdict")
            result.append(rule)
    return result


def rule_tuple(rule):
    """Decode semantic or raw bit-offset payloads from libnftables JSON."""
    address, port, udp = None, None, False
    for expression in rule.get("expr", []):
        match = expression.get("match", {})
        if match.get("op") != "==":
            continue
        payload = match.get("left", {}).get("payload", {})
        right = match.get("right")
        raw = (payload.get("base"), payload.get("offset"), payload.get("len"))
        field = (payload.get("protocol"), payload.get("field"))
        if field == ("ip6", "daddr") or raw == ("nh", 192, 128):
            if isinstance(right, (str, int)):
                value = int(right, 16) if isinstance(right, str) and right.startswith("0x") else right
                address = str(ipaddress.IPv6Address(value))
        elif field in (("udp", "dport"), ("th", "dport")) or raw == ("th", 16, 16):
            port = int(right, 0) if isinstance(right, str) else right
            udp = udp or field[0] == "udp"
        elif (field == ("ip6", "nexthdr") or raw == ("nh", 48, 8)
              or match.get("left", {}).get("meta", {}).get("key") == "l4proto"):
            udp = udp or right in (17, "udp", "0x11")
    return address, port, udp


class Endpoint:
    def __init__(self, namespace, protocol, local, gateway):
        self.process = subprocess.Popen(["ip", "netns", "exec", namespace, sys.executable,
                                         str(Path(__file__).resolve()), "endpoint", protocol,
                                         local, gateway], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        require(self.read()["ready"], "owner endpoint did not become ready")

    def read(self):
        line = self.process.stdout.readline()
        require(bool(line), "owner endpoint exited before completing a command")
        return json.loads(line)

    def start(self, operation, *arguments):
        self.process.stdin.write(json.dumps({"operation": operation, "arguments": arguments}) + "\n")
        self.process.stdin.flush()

    def command(self, operation, *arguments):
        self.start(operation, *arguments)
        return self.read()

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=6)
        require(self.process.returncode == 0, "owner endpoint failed")


def await_kernel(namespace, predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        state = kernel(namespace)
        if predicate(state):
            return state
        require(time.monotonic() < deadline, "gateway kernel state did not reach its expected state")
        time.sleep(0.02)


def prove(role, protocol, output):
    require(role in ("client", "daemon") and protocol in ("pcp", "igd"), "unknown IPv6 case")
    number = 2 if role == "client" else 1
    local, gateway = f"2001:db8:{number}::2", f"2001:db8:{number}::1"
    namespace = f"merkur-natlab-{role}-cpe"
    owner = Endpoint(f"merkur-natlab-{role}", protocol, local, gateway)
    facts = {"role": role, "protocol": protocol, "local": local, "port": PORT,
             "gateway": gateway, "kind": "independent-real-gateway-preflight"}
    payload = secrets.token_bytes(32)
    opened = False
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as probe:
            before = kernel(namespace)
            require(not pinholes(before, local), "probe port already has a gateway pinhole")
            initial = counters(before)
            probe.sendto(payload, (local, PORT))
            denied = await_kernel(namespace, lambda state:
                                  counters(state)["pinhole_denied"] > initial["pinhole_denied"])
            facts["beforeGrant"] = counters(denied)
            facts["beforeGrantState"] = denied
            facts["acquire"] = owner.command("open", 120)
            opened = True
            acquired = await_kernel(namespace, lambda state: len(pinholes(state, local)) == 1)
            facts["acquiredRule"] = pinholes(acquired, local)[0]
            facts["acquiredState"] = acquired
            owner.start("receive")
            probe.sendto(payload, (local, PORT))
            received = owner.read()
            require(received["payload"] == payload.hex(), "gateway changed the proof payload")
            accepted = kernel(namespace)
            now, prior = counters(accepted), counters(denied)
            require(now["pinhole_attempt"] > prior["pinhole_attempt"]
                    and now["pinhole_denied"] == prior["pinhole_denied"],
                    "arrived datagram did not pass through the real gateway pinhole")
            facts["afterArrival"] = {"counters": now, "received": received}
            facts["arrivalState"] = accepted
            facts["renew"] = owner.command("renew", 240)
            renewed = await_kernel(namespace, lambda state:
                                   len(pinholes(state, local)) == 1
                                   and pinholes(state, local)[0]["handle"]
                                   != facts["acquiredRule"]["handle"])
            facts["renewedRule"] = pinholes(renewed, local)[0]
            facts["renewedState"] = renewed
            facts["delete"] = owner.command("delete")
            opened = False
            deleted = await_kernel(namespace, lambda state: not pinholes(state, local))
            prior = counters(deleted)
            probe.sendto(payload, (local, PORT))
            denied = await_kernel(namespace, lambda state:
                                  counters(state)["pinhole_denied"] > prior["pinhole_denied"])
            facts["afterDelete"] = counters(denied)
            facts["deletedState"] = denied
            if protocol == "igd":
                facts["expiringAcquire"] = owner.command("open", 2)
                opened = True
                expiring = await_kernel(namespace, lambda state: len(pinholes(state, local)) == 1)
                facts["expiringRule"] = pinholes(expiring, local)[0]
                facts["expiringState"] = expiring
                expired = await_kernel(namespace, lambda state: not pinholes(state, local))
                opened = False
                facts["expiredAtNs"] = time.time_ns()
                facts["afterExpiry"] = counters(expired)
                facts["expiredState"] = expired
        Path(output).write_text(json.dumps(facts, indent=2) + "\n")
    except Exception as error:
        facts["failure"] = {"type": type(error).__name__, "message": str(error)}
        try:
            facts["failureState"] = kernel(namespace)
        except Exception as snapshot_error:
            facts["failureStateError"] = str(snapshot_error)
        Path(output).write_text(json.dumps(facts, indent=2) + "\n")
        raise
    finally:
        failure = sys.exc_info()[1]
        try:
            try:
                if opened:
                    owner.command("delete")
            finally:
                owner.close()
        except Exception as cleanup_error:
            facts["cleanupFailure"] = str(cleanup_error)
            Path(output).write_text(json.dumps(facts, indent=2) + "\n")
            if failure is None:
                raise
    print(f"NATIVE_V6_GATEWAY=PASS role={role} protocol={protocol}", flush=True)


def wait_native(operation, role, output):
    require(role in ("client", "daemon"), "unknown IPv6 owner role")
    number = 2 if role == "client" else 1
    local = f"2001:db8:{number}::2"
    namespace = f"merkur-natlab-{role}-cpe"
    output = Path(output)
    if operation == "acquired":
        baseline = json.loads(Path("/tmp/merkur-native-topology/pinhole-native-start-nft.json")
                              .read_text())
        state = await_kernel(namespace, lambda value:
                             len(pinholes(value, local, False)) == 1, 30)
        rule = pinholes(state, local, False)[0]
        facts = {"role": role, "case": Path("/tmp/merkur-native-topology/case").read_text().strip(),
                 "kind": "native-kernel-pinhole-lifecycle", "local": local,
                 "acquiredAtNs": time.time_ns(), "acquiredRule": rule,
                 "nativeStartCounters": counters(baseline), "acquiredCounters": counters(state)}
    else:
        facts = json.loads(output.read_text())
        require(facts["role"] == role and facts["local"] == local,
                "native lifecycle belongs to another role")
        acquired = facts["acquiredRule"]
        expressions = acquired["expr"]

        def same_tuple(rule):
            matches = lambda items: [item["match"] for item in items if "match" in item]
            return matches(rule["expr"]) == matches(expressions)

        if operation == "renewed":
            state = await_kernel(namespace, lambda value:
                                 any(same_tuple(rule) and rule["handle"] != acquired["handle"]
                                     for rule in pinholes(value, local, False)), 150)
            facts["renewedAtNs"] = time.time_ns()
            facts["renewedRule"] = next(rule for rule in pinholes(state, local, False)
                                        if same_tuple(rule) and rule["handle"] != acquired["handle"])
        else:
            require(operation == "deleted", "unknown native lifecycle transition")
            state = await_kernel(namespace, lambda value:
                                 not any(same_tuple(rule) for rule in pinholes(value, local, False)), 15)
            facts["deletedAtNs"] = time.time_ns()
            facts["deletedCounters"] = counters(state)
    output.write_text(json.dumps(facts, indent=2) + "\n")
    print(f"NATIVE_V6_PINHOLE={operation} role={role}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "endpoint":
        endpoint(*sys.argv[2:])
    elif len(sys.argv) == 4 and sys.argv[1].startswith("--wait-native-"):
        wait_native(sys.argv[1].removeprefix("--wait-native-"), *sys.argv[2:])
    elif len(sys.argv) == 4:
        prove(*sys.argv[1:])
    else:
        raise SystemExit("usage: native-v6-gateway.py ROLE pcp|igd OUTPUT_JSON")
