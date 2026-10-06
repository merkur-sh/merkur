//! # WebTransport Connection
//!
//! [`Connection`] provides an essential building block for managing WebTransport
//! connections. It allows you to initiate, accept, and control data *streams*, send and receive
//! *datagrams*, monitor connection status, and interact with various aspects of your WebTransport
//! communication.
//!
//! WebTransport exchanges data either via [*streams*](crate#streams) or [*datagrams*](crate#datagrams).
//!
//! ## Streams
//! WebTransport streams provide a lightweight, ordered byte-stream abstraction.
//!
//! There are two fundamental types of streams:
//!  - *Unidirectional* streams carry data in a single direction, from the stream initiator to its peer.
//!  - *Bidirectional* streams allow for data to be sent in both directions.
//!
//! Both server and client endpoints have the capability to create an arbitrary number of streams to
//! operate concurrently.
//!
//! Each stream can be independently cancelled by both side.
//!
//! ### Examples
//! #### Open a stream
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Open a bi-directional stream
//! let (mut send_stream, mut recv_stream) = connection.open_bi().await?.await?;
//!
//! // Send data on the stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//!
//! // Receive data from the stream
//! let mut buffer = vec![0; 1024];
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//!
//! // Open an uni-directional stream (can only send data)
//! let mut send_stream = connection.open_uni().await?.await?;
//!
//! // Send data on the stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//! # Ok(())
//! # }
//! ```
//!
//! #### Accept a stream
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Await the peer opens a bi-directional stream
//! let (mut send_stream, mut recv_stream) = connection.accept_bi().await?;
//!
//! // Can send and receive data on peer's stream
//! send_stream.write_all(b"Hello, wtransport!").await?;
//! # let mut buffer = vec![0; 1024];
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//!
//! // Await the peer opens an uni-directional stream (can only receive data)
//! let mut recv_stream = connection.accept_uni().await?;
//!
//! // Receive data on the stream
//! let bytes_read = recv_stream.read(&mut buffer).await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Datagrams
//! WebTransport datagrams are similar to UDP datagrams but come with an
//! added layer of security through *encryption* and *congestion control*.
//! Datagrams can arrive out of order or might not arrive at all, offering
//! flexibility in data exchange scenarios.
//!
//! Unlike streams, which operate as byte-stream abstractions, WebTransport
//! datagrams act more like messages.
//!
//! ### Examples
//! ```no_run
//! # use anyhow::Result;
//! # async fn foo(connection: wtransport::Connection) -> Result<()> {
//! use wtransport::Connection;
//!
//! // Send datagram message
//! connection.send_datagram(b"Hello, wtransport!")?;
//!
//! // Receive a datagram message
//! let message = connection.receive_datagram().await?;
//! # Ok(())
//! # }
//! ```

use crate::datagram::Datagram;
use crate::datagram::DatagramBatch;
use crate::driver::utils::varint_w2q;
use crate::driver::Driver;
use crate::error::ConnectionError;
use crate::error::ExportKeyingMaterialError;
use crate::error::SendDatagramError;
use crate::stream::OpeningBiStream;
use crate::stream::OpeningUniStream;
use crate::stream::RecvStream;
use crate::stream::SendStream;
use crate::tls::Certificate;
use crate::tls::CertificateChain;
use crate::tls::HandshakeData;
use crate::SessionId;
use crate::VarInt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

#[inline(always)]
fn batch_payload_space(
    first_payload_space: usize,
    additional_entry_overhead: usize,
    datagram_count: usize,
) -> usize {
    let Some(additional_count) = datagram_count.checked_sub(1) else {
        return 0;
    };
    first_payload_space.saturating_sub(additional_count.saturating_mul(additional_entry_overhead))
}

/// A WebTransport session connection.
///
/// For more details, see the [module documentation](crate::connection).
///
/// May be cloned to obtain another handle to the same connection.
#[derive(Clone, Debug)]
pub struct Connection {
    quic_connection: quinn::Connection,
    driver: Arc<Driver>,
    session_id: SessionId,
}

