//! One edge attachment over WebTransport.
//!
//! The dial pins the edge certificate to the hashes the issuance named, writes
//! the routing preface on the first bidirectional stream, and keeps that
//! stream open: its reverse direction carries the edge's splice-control
//! events. After that the edge forwards opaque datagrams and durable streams:
//!
//! ```text
//! client → edge: [channel: u8][body_len: u32 BE][body]...
//! edge → client: [source_attachment: u64 BE][channel: u8][body_len: u32 BE][body]...
//! ```
//!
//! A stream whose prefix has the high bit set is finite: one graphics
//! transfer, `[u32 BE total][body]` then FIN, handed over as it arrives.
//!
//! A candidate attachment opens a second bidirectional stream after its
//! preface for rebind proof records, `[u32 BE len][JSON]` both ways; the edge
//! strips the daemon's selection byte before relaying an answer. It carries no
//! terminal data and ends when the edge selects the candidate or the attempt
//! ends.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};

use merkur_client::session::ConnId;
use merkur_edge_protocol::{
    EGRESS_BUDGET_CLOSE_CODE, EGRESS_BUDGET_CLOSE_REASON, MAX_PREFACE_LEN, SpliceControlEvent,
};
use merkur_wire::protocol::{CHANNEL_CTRL, CHANNEL_DISPLAY_COMMIT, CHANNEL_PTY};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use wtransport::error::ConnectionError;
use wtransport::{ClientConfig, Connection, Endpoint, VarInt};

mod egress;
mod ingress;
pub(crate) use egress::{Completion, Pending};
use egress::{Record, Writer};
use ingress::Lane;
pub use ingress::{InboundDelivery, InboundSender};
const MAX_READER_TASKS: usize = 16;

/// The dataplane's bound on one reliable record.
const MAX_RECORD_BYTES: usize = 16 * 1024 * 1024;
/// One candidate proof record, mirrored from the edge's and the daemon's
/// `MAX_RECORD`.
const MAX_PROOF_RECORD_BYTES: usize = 64 * 1024;
const FINITE_STREAM_BIT: u8 = 0x80;
/// The channels a direct path opens a stream for, mirrored from
/// `WEBTRANSPORT_CHANNELS`: control, pty and display commit.
const DIRECT_CHANNELS: [u8; 3] = [CHANNEL_CTRL, CHANNEL_PTY, CHANNEL_DISPLAY_COMMIT];

/// What a carrier's readers hand the driver.
pub enum Inbound {
    Splice(ConnId, SpliceControlEvent),
    Reliable {
        conn: ConnId,
        source: u64,
        channel: u8,
        payload: Vec<u8>,
    },
    Datagram {
        conn: ConnId,
        payload: bytes::Bytes,
    },
    Proof {
        conn: ConnId,
        payload: Vec<u8>,
    },
    Closed {
        conn: ConnId,
        egress_budget: bool,
    },
    Finite {
        conn: ConnId,
        stream: u64,
        part: Finite,
    },
}

/// One part of a finite stream, as its reader hands it over.
pub enum Finite {
    Begin {
        channel: u8,
        total: u32,
    },
    Data(Vec<u8>),
    /// A clean FIN, or a reset or the connection's end.
    End {
        complete: bool,
    },
}

/// Finite streams of every carrier, numbered apart.
static NEXT_FINITE: AtomicU64 = AtomicU64::new(1);

type StreamPair = (wtransport::SendStream, wtransport::RecvStream);
type PendingWriter = (StreamPair, mpsc::UnboundedReceiver<Record>);

enum BootstrapStreams {
    Relay {
        preface: StreamPair,
        proof: Option<PendingWriter>,
    },
    Direct(Vec<(u8, PendingWriter)>),
}

struct Bootstrap {
    conn: ConnId,
    inbound: InboundSender,
    streams: BootstrapStreams,
}

