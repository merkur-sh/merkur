use super::*;
use std::net::Ipv6Addr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

// WANIPv6FirewallControl:1 identifies the IGDv2 firewall SOAP service.
const FIREWALL: &str = "urn:schemas-upnp-org:service:WANIPv6FirewallControl:1";

async fn request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let len = stream.read(&mut chunk).await.unwrap();
        assert_ne!(len, 0, "complete SOAP request precedes FIN");
        bytes.extend_from_slice(&chunk[..len]);
        assert!(bytes.len() <= 4096, "bounded SOAP request");
        let Some(head_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = std::str::from_utf8(&bytes[..head_end]).unwrap();
        let length: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .unwrap()
            .parse()
            .unwrap();
        if bytes.len() == head_end + 4 + length {
            return String::from_utf8(bytes).unwrap();
        }
    }
}

async fn gateway(
    listener: TcpListener,
    internal: SocketAddr,
    events: mpsc::Sender<&'static str>,
    finish_delete: oneshot::Receiver<()>,
    actions: &'static [(&'static str, bool)],
) {
    let mut finish_delete = Some(finish_delete);
    for &(action, success) in actions {
        let (mut stream, peer) = listener.accept().await.unwrap();
        assert_eq!(peer.ip(), internal.ip(), "SOAP source owns the pinhole");
        let request = request(&mut stream).await;
        assert!(request.starts_with("POST /ctl/IP6FC HTTP/1.1\r\n"));
        assert!(request.contains(&format!("SOAPAction: \"{FIREWALL}#{action}\"")));
        let arguments = match action {
            "AddPinhole" => format!(
                "<RemoteHost></RemoteHost><RemotePort>0</RemotePort><InternalClient>{}</InternalClient><InternalPort>{}</InternalPort><Protocol>17</Protocol><LeaseTime>3600</LeaseTime>",
                internal.ip(),
                internal.port()
            ),
            "UpdatePinhole" => "<UniqueID>65535</UniqueID><NewLeaseTime>3600</NewLeaseTime>".into(),
            "DeletePinhole" => "<UniqueID>65535</UniqueID>".into(),
            _ => unreachable!(),
        };
        assert!(
            request.contains(&arguments),
            "exact SOAP arguments for {action}"
        );
        events.send(action).await.unwrap();
        if action == "DeletePinhole" {
            finish_delete.take().unwrap().await.unwrap();
        }
        let output = if action == "AddPinhole" {
            "<UniqueID>65535</UniqueID>"
        } else {
            ""
        };
        let (status, body) = if success {
            (
                "200 OK",
                format!(
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"{FIREWALL}\">{output}</u:{action}Response></s:Body></s:Envelope>"
                ),
            )
        } else {
            ("500 Internal Server Error", "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>606</errorCode><errorDescription>Action not authorized</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>".to_owned())
        };
        stream.write_all(format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
        ).as_bytes()).await.unwrap();
        stream.shutdown().await.unwrap();
    }
}

pub(crate) struct OwnedPinhole {
    pub owner: super::super::Owner,
    pub carrier: Arc<SocketBinding>,
    pub received: mpsc::Receiver<&'static str>,
    pub finish_delete: oneshot::Sender<()>,
    pub serving: tokio::task::JoinHandle<()>,
    published: mpsc::Receiver<(u64, Vec<Candidate>)>,
}

