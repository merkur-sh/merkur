# Native image submission

Local programs in a Merkur terminal can submit RGB, RGBA or PNG through a Unix socket,
avoiding base64 and bulk PTY traffic. The program opens its own source and transfers an
explicit descriptor extent. Merkur never opens or deletes a caller-supplied path.
Inline Kitty transfers remain available; file, temporary-file and shared-memory path
escape sequences remain refused.

The shell receives `MERKUR_IMAGE_SOCKET` and `MERKUR_IMAGE_CREDENTIAL`. The latter is a
terminal-specific, 32-byte secret encoded as 64 lowercase hexadecimal characters. Keep it
out of output and logs. The broker checks the socket peer's OS UID and this credential.
Knowing a terminal ID, socket path or image ID grants no submission authority.

The helper accepts regular files and regular memory-backed file objects. It checks the
extent and copies it into its confined private arena using positional reads, then closes
the descriptor before decoding. It never changes the caller's file offset or maps mutable
external storage. Keep source bytes stable until the submission response; subsequent
changes or truncation cannot alter the validated image. The source may already be unlinked.
The caller owns deletion. Existing image format, compression, size and processing limits
apply; see [isolated processing](../packages/merkur-image-worker/README.md).

Submission does not place or publish an image. A successful response contains a one-use
reference, which the program consumes with an APC at its intended position in terminal
output. This applies the same scene admission, placement, cursor, query and reply semantics
as inline uploads. References are terminal-bound and retire on consumption, explicit
cancellation, RIS or terminal retirement. There is no timeout-based expiry. Pending work
cannot publish a reference into a later reset generation.

## Local wire contract

Use one request per `AF_UNIX` / `SOCK_STREAM` connection. First send the decoded 32-byte
credential and one operation byte: `1` submits, `2` cancels. Invalid credentials close
the connection. All integers below are little-endian.

A submission then sends this exact 40-byte request:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 1 | Format: 24 RGB, 32 RGBA, 100 PNG |
| 1 | 1 | Compression: 0 none, 1 zlib |
| 2 | 2 | Zero; native input is never base64 |
| 4 | 4 | Pixel width; zero is allowed for PNG |
| 8 | 4 | Pixel height; zero is allowed for PNG |
| 12 | 4 | Inflated byte count, required for compressed PNG |
| 16 | 8 | Reserved, zero |
| 24 | 8 | Source byte offset |
| 32 | 8 | Source byte length, nonzero and at most 64 MiB |

After the request, use `sendmsg` to send one byte with value `1` and exactly one
`SCM_RIGHTS` descriptor. Keep the connection open for the response; disconnect or additional
input during decoding cancels the submission. A cancellation instead sends the 32-byte
reference directly after its operation byte, without any descriptor.

The response is exactly 33 bytes: status `0` for success or `1` for refusal, followed by
the 32-byte reference for a successful submission, or 32 zero bytes otherwise. A successful
cancel also returns zero bytes after its status. Refusal details do not echo caller data.
Read until all 33 bytes arrive; stream reads may split the response.

The broker admits at most eight connections and 32 retained or processing submissions.
Their bookkeeping, validated pixels and helper workspaces have separate bounded ownership.
Native and inline jobs share terminal and daemon image budgets. Processing capacity is
released after physical helper retirement, including cancellation. No background polling or
graphics processing occurs while the endpoint is idle.

## Ordering publication

Encode the returned reference as 64 lowercase hexadecimal characters and use it as the
payload of `ESC _ G ... ; reference ESC \` with `t=n`. Supported actions are `a=t`, `a=T`,
`a=q` and animation frame upload `a=f`. Chunking is forbidden. Decoding controls `f`, `o`, `s`, `v`, `S` and `O` are
forbidden because the descriptor request already owns their meaning. Image and placement
IDs, crop/layout controls and quiet mode retain their normal meanings. For `a=f`,
the validated native pixels are the patch; frame selection, composition and gaps use
the same transaction as an inline frame upload.

For example, this local Python program submits a PNG and places it at the next output
boundary. The application opens the supplied path; the daemon receives only the descriptor.

```python
import array
import os
import socket
import struct
import sys

with open(sys.argv[1], "rb") as source, socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
    sock.connect(os.environ["MERKUR_IMAGE_SOCKET"])
    credential = bytes.fromhex(os.environ["MERKUR_IMAGE_CREDENTIAL"])
    request = struct.pack("<BBBBIII8xQQ", 100, 0, 0, 0, 0, 0, 0, 0,
                          os.fstat(source.fileno()).st_size)
    sock.sendall(credential + b"\x01" + request)
    sock.sendmsg([b"\x01"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                             array.array("i", [source.fileno()]))])
    reply = b""
    while len(reply) < 33:
        part = sock.recv(33 - len(reply))
        if not part:
            raise RuntimeError("submission connection closed")
        reply += part
    if reply[0] != 0:
        raise RuntimeError("image submission refused")
    reference = reply[1:].hex()
    sys.stdout.write("\x1b_Ga=T,t=n,i=1,c=20,r=10,q=2;" + reference + "\x1b\\")
    sys.stdout.flush()
```

The reference is consumed even when later scene admission or placement fails. Never retry
that reference after an uncertain publication; use a new explicit submission. A reference
does not authorize browser asset reads: only publication into the terminal's live scene
can grant that authority.