pub struct Carrier {
    connection: Connection,
    /// One persistent stream per channel, opened on first use. Each writer
    /// task owns its stream, so records on one channel stay in order and a
    /// slow stream never blocks the driver.
    writers: HashMap<u8, Writer>,
    /// A candidate's proof stream writer.
    proof: Option<Writer>,
    /// The daemon's own server rather than the edge.
    direct: bool,
    /// Streams stay unpolled until the driver accepts the dial completion.
    /// Box only this transient state so live carriers and reactor events stay small.
    bootstrap: Option<Box<Bootstrap>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Carrier {
    /// Dials `url` and attaches with `preface`. A `candidate` also opens its
    /// proof stream. The driver activates I/O after accepting the carrier.
    pub async fn dial(
        conn: ConnId,
        url: &str,
        cert_hashes: &[[u8; 32]],
        preface: &[u8],
        candidate: bool,
        origin: &str,
        inbound: InboundSender,
    ) -> Result<Self, String> {
        let config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes(
                cert_hashes
                    .iter()
                    .map(|hash| wtransport::tls::Sha256Digest::new(*hash)),
            )
            .build();
        let endpoint = Endpoint::client(config).map_err(|error| error.to_string())?;
        let connection = endpoint
            .connect(connect_options(url, origin))
            .await
            .map_err(|error| error.to_string())?;
        let (mut send, recv) = connection
            .open_bi()
            .await
            .map_err(|error| error.to_string())?
            .await
            .map_err(|error| error.to_string())?;
        send.write_all(preface)
            .await
            .map_err(|error| error.to_string())?;
        let (proof, proof_stream) = if candidate {
            let (send, recv) = connection
                .open_bi()
                .await
                .map_err(|error| error.to_string())?
                .await
                .map_err(|error| error.to_string())?;
            let (records, pending) = Writer::channel();
            (Some(records), Some(((send, recv), pending)))
        } else {
            (None, None)
        };
        Ok(Self {
            connection,
            writers: HashMap::new(),
            proof,
            direct: false,
            bootstrap: Some(Box::new(Bootstrap {
                conn,
                inbound,
                streams: BootstrapStreams::Relay {
                    preface: (send, recv),
                    proof: proof_stream,
                },
            })),
            tasks: Vec::new(),
        })
    }

    /// Dials the daemon's own WebTransport server at `addr`, pinned to
    /// `cert_hash`. It takes no preface. A bidirectional stream per channel
    /// (control, pty, display commit), opened here and prefixed with its channel
    /// byte on activation, carries records both ways, the daemon's without one.
    /// The connection's end is the carrier's.
    pub async fn dial_direct(
        conn: ConnId,
        addr: SocketAddr,
        cert_hash: [u8; 32],
        origin: &str,
        inbound: InboundSender,
    ) -> Result<Self, String> {
        let config = ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert_hash)])
            .build();
        let endpoint = Endpoint::client(config).map_err(|error| error.to_string())?;
        let connection = endpoint
            .connect(connect_options(&format!("https://{addr}"), origin))
            .await
            .map_err(|error| error.to_string())?;
        let mut writers = HashMap::new();
        let mut streams = Vec::with_capacity(DIRECT_CHANNELS.len());
        for channel in DIRECT_CHANNELS {
            let (send, recv) = connection
                .open_bi()
                .await
                .map_err(|error| error.to_string())?
                .await
                .map_err(|error| error.to_string())?;
            let (records, pending) = Writer::channel();
            streams.push((channel, ((send, recv), pending)));
            writers.insert(channel, records);
        }
        Ok(Self {
            connection,
            writers,
            proof: None,
            direct: true,
            bootstrap: Some(Box::new(Bootstrap {
                conn,
                inbound,
                streams: BootstrapStreams::Direct(streams),
            })),
            tasks: Vec::new(),
        })
    }

    /// No reader can publish before Connected has reached the session owner.
    /// Dropping an unfinished or rejected dial drops its unpolled streams.
    pub(crate) fn activate(&mut self) {
        let Bootstrap {
            conn,
            inbound,
            streams,
        } = *self.bootstrap.take().expect("carrier activated once");
        match streams {
            BootstrapStreams::Relay {
                preface: (send, recv),
                proof,
            } => {
                self.tasks.push(tokio::spawn(read_splice_events(
                    conn,
                    self.connection.clone(),
                    send,
                    recv,
                    inbound.clone(),
                )));
                if let Some(((send, recv), pending)) = proof {
                    self.tasks.push(tokio::spawn(write_proofs(send, pending)));
                    self.tasks
                        .push(tokio::spawn(read_proofs(conn, recv, inbound.clone())));
                }
                self.tasks.push(tokio::spawn(accept_streams(
                    conn,
                    self.connection.clone(),
                    inbound.clone(),
                )));
            }
            BootstrapStreams::Direct(streams) => {
                for (channel, ((send, recv), pending)) in streams {
                    self.tasks
                        .push(tokio::spawn(write_records(send, channel, pending)));
                    self.tasks.push(tokio::spawn(read_direct_records(
                        conn,
                        channel,
                        recv,
                        inbound.clone(),
                    )));
                }
                self.tasks.push(tokio::spawn(accept_direct_streams(
                    conn,
                    self.connection.clone(),
                    inbound.clone(),
                )));
                self.tasks.push(tokio::spawn(report_close(
                    conn,
                    self.connection.clone(),
                    inbound.clone(),
                )));
            }
        }
        for lane in [Lane::Display, Lane::Pulse] {
            self.tasks.push(tokio::spawn(read_datagrams(
                conn,
                self.connection.clone(),
                inbound.lane(lane),
                lane,
            )));
        }
    }

    pub(crate) fn send_proof(&self, payload: Vec<u8>) -> Result<Completion, Pending> {
        self.proof
            .as_ref()
            .expect("proof writer belongs to relay signaling")
            .send(payload)
    }

    pub(crate) fn send_reliable(
        &mut self,
        channel: u8,
        payload: Vec<u8>,
    ) -> Result<Completion, Pending> {
        if self.direct && !self.writers.contains_key(&channel) {
            // The direct path carries its channels' streams and no others: a
            // record for any other channel is reported as never written.
            return Ok(Completion::unwritten());
        }
        let connection = &self.connection;
        let tasks = &mut self.tasks;
        let writer = self.writers.entry(channel).or_insert_with(|| {
            let (sender, receiver) = Writer::channel();
            tasks.push(tokio::spawn(write_stream(
                connection.clone(),
                channel,
                receiver,
            )));
            sender
        });
        writer.send(payload)
    }

    /// Best effort, as datagrams are: a full send queue drops this one.
    pub fn send_datagram(&self, payload: &[u8]) -> bool {
        self.connection.send_datagram(payload).is_ok()
    }
}