pub(crate) async fn owned_pinhole(actions: &'static [(&'static str, bool)]) -> OwnedPinhole {
    drop(rustls::crypto::ring::default_provider().install_default());
    let mut owner = super::super::Owner::new();
    let binding =
        Arc::new(create(1, 6, owner.budget.clone().try_acquire_owned().unwrap()).unwrap());
    let internal = SocketAddr::new(Ipv6Addr::LOCALHOST.into(), binding.local.port());
    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (events, mut received) = mpsc::channel(3);
    let (finish_delete, deletion) = oneshot::channel();
    let serving = tokio::spawn(gateway(listener, internal, events, deletion, actions));
    let egress = EgressPath6 {
        local: Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "loopback".into(),
        gateway: Some(Ipv6Addr::LOCALHOST),
    };
    let control = portmap::upnp::ControlUrl {
        address,
        host: address.to_string(),
        path: "/ctl/IP6FC".into(),
        service_type: FIREWALL,
        source: Some(internal.ip()),
    };
    let pinhole =
        portmap::open_upnp_pinhole(&egress, Ipv6Addr::LOCALHOST, control, internal.port())
            .await
            .unwrap();
    assert_eq!(received.recv().await, Some("AddPinhole"));
    assert_eq!(pinhole.lifetime, Duration::from_secs(3600));
    let mut mapping = Mapping {
        path: RouterPath {
            local: internal.ip(),
            egress: None,
            egress6: Some(egress),
        },
        lease: None,
        pinhole: Some(pinhole),
        announcements: None,
        renewal: None,
    };
    mapping.schedule();
    let (updates, mut published) = mpsc::channel(4);
    let (input, lifetime) = watch::channel(MaintenanceInput {
        credential: Arc::new(Credential::without_observers()),
        updates,
        observation_generation: 0,
    });
    *binding.maintenance.lock().unwrap() = Some(Maintenance { input });
    let worker = Worker {
        id: binding.id,
        family: binding.family,
        port: binding.local.port(),
        socket: binding.socket.clone(),
        observations: binding.observations.clone(),
        mappings: vec![mapping],
        retired: binding.retired.clone(),
        retirements: owner.lifecycle_tx.clone(),
    };
    owner.bindings.push((binding.clone(), Vec::new()));
    owner.register_worker(tokio::spawn(worker.run(lifetime)));
    assert!(
        published.recv().await.is_some(),
        "production worker entered its timer loop"
    );
    OwnedPinhole {
        owner,
        carrier: binding,
        received,
        finish_delete,
        serving,
        published,
    }
}

#[tokio::test]
async fn igdv2_worker_renews_at_half_lifetime_and_deletes_after_last_binding_owner() {
    let mut fixture = owned_pinhole(&[
        ("AddPinhole", true),
        ("UpdatePinhole", true),
        ("DeletePinhole", true),
    ])
    .await;
    let socket = Arc::downgrade(&fixture.carrier.socket);
    fixture.owner.bindings.clear();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(1800)).await;
    tokio::time::resume();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), fixture.received.recv())
            .await
            .unwrap(),
        Some("UpdatePinhole")
    );
    assert!(
        fixture.published.recv().await.is_some(),
        "automatic renewal completed through SOAP"
    );
    assert!(
        fixture.received.try_recv().is_err(),
        "one binding owner cannot delete its live carrier's pinhole"
    );
    drop(fixture.carrier);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), fixture.received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    assert!(
        socket.upgrade().is_some(),
        "UDP port remains owned while deletion is in flight"
    );
    fixture.finish_delete.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), fixture.owner.shutdown())
        .await
        .unwrap();
    fixture.serving.await.unwrap();
}

#[tokio::test]
async fn shutdown_releases_bindings_queued_in_an_unconsumed_preparation_notice() {
    let fixture = owned_pinhole(&[("AddPinhole", true), ("DeletePinhole", true)]).await;
    let OwnedPinhole {
        mut owner,
        carrier,
        mut received,
        finish_delete,
        serving,
        ..
    } = fixture;
    assert!(
        owner
            .events
            .try_send(super::super::Notice::Prepared {
                lineage: 1,
                network: 1,
                work: 1,
                next_id: 2,
                credential: Arc::new(Credential::without_observers()),
                credential_failed: false,
                capacity_blocked: false,
                bindings: vec![(carrier.clone(), Vec::new())],
            })
            .is_ok()
    );
    owner.bindings.clear();
    drop(carrier);
    let stopping = tokio::spawn(async move {
        owner.shutdown().await;
    });
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    assert!(
        !stopping.is_finished(),
        "shutdown waits for the real gateway response"
    );
    finish_delete.send(()).unwrap();
    stopping.await.unwrap();
    serving.await.unwrap();
}

