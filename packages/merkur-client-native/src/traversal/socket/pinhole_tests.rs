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
    actions: &'static [&'static str],
) {
    let mut finish_delete = Some(finish_delete);
    for &action in actions {
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
        let body = format!(
            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"{FIREWALL}\">{output}</u:{action}Response></s:Body></s:Envelope>"
        );
        stream.write_all(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
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

pub(crate) async fn owned_pinhole(actions: &'static [&'static str]) -> OwnedPinhole {
    drop(rustls::crypto::ring::default_provider().install_default());
    let binding = Arc::new(create(1, 6).unwrap());
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
        mapped: internal.ip(),
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
    };
    let mut owner = super::super::Owner::new();
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
    let mut fixture = owned_pinhole(&["AddPinhole", "UpdatePinhole", "DeletePinhole"]).await;
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
    let fixture = owned_pinhole(&["AddPinhole", "DeletePinhole"]).await;
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