impl Drop for Carrier {
    fn drop(&mut self) {
        self.connection.close(VarInt::from_u32(0), b"");
        for task in &self.tasks {
            task.abort();
        }
    }
}

async fn write_stream(
    connection: Connection,
    channel: u8,
    records: mpsc::UnboundedReceiver<Record>,
) {
    let Ok(opening) = connection.open_uni().await else {
        return;
    };
    let Ok(stream) = opening.await else {
        return;
    };
    write_records(stream, channel, records).await;
}

/// `[channel]`, then each record as `[u32 BE len][record]`.
async fn write_records(
    mut stream: wtransport::SendStream,
    channel: u8,
    mut records: mpsc::UnboundedReceiver<Record>,
) {
    if stream.write_all(&[channel]).await.is_err() {
        return;
    }
    while let Some(record) = records.recv().await {
        let Record {
            payload,
            lease: _lease,
            completed,
        } = record;
        if stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await
            .is_err()
            || stream.write_all(&payload).await.is_err()
        {
            return;
        }
        let _ = completed.send(());
    }
}

async fn write_proofs(
    mut stream: wtransport::SendStream,
    mut records: mpsc::UnboundedReceiver<Record>,
) {
    while let Some(record) = records.recv().await {
        let Record {
            payload,
            lease: _lease,
            completed,
        } = record;
        if payload.len() > MAX_PROOF_RECORD_BYTES {
            return;
        }
        if stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await
            .is_err()
            || stream.write_all(&payload).await.is_err()
        {
            return;
        }
        let _ = completed.send(());
    }
}

/// Its end is not the carrier's: selection or the attempt's end closes it.
async fn read_proofs(conn: ConnId, mut recv: wtransport::RecvStream, inbound: InboundSender) {
    while let Ok(Some((payload, lease))) =
        read_record_credited(&mut recv, MAX_PROOF_RECORD_BYTES, &inbound).await
    {
        if payload.is_empty() || !inbound.publish(Inbound::Proof { conn, payload }, lease) {
            return;
        }
    }
}

