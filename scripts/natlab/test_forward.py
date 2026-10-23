import asyncio
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('natlab_forward', Path(__file__).with_name('forward.py'))
forward = importlib.util.module_from_spec(spec)
spec.loader.exec_module(forward)


class Inbox(asyncio.DatagramProtocol):
    def __init__(self):
        self.messages = asyncio.Queue()
        self.closed = asyncio.get_running_loop().create_future()

    def datagram_received(self, payload, source):
        self.messages.put_nowait((payload, source))

    def connection_lost(self, _error):
        self.closed.set_result(None)


class Echo(Inbox):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, payload, source):
        super().datagram_received(payload, source)
        self.transport.sendto(payload, source)


class EstablishedPartition(unittest.IsolatedAsyncioTestCase):
    async def test_a_new_quic_initial_can_reuse_a_partitioned_socket_port(self):
        loop = asyncio.get_running_loop()
        upstream, echo = await loop.create_datagram_endpoint(Echo, local_addr=('127.0.0.1', 0))
        listener, proxy = await loop.create_datagram_endpoint(
            lambda: forward.DatagramForwarder(upstream.get_extra_info('sockname')),
            local_addr=('127.0.0.1', 0),
        )
        old, inbox = await loop.create_datagram_endpoint(Inbox, local_addr=('127.0.0.1', 0))
        recycled = None
        initial = lambda cid: b'\xc0\x00\x00\x00\x01\x08' + cid + b'\x00\x00\x01\x00'
        first, successor = initial(b'old-dcid'), initial(b'new-dcid')
        try:
            target = listener.get_extra_info('sockname')
            address = old.get_extra_info('sockname')
            old.sendto(first, target)
            self.assertEqual((await asyncio.wait_for(inbox.messages.get(), 1))[0], first)
            await asyncio.wait_for(echo.messages.get(), 1)
            proxy.partition_established()
            old.close()
            await asyncio.wait_for(inbox.closed, 1)
            recycled, received = await loop.create_datagram_endpoint(Inbox, local_addr=address)
            recycled.sendto(first, target)
            recycled.sendto(successor, target)
            self.assertEqual((await asyncio.wait_for(received.messages.get(), 1))[0], successor)
            self.assertEqual((await asyncio.wait_for(echo.messages.get(), 1))[0], successor)
            self.assertTrue(echo.messages.empty())
        finally:
            proxy.reset()
            for transport in (old, recycled, listener, upstream):
                if transport is not None:
                    transport.close()

    async def test_existing_relay_tuple_is_blackholed_but_new_dials_reach_real_udp(self):
        loop = asyncio.get_running_loop()
        upstream, echo = await loop.create_datagram_endpoint(Echo, local_addr=('127.0.0.1', 0))
        listener, proxy = await loop.create_datagram_endpoint(
            lambda: forward.DatagramForwarder(upstream.get_extra_info('sockname')),
            local_addr=('127.0.0.1', 0),
        )
        old, old_inbox = await loop.create_datagram_endpoint(Inbox, local_addr=('127.0.0.1', 0))
        new, new_inbox = await loop.create_datagram_endpoint(Inbox, local_addr=('127.0.0.1', 0))
        try:
            target = listener.get_extra_info('sockname')
            old.sendto(b'before-partition', target)
            self.assertEqual((await asyncio.wait_for(old_inbox.messages.get(), 1))[0],
                             b'before-partition')
            await asyncio.wait_for(echo.messages.get(), 1)
            proxy.partition_established()
            old.sendto(b'old-carrier-must-not-escape', target)
            # A new local tuple is an actual new client dial, admitted without unblocking old ones.
            new.sendto(b'successor-carrier', target)
            self.assertEqual((await asyncio.wait_for(new_inbox.messages.get(), 1))[0],
                             b'successor-carrier')
            payload, _ = await asyncio.wait_for(echo.messages.get(), 1)
            self.assertEqual(payload, b'successor-carrier')
            self.assertTrue(echo.messages.empty())
            self.assertTrue(old_inbox.messages.empty())
        finally:
            proxy.reset()
            for transport in (old, new, listener, upstream):
                transport.close()


if __name__ == '__main__':
    unittest.main()
