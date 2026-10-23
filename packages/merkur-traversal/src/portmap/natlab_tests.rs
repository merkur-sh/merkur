//! The acquisition path against a real miniupnpd, inside `scripts/natlab`.
//!
//! miniupnpd is what most consumer routers ship, and it serves UPnP IGD,
//! NAT-PMP and PCP from one mapping table: the case the "exactly one protocol
//! maps" rule exists for. The fakes in `fixture_tests` prove the wire format;
//! this proves the result against the daemon real gateways run, end to end: a
//! datagram from outside arrives through the mapping, renewal holds, and release
//! leaves the table empty. `scripts/natlab/portmap.sh` builds the namespaces,
//! runs one miniupnpd configuration per case, counts the table's rules once the
//! mapping is announced (before it sends the probe) and again after release.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use tokio::net::UdpSocket;

use super::*;

const PORT: u16 = 44_433;
/// Written once the lease exists: `<external ip> <external port>`.
const MAPPED_FILE: &str = "/tmp/natlab-portmap-mapped";

#[tokio::test]
#[ignore = "run by scripts/natlab/portmap.sh inside its namespaces"]
async fn natlab_portmap() {
    let case = std::env::var("MERKUR_NATLAB_CASE").expect("MERKUR_NATLAB_CASE");
    let reflexive: IpAddr = std::env::var("MERKUR_NATLAB_REFLEXIVE")
        .expect("MERKUR_NATLAB_REFLEXIVE")
        .parse()
        .expect("reflexive address");
    // The pinned port is held by the WebTransport endpoint in production; the
    // lab holds it here so the probe through the mapping has a receiver.
    let socket = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), PORT))
        .await
        .expect("bind the mapped port");
    let egress = super::super::egress::resolve_egress_path(None);
    let started = Instant::now();
    let outcome = acquire(PORT, egress.as_ref(), Some(reflexive)).await;
    let elapsed = started.elapsed();
    println!(
        "NATLAB_PORTMAP case={case} outcome={} elapsed_ms={}",
        outcome.metric_key(),
        elapsed.as_millis()
    );

    if case == "double-nat" {
        assert!(
            matches!(outcome, Outcome::InnerNat),
            "an inner router's lease must not be published: {}",
            outcome.metric_key()
        );
        return;
    }

    let Outcome::Mapped(lease) = outcome else {
        panic!("expected a lease, got {}", outcome.metric_key());
    };
    assert_eq!(lease.external.ip(), reflexive, "published on the verified address");
    match case.as_str() {
        // PCP and NAT-PMP answer from the first hop in one round trip; the IGD
        // needs a search and a description fetch first.
        "all" => assert_ne!(lease.protocol, Protocol::Upnp),
        // With the datagram protocols absent or silent, the IGD maps without
        // waiting out their ~7.75 s retransmission schedule.
        "upnp-only" | "datagram-silent" => {
            assert_eq!(lease.protocol, Protocol::Upnp);
            assert!(
                elapsed < Duration::from_secs(2),
                "UPnP waited on the datagram schedule: {elapsed:?}"
            );
        }
        other => panic!("unknown natlab case {other}"),
    }

    std::fs::write(
        MAPPED_FILE,
        format!("{} {}", lease.external.ip(), lease.external.port()),
    )
    .expect("announce the mapping");
    let mut buf = [0u8; 64];
    let (len, from) = tokio::time::timeout(Duration::from_secs(10), socket.recv_from(&mut buf))
        .await
        .expect("a datagram from outside arrives through the mapping")
        .expect("recv");
    println!(
        "NATLAB_PORTMAP arrived={:?} from={from}",
        String::from_utf8_lossy(&buf[..len])
    );

    let mut renewed = *lease;
    assert!(renew(&mut renewed).await, "the gateway renews its own lease");
    release(renewed).await;
    println!("NATLAB_PORTMAP released");
}
