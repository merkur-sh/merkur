import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { computeTerminalGrid } from '../../packages/shared/src/terminal';
import { expectConnected } from './app-state';
import { expect, test } from './fixtures/daemon-process';
import { pixelCounts } from './fixtures/graphics-pixels';
import { expectOutput, primeTerminal, shellQuote } from './terminal-e2e-helpers';

for (const [tool, redValue] of [
  ['chafa', 254],
  ['chafa-tmux', 254],
  ['icat', 255],
  ['icat-unicode', 255],
  ['icat-animation', 255],
] as const) {
  test(`pinned ${tool} output renders through the real graphics pipeline`, async ({
    page,
    linkedDaemon,
  }, testInfo) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    const client = join(linkedDaemon.daemonHome, 'tool-replay.py');
    const capture = join(linkedDaemon.daemonHome, 'tool-capture.json');
    const report = testInfo.outputPath('tool-replay.json');
    await writeFile(
      capture,
      await readFile(join(process.cwd(), 'tests/fixtures/kitty', `${tool}.json`)),
    );
    await writeFile(
      client,
      String.raw`
import base64, hashlib, json, os, select, sys, termios, time, tty, zlib
capture, report = sys.argv[1:]
saved = termios.tcgetattr(0)
failed = None
def record(phase, response=None):
    with open(report + ".tmp", "w") as result:
        json.dump({"phase": phase, "response": response, "failed": failed}, result)
    os.replace(report + ".tmp", report)
def write(data):
    while data:
        count = os.write(1, data)
        if count <= 0: raise RuntimeError("closed PTY")
        data = data[count:]
def until(suffix):
    data = b""
    deadline = time.monotonic() + 45
    while not data.endswith(suffix):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError("response timeout " + data.hex())
        chunk = os.read(0, 4096)
        if not chunk or len(data) + len(chunk) > 16384: raise RuntimeError("invalid response")
        data += chunk
    return data
try:
    fixture = json.load(open(capture))
    data = zlib.decompress(base64.b64decode(fixture["payload"], validate=True))
    assert len(data) == fixture["bytes"]
    assert hashlib.sha256(data).hexdigest() == fixture["sha256"]
    tty.setraw(0)
    write(b"\r\nTOOL-REPLAY-READY\r\n")
    assert until(b"g") == b"g"
    write(b"\x1b[2J\x1b[H" + data + b"\x1b[5n")
    record("capture-written")
    record("capture-applied", until(b"\x1b[0n").hex())
    assert until(b"d") == b"d"
    write(b"\x1b_Ga=d,d=A\x1b\\\x1b[0m\x1b[2J\x1b[5n")
    assert until(b"\x1b[0n") == b"\x1b[0n"
    record("delete-applied")
    assert until(b"f") == b"f"
except BaseException as error:
    failed = repr(error)
finally:
    write(b"\x1b[?1049l")
    termios.tcsetattr(0, termios.TCSANOW, saved)
    record("finished")
sys.exit(0 if failed is None else 1)
`,
    );
    try {
      await page.keyboard.type(
        `python3 ${shellQuote(client)} ${shellQuote(capture)} ${shellQuote(report)}\n`,
      );
      await expectOutput(output, 'TOOL-REPLAY-READY');
      await page.keyboard.type('g');
      await expect
        .poll(async () =>
          existsSync(report) ? JSON.parse(await readFile(report, 'utf8')).phase : 'starting',
        )
        .toBe('capture-applied');
      await expect.poll(async () => (await pixelCounts(page, redValue)).red).toBeGreaterThan(1000);
      if (tool === 'icat-animation') {
        await expect.poll(async () => (await pixelCounts(page)).green).toBeGreaterThan(1000);
        await expect.poll(async () => (await pixelCounts(page)).red).toBeGreaterThan(1000);
      }
      await page.keyboard.type('d');
      await expect
        .poll(async () => JSON.parse(await readFile(report, 'utf8')).phase)
        .toBe('delete-applied');
      await expect.poll(async () => (await pixelCounts(page, redValue)).red).toBe(0);
      if (tool === 'icat-animation') {
        await expect.poll(async () => (await pixelCounts(page)).green).toBe(0);
      }
      await page.keyboard.type('f');
      await expect
        .poll(async () => JSON.parse(await readFile(report, 'utf8')).phase)
        .toBe('finished');
      expect(JSON.parse(await readFile(report, 'utf8')).failed).toBeNull();
    } finally {
      if (existsSync(report))
        await testInfo.attach('tool-replay', { path: report, contentType: 'application/json' });
    }
  });
}

/**
 * A real foreground PTY client. There is no graphics decoder or reply mock in
 * the browser or the test process. Each exchange ends in DSR: its reply proves
 * that the canonical parser applied the suffix after the graphics boundary.
 * A suppressed reply is checked against that barrier, never against a sleep.
 * Only synthetic fixture bytes are written to the diagnostic transcript.
 *
 * Reply cases cover ingestion. The pixels case separately reads browser screenshots
 * after upload, replacement and deletion; OK replies alone never prove rendering.
 */
