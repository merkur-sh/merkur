//! An authenticated daemon peer for WASM client benchmarks; no client shortcuts.
use merkur_authorization::decode_len;
use merkur_client::{auth, issuance, renewal, session, Entropy};
use merkur_e2e::{NoiseHandshake, NoiseTransport};
use merkur_wire::protocol::*;
use merkur_wire::signaling::ClientSignal;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
#[expect(
    dead_code,
    reason = "shared signed test fixture includes helpers unused by this oracle"
)]
#[path = "../src/test_support.rs"]
mod fixture;

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|n| u8::try_from(n.as_u64().unwrap()).unwrap())
        .collect()
}
/// Native daemon codec and FEC encoder fixtures, opened at the authenticated viewer boundary.
fn fec_fixture(frames: u32) -> Value {
    use base64::Engine;
    use merkur_codec::{
        encode_frame_into, write_stream_header, CellRepr, FrameHeader, FrameKind, RowRef,
        StreamHeader, DISPLAY_HEADER_FLAG_FEC_PROTECTED, MSG_TYPE_DISPLAY_PATCH,
        STREAM_HEADER_BYTES,
    };
    use merkur_fec::repair::{repair_header_bytes, RepairHeader};
    assert!(frames > 0 && frames.is_multiple_of(4));
    let encode = |seq: u32| {
        let cells = [CellRepr {
            codepoint: 65 + seq % 26,
            ..CellRepr::BLANK
        }; 80];
        let header = FrameHeader {
            kind: if seq == 0 {
                FrameKind::Snapshot
            } else {
                FrameKind::Delta
            },
            memory_only: false,
            cols: 80,
            rows: 24,
            cursor_col: 0,
            cursor_row: 0,
            cursor_shape: 0,
            cursor_visible: 1,
            mode_flags: 0,
            row_count: 1,
            frame_id: seq + 1,
            presentation_id: seq + 1,
            presentation_member_index: 0,
            presentation_member_count: 1,
            row_predecessor_presentation_id: 0,
            presentation_coherent: false,
            presentation_end: true,
            chunk_index: 0,
            chunk_count: 1,
            demand_serial: 0,
            demand_limited: false,
            demand_prompt: false,
            demand_awaits_grant: false,
            closure_digest: 0,
            scroll_serial: 0,
            echo_horizon: 0,
        };
        let mut out = Vec::new();
        encode_frame_into(
            &mut out,
            &header,
            [RowRef {
                row_index: (seq % 24) as u16,
                left: 0,
                cells: &cells,
                graphics: &[],
            }]
            .into_iter(),
        );
        let body_len = (out.len() - STREAM_HEADER_BYTES) as u32;
        write_stream_header(
            &mut out,
            &StreamHeader {
                msg_type: MSG_TYPE_DISPLAY_PATCH,
                flags: if seq == 0 {
                    0
                } else {
                    DISPLAY_HEADER_FLAG_FEC_PROTECTED
                },
                body_len,
                seq,
                generation: 1,
                input_seq: 0,
            },
        );
        out
    };
    // Length-prefixed preopened frames: snapshot, then three data shards and one
    // repair per batch. The missing fourth data shard is never sent to the viewer.
    let mut fixture = Vec::new();
    let append = |fixture: &mut Vec<u8>, bytes: &[u8]| {
        fixture.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        fixture.extend_from_slice(bytes);
    };
    append(&mut fixture, &encode(0));
    for start in (1..=frames).step_by(4) {
        let mut data: Vec<_> = (start..start + 4).map(&encode).collect();
        let shard_size = data.iter().map(Vec::len).max().unwrap();
        for shard in &mut data {
            shard.resize(shard_size, 0);
        }
        let refs: Vec<_> = data.iter().map(Vec::as_slice).collect();
        let mut body = vec![0; shard_size];
        merkur_fec::encode(&refs, &mut [&mut body]).unwrap();
        let repair_header = RepairHeader {
            batch_start_seq: start,
            data_shards: 4,
            recovery_shards: 1,
            shard_size: shard_size as u16,
            generation: 1,
        };
        let mut repair = repair_header_bytes(
            merkur_codec::MSG_TYPE_DISPLAY_FEC_REPAIR,
            &repair_header,
            body.len() as u16,
        )
        .to_vec();
        repair.extend_from_slice(&body);
        for shard in &data[..3] {
            append(&mut fixture, shard);
        }
        append(&mut fixture, &repair);
    }
    json!({"frames": frames, "recovered": frames / 4, "cols": 80, "rows": 24,
        "payload": base64::engine::general_purpose::STANDARD.encode(fixture)})
}

