use merkur_stun_protocol::message::*;
use ring::hmac;

mod seeds {
    include!("seeds.rs");
}

#[test]
fn fuzz_stun() {
    let key = hmac::Key::new(hmac::HMAC_SHA256, &[7; 32]);
    let other_key = hmac::Key::new(hmac::HMAC_SHA256, &[8; 32]);
    let nonce = [3; TRANSACTION_ID_LEN];
    let request = binding_request(&nonce, b"ticket", 0, &key).expect("seed request");
    let mut response = ResponseWriter::new(&nonce);
    assert!(response.push_address(
        ATTR_XOR_MAPPED_ADDRESS,
        std::net::SocketAddr::from(([198, 51, 100, 1], 44_433)),
        &nonce,
        true,
    ));
    assert!(response.finish_in_place(&key));
    let seeds = vec![
        ("encoder-request", request.as_bytes().to_vec()),
        ("encoder-response", response.as_bytes().to_vec()),
    ];
    seeds::persist(&seeds);
    let check = |bytes: &[u8]| {
        // Both network directions use their actual parser, including on every
        // malformed input; successful syntax alone is never authorization.
        if let Ok(request) = parse_binding_request(bytes) {
            assert!(bytes.len() <= MAX_MESSAGE_LEN);
            assert_eq!(&bytes[8..HEADER_LEN], request.transaction_id);
            let _ = request.verify_integrity(bytes, &key);
            let mut trailing = bytes.to_vec();
            trailing.extend_from_slice(&[0; 4]);
            assert!(parse_binding_request(&trailing).is_err());
        }
        let nonce = bytes
            .get(8..HEADER_LEN)
            .and_then(|s| s.try_into().ok())
            .unwrap_or(&[3; TRANSACTION_ID_LEN]);
        let _ = parse_success(bytes, nonce);
        let _ = verify_integrity(bytes, &key);

        // Valid encoder output guarantees deep authenticated-parser coverage,
        // even before a campaign has grown its retained wire corpus.
        let username = bytes
            .get(..bytes.len().min(256))
            .filter(|s| !s.is_empty())
            .unwrap_or(b"ticket");
        let change = bytes.first().copied().unwrap_or(0) & 0x06;
        let encoded = binding_request(nonce, username, change, &key).expect("bounded request");
        let encoded = encoded.as_bytes();
        let parsed = parse_binding_request(encoded).expect("encoder output parses");
        assert_eq!(parsed.username, username);
        assert!(parsed.verify_integrity(encoded, &key));
        assert!(!parsed.verify_integrity(encoded, &other_key));
        let at = bytes.get(1).copied().unwrap_or(0) as usize % encoded.len();
        let mut changed = encoded.to_vec();
        changed[at] ^= 1 << (bytes.get(2).copied().unwrap_or(0) & 7);
        assert!(!parse_binding_request(&changed)
            .is_ok_and(|request| request.verify_integrity(&changed, &key)));

        let address = std::net::SocketAddr::from(([198, 51, 100, 1], 44_433));
        let mut response = ResponseWriter::new(nonce);
        assert!(response.push_address(ATTR_XOR_MAPPED_ADDRESS, address, nonce, true));
        assert!(response.finish_in_place(&key));
        assert_eq!(
            parse_success(response.as_bytes(), nonce)
                .expect("response parses")
                .mapped,
            Some(address)
        );
        assert!(verify_integrity(response.as_bytes(), &key));
        assert!(!verify_integrity(response.as_bytes(), &other_key));
    };
    for (_, seed) in &seeds {
        check(seed);
    }
    bolero::check!()
        .with_max_len(MAX_MESSAGE_LEN + 1)
        .for_each(check);
}
