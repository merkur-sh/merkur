//! Native UDP traversal authority and tasks. Browser punch/admission is independent.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_e2e::traversal::TraversalKey;
use merkur_stun_protocol::observation::Receipt;
use merkur_wire::signaling::{CandidateKind, CandidateScope, DaemonSignal, DirectCandidate};
use merkur_wire::traversal::{Offer, Snapshot};
use ring::hmac;
use tokio::sync::{RwLock, Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use zeroize::Zeroize;

use crate::connection::PeerDisplayState;
use crate::ipc::commands::RegisterTraversalCmd;
use crate::network::NetworkState;

use super::{CandidateFlavor, WebTransportState};

/// The server issues the same ninety-second ticket for daemon and native discovery.
const MAX_CREDENTIAL_LIFETIME_MS: u64 = 90_000;
/// Wire fact: counters and generations cross JavaScript's exact integer range.
const MAX_GENERATION: u64 = 9_007_199_254_740_991;

struct Credential {
    generation: u64,
    ticket: [u8; 41],
    key: hmac::Key,
    expires: Instant,
}

#[derive(Default)]
pub(crate) struct NativeTraversal {
    high_water: u64,
    credential: Option<Credential>,
    snapshot: Option<Snapshot>,
    offer: Option<Offer>,
    tasks: Vec<JoinHandle<()>>,
    authorities: Vec<merkur_traversal::check::Authority>,
    quota: Option<Arc<Semaphore>>,
}

impl NativeTraversal {
    pub(crate) fn announced(&self) -> bool {
        self.snapshot.is_some()
    }

    pub(crate) fn needs_refresh(&self) -> bool {
        self.snapshot.is_some() && self.offer.is_none()
    }

    #[cfg(test)]
    pub(crate) fn first_authority(&self) -> Option<merkur_traversal::check::Authority> {
        self.authorities.first().cloned()
    }

    fn stop_checks(&mut self) {
        for authority in self.authorities.drain(..) {
            authority.revoke();
        }
        for task in self.tasks.drain(..) {
            task.abort();
        }
        self.offer = None;
    }
}

impl Drop for NativeTraversal {
    fn drop(&mut self) {
        self.stop_checks();
        if let Some(credential) = &mut self.credential {
            credential.ticket.zeroize();
        }
    }
}

fn decode<const N: usize>(text: &str) -> Option<[u8; N]> {
    let bytes: [u8; N] = URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()?;
    (URL_SAFE_NO_PAD.encode(bytes) == text).then_some(bytes)
}

/// A control command can grant authority only to the exact current authenticated peer.
pub(crate) fn register(peer: &mut PeerDisplayState, command: &RegisterTraversalCmd) -> bool {
    if !peer.authenticated
        || !peer.is_e2e_ready()
        || peer.signal_session_id != command.session_id
        || peer.peer_id.as_ref() != command.browser_node_id
        || peer.delegation_id != command.delegation_id
        || peer.rebind.as_ref().map_or(0, |rebind| rebind.counter) != command.rebind_counter
        || command.rebind_counter > MAX_GENERATION
        || command.generation == 0
        || command.generation > MAX_GENERATION
        || command.lifetime_ms == 0
        || command.lifetime_ms > MAX_CREDENTIAL_LIFETIME_MS
    {
        return false;
    }
    let Some(ticket) = decode::<41>(&command.ticket) else {
        return false;
    };
    let Some(mut key) = decode::<32>(&command.receipt_key) else {
        return false;
    };
    let credential = Credential {
        generation: command.generation,
        ticket,
        key: hmac::Key::new(hmac::HMAC_SHA256, &key),
        expires: Instant::now() + std::time::Duration::from_millis(command.lifetime_ms),
    };
    key.zeroize();
    let state = peer.native_traversal.get_or_insert_with(Default::default);
    if command.generation <= state.high_water {
        return state.credential.as_ref().is_some_and(|current| {
            command.generation == current.generation
                && current.ticket == credential.ticket
                && merkur_stun_protocol::message::constant_time_eq(
                    hmac::sign(&current.key, b"registration-identity").as_ref(),
                    hmac::sign(&credential.key, b"registration-identity").as_ref(),
                )
        });
    }
    state.stop_checks();
    state.high_water = command.generation;
    state.credential = Some(credential);
    true
}

fn authorized_targets(
    snapshot: &Snapshot,
    credential: Option<&Credential>,
) -> Option<Vec<Vec<SocketAddr>>> {
    let mut targets = Vec::with_capacity(snapshot.bindings.len());
    for binding in &snapshot.bindings {
        let mut addresses = Vec::with_capacity(binding.candidates.len());
        for candidate in &binding.candidates {
            let credential = credential.filter(|credential| {
                credential.expires > Instant::now() && snapshot.generation >= credential.generation
            })?;
            let observation = &candidate.observation;
            if candidate.address.ip() != candidate.address.ip().to_canonical()
                || observation.mapped.ip() != observation.mapped.ip().to_canonical()
                || !super::side_channel::is_globally_routable(
                    &candidate.address.ip().to_canonical(),
                )
                || !super::side_channel::is_globally_routable(
                    &observation.mapped.ip().to_canonical(),
                )
                || candidate.address.ip() != observation.mapped.ip()
                || decode::<41>(&observation.ticket)? != credential.ticket
            {
                return None;
            }
            let receipt = Receipt {
                observer: observation.observer,
                tag: decode::<32>(&observation.receipt)?,
            };
            if !receipt.verifies(
                &credential.key,
                &credential.ticket,
                &decode::<12>(&observation.transaction)?,
                observation.mapped,
            ) {
                return None;
            }
            if !addresses.contains(&candidate.address) {
                addresses.push(candidate.address);
            }
        }
        targets.push(addresses);
    }
    Some(targets)
}

pub(crate) async fn accept_snapshot(
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    peer: &mut PeerDisplayState,
    snapshot: &Snapshot,
) -> bool {
    if !peer.authenticated || !peer.is_e2e_ready() || !snapshot.is_valid() {
        return false;
    }
    let Some(secret) = &peer.upgrade_secret else {
        return false;
    };
    let Ok(key) = TraversalKey::derive(secret, &peer.signal_session_id) else {
        return false;
    };
    let Some(mac) = decode::<64>(&snapshot.mac) else {
        return false;
    };
    if !key.verifies(false, &snapshot.transcript(), &mac) {
        return false;
    }
    let state = peer.native_traversal.get_or_insert_with(Default::default);
    if snapshot.generation < state.high_water {
        return false;
    }
    if authorized_targets(snapshot, state.credential.as_ref()).is_none() {
        return false;
    }
    if let Some(previous) = &state.snapshot {
        if snapshot.generation < previous.generation
            || (snapshot.generation == previous.generation && snapshot != previous)
        {
            return false;
        }
        if snapshot == previous
            && let Some(offer) = &state.offer
        {
            crate::network::send_signaling_to_peer(
                network_state,
                &peer.peer_id,
                DaemonSignal::WebtransportTraversalOffer(offer.clone())
                    .to_json()
                    .into_bytes(),
            )
            .await;
            return true;
        }
    }
    state.stop_checks();
    state.high_water = snapshot.generation;
    state.snapshot = Some(snapshot.clone());
    // Native traversal uses the main listener. Retire only unused browser-helper
    // preparations; the admission owner preserves an authenticated winner.
    peer.admission_done_generation = Some(peer.manifest_generation);
    if let Some(wt) = wt_state
        && let Some(requests) = &wt.read().await.admission_requests
    {
        drop(requests.try_send(super::admission::Command::Reconcile));
    }
    refresh(wt_state, network_state, peer).await
}

fn candidates(
    state: &WebTransportState,
    browser_address: IpAddr,
    snapshot: &Snapshot,
) -> Vec<DirectCandidate> {
    let mut source =
        super::pairing::manifest_candidates(&state.candidates, browser_address, state.port);
    if !browser_address.is_loopback()
        && let Some(observed) = state.native_observed_endpoint
        && !source.iter().any(|candidate| {
            candidate.addr == observed.ip().to_string() && candidate.port == observed.port()
        })
    {
        source.insert(
            0,
            super::AddressCandidate {
                addr: observed.ip().to_string(),
                port: observed.port(),
                kind: CandidateFlavor::Srflx,
            },
        );
    }
    source
        .into_iter()
        .filter_map(|candidate| {
            let addr: IpAddr = candidate.addr.parse().ok()?;
            if !snapshot
                .bindings
                .iter()
                .any(|binding| (binding.family == 4) == addr.is_ipv4())
            {
                return None;
            }
            let kind = match candidate.kind {
                CandidateFlavor::Srflx => CandidateKind::Srflx,
                CandidateFlavor::NatMap => CandidateKind::NatMap,
                CandidateFlavor::Host4 => CandidateKind::Host4,
                CandidateFlavor::Host6 => CandidateKind::Host6,
                CandidateFlavor::Loopback => CandidateKind::Loopback,
                CandidateFlavor::Tftp | CandidateFlavor::Sip => return None,
            };
            let scope = match super::pairing::candidate_scope(&candidate.addr) {
                super::pairing::CandidateScope::Public => CandidateScope::Public,
                super::pairing::CandidateScope::Local => CandidateScope::Local,
            };
            Some(DirectCandidate {
                addr,
                port: candidate.port,
                kind,
                scope,
                admission: 0,
            })
        })
        .take(merkur_wire::traversal::MAX_BINDINGS)
        .collect()
}

fn spawn_checks(
    checks: merkur_traversal::check::Binding,
    initial: Vec<SocketAddr>,
    expires: Option<Instant>,
) -> JoinHandle<()> {
    let allowed_ips: Vec<IpAddr> = initial.iter().map(|address| address.ip()).collect();
    tokio::spawn(async move {
        let (verified, mut results) = mpsc::channel(1);
        let run = checks.run(
            initial,
            move |source| {
                allowed_ips.contains(&source.ip())
                    && super::side_channel::is_globally_routable(&source.ip())
                    && expires.is_none_or(|deadline| Instant::now() < deadline)
            },
            // Authenticated LAN requests earn bounded replies; they do
            // not authorize unsolicited checks toward private targets.
            |_| true,
            verified,
        );
        tokio::pin!(run);
        let expiry = async move {
            match expires {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(expiry);
        loop {
            tokio::select! {
                () = &mut run => break,
                () = &mut expiry => break,
                result = results.recv() => if result.is_none() { break; },
            }
        }
    })
}

/// Rebuild only this native peer's checked offer after real candidate/certificate events.
pub(crate) async fn refresh(
    wt_state: &Option<Arc<RwLock<WebTransportState>>>,
    network_state: &Arc<RwLock<NetworkState>>,
    peer: &mut PeerDisplayState,
) -> bool {
    if crate::session::wt_upgrade_flow::wt_upgrade_disabled() {
        return false;
    }
    let (Some(wt), Some(browser_address), Some(secret)) =
        (wt_state, peer.browser_address, peer.upgrade_secret.as_ref())
    else {
        return false;
    };
    if !peer.authenticated || !peer.is_e2e_ready() {
        return false;
    }
    let Ok(key) = TraversalKey::derive(secret, &peer.signal_session_id) else {
        return false;
    };
    let Some(native) = peer.native_traversal.as_mut() else {
        return false;
    };
    let Some(snapshot) = native.snapshot.clone() else {
        return false;
    };
    let Some(targets) = authorized_targets(&snapshot, native.credential.as_ref()) else {
        native.stop_checks();
        return false;
    };
    let wt = wt.read().await;
    let Some(socket) = &wt.discovery_socket else {
        return false;
    };
    peer.manifest_generation += 1;
    let generation = peer.manifest_generation;
    let mut offer = Offer {
        client_generation: snapshot.generation,
        generation,
        cert_hash: wt.cert_state.cert_hash_base64(),
        candidates: candidates(&wt, browser_address, &snapshot),
        mac: String::new(),
    };
    offer.mac = URL_SAFE_NO_PAD.encode(key.mac(true, &offer.transcript()));
    let quota = native
        .quota
        .get_or_insert_with(|| {
            Arc::new(Semaphore::new(merkur_traversal::check::MAX_CHECKS_PER_PEER))
        })
        .clone();
    let expires = if targets.iter().any(|addresses| !addresses.is_empty()) {
        native
            .credential
            .as_ref()
            .map(|credential| credential.expires)
    } else {
        None
    };
    native.stop_checks();
    let mut prepared = Vec::with_capacity(snapshot.bindings.len());
    for (binding, initial) in snapshot.bindings.iter().zip(targets) {
        let Ok(keys) = key.checks(snapshot.generation, generation, binding.id) else {
            return false;
        };
        let Ok(checks) = merkur_traversal::check::Binding::install(
            socket.clone(),
            keys.id,
            &keys.client,
            &keys.daemon,
            false,
            quota.clone(),
        ) else {
            return false;
        };
        prepared.push((checks, initial));
    }
    for (checks, initial) in prepared {
        native.authorities.push(checks.authority());
        native.tasks.push(spawn_checks(checks, initial, expires));
    }
    native.offer = Some(offer.clone());
    drop(wt);
    crate::network::send_signaling_to_peer(
        network_state,
        &peer.peer_id,
        DaemonSignal::WebtransportTraversalOffer(offer)
            .to_json()
            .into_bytes(),
    )
    .await;
    true
}

/// Network invalidation retires attempts, while retained snapshots can produce
/// new contexts once maintenance publishes the actual replacement candidates.
pub(crate) fn invalidate(peers: &mut crate::connection::PeerMap) {
    for peer in peers.values_mut() {
        if let Some(native) = &mut peer.native_traversal {
            native.stop_checks();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_wire::traversal::{Binding, Candidate, Observation};

    fn credential() -> Credential {
        Credential {
            generation: 1,
            ticket: [3; 41],
            key: hmac::Key::new(hmac::HMAC_SHA256, &[7; 32]),
            expires: Instant::now() + std::time::Duration::from_secs(60),
        }
    }

    fn snapshot(address: &str, signer: &hmac::Key) -> Snapshot {
        let mapped: SocketAddr = address.parse().unwrap();
        let observer = "203.0.113.1:3478".parse().unwrap();
        let receipt = Receipt::issue(signer, &[3; 41], &[9; 12], mapped, observer);
        Snapshot {
            generation: 1,
            bindings: vec![Binding {
                id: 1,
                family: if mapped.is_ipv4() { 4 } else { 6 },
                candidates: vec![Candidate {
                    address: mapped,
                    kind: CandidateKind::Srflx,
                    observation: Observation {
                        ticket: URL_SAFE_NO_PAD.encode([3; 41]),
                        transaction: URL_SAFE_NO_PAD.encode([9; 12]),
                        mapped,
                        observer,
                        receipt: URL_SAFE_NO_PAD.encode(receipt.tag),
                    },
                }],
            }],
            mac: "A".repeat(86),
        }
    }

    #[test]
    fn only_a_live_registered_responder_receipt_authorizes_public_checks() {
        let mut credential = credential();
        let honest = snapshot("198.51.100.2:50000", &credential.key);
        assert_eq!(
            authorized_targets(&honest, Some(&credential)),
            Some(vec![vec!["198.51.100.2:50000".parse().unwrap()]])
        );
        let forged = snapshot(
            "198.51.100.2:50000",
            &hmac::Key::new(hmac::HMAC_SHA256, b"requester-message-key"),
        );
        assert!(authorized_targets(&forged, Some(&credential)).is_none());
        assert!(authorized_targets(&honest, None).is_none());
        credential.expires = Instant::now();
        assert!(authorized_targets(&honest, Some(&credential)).is_none());
    }

    #[test]
    fn receipt_port_cannot_be_rewritten_except_for_a_checked_lease_on_the_same_ip() {
        let credential = credential();
        let mut claimed = snapshot("198.51.100.2:50000", &credential.key);
        claimed.bindings[0].candidates[0].address.set_port(50001);
        assert!(!claimed.is_valid());
        claimed.bindings[0].candidates[0].kind = CandidateKind::NatMap;
        assert!(claimed.is_valid());
        assert!(authorized_targets(&claimed, Some(&credential)).is_some());
        claimed.bindings[0].candidates[0].address = "198.51.100.3:50001".parse().unwrap();
        assert!(authorized_targets(&claimed, Some(&credential)).is_none());
    }

    #[test]
    fn local_candidates_cannot_authorize_unsolicited_daemon_probes() {
        let credential = credential();
        for address in [
            "10.0.0.1:4444",
            "127.0.0.1:4444",
            "100.64.0.1:4444",
            "[fd00::1]:4444",
        ] {
            let claimed = snapshot(address, &credential.key);
            assert!(
                authorized_targets(&claimed, Some(&credential)).is_none(),
                "{address}"
            );
        }
        let mut local = snapshot("198.51.100.2:50000", &credential.key);
        local.bindings[0].candidates.clear();
        assert!(local.is_valid());
        assert_eq!(authorized_targets(&local, None), Some(vec![Vec::new()]));
    }

    #[test]
    fn an_ipv4_mapped_ipv6_spelling_cannot_launder_a_private_observation() {
        let credential = credential();
        let mut claimed = snapshot("10.0.0.4:4444", &credential.key);
        let mapped = "[::ffff:10.0.0.4]:4444".parse().unwrap();
        claimed.bindings[0].family = 6;
        claimed.bindings[0].candidates[0].address = mapped;
        claimed.bindings[0].candidates[0].observation.mapped = mapped;
        // Receipts canonicalize their IPs; address policy must do so too.
        let observation = &claimed.bindings[0].candidates[0].observation;
        let receipt = Receipt {
            observer: observation.observer,
            tag: decode::<32>(&observation.receipt).unwrap(),
        };
        assert!(receipt.verifies(&credential.key, &credential.ticket, &[9; 12], mapped));
        assert!(authorized_targets(&claimed, Some(&credential)).is_none());
    }

    #[test]
    fn a_current_receipt_covers_progressive_snapshots_above_its_generation_floor() {
        let mut credential = credential();
        let mut claimed = snapshot("198.51.100.2:50000", &credential.key);
        claimed.generation = 3;
        assert!(authorized_targets(&claimed, Some(&credential)).is_some());
        credential.generation = 4;
        assert!(authorized_targets(&claimed, Some(&credential)).is_none());
    }

    fn peer() -> PeerDisplayState {
        let mut peer =
            PeerDisplayState::new("browser".into(), crate::connection::PeerTransport::Edge);
        let psk = [7; 32];
        let prologue = crate::e2e::derive_prologue("session", "daemon", &[4; 64]);
        let (client_static, _) = crate::e2e::generate_static_keypair().unwrap();
        let (daemon_static, _) = crate::e2e::generate_static_keypair().unwrap();
        let mut client =
            crate::e2e::NoiseHandshake::new_initiator(&client_static, &psk, &prologue).unwrap();
        let mut daemon =
            crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
        daemon
            .read_message(&client.write_message(b"").unwrap())
            .unwrap();
        client
            .read_message(&daemon.write_message(b"").unwrap())
            .unwrap();
        daemon
            .read_message(&client.write_message(b"").unwrap())
            .unwrap();
        peer.noise = Some(daemon.into_transport().unwrap());
        peer.authenticated = true;
        peer.signal_session_id = "session".into();
        peer.delegation_id = "delegation".into();
        peer.upgrade_secret = Some([8; 32]);
        peer
    }

    fn command() -> RegisterTraversalCmd {
        RegisterTraversalCmd {
            command_id: "command".into(),
            session_id: "session".into(),
            browser_node_id: "browser".into(),
            delegation_id: "delegation".into(),
            rebind_counter: 0,
            generation: 1,
            ticket: URL_SAFE_NO_PAD.encode([3; 41]),
            receipt_key: URL_SAFE_NO_PAD.encode([7; 32]),
            lifetime_ms: 90_000,
        }
    }

    #[test]
    fn registration_binds_the_current_peer_session_delegation_and_noise_readiness() {
        let mut peer = peer();
        let mut command = command();
        assert!(register(&mut peer, &command));
        command.session_id = "predecessor".into();
        assert!(!register(&mut peer, &command));
        command.session_id = "session".into();
        command.browser_node_id = "another-browser".into();
        assert!(!register(&mut peer, &command));
        command.browser_node_id = "browser".into();
        command.delegation_id = "revoked-delegation".into();
        assert!(!register(&mut peer, &command));
        command.delegation_id = "delegation".into();
        command.lifetime_ms = 90_001;
        assert!(!register(&mut peer, &command));
        command.lifetime_ms = 90_000;
        command.generation = 0;
        assert!(!register(&mut peer, &command));
        command.generation = MAX_GENERATION + 1;
        assert!(!register(&mut peer, &command));
        command.generation = 1;
        peer.noise = None;
        assert!(!register(&mut peer, &command));
    }

    #[tokio::test]
    async fn a_delayed_predecessor_registration_cannot_retire_successor_checks() {
        let mut peer = peer();
        peer.rebind = Some(crate::connection::RebindState {
            secret: [1; 64],
            counter: 1,
            lineage_digest: [2; 64],
            genesis_at_ms: 0.0,
            authorization: crate::session::authorization_epoch::AuthorizationEpoch::new(
                1000, [3; 64], 0, 0.0,
            ),
            in_flight: None,
            pending_refusal: None,
        });
        let mut successor = command();
        successor.rebind_counter = 1;
        successor.ticket = URL_SAFE_NO_PAD.encode([4; 41]);
        assert!(register(&mut peer, &successor));
        let task = tokio::spawn(std::future::pending::<()>());
        let handle = task.abort_handle();
        peer.native_traversal.as_mut().unwrap().tasks.push(task);
        assert!(!register(&mut peer, &command()));
        tokio::task::yield_now().await;
        assert!(!handle.is_finished());
        assert_eq!(
            peer.native_traversal
                .as_ref()
                .unwrap()
                .credential
                .as_ref()
                .unwrap()
                .ticket,
            [4; 41]
        );
    }

    #[tokio::test]
    async fn hybrid_retirement_cancels_its_checks_and_erases_registration() {
        let mut peer = peer();
        assert!(register(&mut peer, &command()));
        let task = tokio::spawn(std::future::pending::<()>());
        let aborted = task.abort_handle();
        peer.native_traversal.as_mut().unwrap().tasks.push(task);
        peer.clear_hybrid_secret_material();
        tokio::task::yield_now().await;
        assert!(peer.native_traversal.is_none());
        assert!(aborted.is_finished());
        assert!(peer.upgrade_secret.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn registration_high_water_and_idempotency_preserve_current_checks_and_expiry() {
        let mut peer = peer();
        let current = command();
        assert!(register(&mut peer, &current));
        let expires = peer
            .native_traversal
            .as_ref()
            .unwrap()
            .credential
            .as_ref()
            .unwrap()
            .expires;
        peer.native_traversal.as_mut().unwrap().high_water = 3;
        let task = tokio::spawn(std::future::pending::<()>());
        let running = task.abort_handle();
        peer.native_traversal.as_mut().unwrap().tasks.push(task);
        let mut delayed = command();
        delayed.generation = 2;
        delayed.ticket = URL_SAFE_NO_PAD.encode([4; 41]);
        assert!(!register(&mut peer, &delayed));
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        assert!(register(&mut peer, &current));
        assert!(!running.is_finished());
        assert_eq!(
            peer.native_traversal
                .as_ref()
                .unwrap()
                .credential
                .as_ref()
                .unwrap()
                .expires,
            expires
        );
        delayed.generation = 1;
        delayed.ticket = current.ticket.clone();
        delayed.receipt_key = URL_SAFE_NO_PAD.encode([8; 32]);
        assert!(!register(&mut peer, &delayed));
        assert!(!running.is_finished());
    }

    #[tokio::test]
    async fn an_authenticated_lan_snapshot_advances_registration_high_water() {
        let mut peer = peer();
        let mut local = snapshot("198.51.100.2:50000", &credential().key);
        local.bindings[0].candidates.clear();
        local.generation = 5;
        let key = TraversalKey::derive(
            peer.upgrade_secret.as_ref().unwrap(),
            &peer.signal_session_id,
        )
        .unwrap();
        local.mac = URL_SAFE_NO_PAD.encode(key.mac(false, &local.transcript()));
        let network = Arc::new(RwLock::new(NetworkState::new()));
        assert!(!accept_snapshot(&None, &network, &mut peer, &local).await);
        assert_eq!(peer.native_traversal.as_ref().unwrap().high_water, 5);
        let mut delayed = command();
        delayed.generation = 4;
        assert!(!register(&mut peer, &delayed));
        assert!(peer.native_traversal.as_ref().unwrap().credential.is_none());
    }

    #[test]
    fn native_edm_observation_does_not_change_browser_candidates() {
        let credential = credential();
        let snapshot = snapshot("198.51.100.2:50000", &credential.key);
        let mut state = WebTransportState::new(
            super::super::CertState {
                cert_hash: [0; 32],
                created_at: std::time::Instant::now(),
                valid_for: std::time::Duration::from_secs(60),
            },
            44300,
            vec![super::super::AddressCandidate {
                addr: "192.168.1.2".into(),
                port: 44300,
                kind: CandidateFlavor::Host4,
            }],
            super::super::pairing::NatSignature {
                public_ip: Some("198.51.100.3".into()),
                nat_type: super::super::pairing::NatTypeLabel::EndpointDependent,
                hairpin: false,
            },
            super::super::stun::NatMapping::EndpointDependent,
            Some("198.51.100.3".parse().unwrap()),
        );
        state.native_observed_endpoint = Some("198.51.100.3:52000".parse().unwrap());
        let native = candidates(&state, "203.0.113.1".parse().unwrap(), &snapshot);
        assert!(native.iter().any(|candidate| candidate.addr
            == "198.51.100.3".parse::<IpAddr>().unwrap()
            && candidate.port == 52000));
        let browser = super::super::pairing::manifest_candidates(
            &state.candidates,
            "203.0.113.1".parse().unwrap(),
            state.port,
        );
        assert!(
            browser
                .iter()
                .all(|candidate| candidate.kind != CandidateFlavor::Srflx)
        );
    }
}