#[tokio::test]
async fn refused_renewal_retires_cold_binding_without_deleting_its_live_grant() {
    let mut fixture = owned_pinhole(&[
        ("AddPinhole", true),
        ("UpdatePinhole", false),
        ("DeletePinhole", true),
    ])
    .await;
    fixture.owner.lineage = Some(1);
    fixture.owner.work = 2;
    fixture.owner.credential = Some(Arc::new(Credential::without_observers()));
    let other = Arc::new(
        create(
            2,
            4,
            fixture.owner.budget.clone().try_acquire_owned().unwrap(),
        )
        .unwrap(),
    );
    fixture.owner.bindings.push((other.clone(), Vec::new()));
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(1800)).await;
    tokio::time::resume();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), fixture.received.recv())
            .await
            .unwrap(),
        Some("UpdatePinhole")
    );
    let notice = tokio::time::timeout(Duration::from_secs(3), fixture.owner.next())
        .await
        .unwrap();
    assert!(
        matches!(notice, super::super::Notice::Retired { binding } if binding == fixture.carrier.id)
    );
    let candidate = Candidate {
        address: "[2001:db8::2]:40000".parse().unwrap(),
        kind: CandidateKind::Host6,
        observation: Observation {
            ticket: String::new(),
            transaction: String::new(),
            mapped: "[2001:db8::2]:40000".parse().unwrap(),
            observer: "[2001:db8::10]:3478".parse().unwrap(),
            receipt: String::new(),
        },
    };
    let mut session = super::super::tests::idle_session();
    fixture.owner.apply(
        super::super::Notice::Candidates {
            lineage: 1,
            network: 1,
            work: 2,
            binding: fixture.carrier.id,
            candidates: vec![candidate.clone()],
        },
        &mut session,
        0,
    );
    fixture.owner.apply(
        super::super::Notice::Observed {
            lineage: 1,
            network: 1,
            work: 2,
            binding: fixture.carrier.id,
            gathered: Gathered {
                candidates: vec![candidate],
                ..Gathered::default()
            },
            complete: true,
        },
        &mut session,
        0,
    );
    assert!(
        fixture.owner.bindings[0].1.is_empty(),
        "queued candidate updates cannot revive a retired binding"
    );
    assert_eq!(
        fixture.carrier.observations.lock().unwrap().generation,
        0,
        "queued observations cannot restart maintenance"
    );
    fixture.owner.apply(notice, &mut session, 0);
    assert!(fixture.owner.binding(fixture.carrier.id).is_none());
    assert!(
        Arc::ptr_eq(&fixture.owner.binding(other.id).unwrap(), &other),
        "the other family's binding remains owned"
    );
    assert!(
        fixture.received.try_recv().is_err(),
        "a renewal refusal cannot delete a live carrier's grant"
    );
    drop(fixture.carrier);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), fixture.received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    fixture.finish_delete.send(()).unwrap();
    fixture.owner.shutdown().await;
    fixture.serving.await.unwrap();
}

#[tokio::test]
async fn refused_delete_quarantines_the_udp_tuple_and_capacity_waits_for_real_retirement() {
    let mut fixture = owned_pinhole(&[("AddPinhole", true), ("DeletePinhole", false)]).await;
    let source = fixture.carrier.local;
    fixture.owner.bindings.clear();
    drop(fixture.carrier);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), fixture.received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    fixture.finish_delete.send(()).unwrap();
    for task in std::mem::take(&mut fixture.owner.workers) {
        fixture.owner.worker_completed(task.await);
    }
    fixture.serving.await.unwrap();
    assert_eq!(
        fixture.owner.quarantined.len(),
        1,
        "an explicit SOAP refusal retains allocation custody"
    );
    assert_eq!(
        std::net::UdpSocket::bind(source).unwrap_err().kind(),
        io::ErrorKind::AddrInUse
    );
    let mut fillers: Vec<_> = (0..MAX_BINDINGS - 1)
        .map(|index| {
            create(
                100 + u64::try_from(index).unwrap(),
                4,
                fixture.owner.budget.clone().try_acquire_owned().unwrap(),
            )
            .unwrap()
        })
        .collect();
    let mut next = 1000;
    let opened = open(Vec::new(), &mut next, &fixture.owner.budget);
    assert!(
        opened.capacity_blocked && opened.bindings.is_empty(),
        "refused cleanup cannot create an uncharged successor"
    );
    fixture.owner.capacity_blocked = true;
    fixture.owner.credential = Some(Arc::new(Credential::without_observers()));
    let mut session = super::super::tests::idle_session();
    fixture.owner.schedule_retry(&session);
    assert!(
        fixture.owner.retry_at.is_none(),
        "resource exhaustion cannot become a periodic credential loop"
    );
    let notice = {
        let waiting = fixture.owner.next();
        tokio::pin!(waiting);
        assert!(
            futures::poll!(waiting.as_mut()).is_pending(),
            "unacknowledged cleanup releases no permit"
        );
        drop(fillers.pop());
        tokio::time::timeout(Duration::from_secs(3), waiting)
            .await
            .unwrap()
    };
    assert!(matches!(notice, super::super::Notice::Capacity));
    fixture.owner.apply(notice, &mut session, 0);
    let opened = open(Vec::new(), &mut next, &fixture.owner.budget);
    assert_eq!(
        opened.bindings.len(),
        1,
        "one actual physical retirement restores one allocation slot"
    );
    assert_eq!(fixture.owner.quarantined.len(), 1);
}