/// Splice events arrive as `[u32 BE len][JSON]` records. The preface's send
/// half stays alive with this task: finishing it would detach the attachment.
/// Their end is the attachment's, reported with whether the edge closed it
/// because its relay egress budget is spent.
async fn read_splice_events(
    conn: ConnId,
    connection: Connection,
    _preface: wtransport::SendStream,
    mut recv: wtransport::RecvStream,
    inbound: InboundSender,
) {
    while let Ok(Some((record, lease))) =
        read_record_credited(&mut recv, MAX_PREFACE_LEN, &inbound).await
    {
        // An event shape this client does not know is ignored, as the edge's
        // own reader does.
        if let Some(event) = SpliceControlEvent::decode(&record)
            && !inbound.publish(Inbound::Splice(conn, event), lease)
        {
            return;
        }
    }
    let egress_budget = matches!(
        connection.closed().await,
        ConnectionError::ApplicationClosed(close)
            if close.code() == VarInt::from_u32(EGRESS_BUDGET_CLOSE_CODE)
                && close.reason() == EGRESS_BUDGET_CLOSE_REASON
    );
    let _ = inbound
        .lane(Lane::Lifecycle)
        .send(Inbound::Closed {
            conn,
            egress_budget,
        })
        .await;
}

async fn accept_streams(conn: ConnId, connection: Connection, inbound: InboundSender) {
    let mut readers = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            Some(_) = readers.join_next(), if !readers.is_empty() => {},
            stream = connection.accept_uni(), if readers.len() < MAX_READER_TASKS => {
                let Ok(stream) = stream else { return; };
                readers.spawn(read_stream(conn, stream, inbound.clone()));
            }
        }
    }
}

async fn read_stream(conn: ConnId, mut stream: wtransport::RecvStream, inbound: InboundSender) {
    let mut head = [0u8; 9];
    if stream.read_exact(&mut head).await.is_err() {
        return;
    }
    let source = u64::from_be_bytes(head[..8].try_into().expect("eight bytes"));
    let channel = head[8];
    let inbound = inbound.channel_lane(channel);
    if channel & FINITE_STREAM_BIT != 0 {
        return read_finite(conn, channel, stream, inbound).await;
    }
    while let Ok(Some((payload, lease))) =
        read_record_credited(&mut stream, MAX_RECORD_BYTES, &inbound).await
    {
        let event = Inbound::Reliable {
            conn,
            source,
            channel,
            payload,
        };
        if !inbound.publish(event, lease) {
            return;
        }
    }
}

/// The daemon's records on a direct channel stream: `[u32 BE len][record]`,
/// without a source, since nothing but the daemon is at the other end.
async fn read_direct_records(
    conn: ConnId,
    channel: u8,
    mut stream: wtransport::RecvStream,
    inbound: InboundSender,
) {
    let inbound = inbound.channel_lane(channel);
    while let Ok(Some((payload, lease))) =
        read_record_credited(&mut stream, MAX_RECORD_BYTES, &inbound).await
    {
        let event = Inbound::Reliable {
            conn,
            source: 0,
            channel,
            payload,
        };
        if !inbound.publish(event, lease) {
            return;
        }
    }
}

/// A finite stream after its channel byte: `[u32 BE total]`, then its body
/// read by read until FIN.
async fn read_finite(
    conn: ConnId,
    channel: u8,
    mut stream: wtransport::RecvStream,
    inbound: InboundSender,
) {
    let inbound = inbound.channel_lane(channel);
    let mut total = [0u8; 4];
    if stream.read_exact(&mut total).await.is_err() {
        return;
    }
    let id = NEXT_FINITE.fetch_add(1, Ordering::Relaxed);
    let part = |part| Inbound::Finite {
        conn,
        stream: id,
        part,
    };
    let begin = Finite::Begin {
        channel,
        total: u32::from_be_bytes(total),
    };
    if !inbound.send(part(begin)).await {
        return;
    }
    let mut buffer = vec![0u8; 32 * 1024];
    let complete = loop {
        match stream.read(&mut buffer).await {
            Ok(Some(read)) => {
                let Some(lease) = inbound.reserve(read).await else {
                    return;
                };
                if !inbound.publish(part(Finite::Data(buffer[..read].to_vec())), lease) {
                    return;
                }
            }
            Ok(None) => break true,
            Err(_) => break false,
        }
    };
    let _ = inbound.send(part(Finite::End { complete })).await;
}