impl Connection {
    pub(crate) fn new(
        quic_connection: quinn::Connection,
        driver: Driver,
        session_id: SessionId,
    ) -> Self {
        Self {
            quic_connection,
            driver: Arc::new(driver),
            session_id,
        }
    }

    /// Asynchronously accepts a unidirectional stream.
    ///
    /// This method is used to accept incoming unidirectional streams that have been initiated
    /// by the remote peer.
    /// It waits for the next unidirectional stream to be available, then wraps it in a
    /// [`RecvStream`] that can be used to read data from the stream.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel safe.
    pub async fn accept_uni(&self) -> Result<RecvStream, ConnectionError> {
        let stream = self
            .driver
            .accept_uni(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })?
            .into_stream();

        Ok(RecvStream::new(stream))
    }

    /// Asynchronously accepts a bidirectional stream.
    ///
    /// This method is used to accept incoming bidirectional streams that have been initiated
    /// by the remote peer.
    /// It waits for the next bidirectional stream to be available, then wraps it in a
    /// tuple containing a [`SendStream`] for sending data and a [`RecvStream`] for receiving
    /// data on the stream.
    ///
    /// # Cancel safety
    ///
    /// This method is cancel safe.
    pub async fn accept_bi(&self) -> Result<(SendStream, RecvStream), ConnectionError> {
        let stream = self
            .driver
            .accept_bi(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })?
            .into_stream();

        Ok((SendStream::new(stream.0), RecvStream::new(stream.1)))
    }

    /// Asynchronously opens a new unidirectional stream.
    ///
    /// This method is used to initiate the opening of a new unidirectional stream.
    ///
    /// # Asynchronous Behavior
    ///
    /// This method is asynchronous and involves two `await` points:
    ///
    /// 1. The first `await` occurs during the initial phase of opening the stream, which may involve awaiting
    ///    the flow controller. This wait is necessary to ensure proper resource allocation and flow control.
    ///    It is safe to cancel this `await` point if needed.
    ///
    /// 2. The second `await` is internal to the returned [`OpeningUniStream`] object when it is used to initialize
    ///    the WebTransport stream. Cancelling this latter future before it completes may result in the stream
    ///    being closed during initialization.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let send_stream = connection.open_uni().await?.await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn open_uni(&self) -> Result<OpeningUniStream, ConnectionError> {
        self.driver
            .open_uni(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Asynchronously opens a new bidirectional stream.
    ///
    /// This method is used to initiate the opening of a new bidirectional stream.
    ///
    /// # Asynchronous Behavior
    ///
    /// This method is asynchronous and involves two `await` points:
    ///
    /// 1. The first `await` occurs during the initial phase of opening the stream, which may involve awaiting
    ///    the flow controller. This wait is necessary to ensure proper resource allocation and flow control.
    ///    It is safe to cancel this `await` point if needed.
    ///
    /// 2. The second `await` is internal to the returned [`OpeningBiStream`] object when it is used to initialize
    ///    the WebTransport stream. Cancelling this latter future before it completes may result in the stream
    ///    being closed during initialization.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let (send_stream, recv_stream) = connection.open_bi().await?.await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn open_bi(&self) -> Result<OpeningBiStream, ConnectionError> {
        self.driver
            .open_bi(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Asynchronously receives an application datagram from the remote peer.
    ///
    /// This method is used to receive an application datagram sent by the remote
    /// peer over the connection.
    /// It waits for a datagram to become available and returns the received [`Datagram`].
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// let datagram = connection.receive_datagram().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn receive_datagram(&self) -> Result<Datagram, ConnectionError> {
        self.driver
            .receive_datagram(self.session_id)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Receive the oldest datagram accepted by `predicate`, leaving other
    /// lanes in QUIC's bounded receive buffer. The predicate must not block.
    /// Dropping this future never removes an unmatched datagram.
    pub async fn receive_datagram_matching(
        &self,
        predicate: impl FnMut(&[u8]) -> bool,
    ) -> Result<Datagram, ConnectionError> {
        self.driver
            .receive_datagram_matching(self.session_id, predicate)
            .await
            .map_err(|error| ConnectionError::with_driver_error(error, &self.quic_connection))
    }

    /// Receives every application datagram already received for this session, at least one,
    /// into `batch`, replacing what it held.
    ///
    /// Datagrams one QUIC packet carried arrive together, so a relay that forwards the batch as
    /// one unit (under [`hold_egress`](Self::hold_egress)) keeps them in one packet.
    pub async fn receive_datagrams(
        &self,
        batch: &mut DatagramBatch,
    ) -> Result<(), ConnectionError> {
        self.driver
            .receive_datagrams(self.session_id, batch)
            .await
            .map_err(|driver_error| {
                ConnectionError::with_driver_error(driver_error, &self.quic_connection)
            })
    }

    /// Keeps the underlying QUIC connection from building packets until the guard drops, so
    /// the datagrams and stream data admitted meanwhile can share packets. See
    /// [`quinn::Connection::hold_egress`].
    pub fn hold_egress(&self) -> quinn::EgressHold {
        self.quic_connection.hold_egress()
    }

    /// Sends an application datagram to the remote peer.
    ///
    /// Admission is non-dropping: if the bounded local QUIC queue has no room,
    /// this returns [`SendDatagramError::Backpressure`] and preserves every
    /// older queued datagram.
    ///
    /// This method is used to send an application datagram to the remote peer
    /// over the connection.
    /// The datagram payload is provided as a reference to a slice of bytes.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wtransport::Connection;
    /// # use anyhow::Result;
    /// # async fn run(connection: Connection) -> Result<()> {
    /// connection.send_datagram(b"Hello, wtransport!")?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn send_datagram<D>(&self, payload: D) -> Result<(), SendDatagramError>
    where
        D: AsRef<[u8]>,
    {
        self.driver.send_datagram(self.session_id, payload.as_ref())
    }

    /// Send an immutable payload without copying it into an HTTP/3 envelope.
    /// The carrier's own quarter-stream ID is encoded separately at QUIC
    /// packetization, so clones can travel across different WebTransport sessions.
    pub fn send_datagram_owned(&self, payload: bytes::Bytes) -> Result<(), SendDatagramError> {
        self.driver.send_datagram_owned(self.session_id, payload)
    }

    /// Closes the connection immediately.
    pub fn close(&self, error_code: VarInt, reason: &[u8]) {
        self.quic_connection.close(varint_w2q(error_code), reason);
    }

    /// Waits for the connection to be closed for any reason.
    pub async fn closed(&self) -> ConnectionError {
        self.quic_connection.closed().await.into()
    }

    /// Returns the WebTransport session identifier.
    #[inline(always)]
    pub fn session_id(&self) -> SessionId {
        self.session_id
    }

    /// Returns the peer's UDP address.
    ///
    /// **Note**: as QUIC supports migration, remote address may change
    /// during connection. Furthermore, when IPv6 support is enabled, IPv4
    /// addresses may be mapped to IPv6.
    #[inline(always)]
    pub fn remote_address(&self) -> SocketAddr {
        self.quic_connection.remote_address()
    }

    /// A stable identifier for this connection.
    ///
    /// Peer addresses and connection IDs can change, but this value will remain
    /// fixed for the lifetime of the connection.
    #[inline(always)]
    pub fn stable_id(&self) -> usize {
        self.quic_connection.stable_id()
    }

    /// Computes the maximum size of datagrams that may be passed to
    /// [`send_datagram`](Self::send_datagram).
    ///
    /// Returns `None` if datagrams are unsupported by the peer or disabled locally.
    ///
    /// This may change over the lifetime of a connection according to variation in the path MTU
    /// estimate. The peer can also enforce an arbitrarily small fixed limit, but if the peer's
    /// limit is large this is guaranteed to be a little over a kilobyte at minimum.
    ///
    /// Not necessarily the maximum size of received datagrams.
    #[inline(always)]
    pub fn max_datagram_size(&self) -> Option<usize> {
        self.quic_connection
            .max_datagram_size()
            .map(|quic_max_size| {
                quic_max_size.saturating_sub(Datagram::header_size(self.session_id))
            })
    }

    /// Application-payload bytes available for one prospective datagram.
    ///
    /// The returned value excludes both this session's exact HTTP/3 datagram
    /// header and the first prospective Quinn queue entry. It is an advisory
    /// planning snapshot; [`send_datagram`](Self::send_datagram) performs the
    /// final atomic, non-dropping admission. Read without the connection's
    /// state lock, as of its most recent release.
    #[inline(always)]
    pub fn datagram_send_buffer_space(&self) -> usize {
        self.quic_connection
            .delivery_state()
            .datagram_send_buffer_space
            .saturating_sub(Datagram::header_size(self.session_id))
    }

    /// This session's QUIC delivery state, read without taking the connection's
    /// state lock: what a holder of that lock saw at its most recent release.
    /// Datagram room is net of this session's HTTP/3 datagram header, as
    /// [`datagram_send_buffer_space`](Self::datagram_send_buffer_space) reports it.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    #[inline(always)]
    pub fn delivery_state(&self) -> quinn::DeliveryState {
        let mut state = self.quic_connection.delivery_state();
        state.datagram_send_buffer_space = state
            .datagram_send_buffer_space
            .saturating_sub(Datagram::header_size(self.session_id));
        state
    }

    /// Whether the connection has closed for any reason, read without taking
    /// its state lock.
    #[inline(always)]
    pub fn is_closed(&self) -> bool {
        self.quic_connection.is_closed()
    }

    /// Extra queue bytes consumed by every prospective datagram after the
    /// first in a batch budget.
    ///
    /// [`datagram_send_buffer_space`](Self::datagram_send_buffer_space) already
    /// reserves the first Quinn queue entry. Each additional datagram needs
    /// one Quinn entry plus this session's HTTP/3 datagram header.
    #[inline(always)]
    pub fn datagram_additional_entry_overhead(&self) -> usize {
        quinn_proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD
            .saturating_add(Datagram::header_size(self.session_id))
    }

    /// Aggregate application-payload bytes available for a batch containing
    /// exactly `datagram_count` prospective datagrams.
    ///
    /// This accounts for every Quinn queue entry and every HTTP/3 datagram
    /// header without a coarse reserve. Individual payloads must still satisfy
    /// [`max_datagram_size`](Self::max_datagram_size).
    #[inline(always)]
    pub fn datagram_batch_send_buffer_space(&self, datagram_count: usize) -> usize {
        batch_payload_space(
            self.datagram_send_buffer_space(),
            self.datagram_additional_entry_overhead(),
            datagram_count,
        )
    }

    /// Current best estimate of this connection's latency (round-trip-time).
    #[inline(always)]
    pub fn rtt(&self) -> Duration {
        self.quic_connection.rtt()
    }

    /// Derive keying material from this connection's TLS session secrets.
    ///
    /// When both peers call this method with the same `label` and `context`
    /// arguments and `output` buffers of equal length, they will get the
    /// same sequence of bytes in `output`. These bytes are cryptographically
    /// strong and pseudorandom, and are suitable for use as keying material.
    ///
    /// See [RFC5705](https://tools.ietf.org/html/rfc5705) for more information.
    pub fn export_keying_material(
        &self,
        output: &mut [u8],
        label: &[u8],
        context: &[u8],
    ) -> Result<(), ExportKeyingMaterialError> {
        self.quic_connection
            .export_keying_material(output, label, context)
            .map_err(|_: quinn::crypto::ExportKeyingMaterialError| ExportKeyingMaterialError)
    }

    /// Returns the peer's identity as a certificate chain if available.
    ///
    /// This function returns an `Option` containing a [`CertificateChain`]. If the peer's identity
    /// is available, it is converted into a `CertificateChain` and returned. If the peer's identity
    /// is not available, `None` is returned.
    pub fn peer_identity(&self) -> Option<CertificateChain> {
        self.quic_connection.peer_identity().map(|any| {
            any.downcast::<Vec<rustls_pki_types::CertificateDer<'static>>>()
                .expect("rustls certificate vector")
                .into_iter()
                .map(Certificate::from_rustls_pki)
                .collect()
        })
    }

    /// Retrieves handshake data associated with the connection.
    pub fn handshake_data(&self) -> HandshakeData {
        let hd = self
            .quic_connection
            .handshake_data()
            .expect("fully established connection")
            .downcast::<quinn::crypto::rustls::HandshakeData>()
            .expect("valid downcast");

        HandshakeData {
            alpn: hd.protocol,
            server_name: hd.server_name,
        }
    }

    /// Returns a reference to the inner QUIC connection for transport
    /// inspection and connection-level controls.
    ///
    /// Do not send application datagrams through the returned Quinn handle:
    /// Quinn's synchronous `send_datagram` deliberately evicts older queued
    /// units. [`send_datagram`](Self::send_datagram) is Merkur's atomic,
    /// non-dropping application-datagram boundary.
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    #[inline(always)]
    pub fn quic_connection(&self) -> &quinn::Connection {
        &self.quic_connection
    }

    /// Returns a mutable reference to the inner QUIC connection.
    ///
    /// As with [`quic_connection`](Self::quic_connection), application
    /// datagrams must use [`send_datagram`](Self::send_datagram).
    #[cfg(feature = "quinn")]
    #[cfg_attr(docsrs, doc(cfg(feature = "quinn")))]
    #[inline(always)]
    pub fn quic_connection_mut(&mut self) -> &mut quinn::Connection {
        &mut self.quic_connection
    }
}

#[cfg(test)]
mod admission_tests {
    use super::batch_payload_space;

    #[cfg(feature = "quinn")]
    async fn connected_pair_with_server_datagram_buffer(
        capacity: usize,
    ) -> (
        crate::Endpoint<crate::endpoint::endpoint_side::Server>,
        crate::Endpoint<crate::endpoint::endpoint_side::Client>,
        super::Connection,
        super::Connection,
    ) {
        use crate::{ClientConfig, Endpoint, Identity, ServerConfig};

        let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"]).unwrap();
        let certificate_hash = identity.certificate_chain().as_slice()[0].hash();
        let mut transport = quinn::TransportConfig::default();
        transport.datagram_send_buffer_size(capacity);
        let server_config = ServerConfig::builder()
            .with_bind_default(0)
            .with_custom_transport(identity, transport)
            .build();
        let server = Endpoint::server(server_config).unwrap();
        let port = server.local_addr().unwrap().port();
        let client_config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([certificate_hash])
            .build();
        let client = Endpoint::client(client_config).unwrap();

        let server_connect = async {
            server
                .accept()
                .await
                .await
                .expect("server QUIC handshake")
                .accept()
                .await
                .expect("server WebTransport accept")
        };
        let client_connect = client.connect(format!("https://[::1]:{port}"));
        let (server_connection, client_connection) = tokio::join!(server_connect, client_connect);
        (
            server,
            client,
            server_connection,
            client_connection.expect("client WebTransport connect"),
        )
    }

    #[test]
    fn batch_space_charges_every_entry_after_the_reserved_first() {
        assert_eq!(batch_payload_space(1_000, 37, 0), 0);
        assert_eq!(batch_payload_space(1_000, 37, 1), 1_000);
        assert_eq!(batch_payload_space(1_000, 37, 2), 963);
        assert_eq!(batch_payload_space(1_000, 37, 8), 741);
    }

    #[test]
    fn batch_space_saturates_for_impossible_and_overflowing_counts() {
        assert_eq!(batch_payload_space(31, 32, 2), 0);
        assert_eq!(batch_payload_space(usize::MAX, usize::MAX, 3), 0);
        assert_eq!(batch_payload_space(usize::MAX, usize::MAX, usize::MAX), 0);
    }

    #[test]
    fn exhaustive_batch_space_matches_checked_arithmetic_oracle() {
        for first_space in 0usize..=128 {
            for overhead in 0usize..=64 {
                for count in 0usize..=12 {
                    let expected = if count == 0 {
                        0
                    } else {
                        (count - 1)
                            .checked_mul(overhead)
                            .and_then(|cost| first_space.checked_sub(cost))
                            .unwrap_or(0)
                    };
                    assert_eq!(
                        batch_payload_space(first_space, overhead, count),
                        expected,
                        "first_space={first_space} overhead={overhead} count={count}",
                    );
                }
            }
        }
    }

    #[cfg(feature = "quinn")]
    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_display_and_control_producers_never_evict_the_fifo() {
        use crate::error::SendDatagramError;
        use std::sync::{Arc, Barrier, Mutex};

        const ADMITTED: usize = 4;
        const PRODUCERS: usize = 12;
        const PAYLOAD_LEN: usize = 64;
        // The first WebTransport session uses QUIC stream 0, whose HTTP/3
        // quarter-stream identifier has a one-byte varint encoding.
        const H3_HEADER_BYTES: usize = 1;

        let per_datagram =
            PAYLOAD_LEN + H3_HEADER_BYTES + quinn_proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let (_server, _client, server_connection, client_connection) =
            connected_pair_with_server_datagram_buffer(ADMITTED * per_datagram).await;

        assert_eq!(
            server_connection.datagram_batch_send_buffer_space(ADMITTED),
            ADMITTED * PAYLOAD_LEN,
        );
        assert!(
            server_connection.datagram_batch_send_buffer_space(ADMITTED + 1)
                < (ADMITTED + 1) * PAYLOAD_LEN
        );

        // A current-thread runtime cannot run Quinn's dequeue task while these
        // OS threads synchronously contend on the connection-state mutex. This
        // makes all producer interleavings deterministic with respect to the
        // fixed-capacity queue while leaving their linearization order free.
        let barrier = Arc::new(Barrier::new(PRODUCERS));
        let results = Arc::new(Mutex::new(Vec::with_capacity(PRODUCERS)));
        std::thread::scope(|scope| {
            for producer in 0..PRODUCERS {
                let connection = server_connection.clone();
                let barrier = Arc::clone(&barrier);
                let results = Arc::clone(&results);
                scope.spawn(move || {
                    barrier.wait();
                    // Even IDs model display sends; odd IDs model heartbeat or
                    // control sends sharing the same datagram queue.
                    let payload = vec![producer as u8; PAYLOAD_LEN];
                    let result = if producer % 2 == 0 {
                        connection.send_datagram_owned(payload.into())
                    } else {
                        connection.send_datagram(payload)
                    };
                    results.lock().unwrap().push((producer as u8, result));
                });
            }
        });
        let mut results = Arc::into_inner(results).unwrap().into_inner().unwrap();
        results.sort_by_key(|(producer, _)| *producer);
        let mut accepted = results
            .iter()
            .filter_map(|(producer, result)| result.is_ok().then_some(*producer))
            .collect::<Vec<_>>();
        let refused = results
            .iter()
            .filter_map(|(_, result)| result.as_ref().err())
            .collect::<Vec<_>>();
        assert_eq!(accepted.len(), ADMITTED);
        assert_eq!(refused.len(), PRODUCERS - ADMITTED);
        assert!(refused
            .iter()
            .all(|error| **error == SendDatagramError::Backpressure));

        let mut received = Vec::with_capacity(ADMITTED);
        for _ in 0..ADMITTED {
            let datagram = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client_connection.receive_datagram(),
            )
            .await
            .expect("accepted datagram delivery timed out")
            .expect("accepted datagram delivery failed");
            received.push(datagram.payload()[0]);
        }
        accepted.sort_unstable();
        received.sort_unstable();
        assert_eq!(received, accepted);
    }

    /// A packet's datagrams reach one batched read together, as payloads without their HTTP/3
    /// header, in order; the single read still takes exactly one.
    #[cfg(feature = "quinn")]
    #[tokio::test(flavor = "current_thread")]
    async fn one_packets_datagrams_are_received_as_one_batch() {
        let (_server, _client, server_connection, client_connection) =
            connected_pair_with_server_datagram_buffer(64 * 1024).await;
        {
            let _hold = server_connection.hold_egress();
            for fill in 1..=3u8 {
                server_connection.send_datagram([fill; 40]).unwrap();
            }
        }
        let mut batch = crate::datagram::DatagramBatch::default();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client_connection.receive_datagrams(&mut batch),
        )
        .await
        .expect("batched delivery timed out")
        .expect("batched delivery failed");
        let payloads = batch.payloads();
        assert_eq!(payloads.len(), 3);
        for (fill, payload) in (1..=3u8).zip(payloads) {
            assert_eq!(payload[..], [fill; 40]);
        }

        {
            let _hold = server_connection.hold_egress();
            server_connection.send_datagram([4; 40]).unwrap();
            server_connection.send_datagram([5; 40]).unwrap();
        }
        for fill in 4..=5u8 {
            let datagram = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                client_connection.receive_datagram(),
            )
            .await
            .expect("single delivery timed out")
            .expect("single delivery failed");
            assert_eq!(datagram.payload()[..], [fill; 40]);
        }
    }

    #[cfg(feature = "quinn")]
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "manual release-mode transport microbenchmark"]
    async fn benchmark_atomic_non_dropping_send_distribution() {
        use crate::datagram::Datagram;
        use std::hint::black_box;
        use std::sync::Mutex;
        use std::time::Instant;

        const BATCHES: usize = 1_000;
        const SENDS_PER_BATCH: usize = 256;
        const WARMUP: usize = 1_000;
        const PAYLOAD_LEN: usize = 64;
        const H3_HEADER_BYTES: usize = 1;
        let total_datagrams = BATCHES * SENDS_PER_BATCH + WARMUP;
        let per_datagram =
            PAYLOAD_LEN + H3_HEADER_BYTES + quinn_proto::DATAGRAM_SEND_BUFFER_ENTRY_OVERHEAD;
        let (_legacy_server, _legacy_client, legacy_connection, _legacy_peer) =
            connected_pair_with_server_datagram_buffer(total_datagrams * per_datagram).await;
        let (_atomic_server, _atomic_client, atomic_connection, _atomic_peer) =
            connected_pair_with_server_datagram_buffer(total_datagrams * per_datagram).await;
        let payload = [0x5a; PAYLOAD_LEN];
        let legacy_mutex = Mutex::new(());

        let legacy_send = || {
            let _admission = legacy_mutex.lock().unwrap();
            let encoded = Datagram::write(legacy_connection.session_id(), black_box(&payload))
                .into_quic_bytes();
            assert!(
                legacy_connection
                    .quic_connection()
                    .delivery_state()
                    .datagram_send_buffer_space
                    >= encoded.len()
            );
            legacy_connection
                .quic_connection()
                .send_datagram(encoded)
                .expect("legacy benchmark queue was pre-sized");
        };
        for _ in 0..WARMUP {
            legacy_send();
            atomic_connection
                .send_datagram(black_box(&payload))
                .expect("atomic benchmark queue was pre-sized");
        }

        let mut legacy_nanos = Vec::with_capacity(BATCHES);
        let mut atomic_nanos = Vec::with_capacity(BATCHES);
        for batch in 0..BATCHES {
            if batch.is_multiple_of(2) {
                let started = Instant::now();
                for _ in 0..SENDS_PER_BATCH {
                    legacy_send();
                }
                legacy_nanos.push(started.elapsed().as_nanos() as f64 / SENDS_PER_BATCH as f64);
                let started = Instant::now();
                for _ in 0..SENDS_PER_BATCH {
                    atomic_connection
                        .send_datagram(black_box(&payload))
                        .expect("atomic benchmark queue was pre-sized");
                }
                atomic_nanos.push(started.elapsed().as_nanos() as f64 / SENDS_PER_BATCH as f64);
            } else {
                let started = Instant::now();
                for _ in 0..SENDS_PER_BATCH {
                    atomic_connection
                        .send_datagram(black_box(&payload))
                        .expect("atomic benchmark queue was pre-sized");
                }
                atomic_nanos.push(started.elapsed().as_nanos() as f64 / SENDS_PER_BATCH as f64);
                let started = Instant::now();
                for _ in 0..SENDS_PER_BATCH {
                    legacy_send();
                }
                legacy_nanos.push(started.elapsed().as_nanos() as f64 / SENDS_PER_BATCH as f64);
            }
        }

        fn print_distribution(label: &str, samples: &mut [f64]) {
            samples.sort_by(f64::total_cmp);
            let at = |percent: usize| samples[(samples.len() - 1) * percent / 100];
            eprintln!(
                "{label} ns/send: median={:.3} p95={:.3} p99={:.3} worst={:.3}",
                at(50),
                at(95),
                at(99),
                samples[samples.len() - 1],
            );
        }
        print_distribution("legacy check+dropping-send", &mut legacy_nanos);
        print_distribution("atomic non-dropping-send", &mut atomic_nanos);
    }

    /// Component profile: immutable owners travel through atomic Quinn
    /// admission, with session prefixes kept separately until packetization.
    /// Pool selection and Noise sealing are measured in the dataplane profile.
    /// Includes writing the payload in both arms, excludes socket drain/waits.
    #[cfg(feature = "quinn")]
    #[tokio::test(flavor = "current_thread")]
    #[ignore = "paired release-mode owned-datagram experiment"]
    async fn owned_datagram_profile() {
        use bytes::Bytes;
        use std::{
            hint::black_box,
            time::{Duration, Instant},
        };
        fn owned_send(connection: &super::Connection, bytes: Bytes) {
            connection.send_datagram_owned(bytes).unwrap();
        }
        for payload_len in [64usize, 256, 1100] {
            for copies in [1usize, 2] {
                let (_server, _client, sender, receiver) =
                    connected_pair_with_server_datagram_buffer(64 * 1024).await;
                for burst in [1usize, 24] {
                    let mut pool: Vec<Option<Bytes>> = (0..burst)
                        .map(|_| {
                            let mut bytes = bytes::BytesMut::zeroed(payload_len);
                            // Keep shared metadata across freeze/try_into_mut cycles.
                            let tail = bytes.split_off(1);
                            bytes.unsplit(tail);
                            Some(bytes.freeze())
                        })
                        .collect();
                    let pointers: Vec<_> =
                        pool.iter().map(|b| b.as_ref().unwrap().as_ptr()).collect();
                    let mut scratch = vec![0; payload_len];
                    for round in 0..80 {
                        for owned in if round % 2 == 0 {
                            [false, true, true, false]
                        } else {
                            [true, false, false, true]
                        } {
                            let began = Instant::now();
                            for (index, slot) in pool.iter_mut().enumerate() {
                                if owned {
                                    let mut buffer = slot
                                        .take()
                                        .unwrap()
                                        .try_into_mut()
                                        .expect("all queued owners retired");
                                    buffer[..].fill(black_box(index as u8));
                                    let bytes = buffer.freeze();
                                    for _ in 0..copies {
                                        owned_send(&sender, bytes.clone());
                                    }
                                    *slot = Some(bytes);
                                } else {
                                    scratch.fill(black_box(index as u8));
                                    for _ in 0..copies {
                                        sender.send_datagram(black_box(&scratch)).unwrap();
                                    }
                                }
                            }
                            let elapsed = began.elapsed().as_nanos();
                            for index in 0..burst {
                                for _ in 0..copies {
                                    let received = tokio::time::timeout(
                                        Duration::from_secs(2),
                                        receiver.receive_datagram(),
                                    )
                                    .await
                                    .unwrap()
                                    .unwrap();
                                    assert_eq!(received.len(), payload_len);
                                    assert!(received.iter().all(|&b| b == index as u8));
                                }
                            }
                            for (slot, pointer) in pool.iter().zip(&pointers) {
                                assert_eq!(slot.as_ref().unwrap().as_ptr(), *pointer);
                                assert!(slot.as_ref().unwrap().is_unique());
                            }
                            if round >= 20 {
                                println!("owned-time bytes={payload_len} copies={copies} burst={burst} owned={owned} round={round} ns={} retained={}", elapsed / burst as u128, burst * payload_len);
                            }
                        }
                    }
                }
            }
        }
    }
}
