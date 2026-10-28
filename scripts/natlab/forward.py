#!/usr/bin/env python3
"""Keep the session's canonical loopback origin while placing peers behind NATs."""

import argparse
import asyncio
import signal
import sys


def endpoint(value):
    host, port = value.rsplit(":", 1)
    return host, int(port)


def initial_id(data):
    if len(data) < 7 or data[0] & 0x80 == 0:
        return None
    version = int.from_bytes(data[1:5], 'big')
    initial_type = 0 if version == 1 else 0x10 if version == 0x6b3343cf else None
    size = data[5]
    if initial_type is None or data[0] & 0x30 != initial_type or not 1 <= size <= 20:
        return None
    return data[6:6 + size] if len(data) >= 7 + size else None


async def tcp(listen, target):
    writers = set()

    def reset():
        for writer in tuple(writers):
            writer.close()

    async def accepted(reader, writer):
        writers.add(writer)
        remote_writer = None

        async def transfer(source, destination):
            while data := await source.read(65536):
                destination.write(data)
                await destination.drain()
            if destination.can_write_eof():
                destination.write_eof()

        try:
            remote_reader, remote_writer = await asyncio.open_connection(*target)
            writers.add(remote_writer)
            await asyncio.gather(transfer(reader, remote_writer), transfer(remote_reader, writer))
        except ConnectionError:
            pass
        finally:
            for connection in (writer, remote_writer):
                if connection is not None:
                    writers.discard(connection)
                    connection.close()
            await asyncio.gather(*(connection.wait_closed() for connection in (writer, remote_writer)
                                   if connection is not None), return_exceptions=True)

    server = await asyncio.start_server(accepted, *listen)
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, reset)
    print("NATLAB_PROXY_READY", flush=True)
    async with server:
        await server.serve_forever()


class ReturnPath(asyncio.DatagramProtocol):
    def __init__(self, forwarder, peer):
        self.forwarder = forwarder
        self.peer = peer

    def datagram_received(self, data, _source):
        if self.peer not in self.forwarder.partitioned:
            self.forwarder.listener.sendto(data, self.peer)


class DatagramForwarder(asyncio.DatagramProtocol):
    def __init__(self, target):
        self.target = target
        self.listener = None
        self.connections = {}
        self.partitioned = set()
        self.initial_ids = {}

    def connection_made(self, transport):
        self.listener = transport
        print("NATLAB_PROXY_READY", flush=True)

    async def open_peer(self, peer):
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: ReturnPath(self, peer), remote_addr=self.target
        )
        return transport

    async def send(self, connection, data):
        transport = await connection
        transport.sendto(data)

    def datagram_received(self, data, peer):
        initial = initial_id(data)
        if peer in self.partitioned:
            if initial is None or initial in self.initial_ids.get(peer, ()):
                return
            # The OS may reuse a retired socket's ephemeral port. A distinct QUIC
            # Initial is a new dial and must remain reachable through the fault.
            self.partitioned.remove(peer)
        if initial is not None:
            self.initial_ids.setdefault(peer, set()).add(initial)
        connection = self.connections.get(peer)
        if connection is None:
            if len(self.connections) >= 64:
                raise RuntimeError("NAT-lab relay connection capacity exceeded")
            connection = asyncio.create_task(self.open_peer(peer))
            self.connections[peer] = connection
        asyncio.create_task(self.send(connection, data))

    def reset(self):
        for connection in self.connections.values():
            if not connection.done():
                connection.cancel()
            elif not connection.cancelled():
                try:
                    connection.result().close()
                except OSError:
                    pass
        self.connections.clear()
        print("NATLAB_PROXY_RESET", flush=True)

    def partition_established(self):
        self.partitioned.update(self.connections)
        self.reset()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("protocol", choices=["tcp", "udp"])
    parser.add_argument("listen", type=endpoint)
    parser.add_argument("target", type=endpoint)
    args = parser.parse_args()
    if args.protocol == "tcp":
        await tcp(args.listen, args.target)
    else:
        transport, forwarder = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: DatagramForwarder(args.target), local_addr=args.listen
        )
        asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, forwarder.reset)
        asyncio.get_running_loop().add_signal_handler(signal.SIGUSR2, forwarder.partition_established)
        try:
            await asyncio.Future()
        finally:
            transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
