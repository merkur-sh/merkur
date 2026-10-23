use super::*;

fn lease(server: pcp::Server, pcp: bool) -> Lease {
    Lease {
        external: "203.0.113.7:44433".parse().unwrap(),
        protocol: if pcp { Protocol::Pcp } else { Protocol::NatPmp },
        lifetime: Duration::from_secs(60),
        expires_at: Instant::now() + Duration::from_secs(60),
        epoch: 1,
        gateway: Ipv4Addr::LOCALHOST,
        interface_index: 0,
        local_ipv4: Ipv4Addr::LOCALHOST,
        inner: if pcp {
            LeaseHandle::Pcp {
                server,
                nonce: [7; 12],
                internal_port: 44433,
            }
        } else {
            LeaseHandle::NatPmp {
                server,
                internal_port: 44433,
            }
        },
    }
}

#[tokio::test]
async fn a_mapping_delete_requires_the_zero_lifetime_ack_for_its_internal_tuple() {
    for is_pcp in [false, true] {
        for lifetime in [0, 60] {
            let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let server = pcp::Server {
                gateway: IpAddr::V4(Ipv4Addr::LOCALHOST),
                interface: 0,
                port: socket.local_addr().unwrap().port(),
            };
            let responder = tokio::spawn(async move {
                let mut request = [0; 100];
                let (len, client) = socket.recv_from(&mut request).await.unwrap();
                let response = if is_pcp {
                    assert_eq!(&request[4..8], &[0; 4]);
                    assert_eq!(&request[24..36], &[7; 12]);
                    pcp::tests::map_response(
                        &[7; 12],
                        44433,
                        0,
                        lifetime,
                        "203.0.113.7".parse().unwrap(),
                    )
                    .to_vec()
                } else {
                    assert_eq!(&request[8..12], &[0; 4]);
                    natpmp::tests::map_answer(&request[..len], lifetime).to_vec()
                };
                socket.send_to(&response, client).await.unwrap();
            });
            assert_eq!(release(lease(server, is_pcp)).await, lifetime == 0);
            responder.await.unwrap();
        }
    }
}

#[tokio::test]
async fn a_pcp_pinhole_delete_requires_the_zero_lifetime_ack_for_its_nonce() {
    for lifetime in [0, 60] {
        let socket = tokio::net::UdpSocket::bind("[::1]:0").await.unwrap();
        let server = pcp::Server {
            gateway: IpAddr::V6(Ipv6Addr::LOCALHOST),
            interface: 0,
            port: socket.local_addr().unwrap().port(),
        };
        let responder = tokio::spawn(async move {
            let mut request = [0; 100];
            let (_, client) = socket.recv_from(&mut request).await.unwrap();
            assert_eq!(&request[4..8], &[0; 4]);
            assert_eq!(&request[24..36], &[7; 12]);
            let response = pcp::tests::map_response(
                &[7; 12],
                44433,
                0,
                lifetime,
                IpAddr::V6(Ipv6Addr::LOCALHOST),
            );
            socket.send_to(&response, client).await.unwrap();
        });
        let pinhole = Pinhole {
            address: Ipv6Addr::LOCALHOST,
            port: 44433,
            protocol: PinholeProtocol::Pcp6,
            lifetime: Duration::from_secs(60),
            expires_at: Instant::now() + Duration::from_secs(60),
            epoch: 1,
            gateway: Ipv6Addr::LOCALHOST,
            interface_index: 0,
            inner: PinholeHandle::Pcp {
                server,
                nonce: [7; 12],
            },
        };
        assert_eq!(release_pinhole(pinhole).await, lifetime == 0);
        responder.await.unwrap();
    }
}

#[tokio::test]
async fn a_router_refusal_is_not_mapping_retirement() {
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let server = pcp::Server {
        gateway: IpAddr::V4(Ipv4Addr::LOCALHOST),
        interface: 0,
        port: socket.local_addr().unwrap().port(),
    };
    let responder = tokio::spawn(async move {
        let mut request = [0; 100];
        let (_, client) = socket.recv_from(&mut request).await.unwrap();
        let response = [0, 0x81, 0, 2];
        socket.send_to(&response, client).await.unwrap();
    });
    assert!(!release(lease(server, false)).await);
    responder.await.unwrap();
}