/// The daemon's finite streams on a direct attachment: the channel byte, and
/// no source, since nothing but the daemon is at the other end.
async fn accept_direct_streams(conn: ConnId, connection: Connection, inbound: InboundSender) {
    let mut readers = tokio::task::JoinSet::new();
    loop {
        let stream = tokio::select! {
            Some(_) = readers.join_next(), if !readers.is_empty() => continue,
            stream = connection.accept_uni(), if readers.len() < MAX_READER_TASKS => stream,
        };
        let Ok(mut stream) = stream else {
            return;
        };
        let inbound = inbound.clone();
        readers.spawn(async move {
            let mut channel = [0u8; 1];
            if stream.read_exact(&mut channel).await.is_err() {
                return;
            }
            if channel[0] & FINITE_STREAM_BIT == 0 {
                stream.stop(VarInt::from_u32(0));
                return;
            }
            read_finite(conn, channel[0], stream, inbound).await;
        });
    }
}

async fn report_close(conn: ConnId, connection: Connection, inbound: InboundSender) {
    connection.closed().await;
    let _ = inbound
        .lane(Lane::Lifecycle)
        .send(Inbound::Closed {
            conn,
            egress_budget: false,
        })
        .await;
}

/// UDP datagrams cannot exceed the 16-bit IP payload envelope. Reserve that
/// whole envelope before taking a packet from QUIC; no plaintext allocation or
/// application discard is needed while the selected lane has no credit.
const DATAGRAM_ENVELOPE_BYTES: usize = 65535;

async fn read_datagrams(conn: ConnId, connection: Connection, inbound: InboundSender, lane: Lane) {
    loop {
        let Some(lease) = inbound.reserve(DATAGRAM_ENVELOPE_BYTES).await else {
            return;
        };
        let datagram = connection
            .receive_datagram_matching(|packet| {
                let pulse = packet
                    .first()
                    .is_some_and(|channel| matches!(*channel, CHANNEL_PTY | CHANNEL_CTRL));
                pulse == (lane == Lane::Pulse)
            })
            .await;
        let Ok(datagram) = datagram else {
            return;
        };
        if !inbound.publish(
            Inbound::Datagram {
                conn,
                payload: datagram.payload(),
            },
            lease,
        ) {
            return;
        }
    }
}

/// One `[u32 BE len][body]` record, or `None` at a clean end of stream.
async fn read_record_credited(
    source: &mut (impl AsyncRead + Unpin),
    max_len: usize,
    inbound: &InboundSender,
) -> std::io::Result<Option<(Vec<u8>, crate::credit::Lease)>> {
    let mut header = [0u8; 4];
    if source.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    source.read_exact(&mut header[1..]).await?;
    let len = u32::from_be_bytes(header) as usize;
    if len > max_len {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized record",
        ));
    }
    let Some(lease) = inbound.reserve(len).await else {
        return Ok(None);
    };
    let mut body = vec![0u8; len];
    source.read_exact(&mut body).await?;
    Ok(Some((body, lease)))
}

