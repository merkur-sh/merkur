use super::*;
use ring::hmac;
use std::sync::Arc;
use tokio::time::{Duration, Instant, timeout};

/// Run by scripts/natlab/discovery.sh in a routed Linux namespace. Uses the
/// actual observer binary, daemon accept loop, TLS pin, and STUN socket.
#[tokio::test]
#[ignore = "requires the isolated routed discovery NAT lab"]
async fn natlab_live_discovery() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let mode = std::env::var("MERKUR_NATLAB_CASE").unwrap();
    let secret = URL_SAFE_NO_PAD
        .decode(std::env::var("MERKUR_STUN_TEST_SECRET").unwrap())
        .unwrap();
    let credential = StunCredential {
        servers: Arc::new(vec![
            "198.51.100.10:3478".into(),
            "198.51.100.11:3478".into(),
        ]),
        ticket: Arc::new(std::env::var("MERKUR_STUN_TEST_TICKET").unwrap()),
        integrity_key: Arc::new(hmac::Key::new(hmac::HMAC_SHA256, &secret)),
        expires_at: Instant::now() + Duration::from_secs(60),
    };
    let (endpoint, cert, info) = crate::webtransport::start_server(44300, None).unwrap();
    let endpoint = Arc::new(endpoint);
    let state = Arc::new(tokio::sync::RwLock::new(
        crate::webtransport::WebTransportState::from_server_info(cert, &info),
    ));
    let socket = state.read().await.discovery_socket.clone().unwrap();
    let (messages, mut message_rx) = tokio::sync::mpsc::channel(16);
    let (events, mut event_rx) = tokio::sync::mpsc::channel(16);
    let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel();
    let owner = tokio::spawn(crate::webtransport::accept_loop(
        endpoint,
        state.clone(),
        messages,
        events,
        shutdown_rx,
        None,
    ));
    let result = probe(&socket, &credential).await.unwrap();
    assert_eq!(result.local_port, 44300);
    let expected_public = if mode == "masquerade" {
        "198.51.100.1:44300"
    } else {
        "198.51.100.1:50000"
    };
    assert_eq!(result.public_addr, expected_public.parse().unwrap());
    assert_eq!(result.nat_mapping, NatMapping::EndpointIndependent);
    // Static SNAT rewrites the port; masquerade preserves it. Both are one
    // mapping seen from two addresses, which is what makes the verdict
    // above reachable at all.
    let expected_allocation = if mode == "masquerade" {
        PortAllocation::Preserved
    } else {
        PortAllocation::Stable
    };
    assert_eq!(result.port_allocation, expected_allocation);
    match mode.as_str() {
        "open" => {
            assert_eq!(result.nat_filtering, NatFiltering::EndpointIndependent);
            std::fs::write("/tmp/merkur-discovery-rebind-ready", b"ready").unwrap();
            timeout(Duration::from_secs(10), async {
                while !std::path::Path::new("/tmp/merkur-discovery-rebound").exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap();
            let rebound = probe(&socket, &credential).await.unwrap();
            assert_eq!(rebound.local_port, 44300, "the listener never rebinds");
            assert_eq!(rebound.public_addr, "198.51.100.1:50001".parse().unwrap());
            assert_ne!(
                rebound.nat_filtering,
                NatFiltering::EndpointIndependent,
                "an observer contacted in the first round cannot prove fresh address independence"
            );
        }
        "loss" => {
            // Every changed-source reply is lost while the mapping probe
            // was answered from the same path. By construction that is the
            // negative verdict: it withholds the punch and never the
            // candidate.
            assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
        }
        "address" => {
            assert_eq!(result.nat_filtering, NatFiltering::PortIndependent);
        }
        "port" => {
            assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
        }
        "masquerade" => {
            // Plain conntrack masquerade preserves the source port and
            // filters by 5-tuple. Before change-only responder ports, the
            // unsolicited changed-port reply was tracked as a flow ahead of
            // the daemon's own probe to that port, which then collided and
            // was translated to a fresh port — reading as symmetric.
            assert_eq!(result.nat_filtering, NatFiltering::PortDependent);
            assert!(!result.hairpin);
        }
        _ => panic!("unexpected lab case"),
    }
    let mapped = result.public_addr;
    let published = crate::webtransport::build_reprobe_result(
        None,
        Vec::new(),
        Ok(result),
        crate::webtransport::PriorReflexive::default(),
        None,
    );
    assert!(
        published.candidates.iter().any(|candidate| {
            candidate.kind == crate::webtransport::CandidateFlavor::Srflx
                && candidate.addr == mapped.ip().to_string()
                && candidate.port == mapped.port()
        }),
        "inconclusive filtering never suppresses the observed mapping"
    );
    assert!(message_rx.try_recv().is_err());
    assert!(event_rx.try_recv().is_err());
    assert!(state.read().await.peer_connections.is_empty());
    shutdown.send(()).unwrap();
    assert!(owner.await.unwrap().is_empty());
}
