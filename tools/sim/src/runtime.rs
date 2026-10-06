//! Quinn's runtime on a turmoil host: tokio's tasks and timers, whose clock
//! the host has paused.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use wtransport::quinn::{AsyncTimer, AsyncUdpSocket, Runtime};

#[derive(Debug)]
pub struct SimRuntime;

impl Runtime for SimRuntime {
    fn new_timer(&self, at: Instant) -> Pin<Box<dyn AsyncTimer>> {
        Box::pin(tokio::time::sleep_until(at.into()))
    }

    fn new_pacing_timer(&self, at: Instant) -> Pin<Box<dyn AsyncTimer>> {
        // Production paces on its own precise scheduler; simulated time is exact.
        self.new_timer(at)
    }

    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send>>) {
        tokio::spawn(future);
    }

    fn wrap_udp_socket(&self, _: std::net::UdpSocket) -> io::Result<Arc<dyn AsyncUdpSocket>> {
        Err(io::Error::other(
            "a simulated endpoint never binds the host's network",
        ))
    }

    fn now(&self) -> Instant {
        tokio::time::Instant::now().into_std()
    }
}