const GRAPHICS_CLIENT = String.raw`
import base64
import array
import fcntl
import json
import os
import select
import socket
import struct
import sys
import tempfile
import termios
import time
import tty
import zlib

mode, report_path, source_path = sys.argv[1:]
saved = termios.tcgetattr(0)
transcript = []
status = b"\x1b[0n"

def write(data):
    while data:
        count = os.write(1, data)
        if count <= 0:
            raise RuntimeError("PTY closed during output")
        data = data[count:]

def read_until(suffix):
    result = bytearray()
    deadline = time.monotonic() + (45 if mode in ["pixels", "placeholders", "native-pixels", "animation", "native-animation"] else 15)
    while not result.endswith(suffix):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError("PTY response deadline: " + bytes(result).hex())
        chunk = os.read(0, 4096)
        if not chunk:
            raise RuntimeError("PTY closed during response")
        result.extend(chunk)
        if len(result) > 16384:
            raise RuntimeError("unbounded PTY response")
    return bytes(result)

def apc(control, payload=b""):
    return b"\x1b_G" + control.encode("ascii") + b";" + payload + b"\x1b\\"

def reply(image, value="OK", number=None):
    control = "i=" + str(image)
    if number is not None:
        control += ",I=" + str(number)
    return apc(control, value.encode("ascii"))

def exchange(name, output, expected):
    write(output + b"\x1b[5n")
    actual = read_until(status)
    transcript.append({"name": name, "expected": (expected + status).hex(), "actual": actual.hex()})
    if actual != expected + status:
        raise AssertionError(name + ": " + actual.hex())

def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

def native_connection(operation):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(15)
    connection.connect(os.environ["MERKUR_IMAGE_SOCKET"])
    connection.sendall(bytes.fromhex(os.environ["MERKUR_IMAGE_CREDENTIAL"]) + bytes([operation]))
    return connection

def native_reply(connection):
    result = b""
    while len(result) != 33:
        data = connection.recv(33 - len(result))
        if not data:
            raise RuntimeError("native ingress closed")
        result += data
    return result

def native_submit(data, fmt=24, width=1, height=1):
    with tempfile.TemporaryFile() as source, native_connection(1) as connection:
        source.write(b"prefix!" + data + b"suffix!")
        source.flush()
        position = source.tell()
        request = struct.pack("<BBBBIII8xQQ", fmt, 0, 0, 0, width, height, 0, 7, len(data))
        connection.sendall(request)
        connection.sendmsg([b"\1"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [source.fileno()]))])
        result = native_reply(connection)
        if result[0] != 0:
            raise RuntimeError("native submission refused")
        if source.tell() != position:
            raise AssertionError("native ingress changed the caller's file offset")
        source.truncate(0)
        return result[1:].hex().encode("ascii")

def native():
    reference = native_submit(bytes([255, 0, 0]))
    exchange("native-not-published-by-arrival", apc("a=p,i=900"), reply(900, "ENOENT:image or frame does not exist"))
    exchange("native-publication-boundary", apc("a=t,t=n,i=900", reference), reply(900))
    exchange("native-reference-replay", apc("a=t,t=n,i=901", reference), reply(901, "ENOENT:image or frame does not exist"))
    reference = native_submit(bytes([0, 255, 0]))
    with native_connection(2) as connection:
        connection.sendall(bytes.fromhex(reference.decode()))
        if native_reply(connection)[0] != 0:
            raise AssertionError("native cancellation failed")
    exchange("native-cancelled-reference", apc("a=t,t=n,i=902", reference), reply(902, "ENOENT:image or frame does not exist"))
    reference = native_submit(bytes([0, 0, 255]))
    exchange("native-reset", b"\x1bc", b"")
    exchange("native-reset-reference", apc("a=t,t=n,i=903", reference), reply(903, "ENOENT:image or frame does not exist"))
    reference = native_submit(bytes([255, 255, 255]))
    exchange("native-query", apc("a=q,t=n,i=904", reference), reply(904))
    exchange("native-query-is-not-stored", apc("a=p,i=904"), reply(904, "ENOENT:image or frame does not exist"))

def pixel_upload(control, data, width=1, height=1, fmt=24):
    if mode in ["native-pixels", "native-animation"]:
        return apc(control + ",t=n", native_submit(data, fmt, width, height))
    payload = base64.b64encode(data)
    chunks = []
    for offset in range(0, len(payload), 4096):
        header = control + ",f=" + str(fmt) + ",s=" + str(width) + ",v=" + str(height) + "," if offset == 0 else ""
        header += "m=" + ("0" if offset + 4096 >= len(payload) else "1")
        chunks.append(apc(header, payload[offset:offset + 4096]))
    return b"".join(chunks)

def formats():
    rgb = bytes([255, 0, 1, 2, 254, 3])
    rgba = bytes([255, 0, 1, 128, 2, 254, 3, 0])
    png = (b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(b"\x00" + rgba))
        + png_chunk(b"IEND", b""))
    cases = [(24, rgb, ""), (32, rgba, ""), (100, png, ""),
             (24, zlib.compress(rgb), ",o=z"), (32, zlib.compress(rgba), ",o=z"),
             (100, zlib.compress(png), ",o=z,S=" + str(len(png)))]
    for action in ["q", "t"]:
        for index, (fmt, payload, compression) in enumerate(cases):
            image = 100 + index
            exchange(action + "-format-" + str(index),
                apc("a=" + action + ",f=" + str(fmt) + ",s=2,v=1,i=" + str(image) + compression,
                    base64.b64encode(payload)), reply(image))
    exchange("same-id-replacement", apc("a=t,f=24,s=1,v=1,i=100", b"////"), reply(100))
    exchange("anonymous-upload", apc("a=t,f=24,s=1,v=1", b"AAAA"), b"")
    # A worker-scoped daemon can retain the terminal's monotonic ID allocator
    # from an earlier session. Assert the protocol's fresh nonzero identity and
    # actual addressability, not that the terminal has never allocated an ID.
    allocated = set(range(100, 106))
    for name, payload in [("number-allocates-id", b"AAAA"), ("repeated-number-allocates-new-id", b"////")]:
        write(apc("a=t,f=24,s=1,v=1,I=700", payload) + b"\x1b[5n")
        actual = read_until(status)
        if not actual.startswith(b"\x1b_Gi="): raise AssertionError("missing allocated ID")
        identity = actual[5:].split(b",", 1)[0]
        if not identity.isdigit(): raise AssertionError("invalid allocated ID")
        image = int(identity)
        if not 0 < image <= 0xffffffff or image in allocated: raise AssertionError("reused image ID")
        allocated.add(image)
        expected = reply(image, number=700) + status
        transcript.append({"name": name, "expected": expected.hex(), "actual": actual.hex()})
        if actual != expected: raise AssertionError(name + ": " + actual.hex())
        exchange(name + "-addressable", apc("a=p,i=" + str(image) + ",c=1,r=1,C=1"), reply(image))

def rejection():
    for medium in ["f", "t", "s"]:
        for action in ["q", "t"]:
            exchange("denied-" + medium + "-" + action,
                apc("a=" + action + ",t=" + medium + ",f=24,s=1,v=1,i=200",
                    base64.b64encode(source_path.encode())),
                reply(200, "ENOTSUP:inline graphics required"))
    # Kitty answers short raw pixels with ENODATA and an undecodable PNG with EBADPNG.
    exchange("malformed-pixels", apc("a=q,f=24,s=1,v=1,i=201", b"AA=="),
        reply(201, "ENODATA:insufficient image data"))
    exchange("malformed-base64", apc("a=q,f=24,s=1,v=1,i=202", b"!!!!"),
        reply(202, "EINVAL:invalid image data"))
    exchange("truncated-png", apc("a=q,f=100,i=203", base64.b64encode(b"\x89PNG\r\n\x1a\n")),
        reply(203, "EBADPNG:invalid PNG data"))
    exchange("quiet-success", apc("a=q,f=24,s=1,v=1,i=204,q=1", b"AAAA"), b"")
    exchange("quiet-errors-only", apc("a=q,f=24,s=1,v=1,i=205,q=1", b"AA=="),
        reply(205, "ENODATA:insufficient image data"))
    exchange("quiet-error", apc("a=q,f=24,s=1,v=1,i=206,q=2", b"AA=="), b"")
    exchange("valid-after-errors", apc("a=q,f=24,s=1,v=1,i=207", b"AAAA"), reply(207))
    # Kitty answers data past its load buffer, the declared extent and ten bytes,
    # with EFBIG; Merkur's own 4096-byte chunk bound answers the same code.
    exchange("oversized-chunk", apc("a=q,f=24,s=1,v=1,i=208", b"A" * 4097),
        reply(208, "EFBIG:graphics data too large"))
    exchange("oversized-pixels", apc("a=q,f=24,s=1,v=1,i=212", b"A" * 24),
        reply(212, "EFBIG:graphics data too large"))
    exchange("oversized-dimension", apc("a=q,f=24,s=16385,v=1,i=209", b"AAAA"),
        reply(209, "EINVAL:invalid graphics command"))
    exchange("trailing-zlib", apc("a=q,f=24,s=1,v=1,i=210,o=z",
        base64.b64encode(zlib.compress(b"abc") + b"trailing")), reply(210, "EINVAL:invalid image data"))
    exchange("valid-after-resource-rejection", apc("a=q,f=24,s=1,v=1,i=211", b"AAAA"), reply(211))

def chunks():
    # The first barrier observes the still-open upload. The remaining 511
    # full chunks cross both the fixed owner queue and many PTY read buffers.
    exchange("open-upload", apc("a=t,f=24,s=1024,v=512,i=300,m=1", b"AAAA" * 1024), b"")
    write(b"\r\nKGP-chunks-UPLOAD-OPEN\r\n")
    if read_until(b"i") != b"i":
        raise AssertionError("input did not reach the open upload's PTY client")
    for index in range(511):
        write(apc("m=" + ("0" if index == 510 else "1"), b"AAAA" * 1024))
    exchange("final-chunk", b"", reply(300))
    exchange("quiet-continuation-open", apc("a=t,f=24,s=2,v=1,i=301,m=1", b"AAAA"), b"")
    exchange("quiet-continuation-final", apc("m=0,q=1", b"////"), b"")
    exchange("after-chunks", apc("a=q,f=24,s=1,v=1,i=302", b"AAAA"), reply(302))

def geometry():
    rows, cols, width, height = struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
    if width == 0 or height == 0:
        raise AssertionError("PTY did not receive measured pixel dimensions")
    expected = ("\x1b[4;" + str(height) + ";" + str(width) + "t").encode()
    exchange("pixel-query-matches-kernel", b"\x1b[14t", expected)
    exchange("character-query-matches-kernel", b"\x1b[18t",
        ("\x1b[8;" + str(rows) + ";" + str(cols) + "t").encode())
    exchange("geometry-survives-reset", b"\x1bc\x1b[14t", expected)


def placements():
    def placed(image, placement, value="OK"):
        return apc("i=" + str(image) + ",p=" + str(placement), value.encode())
    # As in Kitty, the cursor ends past the image's last column on its last row.
    exchange("transmit-and-place", b"\x1b[2;3H" + apc("a=T,f=24,s=1,v=1,i=600,p=1,c=4,r=2", b"AAAA")
        + b"\x1b[6n", placed(600, 1) + b"\x1b[3;7R")
    exchange("place-without-cursor-movement", apc("a=p,i=600,p=2,c=3,r=1,C=1") + b"\x1b[6n",
        placed(600, 2) + b"\x1b[3;7R")
    exchange("relative-placement-preserves-cursor", apc("a=p,i=600,p=3,P=600,Q=1,H=-2,V=1") + b"\x1b[6n",
        placed(600, 3) + b"\x1b[3;7R")
    exchange("relative-cycle-refused", apc("a=p,i=600,p=1,P=600,Q=3"),
        placed(600, 1, "ECYCLE:placement dependency cycle"))
    exchange("missing-parent-refused", apc("a=p,i=600,p=4,P=600,Q=99"),
        placed(600, 4, "ENOPARENT:parent placement does not exist"))
    exchange("soft-delete-parent", apc("a=d,d=i,i=600,p=1"), b"")
    exchange("dependent-was-deleted", apc("a=p,i=600,p=4,P=600,Q=3"),
        placed(600, 4, "ENOPARENT:parent placement does not exist"))
    exchange("soft-delete-keeps-image", apc("a=p,i=600,p=5,C=1"), placed(600, 5))
    exchange("replacement-retires-all-placements", apc("a=t,f=24,s=1,v=1,i=600", b"////"), reply(600))
    exchange("replacement-cannot-reuse-old-parent", apc("a=p,i=600,p=6,P=600,Q=5"),
        placed(600, 6, "ENOPARENT:parent placement does not exist"))
    exchange("virtual-placement", apc("a=p,i=600,p=7,U=1,c=4,r=2") + b"\x1b[6n",
        placed(600, 7) + b"\x1b[3;7R")
    exchange("virtual-relative-refused", apc("a=p,i=600,p=8,U=1,P=600,Q=7"),
        placed(600, 8, "EINVAL:invalid graphics command"))
    exchange("z-delete-preserves-virtual-prototype", apc("a=d,d=Z,z=0"), b"")
    exchange("virtual-parent-survives-spatial-deletion", apc("a=p,i=600,p=8,P=600,Q=7"), placed(600, 8))
    exchange("soft-delete-relative-placement", apc("a=d,d=i,i=600,p=8"), b"")
    exchange("soft-delete-virtual-prototype", apc("a=d,d=i,i=600,p=7"), b"")
    exchange("relative-soft-deletion-keeps-source", apc("a=p,i=600,p=9,C=1"), placed(600, 9))
    exchange("hard-delete", apc("a=d,d=I,i=600"), b"")
    exchange("hard-delete-removes-image", apc("a=p,i=600,p=9"),
        placed(600, 9, "ENOENT:image or frame does not exist"))
    exchange("chunked-placement-opens", apc("a=T,f=24,s=2,v=1,i=601,p=1,c=2,r=1,m=1", b"AAAA"), b"")
    exchange("chunked-placement-uses-final-cursor", b"\x1b[5;9H" + apc("m=0", b"////") + b"\x1b[6n",
        placed(601, 1) + b"\x1b[5;11R")
    exchange("reset-removes-placements", b"\x1bc" + apc("a=p,i=601,p=1"),
        placed(601, 1, "ENOENT:image or frame does not exist"))
    exchange("unplaced-range-source", apc("a=t,f=24,s=1,v=1,i=602", b"AAAA"), reply(602))
    exchange("range-delete-stored-source", apc("a=d,d=R,x=602,y=602"), b"")
    exchange("range-delete-removes-unplaced-image", apc("a=p,i=602,p=1"),
        placed(602, 1, "ENOENT:image or frame does not exist"))
    exchange("relative-source-parent", apc("a=T,f=24,s=1,v=1,i=603,p=1,C=1", b"AAAA"), placed(603, 1))
    exchange("relative-source-child", apc("a=T,f=24,s=1,v=1,i=604,p=1,P=603,Q=1", b"AAAA"), placed(604, 1))
    exchange("soft-delete-only-relative-placement", apc("a=d,d=i,i=604,p=1"), b"")
    exchange("relative-source-can-be-placed-again", apc("a=p,i=604,p=1,P=603,Q=1"), placed(604, 1))
    exchange("newer-parent-placement", apc("a=p,i=603,p=2,C=1"), placed(603, 2))
    exchange("reparent-older-child", apc("a=p,i=604,p=1,P=603,Q=2"), placed(604, 1))
    # The range selects the child itself. As in Kitty, it is deleted directly, not
    # through its parent's cascade, so its image survives its last placement.
    exchange("bulk-delete-selects-parent-and-child", apc("a=d,d=r,x=603,y=604"), b"")
    exchange("directly-selected-child-source-remains", apc("a=p,i=604,p=2"), placed(604, 2))
    exchange("explicitly-deleted-parent-source-remains", apc("a=p,i=603,p=3,C=1"), placed(603, 3))

def grid():
    def placed(placement, value="OK"):
        return apc("i=700,p=" + str(placement), value.encode())
    def probe(name, placement, parent, exists):
        exchange(name, apc("a=p,i=700,p=" + str(placement) + ",P=700,Q=" + str(parent)),
            placed(placement, "OK" if exists else "ENOPARENT:parent placement does not exist"))
    # Keep a virtual prototype so deleting a relative probe cannot release the
    # shared source before the next parent-existence check.
    exchange("grid-source", b"\x1bc" + apc("a=T,f=24,s=1,v=1,i=700,p=99,U=1,c=1,r=1", b"AAAA"), placed(99))
    exchange("margin-contained-image", b"\x1b[2;1H" + apc("a=p,i=700,p=1,c=2,r=4,C=1"), placed(1))
    exchange("top-margin-crop", b"\x1b[2;6r\x1b[1S" + apc("a=d,d=y,y=1"), b"")
    probe("clipped-origin-is-not-visible", 2, 1, True)
    exchange("relative-child-does-not-use-clipped-origin", apc("a=d,d=y,y=1"), b"")
    probe("child-follows-surviving-parent-cell", 10, 2, True)
    exchange("visible-tail-delete", apc("a=d,d=y,y=2"), b"")
    probe("visible-tail-delete-retired-parent", 3, 1, False)
    exchange("margin-crossing-image", b"\x1b[5;1H" + apc("a=p,i=700,p=4,c=2,r=4,C=1"), placed(4))
    exchange("whole-margin-scroll", b"\x1b[5S", b"")
    probe("crossing-image-survives", 5, 4, True)
    exchange("remove-probe", apc("a=d,d=i,i=700,p=5"), b"")
    exchange("crossing-image-remains-at-original-row", apc("a=d,d=y,y=5"), b"")
    probe("crossing-original-row-was-deleted", 6, 4, False)
    exchange("history-image", b"\x1b[r\x1b[1;1H" + apc("a=p,i=700,p=7,c=2,r=4,C=1"), placed(7))
    exchange("history-retirement-crops-tail", b"\x1b[2S\x1b[3J", b"")
    probe("tail-survives-history-retirement", 8, 7, True)
    exchange("clear-screen-includes-history-tail", b"\x1b[2J", b"")
    # A separate image also exercises lookup of a missing cross-image parent.
    exchange("probe-source", apc("a=t,f=24,s=1,v=1,i=701", b"AAAA"), reply(701))
    exchange("clear-screen-retired-parent", apc("a=p,i=701,p=1,P=700,Q=7"),
        apc("i=701,p=1", b"ENOPARENT:parent placement does not exist"))

def pixels():
    # Two flat colours cross the helper, finite encrypted object, verifier,
    # browser decoder and terminal GPU pass. Stay foreground until the browser
    # samples real presented pixels and explicitly requests replacement/deletion.
    virtual = ",U=1" if mode == "placeholders" else ""
    def placeholders(image, background=""):
        if not virtual:
            return
        for row, mark in enumerate([0x305, 0x30d, 0x30e, 0x310, 0x312, 0x33d]):
            text = ("\x1b[" + str(row + 1) + ";1H\x1b[38;2;0;" + str(image >> 8)
                + ";" + str(image & 255) + ";58;5;1m" + background
                + "\U0010eeee" + chr(mark) + "\u0305" + "\U0010eeee" * 11 + "\x1b[0m")
            write(text.encode())
    write(b"\x1b[2J\x1b[H\x1b[?25l")
    exchange("red-pixels", pixel_upload("a=T,i=800,p=1,c=12,r=6,C=1,z=1" + virtual, bytes([255, 0, 0])), apc("i=800,p=1", b"OK"))
    placeholders(800)
    write(b"\x1b[10;1HKGP-pixels-RED")
    if read_until(b"n") != b"n":
        raise AssertionError("unexpected replacement input")
    write(b"\x1b[H")
    write(pixel_upload("a=T,i=800,p=1,c=12,r=6,C=1,z=1" + virtual, bytes([0, 255, 0]) * (512 * 512), 512, 512))
    exchange("green-mip-replacement", b"", apc("i=800,p=1", b"OK"))
    write(b"\x1b[10;1HKGP-pixels-GREEN")
    if read_until(b"a") != b"a":
        raise AssertionError("unexpected alpha input")
    relative = ",P=800,Q=1" if virtual else ""
    exchange("alpha-over-green", b"\x1b[H" + pixel_upload("a=T,i=801,p=1,c=12,r=6,C=1,z=2" + relative, bytes([0, 0, 255, 128]), fmt=32), apc("i=801,p=1", b"OK"))
    if read_until(b"b") != b"b":
        raise AssertionError("unexpected background input")
    exchange("delete-alpha-and-green", apc("a=d,d=I,i=801") + apc("a=d,d=I,i=800"), b"")
    for row in range(1, 7):
        write(("\x1b[" + str(row) + ";1H\x1b[48;2;0;0;255m" + " " * 12 + "\x1b[0m").encode())
    # Kitty draws every placeholder image at z -1, above explicit cell backgrounds,
    # whatever z its virtual placement requests, so only direct placements go below.
    exchange("image-below-explicit-background", b"\x1b[H" + pixel_upload("a=T,i=802,p=1,c=12,r=6,C=1,z=-2147483648" + virtual, bytes([255, 0, 0])), apc("i=802,p=1", b"OK"))
    placeholders(802, "\x1b[48;2;0;0;255m")
    if read_until(b"z") != b"z":
        raise AssertionError("unexpected layer input")
    exchange("image-above-explicit-background", b"\x1b[H" + apc("a=p,i=802,p=1,c=12,r=6,C=1,z=-1" + virtual), apc("i=802,p=1", b"OK"))
    if read_until(b"d") != b"d":
        raise AssertionError("unexpected deletion input")
    exchange("delete-visible-pixels", apc("a=d,d=I,i=802") + b"\x1b[0m\x1b[2J", b"")
    write(b"\x1b[10;1HKGP-pixels-DELETED")
    if read_until(b"f") != b"f":
        raise AssertionError("unexpected finish input")
    write(b"\x1b[?25h")

def animation():
    write(b"\x1b[2J\x1b[H\x1b[?25l")
    exchange("animation-root", pixel_upload("a=T,i=810,p=1,c=12,r=6,C=1,z=1", bytes([255, 0, 0])), apc("i=810,p=1", b"OK"))
    if read_until(b"n") != b"n": raise AssertionError("animation green input")
    exchange("animation-green-frame", pixel_upload("a=f,i=810,z=2000", bytes([0, 255, 0])), apc("i=810,r=2", b"OK"))
    exchange("animation-select-green", apc("a=a,i=810,c=2,s=1,r=1,z=2000"), b"")
    if read_until(b"a") != b"a": raise AssertionError("animation blend input")
    exchange("animation-blended-frame", pixel_upload("a=f,i=810,c=2,z=2000", bytes([0, 0, 255, 128]), fmt=32), apc("i=810,r=3", b"OK"))
    exchange("animation-select-blend", apc("a=a,i=810,c=3"), b"")
    if read_until(b"b") != b"b": raise AssertionError("animation blue input")
    exchange("animation-blue-frame", pixel_upload("a=f,i=810,z=2000", bytes([0, 0, 255])), apc("i=810,r=4", b"OK"))
    exchange("animation-select-blue", apc("a=a,i=810,c=4"), b"")
    if read_until(b"z") != b"z": raise AssertionError("animation red input")
    exchange("animation-select-root", apc("a=a,i=810,c=1"), b"")
    if read_until(b"l") != b"l": raise AssertionError("animation loop input")
    exchange("animation-finite-loop", apc("a=a,i=810,s=3,v=2,c=1"), b"")
    if read_until(b"d") != b"d": raise AssertionError("animation delete input")
    exchange("animation-delete", apc("a=d,d=I,i=810") + b"\x1b[0m\x1b[2J", b"")
    if read_until(b"f") != b"f": raise AssertionError("animation finish input")
    write(b"\x1b[?25h")

def lifecycle():
    exchange("reset-open-upload", apc("a=t,f=24,s=2,v=1,i=400,m=1", b"AAAA"), b"")
    exchange("reset-cancels-upload", b"\x1bc", b"")
    exchange("reuse-id-after-reset", apc("a=t,f=24,s=1,v=1,i=400", b"////"), reply(400))
    exchange("cancel-apc", b"\x1b_Ga=t,f=24,s=1,v=1,i=401;AAAA\x18", b"")
    exchange("after-cancel", apc("a=q,f=24,s=1,v=1,i=401", b"AAAA"), reply(401))
    exchange("synchronized-validation",
        b"\x1b[?2026h" + apc("a=q,f=24,s=1,v=1,i=402", b"AAAA")
        + b"\x1b[c\x1b[?2026l", reply(402) + b"\x1b[?6c")

failed = None
try:
    tty.setraw(0)
    write(("\r\nKGP-" + mode + "-READY\r\n").encode())
    if read_until(b"g") != b"g":
        raise AssertionError("unexpected input before browser start")
    {"formats": formats, "rejection": rejection, "chunks": chunks, "lifecycle": lifecycle, "geometry": geometry, "placements": placements, "grid": grid, "pixels": pixels, "placeholders": pixels, "native": native, "native-pixels": pixels, "animation": animation, "native-animation": animation}[mode]()
except BaseException as error:
    failed = repr(error)
finally:
    termios.tcsetattr(0, termios.TCSANOW, saved)
    with open(report_path, "w") as report:
        json.dump({"mode": mode, "failed": failed, "exchanges": transcript}, report)
    write(("\r\nKGP-" + mode + ("-PASS" if failed is None else "-FAIL") + "\r\n").encode())
    if failed is not None:
        write((failed + "\r\n").encode())
sys.exit(0 if failed is None else 1)
`;

