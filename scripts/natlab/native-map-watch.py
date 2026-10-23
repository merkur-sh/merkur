#!/usr/bin/env python3
"""Install the lab's EIF/ADF reverse mapping from conntrack's actual STUN tuple."""

import ipaddress
import json
import pathlib
import signal
import subprocess
import sys
import time


def mappings(text, inside, observer):
    """Read the two named tuple groups in conntrack's extended output."""
    found = set()
    for line in text.splitlines():
        fields = [part.split("=", 1) for part in line.split() if "=" in part]
        groups = []
        current = {}
        for key, value in fields:
            if key == "src" and "src" in current:
                groups.append(current)
                current = {}
            current[key] = value
        groups.append(current)
        if len(groups) < 2:
            continue
        original, reply = groups[:2]
        if original.get("src") != inside or original.get("dst") != observer:
            continue
        if original.get("dport") != "3478":
            continue
        try:
            local = int(original["sport"])
            external = int(reply["dport"])
            public = str(ipaddress.ip_address(reply["dst"]))
        except (KeyError, ValueError):
            continue
        if 0 < local <= 65535 and 0 < external <= 65535:
            found.add((local, public, external))
    return found


def main():
    namespace, inside, public, state_file = sys.argv[1:]
    active = True

    def stop(_signum, _frame):
        nonlocal active
        active = False

    signal.signal(signal.SIGTERM, stop)
    installed = set()
    while active:
        result = subprocess.run(
            ["ip", "netns", "exec", namespace, "conntrack", "-L", "-p", "udp", "-o", "extended"],
            capture_output=True,
            text=True,
            check=False,
        )
        for local, mapped, external in sorted(mappings(result.stdout, inside, "198.51.100.10")):
            if mapped != public or (local, external) in installed:
                continue
            subprocess.run(
                [
                    "ip", "netns", "exec", namespace, "nft", "add", "rule", "ip", "natlab",
                    "prerouting", "iifname", "wan0", "ip", "daddr", public, "udp", "dport",
                    str(external), "dnat", "to", f"{inside}:{local}",
                ],
                check=True,
            )
            installed.add((local, external))
            pathlib.Path(state_file).write_text(json.dumps([
                {"local_port": port, "mapped_port": translated, "public_ip": public}
                for port, translated in sorted(installed)
            ]) + "\n")
        # Polling observes controlled kernel state; elapsed time never declares a mapping.
        time.sleep(0.01)


if __name__ == "__main__":
    main()