fn main() {
    let (account, daemon, binding) = fixture::account();
    let issued = fixture::issuance(&daemon, binding);
    let public = fixture::delegate().public_key().to_vec();
    let mut responder: Option<NoiseHandshake> = None;
    let mut transport: Option<NoiseTransport> = None;
    let mut lineage: Option<fixture::DaemonLineage> = None;
    let mut in_flight: Option<fixture::RebindInFlight> = None;
    let mut next_input = 1u32;
    let mut held = std::collections::BTreeMap::<u32, Vec<u8>>::new();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let command: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let reply = match command["op"].as_str().unwrap() {
            "fec-fixture" => {
                fec_fixture(u32::try_from(command["frames"].as_u64().unwrap()).unwrap())
            }
            "init" => json!({ "origin": fixture::ORIGIN, "browser": fixture::BROWSER_NODE_ID,
                "now": fixture::NOW, "certificate": account.certificate.to_json(),
                "root": &account.root_public_key[..], "issuance": {
                "daemonId": issued.daemon_id, "daemonIdentityPublicKey": issued.daemon_identity_public_key,
                "daemonIdentityP256PublicKey": issued.daemon_identity_p256_public_key,
                "daemonBinding": issued.daemon_binding, "sessionToken": issued.session_token,
                "sessionTokenExpiresAtMs": issued.session_token_expires_at_ms,
                "sessionTokenExpiresInMs": issued.session_token_expires_in_ms,
                "sessionId": issued.session_id, "edgeWtUrl": issued.edge_wt_url,
                "edgeCertHashes": issued.edge_cert_hashes, "edgeAttachTicket": issued.edge_attach_ticket }}),
            "signal" => {
                let flight = ClientSignal::parse(&bytes(&command["bytes"])).unwrap();
                let signal = match &flight {
                    ClientSignal::SessionAuth(_) => {
                        let (ready, pending, keeper) = fixture::answer(&daemon, &flight, &public);
                        responder = Some(pending);
                        lineage = Some(keeper);
                        Some(ready)
                    }
                    ClientSignal::NoiseFinal(final_flight) => {
                        let mut pending = responder.take().unwrap();
                        pending
                            .read_message(
                                &decode_len(
                                    &final_flight.data,
                                    final_flight.data.len() * 3 / 4,
                                    "msg3",
                                )
                                .unwrap(),
                            )
                            .unwrap();
                        transport = Some(pending.into_transport().unwrap());
                        None
                    }
                    ClientSignal::SessionRebind(_) => {
                        let (rebound, hold) = lineage.as_ref().unwrap().answer(&flight, next_input);
                        in_flight = Some(hold);
                        Some(rebound)
                    }
                    ClientSignal::RebindFinal(_) => {
                        transport = Some(
                            lineage
                                .as_mut()
                                .unwrap()
                                .commit(in_flight.take().unwrap(), &flight),
                        );
                        None
                    }
                    ClientSignal::SessionRebindReconcile(_) => {
                        Some(lineage.as_ref().unwrap().reconcile(&flight))
                    }
                    _ => None,
                };
                json!({"signal": signal.map(|s| s.to_json())})
            }
            "receive" => {
                let channel = u8::try_from(command["channel"].as_u64().unwrap()).unwrap();
                let datagram = command["datagram"].as_bool().unwrap();
                let packet = bytes(&command["bytes"]);
                let lane = merkur_e2e::lane_for_channel(channel).unwrap();
                let peer = transport.as_mut().unwrap();
                let opened = if datagram {
                    peer.open_datagram(lane, &packet)
                } else {
                    peer.open_stream(lane, &packet)
                };
                match opened {
                    Err(_) => json!({"responses": [], "applied": []}),
                    Ok(plaintext) => {
                        let mut responses: Vec<(u8, Vec<u8>)> = Vec::new();
                        let mut applied = Vec::new();
                        if let Some((kind, body)) = decode_proto_frame(&plaintext) {
                            if kind == MSG_TYPE_INPUT_RUN {
                                let (header, records) = parse_input_run(body).unwrap();
                                for (offset, entry) in records.enumerate() {
                                    let sequence =
                                        header.base_seq.checked_add(offset as u32).unwrap();
                                    if sequence >= next_input {
                                        held.entry(sequence)
                                            .or_insert_with(|| entry.payload.to_vec());
                                    }
                                }
                                while let Some(record) = held.remove(&next_input) {
                                    applied.push(json!({"sequence":next_input,"record":record}));
                                    next_input += 1;
                                }
                                let ack = encode_proto_frame(
                                    MSG_TYPE_INPUT_ACK,
                                    &(next_input - 1).to_be_bytes(),
                                );
                                responses.push((
                                    CHANNEL_PTY,
                                    peer.seal_stream(
                                        merkur_e2e::lane_for_channel(CHANNEL_PTY).unwrap(),
                                        &ack,
                                    )
                                    .unwrap(),
                                ));
                                if let Some(probe) = header.probe {
                                    let mut body = [0u8; 16];
                                    body[..8].copy_from_slice(&probe.to_be_bytes());
                                    let pong = encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &body);
                                    responses.push((
                                        CHANNEL_CTRL,
                                        peer.seal_stream(
                                            merkur_e2e::lane_for_channel(CHANNEL_CTRL).unwrap(),
                                            &pong,
                                        )
                                        .unwrap(),
                                    ));
                                }
                            } else if kind == MSG_TYPE_HEARTBEAT_PING {
                                let mut pong_body = [0u8; 16];
                                pong_body[..8].copy_from_slice(&body[..8]);
                                let pong = encode_proto_frame(MSG_TYPE_HEARTBEAT_PONG, &pong_body);
                                responses
                                    .push((CHANNEL_CTRL, peer.seal_stream(lane, &pong).unwrap()));
                            }
                        }
                        json!({"responses":responses,"applied":applied})
                    }
                }
            }
            "hello" => {
                let packet = bytes(&command["bytes"]);
                let (kind, nonce) = decode_data_handshake_frame(&packet).unwrap();
                assert_eq!(kind, DataHandshakeKind::Hello);
                json!({"ack": encode_data_handshake_frame(DataHandshakeKind::Ack, &nonce)})
            }
            "seal" => {
                let channel = u8::try_from(command["channel"].as_u64().unwrap()).unwrap();
                let packet = bytes(&command["bytes"]);
                let peer = transport.as_mut().unwrap();
                let lane = merkur_e2e::lane_for_channel(channel).unwrap();
                let sealed = if command["datagram"].as_bool().unwrap_or(false) {
                    peer.seal_datagram(lane, &packet)
                } else {
                    peer.seal_stream(lane, &packet)
                }
                .unwrap();
                json!({"bytes":sealed})
            }
            other => panic!("unknown oracle command {other}"),
        };
        serde_json::to_writer(&mut stdout, &reply).unwrap();
        writeln!(stdout).unwrap();
        stdout.flush().unwrap();
    }
}