test('only the controlling attachment can change shared PTY and image geometry', async ({
  page,
  linkedDaemon,
}, testInfo) => {
  const output = await primeTerminal(page, linkedDaemon.daemonName);
  const client = join(linkedDaemon.daemonHome, 'geometry-owner.py');
  const report = testInfo.outputPath('geometry-owner.json');
  await writeFile(
    client,
    String.raw`
import fcntl, json, os, struct, sys, termios, tty
saved = termios.tcgetattr(0)
samples = []
try:
    tty.setraw(0)
    os.write(1, b'\r\nGEOMETRY-OWNER-READY\r\n')
    while True:
        key = os.read(0, 1)
        if key == b'x': break
        if key != b'q': continue
        samples.append(list(struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8))))
        with open(sys.argv[1] + '.tmp', 'w') as report: json.dump(samples, report)
        os.replace(sys.argv[1] + '.tmp', sys.argv[1])
finally:
    termios.tcsetattr(0, termios.TCSANOW, saved)
`,
  );
  await page.keyboard.type(`python3 ${shellQuote(client)} ${shellQuote(report)}\n`);
  await expectOutput(output, 'GEOMETRY-OWNER-READY');
  let samples = 0;
  const sample = async (target: Page): Promise<number[]> => {
    await target.keyboard.type('q');
    samples += 1;
    await expect
      .poll(async () =>
        existsSync(report) ? (JSON.parse(await readFile(report, 'utf8')) as number[][]).length : 0,
      )
      .toBe(samples);
    const values = JSON.parse(await readFile(report, 'utf8')) as number[][];
    const value = values[samples - 1];
    if (value === undefined) throw new Error('missing geometry sample');
    return value;
  };
  const canvasSize = (target: Page) =>
    target
      .locator('#terminal-output canvas')
      .first()
      .evaluate((canvas) => [
        canvas.getBoundingClientRect().width,
        canvas.getBoundingClientRect().height,
      ]);
  const before = await sample(page);
  const [rows, columns, pixelWidth, pixelHeight] = before;
  if (
    rows === undefined ||
    columns === undefined ||
    pixelWidth === undefined ||
    pixelHeight === undefined
  )
    throw new Error('incomplete PTY geometry');
  const charWidth = pixelWidth / columns;
  const charHeight = pixelHeight / rows;
  const requestedGeometry = async (target: Page): Promise<number[]> => {
    const [width, height] = await target.locator('#terminal-output').evaluate((container) => {
      const rect = container.getBoundingClientRect();
      return [rect.width, rect.height];
    });
    if (width === undefined || height === undefined) throw new Error('missing terminal viewport');
    const grid = computeTerminalGrid(width, height, charWidth, charHeight);
    return [grid.rows, grid.columns, grid.columns * charWidth, grid.rows * charHeight];
  };
  const observer = await page.context().newPage();
  // Playwright forces every Chromium page focused, including background tabs.
  // Drive its focus emulation explicitly so an observer really stays unfocused.
  const ownerFocus = await page.context().newCDPSession(page);
  const observerFocus = await page.context().newCDPSession(observer);
  try {
    await observer.setViewportSize({ width: 650, height: 550 });
    await observer.goto('/');
    await observer.getByTitle(`Connect to ${linkedDaemon.daemonName}`).click();
    await expectConnected(observer);
    await observerFocus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await ownerFocus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await expect.poll(() => observer.evaluate(() => document.hasFocus())).toBe(false);
    await expect.poll(() => sample(page)).toEqual(before);
    // Keyboard input activates its target tab, so query through the current
    // owner while checking that the background window cannot resize the PTY.
    expect(await sample(page)).toEqual(before);
    await expect.poll(() => canvasSize(page)).toEqual(before.slice(2));
    await observer.setViewportSize({ width: 540, height: 450 });
    expect(await sample(page)).toEqual(before);
    await observer.bringToFront();
    // The prior 650px viewport can commit before the latest 540px request.
    // Wait for the exact current container grid, not merely a smaller PTY.
    const transferred = await requestedGeometry(observer);
    await expect.poll(() => sample(observer)).toEqual(transferred);
    await page.setViewportSize({ width: 1000, height: 800 });
    expect(await sample(observer)).toEqual(transferred);
    // A hidden observer can retain its presented frame until it becomes visible.
    // The focused owner's canvas must reach the geometry committed by the PTY.
    await expect.poll(() => canvasSize(observer)).toEqual(transferred.slice(2));
    await page.bringToFront();
    const reclaimed = await requestedGeometry(page);
    await expect.poll(() => sample(page)).toEqual(reclaimed);
    await expect.poll(() => canvasSize(page)).toEqual(reclaimed.slice(2));
    await page.keyboard.type('x');
  } finally {
    await ownerFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await ownerFocus.detach();
    await observerFocus.detach();
    await observer.close();
    if (existsSync(report))
      await testInfo.attach('geometry-owner', { path: report, contentType: 'application/json' });
  }
});

