//! Quinn's socket over a turmoil UDP socket.

use std::fmt;
use std::future::Future;
use std::io::{self, IoSliceMut};
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use wtransport::quinn::udp::{RecvMeta, Transmit};
use wtransport::quinn::{AsyncUdpSocket, UdpPoller};

type Readable = Pin<Box<dyn Future<Output = io::Result<()>> + Send>>;

pub struct SimSocket {
    /// The port the host's NAT maps this socket to now; a rebinding replaces it.
    mapped: Mutex<Mapped>,
    /// The address the host bound, which a NAT rebinding never changes.
    local: SocketAddr,
    /// The host this socket was bound on, when that host registered
    /// (`crate::hosts`); faults address hosts by it.
    host: Option<IpAddr>,
    /// turmoil's readiness future holds the receive lock while it waits, so
    /// a receive runs only once it has resolved.
    readable: Mutex<Option<Readable>>,
}

struct Mapped {
    socket: Arc<turmoil::net::UdpSocket>,
    /// The host's NAT rebinding this mapping belongs to.
    rebinds: u64,
}

impl fmt::Debug for SimSocket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SimSocket")
            .field("local", &self.local)
            .finish()
    }
}

impl SimSocket {
    pub fn bind(address: SocketAddr) -> io::Result<Self> {
        // Production binds dual-stack `[::]`; turmoil's hosts are IPv4, which
        // is the traffic such a socket carries here.
        let address = if address.is_ipv6() && address.ip().is_unspecified() {
            SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, address.port()))
        } else {
            address
        };
        let socket = bind(address)?;
        let local = socket.local_addr()?;
        let host = crate::hosts::current();
        crate::hosts::bound(host);
        Ok(Self {
            mapped: Mutex::new(Mapped {
                socket: Arc::new(socket),
                rebinds: crate::faults::nat_rebinds(host),
            }),
            local,
            host,
            readable: Mutex::new(None),
        })
    }

    /// The socket the host's NAT maps this one to now, moved to a new port
    /// when the NAT rebound since the last datagram.
    fn mapped(&self) -> io::Result<Arc<turmoil::net::UdpSocket>> {
        let mut mapped = self.mapped.lock().expect("mapping");
        let rebinds = crate::faults::nat_rebinds(self.host);
        if mapped.rebinds != rebinds {
            let address = SocketAddr::from((self.local.ip(), 0));
            *mapped = Mapped {
                socket: Arc::new(bind(address)?),
                rebinds,
            };
        }
        Ok(Arc::clone(&mapped.socket))
    }
}

/// Binds on the current host. turmoil binds synchronously behind its async
/// signature, so one poll completes it.
fn bind(address: SocketAddr) -> io::Result<turmoil::net::UdpSocket> {
    let mut bind = std::pin::pin!(turmoil::net::UdpSocket::bind(address));
    let Poll::Ready(socket) = bind
        .as_mut()
        .poll(&mut Context::from_waker(std::task::Waker::noop()))
    else {
        unreachable!("turmoil binds without waiting");
    };
    socket
}

#[derive(Debug)]
struct AlwaysWritable;

impl UdpPoller for AlwaysWritable {
    fn poll_writable(self: Pin<&mut Self>, _: &mut Context) -> Poll<io::Result<()>> {
        // turmoil's UDP has no backpressure; a full queue drops, as a network does.
        Poll::Ready(Ok(()))
    }
}

impl AsyncUdpSocket for SimSocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Box::pin(AlwaysWritable)
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        let socket = self.mapped()?;
        // A cut datagram is lost on the wire: the sender saw it leave.
        if crate::faults::admits(self.host) {
            socket.try_send_to(transmit.contents, transmit.destination)?;
            crate::trace::sent(
                socket.local_addr()?,
                transmit.destination,
                transmit.contents.len(),
            );
        }
        Ok(())
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let mut readable = self.readable.lock().expect("readiness lock");
        loop {
            if let Some(waiting) = readable.as_mut() {
                let ready = std::task::ready!(waiting.as_mut().poll(cx));
                *readable = None;
                ready?;
            }
            let socket = self.mapped()?;
            match socket.try_recv_from(&mut bufs[0]) {
                Ok((len, addr)) => {
                    let mut received = RecvMeta::default();
                    received.addr = addr;
                    received.len = len;
                    received.stride = len;
                    meta[0] = received;
                    return Poll::Ready(Ok(1));
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    // A rebinding strands a receive waiting on the old port.
                    let rebound = crate::faults::nat_rebound();
                    *readable = Some(Box::pin(async move {
                        tokio::select! {
                            ready = socket.readable() => ready,
                            () = rebound => Ok(()),
                        }
                    }));
                }
                Err(error) => return Poll::Ready(Err(error)),
            }
        }
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(self.local)
    }

    fn may_fragment(&self) -> bool {
        // As the production sockets set DONTFRAG: path MTU discovery runs.
        false
    }
}