#[tokio::test]
async fn a_changed_outer_address_cannot_reserve_a_second_grant_on_the_owned_internal_tuple() {
    let budget = Arc::new(Semaphore::new(MAX_BINDINGS));
    let binding = Arc::new(create(1, 6, budget.try_acquire_owned().unwrap()).unwrap());
    let internal = SocketAddr::new(Ipv6Addr::LOCALHOST.into(), binding.local.port());
    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (events, mut received) = mpsc::channel(3);
    let (finish_delete, deletion) = oneshot::channel();
    let serving = tokio::spawn(gateway(
        listener,
        internal,
        events,
        deletion,
        &[("AddPinhole", true), ("DeletePinhole", true)],
    ));
    let egress = EgressPath6 {
        local: Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "loopback".into(),
        gateway: Some(Ipv6Addr::LOCALHOST),
    };
    let path = RouterPath {
        local: internal.ip(),
        egress: None,
        egress6: Some(egress.clone()),
    };
    let control = portmap::upnp::ControlUrl {
        address,
        host: address.to_string(),
        path: "/ctl/IP6FC".into(),
        service_type: FIREWALL,
        source: Some(internal.ip()),
    };
    let pinhole =
        portmap::open_upnp_pinhole(&egress, Ipv6Addr::LOCALHOST, control, internal.port())
            .await
            .unwrap();
    assert_eq!(received.recv().await, Some("AddPinhole"));
    let (updates, _updated) = mpsc::channel(3);
    let current = MaintenanceInput {
        credential: Arc::new(Credential::without_observers()),
        updates,
        observation_generation: 0,
    };
    let (input, lifetime) = watch::channel(current.clone());
    *binding.maintenance.lock().unwrap() = Some(Maintenance { input });
    let (retirements, _retired) = mpsc::channel(1);
    let mut worker = Worker {
        id: 1,
        family: 6,
        port: internal.port(),
        socket: binding.socket.clone(),
        observations: binding.observations.clone(),
        retired: binding.retired.clone(),
        retirements,
        mappings: vec![Mapping {
            path: path.clone(),
            lease: None,
            pinhole: Some(pinhole),
            announcements: None,
            renewal: None,
        }],
    };
    let changed = ObservedPath {
        local: internal.ip(),
        mapped: "2001:db8::99".parse().unwrap(),
        observer: "[::1]:3478".parse().unwrap(),
    };
    let round = Round {
        current,
        generation: 0,
        gathered: Gathered::default(),
    };
    worker
        .admit_paths(vec![(path, changed)], &round, &lifetime)
        .await;
    assert_eq!(
        worker.mappings.len(),
        1,
        "a different observed outer IP does not create a new internal allocation identity"
    );
    assert!(
        received.try_recv().is_err(),
        "the owned grant receives neither a second Add nor a premature Delete"
    );
    let maintaining = tokio::spawn(worker.run(lifetime));
    drop(binding);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), received.recv())
            .await
            .unwrap(),
        Some("DeletePinhole")
    );
    finish_delete.send(()).unwrap();
    assert!(maintaining.await.unwrap().is_none());
    serving.await.unwrap();
}