fn connect_options(url: &str, origin: &str) -> wtransport::endpoint::ConnectOptions {
    wtransport::endpoint::ConnectOptions::builder(url)
        .add_header("origin", origin)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn immediate_splice_verdict_waits_for_driver_carrier_ownership() {
        for activate in [false, true] {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let identity = wtransport::Identity::self_signed(["localhost"]).unwrap();
            let cert_hash = *identity.certificate_chain().as_slice()[0].hash().as_ref();
            let endpoint = Endpoint::server(
                wtransport::ServerConfig::builder()
                    .with_bind_address("127.0.0.1:0".parse().unwrap())
                    .with_identity(identity)
                    .build(),
            )
            .unwrap();
            let url = format!("https://{}", endpoint.local_addr().unwrap());
            let (inbound, mut received) = InboundSender::channel();
            let verdict = SpliceControlEvent::CounterpartPresent {
                present: true,
                counterpart_attachment_id: Some(7),
            };
            let accept = async {
                let connection = endpoint
                    .accept()
                    .await
                    .await
                    .unwrap()
                    .accept()
                    .await
                    .unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                recv.read_exact(&mut [0u8; 1]).await.unwrap();
                send.write_all(&verdict.encode()).await.unwrap();
                // An acknowledged FIN proves the complete verdict is already at the
                // client, independent of whether the driver accepted its dial yet.
                send.finish().await.unwrap();
                (connection, send, recv)
            };
            let cert_hashes = [cert_hash];
            let (server, carrier) = tokio::join!(
                accept,
                Carrier::dial(
                    ConnId(1),
                    &url,
                    &cert_hashes,
                    b"!",
                    false,
                    "https://account.example",
                    inbound
                ),
            );
            let mut carrier = carrier.unwrap();
            tokio::task::yield_now().await;
            assert!(
                received.control.try_recv().is_err(),
                "a verdict escaped before dial completion was accepted"
            );
            if activate {
                // The driver inserts the carrier and applies Connected before activation.
                carrier.activate();
                let delivery = received.control.recv().await.unwrap();
                assert!(
                    matches!(delivery.into_parts().0, Inbound::Splice(ConnId(1), event) if event == verdict)
                );
                drop((carrier, server));
            } else {
                // A dial the driver retired must leave no detached reader that can
                // publish this buffered verdict or a stale close afterwards.
                drop(carrier);
                server.0.closed().await;
                assert!(received.control.try_recv().is_err());
                assert!(received.lifecycle.try_recv().is_err());
            }
        }
    }

    #[test]
    fn relay_and_direct_options_send_only_the_canonical_account_origin() {
        for url in ["https://edge.example:4433", "https://[::1]:4433"] {
            let options = connect_options(url, "https://account.example");
            assert_eq!(options.url(), url);
            assert_eq!(options.additional_headers().len(), 1);
            assert_eq!(
                options
                    .additional_headers()
                    .get("origin")
                    .map(String::as_str),
                Some("https://account.example")
            );
        }
    }

    #[tokio::test]
    async fn reliable_body_reads_wait_for_credit_and_keep_it_until_the_driver_consumes() {
        use tokio::io::AsyncWriteExt;
        let (inbound, mut received) = InboundSender::channel();
        let charge = 64 * 1024 * 1024 - std::mem::size_of::<InboundDelivery>();
        let held = inbound.reserve(charge).await.unwrap();
        let (mut source, mut sink) = tokio::io::duplex(64);
        sink.write_all(&[0, 0, 0, 3, b'a', b'b', b'c'])
            .await
            .unwrap();
        let mut reading = Box::pin(read_record_credited(
            &mut source,
            MAX_RECORD_BYTES,
            &inbound,
        ));
        assert!(futures::poll!(&mut reading).is_pending());
        drop(held);
        let (payload, lease) = reading.await.unwrap().unwrap();
        assert_eq!(payload, b"abc");
        assert!(inbound.publish(
            Inbound::Proof {
                conn: ConnId(1),
                payload
            },
            lease
        ));
        // The complete body is still resident in the queued delivery.
        let mut all = Box::pin(inbound.reserve(charge));
        assert!(futures::poll!(&mut all).is_pending());
        let (event, lease) = received.control.recv().await.unwrap().into_parts();
        assert!(matches!(event, Inbound::Proof { payload, .. } if payload == b"abc"));
        assert!(futures::poll!(&mut all).is_pending());
        drop(lease);
        assert!(all.await.is_some());
    }

    #[tokio::test]
    async fn cancelling_a_reader_waiting_for_credit_returns_its_record_slot() {
        use tokio::io::AsyncWriteExt;
        let (inbound, _received) = InboundSender::channel();
        let charge = 64 * 1024 * 1024 - std::mem::size_of::<InboundDelivery>();
        let held = inbound.reserve(charge).await.unwrap();
        let (mut source, mut sink) = tokio::io::duplex(64);
        sink.write_all(&[0, 0, 0, 3, b'a', b'b', b'c'])
            .await
            .unwrap();
        let mut reading = Box::pin(read_record_credited(
            &mut source,
            MAX_RECORD_BYTES,
            &inbound,
        ));
        assert!(futures::poll!(&mut reading).is_pending());
        drop(reading);
        drop(held);
        // Every count slot can be reserved again; the cancelled body never owned bytes.
        let mut leases = Vec::new();
        for _ in 0..64 {
            leases.push(inbound.reserve(0).await.unwrap());
        }
    }
}
