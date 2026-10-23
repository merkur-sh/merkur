use super::*;
use crate::egress::EgressPath6;
use crate::portmap::{
    PinholeHandle, PinholeProtocol, open_upnp_pinhole, release_pinhole, renew_pinhole,
};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

async fn read_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let read = stream.read(&mut chunk).await.unwrap();
        assert_ne!(read, 0, "the complete HTTP request arrives before FIN");
        request.extend_from_slice(&chunk[..read]);
        assert!(request.len() <= 4096, "bounded SOAP request");
        let Some(head_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = std::str::from_utf8(&request[..head_end]).unwrap();
        let length: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .map_or(0, |length| length.parse().unwrap());
        if request.len() == head_end + 4 + length {
            return String::from_utf8(request).unwrap();
        }
    }
}

async fn respond(stream: &mut TcpStream, action: &str, output: &str) {
    let body = format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"{WAN_IPV6_FIREWALL_1}\">{output}</u:{action}Response></s:Body></s:Envelope>"
    );
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    stream.shutdown().await.unwrap();
}

async fn pinhole_gateway(listener: TcpListener, internal: SocketAddr) {
    let gateway = listener.local_addr().unwrap();
    for action in [
        "Description",
        "AddPinhole",
        "UpdatePinhole",
        "DeletePinhole",
    ] {
        let (mut stream, peer) = listener.accept().await.unwrap();
        assert_eq!(peer.ip(), internal.ip(), "the HTTP source owns the pinhole");
        assert_eq!(stream.local_addr().unwrap(), gateway);
        let request = read_request(&mut stream).await;
        assert!(request.contains(&format!("\r\nHost: {gateway}\r\n")));
        if action == "Description" {
            assert!(request.starts_with("GET /root.xml HTTP/1.1\r\n"));
            let description = format!(
                "<root><device><serviceList><service><serviceType>{WAN_IPV6_FIREWALL_1}</serviceType><controlURL>/ctl/IP6FC</controlURL></service></serviceList></device></root>"
            );
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{description}",
                        description.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
            continue;
        }
        assert!(request.starts_with("POST /ctl/IP6FC HTTP/1.1\r\n"));
        assert!(request.contains(&format!(
            "\r\nSOAPAction: \"{WAN_IPV6_FIREWALL_1}#{action}\"\r\n"
        )));
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
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
        assert!(body.contains(&format!(
            "<u:{action} xmlns:u=\"{WAN_IPV6_FIREWALL_1}\">{arguments}</u:{action}>"
        )));
        let output = if action == "AddPinhole" {
            "<UniqueID>65535</UniqueID>"
        } else {
            ""
        };
        respond(&mut stream, action, output).await;
    }
}

/// WANIPv6FirewallControl:1 §§2.6.3–2.6.5: the HTTP owner opens UDP for its
/// exact socket, then retains the gateway's ui2 UniqueID for renewal and deletion.
#[tokio::test]
async fn igdv2_pinhole_lifecycle_keeps_the_source_tuple_and_gateway_unique_id() {
    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let gateway = listener.local_addr().unwrap();
    let socket = UdpSocket::bind("[::1]:0").await.unwrap();
    let internal = socket.local_addr().unwrap();
    let server = tokio::spawn(pinhole_gateway(listener, internal));
    let location = parse_http_url(&format!("http://{gateway}/root.xml")).unwrap();
    let control = fetch_description(&location, Some(internal.ip()))
        .await
        .unwrap()
        .firewall6
        .unwrap();
    assert_eq!(control.source, Some(internal.ip()));
    assert_eq!(control.address, gateway);
    let egress = EgressPath6 {
        local: Ipv6Addr::LOCALHOST,
        interface_index: 0,
        interface_name: "loopback".into(),
        gateway: Some(Ipv6Addr::LOCALHOST),
    };
    let mut pinhole = open_upnp_pinhole(&egress, Ipv6Addr::LOCALHOST, control, internal.port())
        .await
        .unwrap();
    assert_eq!(pinhole.address, Ipv6Addr::LOCALHOST);
    assert_eq!(pinhole.port, internal.port());
    assert_eq!(pinhole.protocol, PinholeProtocol::Upnp6);
    assert_eq!(pinhole.lifetime, Duration::from_secs(3600));
    assert!(matches!(
        pinhole.inner,
        PinholeHandle::Upnp {
            unique_id: 65535,
            ..
        }
    ));
    pinhole.expires_at = std::time::Instant::now();
    let previous_expiry = pinhole.expires_at;
    assert!(renew_pinhole(&mut pinhole).await);
    assert!(pinhole.expires_at > previous_expiry);
    assert_eq!(pinhole.port, socket.local_addr().unwrap().port());
    release_pinhole(*pinhole).await;
    tokio::time::timeout(HTTP_TIMEOUT, server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn an_igdv2_owner_refusal_never_becomes_a_pinhole() {
    let listener = TcpListener::bind("[::1]:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, peer) = listener.accept().await.unwrap();
        assert_eq!(peer.ip(), IpAddr::V6(Ipv6Addr::LOCALHOST));
        let request = read_request(&mut stream).await;
        assert!(request.contains("<InternalClient>2001:db8::2</InternalClient>"));
        let fault = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>606</errorCode><errorDescription>Action not authorized</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
        stream
            .write_all(
                format!(
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\n\r\n{fault}",
                    fault.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
    });
    let control = ControlUrl {
        address,
        host: address.to_string(),
        path: "/ctl/IP6FC".into(),
        service_type: WAN_IPV6_FIREWALL_1,
        source: Some(IpAddr::V6(Ipv6Addr::LOCALHOST)),
    };
    assert_eq!(
        add_pinhole(&control, "2001:db8::2".parse().unwrap(), 44433, 3600).await,
        Err(SoapError::Upnp(606))
    );
    tokio::time::timeout(HTTP_TIMEOUT, server)
        .await
        .unwrap()
        .unwrap();
}
