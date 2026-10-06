#!/usr/bin/env python3
"""Prove the harnesses detect missing safeguards, mutating only temporary copies."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    "packages/merkur-client/src/session.rs",
    "packages/merkur-e2e/src/lib.rs",
    "apps/edge/src/splice.rs",
)


def check(name, source, original, mutation, command, signal):
    with tempfile.TemporaryDirectory(prefix="merkur-proof-negative-") as directory:
        scratch = Path(directory)
        shutil.copytree(ROOT / "tools/ownership-proofs", scratch / "tools/ownership-proofs",
                        ignore=shutil.ignore_patterns("target", "__pycache__"))
        for relative in SOURCES:
            destination = scratch / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        destination = scratch / source
        text = destination.read_text()
        if text.count(original) != 1:
            raise RuntimeError(f"{name}: mutation no longer matches exactly one safeguard")
        destination.write_text(text.replace(original, mutation))
        env = dict(os.environ)
        env.pop("RUSTUP_TOOLCHAIN", None)
        target_root = Path(env.get("CARGO_TARGET_DIR", ROOT / "target/ownership-proofs"))
        env["CARGO_TARGET_DIR"] = str(target_root / "negative-controls")
        result = subprocess.run(command, cwd=scratch, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        lines = result.stdout.splitlines()
        compiler_error = any(line.startswith((
            "error[", "error: could not compile", "error: aborting due to",
            "error: failed to run custom build command",
        )) for line in lines)
        failed_result = (
            "VERIFICATION RESULT:" in lines if command[1] == "kani"
            else any(line.startswith("test result: FAILED.") for line in lines)
        )
        if compiler_error:
            print(result.stdout)
            raise RuntimeError(f"{name}: compilation failure is not an invariant failure")
        if result.returncode == 0 or not failed_result or signal not in result.stdout:
            print(result.stdout)
            raise RuntimeError(f"{name}: expected invariant failure was not observed")
        print(f"{name}: missing safeguard rejected ({signal})", flush=True)


MANIFEST = "tools/ownership-proofs/Cargo.toml"
check(
    "provider-specific counter custody",
    SOURCES[0],
    ".any(|(_, other)| merkur_e2e::lane_for_channel(*other) == Some(lane))",
    ".any(|(owner, other)| *owner == conn && merkur_e2e::lane_for_channel(*other) == Some(lane))",
    ["cargo", "kani", "--manifest-path", MANIFEST, "--harness",
     "custody_survives_provider_switch", "--output-format", "terse"],
    "VERIFICATION:- FAILED",
)
check(
    "released route guard before admission",
    SOURCES[2],
    "        match peers.sink_for(self.from_role.peer()) {",
    "        drop(peers);\n        let peers = self.peers.read();\n"
    "        match peers.sink_for(self.from_role.peer()) {",
    ["cargo", "test", "--locked", "--manifest-path", MANIFEST, "--test", "edge_routing",
     "source_replacement_never_admits_the_retired_writer", "--", "--nocapture"],
    "admitted retired source",
)
check(
    "pair retirement retains senders",
    SOURCES[2],
    "[peers.browser.take(), peers.daemon.take()]",
    "[Option::<PeerSink>::None, Option::<PeerSink>::None]",
    ["cargo", "test", "--locked", "--manifest-path", MANIFEST, "--test", "edge_routing",
     "retiring_the_pair_revokes_retained_route_handles", "--", "--nocapture"],
    "assertion failed: !route.route(frame(&source))",
)
check(
    "slot drop retains routing membership",
    SOURCES[2],
    "        *self.peers.write() = SessionPeers::default();",
    "        let _ = self;",
    ["cargo", "test", "--locked", "--manifest-path", MANIFEST, "--test", "edge_routing",
     "slot_drop_revokes_old_handles_before_label_reuse", "--", "--nocapture"],
    "assertion failed: !route.route(frame(&source))",
)
check(
    "stale detach removes successor membership",
    SOURCES[2],
    "        if sink\n            .as_ref()\n"
    "            .is_some_and(|current| current.attachment_id == attachment_id)",
    "        if sink\n            .as_ref()\n            .is_some_and(|_| true)",
    ["cargo", "test", "--locked", "--manifest-path", MANIFEST, "--test", "edge_routing",
     "stale_detach_cannot_remove_a_successor_attachment", "--", "--nocapture"],
    "assertion failed: route.route(frame(&source))",
)