for (const mode of [
  'formats',
  'rejection',
  'chunks',
  'lifecycle',
  'geometry',
  'placements',
  'grid',
  'pixels',
  'placeholders',
  'native',
  'native-pixels',
  'animation',
  'native-animation',
] as const) {
  test(`Kitty graphics ${mode} crosses the real browser, PTY and sandboxed helper`, async ({
    page,
    linkedDaemon,
  }, testInfo) => {
    const output = await primeTerminal(page, linkedDaemon.daemonName);
    const client = join(linkedDaemon.daemonHome, `graphics-${mode}.py`);
    const source = join(linkedDaemon.daemonHome, `graphics-${mode}.rgb`);
    const report = testInfo.outputPath('graphics-exchanges.json');
    const sourceBytes = Buffer.from([1, 2, 3]);
    await writeFile(client, GRAPHICS_CLIENT);
    await writeFile(source, sourceBytes);
    try {
      await page.keyboard.type(
        `python3 ${shellQuote(client)} ${mode} ${shellQuote(report)} ${shellQuote(source)}\n`,
      );
      await expectOutput(output, `KGP-${mode}-READY`);
      await page.keyboard.type('g');
      if (
        mode === 'pixels' ||
        mode === 'placeholders' ||
        mode === 'native-pixels' ||
        mode === 'animation' ||
        mode === 'native-animation'
      ) {
        const counts = () => pixelCounts(page);
        await expect
          .poll(async () => (await counts()).red, { timeout: 20_000 })
          .toBeGreaterThan(1000);
        await page.keyboard.type('n');
        await expect
          .poll(async () => (await counts()).green, { timeout: 20_000 })
          .toBeGreaterThan(1000);
        expect((await counts()).red).toBe(0);
        await page.keyboard.type('a');
        await expect
          .poll(async () => (await counts()).blend, { timeout: 20_000 })
          .toBeGreaterThan(1000);
        await page.keyboard.type('b');
        if (mode === 'placeholders') {
          // Kitty stacks placeholder images at z -1 whatever z was requested:
          // the image stays above the explicit background.
          await expect
            .poll(async () => (await counts()).red, { timeout: 20_000 })
            .toBeGreaterThan(1000);
          expect(await counts()).toMatchObject({ green: 0, blend: 0 });
        } else {
          await expect
            .poll(async () => (await counts()).blue, { timeout: 20_000 })
            .toBeGreaterThan(1000);
          expect((await counts()).red).toBe(0);
        }
        await page.keyboard.type('z');
        await expect
          .poll(async () => (await counts()).red, { timeout: 20_000 })
          .toBeGreaterThan(1000);
        if (mode === 'animation' || mode === 'native-animation') {
          await page.keyboard.type('l');
          // No PTY input between these observations: the worker must advance the
          // native timeline autonomously, then hold its finite-loop last frame.
          await expect
            .poll(async () => (await counts()).green, { timeout: 20_000 })
            .toBeGreaterThan(1000);
          await expect
            .poll(async () => (await counts()).blue, { timeout: 20_000 })
            .toBeGreaterThan(1000);
        }
        await page.keyboard.type('d');
        await expect.poll(counts).toEqual({ red: 0, green: 0, blue: 0, blend: 0 });
        await page.keyboard.type('f');
      }
      if (mode === 'chunks') {
        await expectOutput(output, 'KGP-chunks-UPLOAD-OPEN');
        await page.keyboard.type('i');
      }
      if (
        mode === 'pixels' ||
        mode === 'placeholders' ||
        mode === 'native-pixels' ||
        mode === 'animation' ||
        mode === 'native-animation'
      ) {
        await expect.poll(() => existsSync(report)).toBe(true);
      } else {
        await expect
          .poll(() => output.textContent(), { timeout: 45_000 })
          .toMatch(new RegExp(`KGP-${mode}-(PASS|FAIL)`));
        expect(await output.textContent()).toContain(`KGP-${mode}-PASS`);
      }
      // Even temporary-file transfer cannot unlink a path printed by the PTY.
      expect(await readFile(source)).toEqual(sourceBytes);
      const result = JSON.parse(await readFile(report, 'utf8'));
      expect(result.failed).toBeNull();
      expect(result.exchanges).toHaveLength(
        {
          formats: 18,
          rejection: 18,
          chunks: 5,
          lifecycle: 6,
          geometry: 3,
          placements: 34,
          grid: 20,
          pixels: 7,
          placeholders: 7,
          native: 8,
          'native-pixels': 7,
          animation: 10,
          'native-animation': 10,
        }[mode],
      );
      for (const exchange of result.exchanges) {
        expect(exchange.actual, exchange.name).toBe(exchange.expected);
      }
    } finally {
      if (existsSync(report)) {
        await testInfo.attach('graphics-exchanges', {
          path: report,
          contentType: 'application/json',
        });
      }
    }
  });
}
