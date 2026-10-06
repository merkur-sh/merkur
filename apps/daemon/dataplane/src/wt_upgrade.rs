use merkur_wire::signaling::webtransport_upgrade_proof_payload as build_proof_payload;
use ring::hmac;

pub fn verify_wt_upgrade_proof(
    upgrade_key: &[u8; 32],
    nonce_hex: &str,
    signal_session_id: &str,
    browser_node_id: &str,
    daemon_id: &str,
    wt_temp_peer_id: &str,
    proof: &[u8],
) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA512, upgrade_key);
    let payload = build_proof_payload(
        nonce_hex,
        signal_session_id,
        browser_node_id,
        daemon_id,
        wt_temp_peer_id,
    );
    hmac::verify(&key, payload.as_bytes(), proof).is_ok()
}

pub fn hex_encode_nonce(nonce: &[u8; 32]) -> String {
    nonce.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct SessionAuthVectors {
        webtransport_upgrade: WebTransportUpgradeVector,
    }

    #[derive(Deserialize)]
    struct WebTransportUpgradeVector {
        upgrade_secret_hex: String,
        nonce_hex: String,
        signal_session_id: String,
        browser_node_id: String,
        daemon_id: String,
        wt_temp_peer_id: String,
        payload_utf8: String,
        proof_hex: String,
    }

    fn make_proof(
        upgrade_key: &[u8; 32],
        nonce_hex: &str,
        signal_session_id: &str,
        browser_node_id: &str,
        daemon_id: &str,
        wt_temp_peer_id: &str,
    ) -> Vec<u8> {
        let key = hmac::Key::new(hmac::HMAC_SHA512, upgrade_key);
        let payload = build_proof_payload(
            nonce_hex,
            signal_session_id,
            browser_node_id,
            daemon_id,
            wt_temp_peer_id,
        );
        hmac::sign(&key, payload.as_bytes()).as_ref().to_vec()
    }

    #[test]
    fn roundtrip_and_context_binding() {
        let session_key = [7u8; 32];
        let nonce = "deadbeef".repeat(8);
        let mut proof = make_proof(&session_key, &nonce, "s1", "b1", "d1", "wt-pending-1");
        assert!(verify_wt_upgrade_proof(
            &session_key,
            &nonce,
            "s1",
            "b1",
            "d1",
            "wt-pending-1",
            &proof,
        ));
        assert!(!verify_wt_upgrade_proof(
            &session_key,
            &"cafebabe".repeat(8),
            "s1",
            "b1",
            "d1",
            "wt-pending-1",
            &proof,
        ));
        assert!(!verify_wt_upgrade_proof(
            &[8u8; 32],
            &nonce,
            "s1",
            "b1",
            "d1",
            "wt-pending-1",
            &proof,
        ));
        assert!(!verify_wt_upgrade_proof(
            &session_key,
            &nonce,
            "s1",
            "b1",
            "d1",
            "wt-pending-999",
            &proof,
        ));
        proof[0] ^= 0x01;
        assert!(!verify_wt_upgrade_proof(
            &session_key,
            &nonce,
            "s1",
            "b1",
            "d1",
            "wt-pending-1",
            &proof,
        ));
    }

    #[test]
    fn browser_and_daemon_share_the_committed_sha512_proof_vector() {
        let vectors: SessionAuthVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/shared/test-vectors/session-auth.json"
        )))
        .expect("direct-upgrade vector JSON");
        let vector = vectors.webtransport_upgrade;
        let upgrade_key: [u8; 32] = decode_hex(&vector.upgrade_secret_hex)
            .try_into()
            .expect("32-byte direct secret");
        let proof = decode_hex(&vector.proof_hex);
        assert_eq!(
            build_proof_payload(
                &vector.nonce_hex,
                &vector.signal_session_id,
                &vector.browser_node_id,
                &vector.daemon_id,
                &vector.wt_temp_peer_id,
            ),
            vector.payload_utf8
        );
        assert_eq!(proof.len(), 64);
        assert!(verify_wt_upgrade_proof(
            &upgrade_key,
            &vector.nonce_hex,
            &vector.signal_session_id,
            &vector.browser_node_id,
            &vector.daemon_id,
            &vector.wt_temp_peer_id,
            &proof,
        ));
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert!(value.len().is_multiple_of(2));
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).expect("hex byte"))
            .collect()
    }
}
