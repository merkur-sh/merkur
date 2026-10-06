use super::*;
use crate::connection::PeerTransport;
use crate::display::compressor::{DISPLAY_DICTIONARY_MAX_BYTES, DISPLAY_DICTIONARY_MIN_BYTES};
use crate::network::peer::{DeliveryMode, PeerMessage};

/// A group send preceded by the atomic plan the burst makes for its whole
/// admitted prefix: these tests hand the group send unplanned datagrams.
fn send_planned_group(
    peer: &mut PeerDisplayState,
    group: &mut [PreparedDisplayDatagram],
    frames: &mut BufferPool,
    now_ms: f64,
    budget: &mut DatagramPhysicalBudget,
) -> GroupSendOutcome {
    if group
        .iter()
        .any(|datagram| !datagram.physical_plan.data_paths.any())
    {
        let mut trial_budget = *budget;
        let mut trial_evidence = peer.display_cache.fec_evidence;
        let mut plans = [PreparedPhysicalDatagramPlan::default(); merkur_fec::FEC_MAX_DATA];
        let preferred = prepared_display_transport(peer, group, group.len(), now_ms, budget);
        if !plan_required_physical_group(
            &peer.paths,
            preferred,
            &mut trial_evidence,
            group,
            now_ms,
            &mut trial_budget,
            &mut plans,
        ) {
            return GroupSendOutcome {
                all_sent: false,
                original_admitted: false,
                stop: true,
                presentation_end_admitted: false,
                probe_path: None,
            };
        }
        for (datagram, plan) in group.iter_mut().zip(plans) {
            datagram.physical_plan = plan;
        }
        *budget = trial_budget;
        plan_optional_physical_sends(peer, group, group.len(), now_ms, budget);
    }
    send_prepared_datagram_group_inner(peer, group, frames, now_ms, budget)
}

/// The direct carrier's room and quote come from the delivery view of the
/// session the peer owns.
#[tokio::test]
async fn a_flush_budgets_and_quotes_the_direct_carrier_from_its_session_view() {
    let (config, cert) = crate::webtransport::build_server_config(0).expect("server config");
    let server = wtransport::Endpoint::server(config).expect("server");
    let url = format!(
        "https://127.0.0.1:{}",
        server.local_addr().expect("addr").port()
    );
    let client = wtransport::Endpoint::client(
        wtransport::ClientConfig::builder()
            .with_bind_default()
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(cert.cert_hash)])
            .build(),
    )
    .expect("client");
    let (daemon, browser) = tokio::join!(
        async { server.accept().await.await.unwrap().accept().await.unwrap() },
        client.connect(&url)
    );
    let (daemon, _browser) = (Arc::new(daemon), browser.expect("browser"));
    // Queued and not yet packetized: this runtime has not run the driver.
    daemon
        .send_datagram_owned(bytes::Bytes::from_static(&[7; 300]))
        .expect("queued");
    let view = daemon.delivery_state();
    assert!(view.datagram_send_buffer_space < DATAGRAM_SEND_BUFFER_BYTES - 300);

    let mut peer = PeerDisplayState::new("browser".into(), PeerTransport::WebTransport);
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(0.0);
    peer.direct_session = Some(crate::webtransport::DirectSession::from_connection(
        Arc::clone(&daemon),
    ));

    let budget = DatagramPhysicalBudget::capture(&peer, 0.0);
    assert_eq!(budget.webtransport_bytes, view.datagram_send_buffer_space);
    assert_eq!(
        budget.webtransport_additional_entry_overhead,
        daemon.datagram_additional_entry_overhead()
    );
    let (_, direct) = refresh_display_delivery_quotes(&mut peer);
    assert_eq!(direct, Some(view.datagram_send_buffer_space));
    let quote = peer
        .display_planning
        .carrier_quote(0, CarrierDeliveryQuote::default());
    assert_eq!(quote.congestion_window_bytes, view.cwnd);
    assert_eq!(quote.bytes_in_flight, view.bytes_in_flight);
    assert_eq!(
        quote.send_buffer_occupied_bytes,
        DATAGRAM_SEND_BUFFER_BYTES - view.datagram_send_buffer_space
    );
}

#[test]
fn attachment_fenced_missing_quote_resets_planner_history() {
    let mut planning = crate::display::planner::PeerDisplayPlanningModel::default();
    let learned = CarrierDeliveryQuote {
        one_way_us: 80_000.0,
        jitter_upper_us: 20_000.0,
        loss_upper: 0.09,
        ..CarrierDeliveryQuote::default()
    };
    planning.observe_carrier_quote(1, learned);
    let fallback = CarrierDeliveryQuote {
        one_way_us: 5_000.0,
        jitter_upper_us: 0.0,
        loss_upper: 0.0,
        ..CarrierDeliveryQuote::default()
    };
    assert!(planning.carrier_quote(1, fallback).one_way_us >= 100_000.0);

    refresh_planner_carrier_quote(&mut planning, 1, None);

    let reset = planning.carrier_quote(1, fallback);
    assert_eq!(reset.one_way_us, fallback.one_way_us);
    assert_eq!(reset.loss_upper, fallback.loss_upper);
}

#[test]
fn preparation_captures_both_live_quotes_and_excludes_a_retired_carrier() {
    let mut peer = benchmark_noise_peer();
    peer.paths.webtransport.available = true;
    peer.paths.webtransport.last_ack_at_ms = 100.0;
    peer.paths.edge.available = true;
    peer.paths.edge.last_ack_at_ms = 100.0;
    let direct = CarrierDeliveryQuote {
        one_way_us: 1_000.0,
        pacing_rate_bps: 8_000_000,
        ..CarrierDeliveryQuote::default()
    };
    let edge = CarrierDeliveryQuote {
        one_way_us: 2_500.0,
        pacing_rate_bps: 80_000_000,
        ..direct
    };
    peer.display_planning.observe_carrier_quote(0, direct);
    peer.display_planning.observe_carrier_quote(1, edge);
    let both = display_planning_context(&peer, 100.0, 0);
    assert_eq!(both.carrier.pacing_rate_bps, direct.pacing_rate_bps);
    assert_eq!(
        both.alternate_carrier.unwrap().pacing_rate_bps,
        edge.pacing_rate_bps
    );
    peer.paths.edge.available = false;
    let direct_only = display_planning_context(&peer, 100.0, 0);
    assert!(direct_only.alternate_carrier.is_none());
    peer.paths.edge.available = true;
    peer.paths.webtransport.available = false;
    let edge_only = display_planning_context(&peer, 100.0, 0);
    assert!(edge_only.alternate_carrier.is_none());
    assert_eq!(edge_only.carrier.pacing_rate_bps, edge.pacing_rate_bps);
}

#[test]
fn actual_burst_quote_controls_data_parity_and_jumbo_primary() {
    let mut peer = benchmark_noise_peer();
    for (path, rtt) in [
        (PeerTransport::WebTransport, 2.0),
        (PeerTransport::Edge, 5.0),
    ] {
        let health = peer.paths.get_mut(path);
        health.available = true;
        health.last_ack_at_ms = 100.0;
        health.network_rtt_ewma_ms = rtt;
    }
    let direct = CarrierDeliveryQuote {
        one_way_us: 1_000.0,
        pacing_rate_bps: 8_000_000,
        ..CarrierDeliveryQuote::default()
    };
    peer.display_planning.observe_carrier_quote(0, direct);
    peer.display_planning.observe_carrier_quote(
        1,
        CarrierDeliveryQuote {
            one_way_us: 2_500.0,
            pacing_rate_bps: 80_000_000,
            ..direct
        },
    );
    let budget = DatagramPhysicalBudget::exact(100_000, 100_000, 512);
    let mut small = [prepared_with_utility_for_test(
        1,
        64,
        DisplayUtility::NonCritical,
    )];
    assert_eq!(
        prepared_display_transport(&peer, &mut small, 4, 100.0, &budget),
        PeerTransport::WebTransport
    );

    let mut burst: Vec<_> = (1..=4)
        .map(|seq| prepared_with_utility_for_test(seq, 700, DisplayUtility::NonCritical))
        .collect();
    burst.push(prepared_with_utility_for_test(
        5,
        5_000,
        DisplayUtility::Critical,
    ));
    let mut available = budget;
    let mut pool = frame_pool_for_test();
    assert_eq!(
        admit_prepared_physical_prefix(&mut peer, &mut burst, &mut pool, 4, 100.0, &mut available),
        5
    );
    assert!(
        burst
            .iter()
            .all(|frame| frame.physical_plan.data_primary == Some(PeerTransport::Edge))
    );
    assert_eq!(
        burst[3].physical_plan.repair_primary,
        Some(PeerTransport::Edge)
    );
    assert_eq!(
        burst[4].physical_plan.data_primary,
        Some(PeerTransport::Edge)
    );

    // A refused preferred queue must choose the complete other-carrier
    // reservation, not partly fill the edge before switching mid-group.
    let mut constrained = DatagramPhysicalBudget::exact(100_000, 100, 512);
    assert_eq!(
        admit_prepared_physical_prefix(
            &mut peer,
            &mut burst,
            &mut pool,
            4,
            100.0,
            &mut constrained
        ),
        5
    );
    assert!(
        burst
            .iter()
            .all(|frame| frame.physical_plan.data_primary == Some(PeerTransport::WebTransport))
    );
    assert_eq!(
        burst[3].physical_plan.repair_primary,
        Some(PeerTransport::WebTransport)
    );
    assert_eq!(constrained.edge_bytes, 100);

    // Neither queue holds the whole group. Reserving parity first gives
    // opposite mixed layouts depending on preference: price the actual
    // chosen data/repair paths, not fictional all-direct/all-edge bytes.
    let mut mixed = [
        prepared_with_utility_for_test(1, 700, DisplayUtility::NonCritical),
        prepared_with_utility_for_test(2, 200, DisplayUtility::NonCritical),
    ];
    let mixed_budget = DatagramPhysicalBudget::exact(1_000, 1_000, 3);
    let mut direct_budget = mixed_budget;
    assert_eq!(
        plan_required_physical_prefix(
            &peer,
            PeerTransport::WebTransport,
            &mut mixed,
            4,
            100.0,
            &mut direct_budget
        ),
        2
    );
    assert_eq!(
        mixed[0].physical_plan.data_primary,
        Some(PeerTransport::Edge)
    );
    assert_eq!(
        mixed[1].physical_plan.data_primary,
        Some(PeerTransport::WebTransport)
    );
    assert_eq!(
        mixed[1].physical_plan.repair_primary,
        Some(PeerTransport::WebTransport)
    );
    let direct_first = prepared_carrier_delivery_us(&peer, &mixed, 4);
    let mut edge_budget = mixed_budget;
    assert_eq!(
        plan_required_physical_prefix(
            &peer,
            PeerTransport::Edge,
            &mut mixed,
            4,
            100.0,
            &mut edge_budget
        ),
        2
    );
    assert_eq!(
        mixed[0].physical_plan.data_primary,
        Some(PeerTransport::WebTransport)
    );
    assert_eq!(
        mixed[1].physical_plan.repair_primary,
        Some(PeerTransport::Edge)
    );
    let edge_first = prepared_carrier_delivery_us(&peer, &mixed, 4);
    assert!(
        direct_first < edge_first,
        "actual mixed direct-first={direct_first} must beat edge-first={edge_first}"
    );
    assert_eq!(
        prepared_display_transport(&peer, &mut mixed, 4, 100.0, &mixed_budget),
        PeerTransport::WebTransport
    );

    let mut critical = [prepared_with_utility_for_test(
        1,
        700,
        DisplayUtility::Critical,
    )];
    let mut available = budget;
    assert_eq!(
        admit_prepared_physical_prefix(
            &mut peer,
            &mut critical,
            &mut pool,
            4,
            100.0,
            &mut available
        ),
        1
    );
    assert!(critical[0].physical_plan.data_paths.webtransport);
    assert!(critical[0].physical_plan.data_paths.edge);
}

/// Synthetic causal regressions, not physical/cohort latency measurements.
/// Forward quotes, receiver costs, capacity and liveness stay fixed while
/// the real ACK handler receives independently varied return/cadence times.
mod ack_route_invariance {
    use super::*;
    use crate::display::recv::{DisplayAck, handle_display_ack};

    const DECISION_AT_MS: f64 = 100_000.0;
    const ACKED_WIRE_BYTES: usize = 128;

    fn physical_quote(path: PeerTransport) -> CarrierDeliveryQuote {
        CarrierDeliveryQuote {
            one_way_us: if path == PeerTransport::WebTransport {
                25_000.0
            } else {
                60_000.0
            },
            // Fixed, deliberately different pacers expose the small/bulk
            // crossover. They are fixture values, not estimates of the cohort.
            pacing_rate_bps: if path == PeerTransport::WebTransport {
                96_000_000
            } else {
                1_000_000
            },
            loss_upper: 0.0,
            ..CarrierDeliveryQuote::default()
        }
    }

    fn peer(with_physical_quotes: bool) -> PeerDisplayState {
        let mut peer = PeerDisplayState::new("ack-route-diagnostic".into(), PeerTransport::Edge);
        peer.generation = 1;
        peer.display_cache.resize(1, 1);
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            let health = peer.paths.get_mut(path);
            health.available = true;
            health.last_ack_at_ms = DECISION_AT_MS;
            health.network_rtt_ewma_ms = physical_quote(path).one_way_us / 500.0;
            health.network_jitter_ewma_ms = 4.0;
            if with_physical_quotes {
                peer.display_planning.observe_carrier_quote(
                    usize::from(path == PeerTransport::Edge),
                    physical_quote(path),
                );
            }
        }
        peer
    }

    fn acknowledge(
        peer: &mut PeerDisplayState,
        original_path: PeerTransport,
        ack_path: PeerTransport,
        return_ms: f64,
        cadence_ms: f64,
        ack_quote_queue_us: Option<f64>,
    ) {
        let seq = peer.last_display_seq_sent + 1;
        let sent_at_ms = f64::from(seq) * 200.0;
        let quote = physical_quote(original_path);
        let forward_us = quote.fixed_delivery_us() + quote.serialization_us(ACKED_WIRE_BYTES);
        let at_ms = sent_at_ms + forward_us / 1_000.0 + return_ms + cadence_ms;
        let rows = SentRows::from_iter([SentRow {
            graphics: None,
            row: 0,
            hash: 7,
            cells: Arc::from([CellRepr::BLANK]),
        }]);
        let paths = SentPaths::single(original_path);
        peer.display_cache
            .record_sent_rows_on_paths(seq, &rows, sent_at_ms, paths, 100.0);
        peer.display_cache.sent_datagrams.insert(
            seq,
            SentDatagram {
                sent_at_ms,
                rows,
                sent_via: paths,
                header_only: false,
                reliable: false,
                protection: DisplayDatagramProtection::Unprotected,
            },
        );
        peer.last_display_seq_sent = seq;

        // This queue appeared AFTER the fixture's original arrived. Clear
        // it again before ranking the next work; only the ACK-time quote
        // differs, never the original or next actual forward delivery.
        let index = usize::from(original_path == PeerTransport::Edge);
        if let Some(queue_us) = ack_quote_queue_us {
            let mut ack_quote = quote;
            ack_quote.bytes_in_flight = ack_quote.congestion_window_bytes
                + (queue_us * quote.pacing_rate_bps as f64 / 8_000_000.0) as u64;
            peer.display_planning
                .observe_carrier_quote(index, ack_quote);
        }
        handle_display_ack(
            peer,
            DisplayAck::new(1, seq, [1, 0, 0, 0]),
            at_ms,
            ack_path,
            &[7],
            false,
        );
        if ack_quote_queue_us.is_some() {
            peer.display_planning.observe_carrier_quote(index, quote);
        }
        // Keep liveness out of this route-cost experiment.
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            peer.paths.get_mut(path).last_ack_at_ms = DECISION_AT_MS;
        }
        assert_eq!(peer.display_cache.acked_row_hashes, [7]);
        assert_eq!(peer.display_cache.acked_row_seq, [seq]);
        assert!(peer.display_cache.sent_row_confirmed[0]);
        assert!(peer.display_cache.sent_datagrams.is_empty());
    }

    #[derive(Debug, PartialEq)]
    struct Ranking {
        primary: PeerTransport,
        direct_us: f64,
        edge_us: f64,
    }

    fn rank(peer: &PeerDisplayState, shape: &str) -> Ranking {
        let mut prepared = match shape {
            "noncritical-singleton" => vec![prepared_with_utility_for_test(
                1,
                76,
                DisplayUtility::NonCritical,
            )],
            "critical-singleton" => vec![prepared_with_utility_for_test(
                1,
                76,
                DisplayUtility::Critical,
            )],
            "critical-plus-fec" => {
                let mut frames = vec![prepared_with_utility_for_test(
                    1,
                    76,
                    DisplayUtility::Critical,
                )];
                frames.extend((2..=5).map(|seq| {
                    prepared_with_utility_for_test(seq, 700, DisplayUtility::NonCritical)
                }));
                frames
            }
            _ => panic!("unknown diagnostic shape"),
        };
        let budget = DatagramPhysicalBudget::exact(1_000_000, 1_000_000, 512);
        let mut costs = [0.0; 2];
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            let mut available = budget;
            assert_eq!(
                plan_required_physical_prefix(
                    peer,
                    path,
                    &mut prepared,
                    4,
                    DECISION_AT_MS,
                    &mut available
                ),
                prepared.len()
            );
            costs[usize::from(path == PeerTransport::Edge)] =
                prepared_carrier_delivery_us(peer, &prepared, 4);
        }
        let primary = prepared_display_transport(peer, &mut prepared, 4, DECISION_AT_MS, &budget);
        assert_eq!(
            primary,
            if costs[0] <= costs[1] {
                PeerTransport::WebTransport
            } else {
                PeerTransport::Edge
            }
        );
        let mut available = budget;
        assert_eq!(
            plan_required_physical_prefix(
                peer,
                primary,
                &mut prepared,
                4,
                DECISION_AT_MS,
                &mut available
            ),
            prepared.len()
        );
        plan_optional_physical_sends(peer, &mut prepared, 4, DECISION_AT_MS, &mut available);
        if shape != "noncritical-singleton" {
            assert!(
                prepared[0].physical_plan.data_paths.webtransport
                    && prepared[0].physical_plan.data_paths.edge,
                "the changed primary must not erase Critical's redundant copy"
            );
        }
        if shape == "critical-plus-fec" {
            assert!(
                prepared[4].physical_plan.repair_paths.any(),
                "dense shape must actually include parity"
            );
        }
        Ranking {
            primary,
            direct_us: costs[0],
            edge_us: costs[1],
        }
    }

    fn ranks(peer: &PeerDisplayState) -> [Ranking; 3] {
        [
            "noncritical-singleton",
            "critical-singleton",
            "critical-plus-fec",
        ]
        .map(|shape| rank(peer, shape))
    }

    #[derive(Debug, PartialEq)]
    struct PackingDecision {
        attempt_compression: bool,
        fitted_representation: Representation,
        partitions: Vec<(usize, Representation)>,
    }

    fn packing_decision(peer: &PeerDisplayState, dictionary: DictionaryClass) -> PackingDecision {
        let global = GlobalDisplayPlanningModel::default();
        let snapshot = peer
            .display_planning
            .snapshot(ContentClass::Text, dictionary);
        let context = display_planning_context(peer, DECISION_AT_MS, 0);
        let mut workspace = PlannerWorkspace::default();
        let mut partitions = BatchPartitionPlan::default();
        plan_batch_partitions(
            &global,
            &[snapshot; 3],
            ExecutionLane::Bulk,
            dictionary,
            context,
            &[PlannedRow::of(600, ContentClass::Text); 8],
            FRAME_HEADER_BODY_BYTES,
            1_084,
            &mut workspace,
            &mut partitions,
        );
        PackingDecision {
            attempt_compression: planner_should_attempt_compression(
                &global,
                snapshot,
                ExecutionLane::Bulk,
                5_000,
                ContentClass::Text,
                dictionary,
                context,
            ),
            fitted_representation: choose_after_compression(
                snapshot, 5_000, 1_000, dictionary, context,
            ),
            partitions: (0..8).filter_map(|index| partitions.get(index)).collect(),
        }
    }

    #[test]
    fn return_carrier_delay_cadence_and_cold_evidence_do_not_change_forward_decisions() {
        let mut cases = 0;
        for with_quotes in [false, true] {
            let cold = peer(with_quotes);
            let expected = ranks(&cold);
            let expected_packing = [DictionaryClass::Plain, DictionaryClass::Finalized]
                .map(|dictionary| packing_decision(&cold, dictionary));
            for original in [PeerTransport::WebTransport, PeerTransport::Edge] {
                for ack_path in [PeerTransport::WebTransport, PeerTransport::Edge] {
                    for count in [0, 1, 8, 32] {
                        for (return_ms, cadence_ms) in
                            [(25.0, 0.0), (60.0, 0.0), (25.0, 20.0), (60.0, 20.0)]
                        {
                            let mut warmed = peer(with_quotes);
                            for _ in 0..count {
                                acknowledge(
                                    &mut warmed,
                                    original,
                                    ack_path,
                                    return_ms,
                                    cadence_ms,
                                    with_quotes.then_some(0.0),
                                );
                            }
                            assert_eq!(
                                ranks(&warmed),
                                expected,
                                "quotes={with_quotes} original={original:?} ack={ack_path:?} count={count} return={return_ms} cadence={cadence_ms}"
                            );
                            assert_eq!(
                                [DictionaryClass::Plain, DictionaryClass::Finalized]
                                    .map(|dictionary| packing_decision(&warmed, dictionary)),
                                expected_packing
                            );
                            assert_eq!(warmed.display_confirm.sample_count(), count);
                            for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
                                assert_eq!(warmed.paths.get(path).network_jitter_ewma_ms, 4.0);
                                assert_eq!(
                                    warmed.paths.get(path).network_rtt_ewma_ms,
                                    physical_quote(path).one_way_us / 500.0
                                );
                            }
                            // The negative control really exercised mixed jitter;
                            // missing physical quotes must still ignore it.
                            if count > 0 {
                                assert!(warmed.paths.get(original).jitter_ewma_ms > 0.0);
                            }
                            cases += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(cases, 128);
        println!(
            "ack-forward-invariance cases={cases} shapes=3 boundary=synthetic-model-functional-not-measured-delivery"
        );
    }

    #[test]
    fn warming_one_then_both_carriers_preserves_forward_ranking() {
        for with_quotes in [false, true] {
            let mut warmed = peer(with_quotes);
            let expected = ranks(&warmed);
            for original in [PeerTransport::WebTransport, PeerTransport::Edge] {
                for _ in 0..32 {
                    acknowledge(
                        &mut warmed,
                        original,
                        PeerTransport::WebTransport,
                        25.0,
                        20.0,
                        with_quotes.then_some(0.0),
                    );
                }
                assert_eq!(ranks(&warmed), expected);
            }
        }
    }

    #[test]
    fn ack_time_queue_cannot_leave_a_confirmation_derived_forward_penalty() {
        let mut unchanged = peer(true);
        let mut transient_queue = peer(true);
        let expected = ranks(&unchanged);
        for _ in 0..32 {
            acknowledge(
                &mut unchanged,
                PeerTransport::WebTransport,
                PeerTransport::Edge,
                60.0,
                0.0,
                Some(0.0),
            );
            acknowledge(
                &mut transient_queue,
                PeerTransport::WebTransport,
                PeerTransport::Edge,
                60.0,
                0.0,
                Some(30_000.0),
            );
        }
        assert_eq!(ranks(&unchanged), expected);
        assert_eq!(ranks(&transient_queue), expected);
    }

    #[test]
    fn confirmation_deadline_still_accounts_for_return_and_cadence() {
        for with_quotes in [false, true] {
            let mut fast = peer(with_quotes);
            let mut delayed = peer(with_quotes);
            acknowledge(
                &mut fast,
                PeerTransport::WebTransport,
                PeerTransport::WebTransport,
                25.0,
                0.0,
                with_quotes.then_some(0.0),
            );
            acknowledge(
                &mut delayed,
                PeerTransport::WebTransport,
                PeerTransport::Edge,
                60.0,
                20.0,
                with_quotes.then_some(0.0),
            );
            // The confirmation term alone: the path round-trip floor is
            // held at zero so this compares what the ACKs taught.
            let deadline = |peer: &PeerDisplayState| {
                DisplayPolicy::row_resend_interval_ms(
                    peer.display_confirm.ewma_ms,
                    peer.display_confirm.jitter_ewma_ms,
                    0.0,
                    0.0,
                )
            };
            assert!((deadline(&delayed) - deadline(&fast) - 55.0).abs() < 1e-9);
            assert_eq!(ranks(&fast), ranks(&delayed));
        }
    }

    #[test]
    fn heartbeat_jitter_changes_missing_quote_ranking_without_changing_mean_rtt() {
        let mut changing = peer(false);
        for path in [PeerTransport::WebTransport, PeerTransport::Edge] {
            changing
                .paths
                .get_mut(path)
                .seed_rtt(physical_quote(path).one_way_us / 500.0);
        }
        let before = ranks(&changing);
        assert!(
            before
                .iter()
                .all(|rank| rank.primary == PeerTransport::WebTransport)
        );
        for _ in 0..4 {
            let direct = &mut changing.paths.webtransport;
            // Each pair returns the EWMA exactly to 50ms; only its
            // heartbeat-owned variation remains in the next forward quote.
            direct.record_network_rtt_sample(100.0);
            direct.record_network_rtt_sample(7.5);
            assert_eq!(direct.network_rtt_ewma_ms, 50.0);
        }
        assert!(changing.paths.webtransport.network_jitter_ewma_ms > 40.0);
        assert_eq!(changing.paths.edge.network_jitter_ewma_ms, 0.0);
        let after = ranks(&changing);
        for (before, after) in before.iter().zip(&after) {
            assert!(after.direct_us > before.direct_us);
            assert_eq!(after.edge_us, before.edge_us);
            assert_eq!(after.primary, PeerTransport::Edge);
        }
    }

    #[test]
    fn actual_forward_queue_congestion_loss_and_pacer_still_change_routing() {
        for condition in ["queue", "cwnd", "loss", "pacer"] {
            let mut changing = peer(true);
            let mut direct = physical_quote(PeerTransport::WebTransport);
            if condition == "cwnd" {
                // Identical flight bytes fit the old cwnd but not the new one.
                direct.bytes_in_flight = 2_000_000;
                direct.congestion_window_bytes = 2_000_000;
                changing.display_planning.observe_carrier_quote(0, direct);
            }
            let before = ranks(&changing);
            assert!(
                before
                    .iter()
                    .all(|rank| rank.primary == PeerTransport::WebTransport)
            );
            match condition {
                "queue" => direct.send_buffer_occupied_bytes = 1_000_000,
                "cwnd" => direct.congestion_window_bytes = 1_200,
                "loss" => direct.loss_upper = 0.9,
                "pacer" => direct.pacing_rate_bps = 1_000,
                _ => unreachable!(),
            }
            changing.display_planning.observe_carrier_quote(0, direct);
            let after = ranks(&changing);
            for (before, after) in before.iter().zip(&after) {
                assert!(after.direct_us > before.direct_us, "{condition}: {after:?}");
                assert_eq!(after.edge_us, before.edge_us, "{condition}");
                assert_eq!(after.primary, PeerTransport::Edge, "{condition}: {after:?}");
            }
        }
    }
}

fn compression_policy_for_test(
    terminal_rows: u16,
    recently_interactive: bool,
    execution_lane: ExecutionLane,
) -> DisplayCompressionPolicy {
    let peer = crate::display::planner::PeerDisplayPlanningModel::default();
    DisplayCompressionPolicy {
        terminal_rows,
        chunk_target_bytes: 1_100,
        snapshot_target_bytes: 64 * 1024,
        backpressure_score: 0,
        recently_interactive,
        fit_relay_critical_datagram: false,
        planning_profiles: [
            peer.snapshot(ContentClass::Sparse, DictionaryClass::Plain),
            peer.snapshot(ContentClass::Text, DictionaryClass::Plain),
            peer.snapshot(ContentClass::Color, DictionaryClass::Plain),
        ],
        planning_context: PlanningContext::default(),
        execution_lane,
    }
}

#[test]
fn batch_compression_preserves_attempted_rejection() {
    assert_eq!(
        BatchCompression::from_outcome(&DisplayCompressionOutcome::NOTHING),
        BatchCompression::NotAttempted,
    );
    assert_eq!(
        BatchCompression::from_outcome(&DisplayCompressionOutcome {
            used: false,
            achieved_ratio: Some(1.0),
        }),
        BatchCompression::AttemptedRejected,
    );
    assert_eq!(
        BatchCompression::from_outcome(&DisplayCompressionOutcome {
            used: false,
            achieved_ratio: Some(0.97),
        }),
        BatchCompression::AttemptedRejected,
    );
    assert_eq!(
        BatchCompression::from_outcome(&DisplayCompressionOutcome {
            used: true,
            achieved_ratio: Some(0.25),
        }),
        BatchCompression::Compressed,
    );
}

#[test]
fn display_utility_orders_cursor_prompt_and_bottom_before_ordinary_rows() {
    let mut rows = vec![
        DisplayRowRequest::literal(9, false),
        DisplayRowRequest::literal(1, false),
        DisplayRowRequest::literal(7, false),
        DisplayRowRequest::literal(2, false),
        DisplayRowRequest::literal(0, false),
        DisplayRowRequest::literal(8, false),
        DisplayRowRequest::literal(6, false),
        DisplayRowRequest::literal(4, false),
        DisplayRowRequest::literal(3, false),
        DisplayRowRequest::literal(5, false),
    ];

    prioritize_display_rows(&mut rows, Some(4), 10, &[], &[]);

    assert_eq!(
        rows.iter().map(|request| request.row).collect::<Vec<_>>(),
        vec![4, 2, 3, 7, 8, 9, 0, 1, 5, 6]
    );
    assert_eq!(
        display_row_utility(4, Some(4), 10),
        DisplayUtility::Critical
    );
    assert_eq!(
        display_row_utility(3, Some(4), 10),
        DisplayUtility::NonCritical,
        "prompt-adjacent rows stay valuable away from the terminal bottom"
    );
    assert_eq!(
        display_row_utility(9, Some(4), 10),
        DisplayUtility::NonCritical
    );
    assert_eq!(
        display_row_utility(1, Some(4), 10),
        DisplayUtility::NonCritical
    );
    assert_eq!(display_row_priority(3, Some(4), 10), 1);
    assert_eq!(display_row_priority(9, Some(4), 10), 1);
    assert_eq!(display_row_priority(1, Some(4), 10), 2);
    assert_eq!(
        display_row_utility(4, Some(4), 10).send_intent(),
        SendIntent::Redundant
    );
    assert_eq!(
        display_row_utility(3, Some(4), 10).send_intent(),
        SendIntent::SinglePath
    );
    assert_eq!(
        display_row_utility(1, Some(4), 10).send_intent(),
        SendIntent::SinglePath
    );
}

#[test]
fn utility_domains_keep_independent_frames_in_one_presentation() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 8, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 8);

    // Mutate one row in every class plus both valuable bands. Leave the
    // cursor away from the bottom so the prompt-adjacent case is explicit.
    terminal.apply_bytes(b"\x1b[5;1HC\x1b[4;1HP\x1b[8;1HV\x1b[2;1HO\x1b[5;2H");
    let mut selected_rows = vec![
        DisplayRowRequest::literal(1, false),
        DisplayRowRequest::literal(7, false),
        DisplayRowRequest::literal(3, false),
        DisplayRowRequest::literal(4, false),
    ];
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();

    let prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        9,
        100.0,
        &mut compressor,
        &mut row_capture_scratch,
        &mut flush_row_cache,
    );

    assert_eq!(
        prepared
            .iter()
            .map(|datagram| datagram.utility)
            .collect::<Vec<_>>(),
        vec![DisplayUtility::Critical, DisplayUtility::NonCritical]
    );
    assert_eq!(
        prepared
            .iter()
            .map(|datagram| {
                datagram
                    .rows
                    .iter()
                    .map(|sent_row| sent_row.row)
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
        vec![vec![4], vec![3, 7, 1]]
    );
    assert!(
        prepared
            .windows(2)
            .all(|pair| pair[0].frame_id != pair[1].frame_id),
        "critical and noncritical retain independent frame ids"
    );
    let presentation_id = merkur_codec::parse_frame_header(&prepared[0].frame)
        .unwrap()
        .presentation_id;
    for (index, (datagram, expected_row_count)) in prepared.iter().zip([1, 3]).enumerate() {
        let header = merkur_codec::parse_frame_header(&datagram.frame).unwrap();
        assert_eq!(header.frame_id, datagram.frame_id);
        assert_eq!(header.presentation_id, presentation_id);
        assert!(header.presentation_coherent);
        assert_eq!(header.presentation_end, index + 1 == prepared.len());
        assert_eq!(header.presentation_member_index, index as u16);
        assert_eq!(header.presentation_member_count, prepared.len() as u16);
        assert_eq!(header.chunk_index, 0);
        assert_eq!(header.chunk_count, 1);
        assert_eq!(header.row_count, expected_row_count);
    }
}

#[test]
fn multiple_noncritical_packets_keep_distinct_frames_in_one_presentation() {
    const COLS: u16 = 120;
    const ROWS: u16 = 12;

    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let mut contents = Vec::new();
    for row in 1..=ROWS {
        contents.extend_from_slice(format!("\x1b[{row};1H").as_bytes());
        for col in 0..COLS {
            contents.push(b'!' + ((usize::from(row) * 17 + usize::from(col) * 31) % 90) as u8);
        }
    }
    terminal.apply_bytes(&contents);
    terminal.apply_bytes(b"\x1b[6;60H");

    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(COLS, ROWS);
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    let mut selected_rows = (0..ROWS)
        .filter(|row| *row != 5)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect::<Vec<_>>();
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();

    let prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        9,
        100.0,
        &mut compressor,
        &mut row_capture_scratch,
        &mut flush_row_cache,
    );

    assert!(prepared.len() > 1, "fixture must cross the datagram cap");
    assert!(
        prepared
            .iter()
            .all(|datagram| datagram.utility == DisplayUtility::NonCritical)
    );

    // Every datagram is its own frame. These batches used to share one
    // frame id and a chunk count, which made the receiver hold all of them
    // before applying any — so losing one lost the whole redraw, and the
    // stranded assembly then pinned a receiver slot until an overflow
    // forced a full-screen snapshot.
    let mut frame_ids: Vec<u32> = Vec::new();
    let presentation_id = merkur_codec::parse_frame_header(&prepared[0].frame)
        .unwrap()
        .presentation_id;
    for (index, datagram) in prepared.iter().enumerate() {
        let header = merkur_codec::parse_frame_header(&datagram.frame).unwrap();
        assert_eq!(header.frame_id, datagram.frame_id);
        assert_eq!(header.presentation_id, presentation_id);
        assert!(header.presentation_coherent);
        assert_eq!(header.presentation_end, index + 1 == prepared.len());
        assert_eq!(header.chunk_index, 0);
        assert_eq!(header.chunk_count, 1);
        frame_ids.push(datagram.frame_id);
    }
    let distinct = frame_ids.iter().collect::<std::collections::HashSet<_>>();
    assert_eq!(
        distinct.len(),
        frame_ids.len(),
        "one flush must not reuse a frame id across datagrams"
    );

    // END is an early-commit hint, never an application barrier. Drop the
    // final END-bearing transport unit and feed every preceding frame to
    // the real browser terminal core: each independent transformation
    // must still apply, and only the rows on the lost datagram are absent.
    let mut receiver = term_wasm::Terminal::new_headless(COLS, ROWS);
    let unused_dictionary = DisplayDictionary::new(1, peer.generation, vec![1; 256]);
    for datagram in &prepared[..prepared.len() - 1] {
        let frame = decode_async_dictionary_benchmark_frame(datagram, &unused_dictionary);
        assert!(receiver.apply_delta_seq(&frame, datagram.seq));
        for row in &datagram.rows {
            assert_eq!(receiver.row_hash(row.row), row.hash);
        }
    }
}

#[test]
fn isolated_update_ends_immediately_but_known_continuation_stays_open() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 1, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 1);
    let mut compressor = Compressor::new();
    let mut scratch = PrepareScratch::default();
    let mut frames = frame_pool_for_test();
    let mut prepared = Vec::new();

    build_captured_datagram_batches(
        terminal.display_header_state(),
        &mut terminal,
        &mut peer,
        &[],
        0,
        true,
        false,
        false,
        1,
        100.0,
        &mut compressor,
        &mut scratch,
        &mut frames,
        &mut prepared,
    );
    assert_eq!(prepared.len(), 1);
    let isolated = merkur_codec::parse_frame_header(&prepared[0].frame).unwrap();
    assert_eq!(isolated.presentation_id, isolated.frame_id);
    assert!(!isolated.presentation_coherent);
    assert!(isolated.presentation_end);

    recycle_frames_for_test(&mut prepared, &mut frames);
    build_captured_datagram_batches(
        terminal.display_header_state(),
        &mut terminal,
        &mut peer,
        &[],
        0,
        true,
        true,
        false,
        1,
        100.0,
        &mut compressor,
        &mut scratch,
        &mut frames,
        &mut prepared,
    );
    assert_eq!(prepared.len(), 1);
    let continued = merkur_codec::parse_frame_header(&prepared[0].frame).unwrap();
    assert_eq!(continued.presentation_id, continued.frame_id);
    assert!(continued.presentation_coherent);
    assert!(!continued.presentation_end);
}

#[test]
fn only_header_or_causal_cursor_row_updates_bypass_presentation_coherence() {
    fn batch(row: Option<u16>, encoded_rows: u16, utility: DisplayUtility) -> PackedBatch {
        let mut rows = SentRows::default();
        if let Some(row) = row {
            rows.push(SentRow {
                graphics: None,
                row,
                hash: u64::from(row) + 1,
                cells: Arc::from(vec![CellRepr::BLANK]),
            });
        }
        (
            BatchPayload::plain(
                vec![0; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES],
                ContentClass::Text,
            ),
            rows,
            encoded_rows,
            utility,
        )
    }

    assert!(!presentation_is_coherent(
        &[batch(None, 0, DisplayUtility::Critical)],
        3,
        false,
        false,
    ));
    assert!(!presentation_is_coherent(
        &[batch(Some(3), 1, DisplayUtility::Critical)],
        3,
        true,
        false,
    ));

    for (label, batches, cursor_row, causal, continuation) in [
        (
            "cursor-row TUI content with unchanged input",
            vec![batch(Some(3), 1, DisplayUtility::Critical)],
            3,
            false,
            false,
        ),
        (
            "header-promoted distant row",
            vec![batch(Some(6), 1, DisplayUtility::Critical)],
            3,
            true,
            false,
        ),
        (
            "ordinary distant row",
            vec![batch(Some(6), 1, DisplayUtility::NonCritical)],
            3,
            true,
            false,
        ),
        (
            "multiple rows",
            vec![batch(Some(3), 2, DisplayUtility::Critical)],
            3,
            true,
            false,
        ),
        (
            "known continuation",
            vec![batch(Some(3), 1, DisplayUtility::Critical)],
            3,
            true,
            true,
        ),
        (
            "multiple batches",
            vec![
                batch(Some(3), 1, DisplayUtility::Critical),
                batch(Some(6), 1, DisplayUtility::NonCritical),
            ],
            3,
            true,
            false,
        ),
    ] {
        assert!(
            presentation_is_coherent(&batches, cursor_row, causal, continuation),
            "{label} must join a bounded presentation transaction",
        );
    }
}

/// A keystroke's header-only advertisement is admitted before the shell's
/// echo is read, so it must not strip the echo of its causal standing. Every
/// echo used to lose it and waited a whole worker animation frame for a
/// presentation transaction it was never part of.
#[test]
fn an_echo_after_its_header_only_advertisement_still_bypasses_presentation_hold() {
    let echo_coherence = |row_advertised: u32| {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(8, 4, event_tx);
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(8, 4);
        peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
        // The barrier release for input 9 already entered a carrier.
        peer.latest_input_seq = 9;
        peer.last_advertised_input_seq = 9;
        peer.last_row_advertised_input_seq = row_advertised;
        terminal.apply_bytes(b"x");
        let mut selected_rows = vec![DisplayRowRequest::literal(0, false)];
        let prepared = build_datagram_batches(
            &mut terminal,
            &mut peer,
            &mut selected_rows,
            9,
            100.0,
            &mut Compressor::new(),
            &mut RowCaptureScratch::default(),
            &mut HashMap::new(),
        );
        assert_eq!(prepared.len(), 1);
        prepared[0].frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_PRESENTATION_COHERENT != 0
    };
    assert!(
        !echo_coherence(8),
        "the echo answers input 9 and commits at once"
    );
    assert!(
        echo_coherence(9),
        "a later cursor-row change that answers no new input still joins a presentation",
    );
}

#[test]
fn mixed_cursor_move_promotes_existing_ordinary_batch_without_extra_packet() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 8, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 8);
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();

    // Change ordinary row 1, then move the cursor to unchanged row 4. Cursor
    // position is header state and therefore absent from row hashes.
    terminal.apply_bytes(b"\x1b[2;1HO\x1b[5;2H");
    let mut selected_rows = vec![DisplayRowRequest::literal(1, false)];
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();

    let prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        9,
        100.0,
        &mut compressor,
        &mut row_capture_scratch,
        &mut flush_row_cache,
    );

    assert_eq!(
        prepared.len(),
        1,
        "promotion must not allocate a header packet"
    );
    assert_eq!(prepared[0].utility, DisplayUtility::Critical);
    assert_eq!(prepared[0].rows.iter().next().map(|row| row.row), Some(1));
    let header = merkur_codec::parse_frame_header(&prepared[0].frame).unwrap();
    assert_eq!(header.cursor_row, 4);
    assert_eq!(header.cursor_col, 1);
}

#[test]
fn a_header_change_waits_with_its_rows_unless_it_changes_what_input_does() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 4, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 4);
    terminal.apply_bytes(b"unsent rows");
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    let mut hashes = Vec::new();
    terminal.current_row_hashes_into(&mut hashes);
    assert!(
        peer.display_cache.has_selectable_rows(&hashes, 100.0),
        "fixture: rows wait for a grant"
    );
    let exempt = |terminal: &TerminalState, peer: &PeerDisplayState| {
        header_change_is_grant_exempt(
            peer,
            terminal.current_display_header_signal(),
            &hashes,
            100.0,
        )
    };
    terminal.apply_bytes(b"\x1b[3;3H");
    assert!(
        !exempt(&terminal, &peer),
        "a cursor move rides the paid state"
    );
    peer.latest_input_seq = 1;
    assert!(
        exempt(&terminal, &peer),
        "the move may answer unadvertised input"
    );
    peer.last_row_advertised_input_seq = 1;
    terminal.apply_bytes(b"\x1b[?1000h");
    assert!(
        exempt(&terminal, &peer),
        "mouse reporting changes where input goes"
    );
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    assert!(terminal.set_prediction_safe(true));
    assert!(exempt(&terminal, &peer), "a prediction grant");
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    assert!(!exempt(&terminal, &peer));
    assert!(terminal.set_prediction_safe(false));
    assert!(
        exempt(&terminal, &peer),
        "a revoked prediction grant leaves at once"
    );
    let mut quiet = PeerDisplayState::new("browser-2".into(), PeerTransport::Edge);
    quiet.display_cache.resize(8, 4);
    for (row, &hash) in hashes.iter().enumerate() {
        quiet.display_cache.sent_row_hashes[row] = hash;
        quiet.display_cache.acked_row_hashes[row] = hash;
        quiet.display_cache.acked_row_exact[row] = true;
        quiet.display_cache.sent_row_confirmed[row] = true;
    }
    assert!(!quiet.display_cache.has_selectable_rows(&hashes, 100.0));
    // Same admitted header, input and modes: only the waiting rows differ.
    let current = terminal.current_display_header_signal();
    quiet.last_admitted_critical_header_signal = current;
    peer.last_admitted_critical_header_signal = current;
    assert!(!exempt(&terminal, &peer));
    assert!(
        exempt(&terminal, &quiet),
        "with no row waiting the header change is the whole state"
    );
}

#[test]
fn header_only_cursor_update_is_critical() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 4, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 4);
    terminal.apply_bytes(b"\x1b[C");
    let mut selected_rows = Vec::new();
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();

    let prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        3,
        100.0,
        &mut compressor,
        &mut row_capture_scratch,
        &mut flush_row_cache,
    );

    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].utility, DisplayUtility::Critical);
    assert_eq!(prepared[0].utility.send_intent(), SendIntent::Redundant);
    assert!(prepared[0].rows.is_empty());
    assert_eq!(
        merkur_codec::parse_frame_header(&prepared[0].frame)
            .unwrap()
            .row_count,
        0
    );
}

/// A frame names the inputs its grid could already show answers to: those
/// queued before the output it last applied. The advertised watermark says
/// only that a write completed, and a capture between a key's write and
/// its echo shares that with a capture after the echo.
#[test]
fn a_captured_frame_carries_the_inputs_its_output_followed() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 4, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 4);
    let peer_id = Arc::clone(&peer.peer_id);
    let mut peers = PeerMap::new();
    peers.insert(Arc::clone(&peer_id), peer);
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();
    let mut capture = |terminal: &mut TerminalState, peers: &mut PeerMap, row: Option<u16>| {
        let peer = peers.get_mut(&peer_id).unwrap();
        let mut selected_rows: Vec<_> = row
            .map(|row| DisplayRowRequest::literal(row, false))
            .into_iter()
            .collect();
        let prepared = build_datagram_batches(
            terminal,
            peer,
            &mut selected_rows,
            peer.keystroke_next_queued_seq.wrapping_sub(1),
            100.0,
            &mut compressor,
            &mut row_capture_scratch,
            &mut flush_row_cache,
        );
        prepared
            .iter()
            .map(|datagram| {
                merkur_codec::parse_frame_header(&datagram.frame)
                    .unwrap()
                    .echo_horizon
            })
            .collect::<Vec<_>>()
    };

    // Inputs 1..=3 are queued, then the program's output is applied.
    peers.get_mut(&peer_id).unwrap().keystroke_next_queued_seq = 4;
    terminal.apply_bytes(b"abc");
    note_display_output(&mut peers, 0.0);
    // Inputs 4 and 5 are queued and written; nothing has answered them.
    peers.get_mut(&peer_id).unwrap().keystroke_next_queued_seq = 6;
    assert_eq!(capture(&mut terminal, &mut peers, None), [3]);
    assert_eq!(capture(&mut terminal, &mut peers, Some(0)), [3]);

    terminal.apply_bytes(b"de");
    note_display_output(&mut peers, 1.0);
    assert_eq!(capture(&mut terminal, &mut peers, Some(0)), [5]);
}

/// The regression test for the recovery hole idempotent selection was
/// supposed to close.
///
/// Selection is state-derived, so scheduling must be too. Immediately after
/// a flush every row it sent is unconfirmed AND inside its pacing window:
/// nothing is sendable, `needs_full_diff` is false, and — before this was
/// fixed — the peer fell out of BOTH scheduling predicates. With no NACK
/// and no fence left to raise an edge, a lost datagram then stranded the
/// row until the ~1s digest backstop instead of the one flush interval the
/// design promises.
///
/// Nothing in this test ever sets `needs_full_diff`. That is the point.
#[test]
fn an_unacked_row_stays_schedulable_and_becomes_runnable_at_its_deadline() {
    use crate::connection::{PerPeerDisplayCache, SentRow};
    use std::sync::Arc;

    let resend_interval_ms = DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS;
    let sent_at_ms = 1_000.0;

    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    // A fresh peer is armed for its cold-start snapshot; this test is about
    // the steady state after that snapshot has already gone out.
    peer.needs_snapshot = false;
    peer.display_cache = PerPeerDisplayCache::new();
    peer.display_cache.resize(2, 1);

    // One row goes on the wire and is never acknowledged.
    let sent = SentRow {
        graphics: None,
        row: 0,
        hash: 0xfeed,
        cells: Arc::from(vec![CellRepr::BLANK; 2]),
    };
    peer.display_cache.record_sent_rows(
        1,
        std::slice::from_ref(&sent),
        sent_at_ms,
        resend_interval_ms,
    );
    peer.last_display_seq_sent = 1;
    assert!(!peer.needs_full_diff, "test must not lean on the edge flag");
    // The terminal still shows what went on the wire: selection compares
    // the row against it, so the scheduler is asked with it too.
    let current = vec![0xfeed_u64];

    // Immediately after the flush: paced, so not runnable — but the peer
    // MUST stay scheduled or nothing will ever bring it back.
    assert!(
        !peer.display_cache.has_sendable_rows(sent_at_ms),
        "a just-sent row is inside its pacing window",
    );
    assert!(
        peer.display_cache.has_unacked_rows(),
        "the row is unconfirmed regardless of pacing",
    );
    assert!(
        !peer_has_runnable_display_work(&peer, false, 0, &current, sent_at_ms),
        "re-sending inside one round trip cannot be a response to new information",
    );
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, sent_at_ms,),
        Some(resend_interval_ms.ceil() as u64),
        "the owner loop must stay awake for exactly this row's re-send deadline",
    );

    // The deadline it must sleep until is exactly the row's.
    assert_eq!(
        peer.display_cache.next_row_resend_due_ms(sent_at_ms),
        Some(sent_at_ms + resend_interval_ms),
    );

    // At the deadline the row becomes runnable on its own — no ACK, no
    // NACK, no terminal damage, no flag flipped by anyone.
    let due_ms = sent_at_ms + resend_interval_ms;
    assert!(peer.display_cache.has_sendable_rows(due_ms));
    assert!(
        peer_has_runnable_display_work(&peer, false, 0, &current, due_ms),
        "an unACKed row past its deadline is runnable with no event required",
    );

    // And once the peer confirms it, the row goes quiet again.
    peer.display_cache.acked_row_hashes[0] = 0xfeed;
    peer.display_cache.acked_row_exact[0] = true;
    peer.display_cache.sent_row_confirmed[0] = true;
    assert!(!peer.display_cache.has_unacked_rows());
    assert!(!peer_has_runnable_display_work(
        &peer,
        false,
        0,
        &current,
        due_ms + 10_000.0
    ));
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::CLEAN,
            0,
            &current,
            due_ms + 10_000.0,
        ),
        None,
        "a confirmed row leaves the owner loop nothing to arm",
    );

    // …unless the terminal has moved past that confirmed baseline. This is
    // the clipped-flush remainder: no dirty edge (the flush that clipped it
    // consumed that), and nothing unconfirmed (it was never sent at all).
    let moved = vec![0xc0ffee_u64];
    assert!(
        peer.display_cache
            .has_selectable_rows(&moved, due_ms + 10_000.0)
    );
    assert!(
        peer_has_runnable_display_work(&peer, false, 0, &moved, due_ms + 10_000.0),
        "a row the terminal has moved past must be runnable without a dirty edge",
    );
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::CLEAN,
            0,
            &moved,
            due_ms + 10_000.0,
        ),
        Some(0),
        "and the owner loop must send it in this turn, not after a deadline",
    );
}

/// A peer whose browser is gone must not be offered the whole screen every
/// flush interval for the length of the carrier-gap window.
///
/// This is the closed-page storm: a page that goes away without a
/// disconnect leaves the edge reporting `CounterpartDetached` on a tunnel
/// the daemon keeps holding, so `reconcile_rebind_windows` marks the path
/// unavailable and arms the gap window — and every row this peer holds is
/// unacknowledged and past its re-send deadline, which is a standing reason
/// to flush. Nothing else in the scheduler asks whether there is anyone to
/// flush TO.
#[test]
fn a_peer_with_no_counterpart_is_unscheduled_until_its_carrier_returns() {
    use crate::connection::{EdgeRebindWindow, PerPeerDisplayCache, SentRow};
    use std::sync::Arc;

    let resend_interval_ms = DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS;
    let sent_at_ms = 1_000.0;
    let now_ms = sent_at_ms + resend_interval_ms + 10_000.0;

    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.display_cache = PerPeerDisplayCache::new();
    peer.display_cache.resize(2, 1);
    peer.display_cache.record_sent_rows(
        1,
        std::slice::from_ref(&SentRow {
            graphics: None,
            row: 0,
            hash: 0xfeed,
            cells: Arc::from(vec![CellRepr::BLANK; 2]),
        }),
        sent_at_ms,
        resend_interval_ms,
    );
    peer.last_display_seq_sent = 1;
    let current = vec![0xfeed_u64];

    assert!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, now_ms,)
            .is_some(),
        "an unconfirmed row past its deadline is a standing reason to flush",
    );

    // The browser leaves the splice. `reconcile_rebind_windows` marks the
    // path unavailable and holds the session for its return.
    peer.paths.edge.available = false;
    peer.edge_rebind = Some(EdgeRebindWindow {
        deadline_ms: now_ms + 59_000.0,
        rebinds_used: 0,
    });
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, now_ms,),
        None,
        "a peer with no carrier must not be scheduled by its own unconfirmed rows",
    );
    assert!(
        !peer_has_runnable_display_work(&peer, false, 0, &current, now_ms),
        "and it must not be runnable either, or the round-robin still picks it",
    );

    // A background redial re-attaches at the edge. The path reads available
    // again, but the splice's browser half is still empty and a rebind will
    // rekey Noise, so anything sealed now is unopenable by construction.
    peer.paths.edge = crate::connection::PathHealth::fresh_available(now_ms);
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, now_ms,),
        None,
        "re-attaching a carrier is not the browser coming back",
    );

    // A live direct carrier IS the browser, whatever the edge window says.
    // `handle_edge_lane_closed` arms one whenever the daemon's interactive
    // edge lane closes and the peer is resumable — it never asks whether a
    // direct path is up — so reading the window as "no counterpart" would
    // freeze display for every peer that lost its edge lane while running
    // on direct WebTransport, until the sweep parked it a minute later.
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(now_ms);
    assert!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, now_ms,)
            .is_some(),
        "an edge-scoped gap window must not disqualify a live direct carrier",
    );
    peer.paths.webtransport = crate::connection::PathHealth::dormant();

    // The browser rebinds: `splice_rebound_peer` clears the window and
    // installs the fresh path together.
    peer.edge_rebind = None;
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, now_ms,),
        Some(0),
        "and the row it was holding is due the moment there is somewhere to send it",
    );
}

/// A block belongs to the connection it was read from. A phone suspended
/// long enough fills its carrier, which records blocked-and-holding; the
/// successor starts open, so no reopening ever fires for it. That record
/// withheld an owed snapshot from a returning phone until the dead lane
/// finally dropped.
#[test]
fn a_block_recorded_for_a_replaced_carrier_holds_no_display() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.paths.edge = crate::connection::PathHealth::fresh_available(0.0);
    let filled = Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx.clone()));
    filled.set_upstream_blocked_for_test(true);
    peer.edge_tunnel = Some(filled);
    observe_carrier_blocks(&mut peer);
    peer.carrier_blocks.admitted(PeerTransport::Edge);
    assert!(
        display_held(&peer, 1.0),
        "a blocked carrier already holding its one frame holds display"
    );

    // The successor carrier is open. Nothing reopened, so nothing re-read
    // the record before the resume asked for a snapshot.
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
    peer.needs_snapshot = true;
    assert!(!display_held(&peer, 1.0));
    assert!(
        peer_snapshot_due(&peer, 1.0),
        "the owed snapshot is due at once"
    );
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &[], 1.0),
        Some(0),
        "and the owner loop is scheduled to send it",
    );
}

/// A keystroke that changes nothing visible still has to be scheduled.
///
/// The advertised `input_seq` is the browser's causal-barrier release, and
/// `flush_display` treats a stale one as its own reason to emit a
/// header-only frame. Neither scheduling predicate carried that term, so on
/// a quiesced, fully-acked screen the frame that releases the barrier was
/// never armed: an arrow at a line edge, a Tab with no completion, or a key
/// the line editor swallows advanced `latest_input_seq`, dirtied nothing,
/// and left local echo dead until unrelated output happened to wake a
/// flush. Selection and scheduling have to derive from the same state.
#[test]
fn a_stale_input_seq_advertisement_is_scheduled_on_a_quiesced_screen() {
    use crate::connection::PerPeerDisplayCache;

    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.display_cache = PerPeerDisplayCache::new();
    peer.display_cache.resize(2, 4);
    // Fully converged: every row sent, acknowledged, and cell-exact.
    for row in 0..4 {
        peer.display_cache.acked_row_hashes[row] = 0x2000 + row as u64;
        peer.display_cache.sent_row_hashes[row] = 0x2000 + row as u64;
        peer.display_cache.acked_row_exact[row] = true;
        peer.display_cache.sent_row_confirmed[row] = true;
    }
    let current: Vec<u64> = (0..4).map(|row| 0x2000 + row as u64).collect();
    assert!(!peer.display_cache.has_unacked_rows());
    assert!(!peer.display_cache.has_selectable_rows(&current, 0.0));

    // Nothing to send, nothing advertised yet to correct.
    peer.latest_input_seq = 7;
    peer.last_advertised_input_seq = 7;
    peer.last_admitted_critical_header_signal = 0;
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, 0.0,),
        None,
        "a converged screen with a current advertisement must stay parked",
    );

    // The keystroke lands. It dirties no row — the line editor swallowed it.
    peer.latest_input_seq = 8;
    assert!(
        peer_has_runnable_display_work(&peer, false, 0, &current, 0.0),
        "a stale input_seq advertisement is runnable work on its own",
    );
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, 0.0,),
        Some(0),
        "and the owner loop must carry it in this same turn",
    );

    // Same for a critical header the peer has not acknowledged.
    peer.last_advertised_input_seq = 8;
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, 0.0,),
        None
    );
    assert!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0x51, &current, 0.0,)
            .is_some(),
        "a changed critical header is the other header-only reason",
    );
}

/// Every shape of dirty work leaves in the turn that produced it. The old
/// scheduler put a multi-row or non-cursor causal response on a 10 ms
/// "redraw tail" (8 ms at 120 Hz) to bundle a multi-write redraw; production
/// measured that tail as `display_coalesce_us` p90 9-13 ms on every screen
/// update that was not a single cursor-row echo. Output the reader thread
/// has already queued is drained into the same flush by the owner loop
/// before this predicate is asked, which is the exact signal the tail was
/// guessing at, so there is nothing left for a clock to add.
#[test]
fn every_causal_row_shape_flushes_in_the_same_turn() {
    let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
    peer.last_input_at_ms = SCHED_NOW_MS;
    peer.latest_input_seq = 7;
    peer.last_advertised_input_seq = 6;
    peer.adaptive.presentation_period_ms = 1_000.0 / 120.0;

    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::COHERENT,
            0,
            &current,
            SCHED_NOW_MS,
        ),
        Some(0),
        "a causal multi-row redraw leaves in this turn",
    );
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::cursor_only(1),
            0,
            &current,
            SCHED_NOW_MS,
        ),
        Some(0),
        "the isolated cursor-row echo leaves in this turn",
    );

    // Once the input fence is advertised, every following sparse TUI read
    // is its own same-turn flush as well: a read that arrives after the
    // previous flush left is by definition not in the drained set.
    peer.last_advertised_input_seq = peer.latest_input_seq;
    current[1] ^= 0x55aa;
    for index in 1..=8 {
        let read_at_ms = SCHED_NOW_MS + index as f64 * 0.8;
        assert_eq!(
            peer_next_flush_delay_ms(
                &peer,
                PendingDisplayDamage::COHERENT,
                (0x100 + index) as u128,
                &current,
                read_at_ms,
            ),
            Some(0),
            "read {index} must not wait on a clock",
        );
    }

    let (mut cursor_peer, cursor_current) = converged_peer_for_scheduling(SCHED_NOW_MS);
    cursor_peer.last_input_at_ms = SCHED_NOW_MS;
    cursor_peer.latest_input_seq = 7;
    cursor_peer.last_advertised_input_seq = 7;
    cursor_peer.last_admitted_critical_header_signal = 0;
    assert_eq!(
        peer_next_flush_delay_ms(
            &cursor_peer,
            PendingDisplayDamage::METADATA,
            0xfeed,
            &cursor_current,
            SCHED_NOW_MS,
        ),
        Some(0),
        "a genuine cursor/header-only change leaves in this turn",
    );
}

/// The browser's measured refresh period bounds the zero-progress
/// admission retry and nothing else: it is not a coalescing budget.
#[test]
fn the_browser_refresh_period_never_delays_a_flush() {
    for hz in [60.0, 120.0, 240.0, 480.0] {
        let (mut peer, current) = converged_peer_for_scheduling(SCHED_NOW_MS);
        peer.last_input_at_ms = SCHED_NOW_MS;
        peer.latest_input_seq = 7;
        peer.last_advertised_input_seq = 6;
        peer.adaptive.presentation_period_ms = 1_000.0 / hz;
        assert_eq!(
            peer_next_flush_delay_ms(
                &peer,
                PendingDisplayDamage::COHERENT,
                0,
                &current,
                SCHED_NOW_MS,
            ),
            Some(0),
            "{hz}Hz coherent redraw",
        );
    }
}

/// A flush that clips its row budget must not depend on the rows it *did*
/// send staying unconfirmed in order to come back for the rest.
///
/// That was the only thing keeping the remainder scheduled: `terminal_dirty`
/// is a consumed edge, and an unsent row is not `has_unacked_rows`. So a
/// clipped flush whose sent rows were all confirmed at once left the owner
/// loop parked with the remainder never sent, and only the hash-digest
/// backstop to find it — a full heartbeat interval later.
#[test]
fn a_clipped_flush_remainder_stays_scheduled_with_nothing_else_outstanding() {
    use crate::connection::PerPeerDisplayCache;

    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.display_cache = PerPeerDisplayCache::new();
    peer.display_cache.resize(2, 4);
    // Every row the flush sent is confirmed cell-exact: nothing outstanding.
    for row in 0..4 {
        peer.display_cache.acked_row_hashes[row] = 0x1000 + row as u64;
        peer.display_cache.sent_row_hashes[row] = 0x1000 + row as u64;
        peer.display_cache.acked_row_exact[row] = true;
        peer.display_cache.sent_row_confirmed[row] = true;
    }
    assert!(!peer.display_cache.has_unacked_rows());
    assert!(!peer.display_cache.has_sendable_rows(0.0));

    // Rows 2 and 3 are the remainder the clipped flush never reached.
    let mut current = peer.display_cache.acked_row_hashes.clone();
    current[2] = 0xdead;
    current[3] = 0xbeef;

    assert!(
        peer_has_runnable_display_work(&peer, false, 0, &current, 0.0),
        "the remainder must be runnable with no dirty edge and nothing unconfirmed",
    );
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &current, 0.0,),
        Some(0),
        "a clipped redraw remainder goes out in the next turn, not after a frame budget",
    );

    // And once the terminal agrees with the baseline again, it goes quiet:
    // the level predicate is not a permanent wakeup.
    let quiet = peer.display_cache.acked_row_hashes.clone();
    assert!(!peer_has_runnable_display_work(
        &peer, false, 0, &quiet, 0.0
    ));
    assert_eq!(
        peer_next_flush_delay_ms(&peer, PendingDisplayDamage::CLEAN, 0, &quiet, 0.0,),
        None
    );
}

#[test]
fn the_resend_deadline_tracks_the_measured_confirmation_delay() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    // A path whose heartbeat RTT would have clamped the interval to the
    // floor, which is the shape production ran in: 22 ms network RTT
    // against a confirmation delay several times longer.
    peer.paths
        .get_mut(PeerTransport::Edge)
        .record_network_rtt_sample(22.0);
    for _ in 0..20 {
        peer.display_confirm.record(90.0);
    }

    let interval_ms = peer_row_resend_interval_ms(&peer, 0.0);
    assert!(
        interval_ms >= 90.0,
        "a row may not be re-sent before its ACK can arrive; got {interval_ms}ms \
         against a 90ms measured confirmation delay"
    );
    assert!(interval_ms <= DisplayPolicy::ROW_RESEND_MAX_MS);
}

/// Before the first display ACK the confirmation estimate is empty, and the
/// deadline is the primary path's own round trip. On a 55 ms path that is
/// 55 ms plus twice the heartbeat jitter — never the old blind 20 ms seed
/// clamped to a 25 ms floor, which re-sent every row before its ACK could
/// physically exist.
#[test]
fn a_blind_peer_is_paced_by_its_path_round_trip_not_a_seed() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    assert_eq!(peer.display_confirm.ewma_ms, 0.0);
    let path = peer.paths.get_mut(PeerTransport::Edge);
    path.available = true;
    path.last_ack_at_ms = 1.0;
    path.network_rtt_ewma_ms = 55.0;
    path.network_jitter_ewma_ms = 4.0;
    assert_eq!(peer_row_resend_interval_ms(&peer, 1.0), 63.0);

    // The first confirmation sample replaces the empty estimate outright,
    // and wins as soon as it exceeds the round trip.
    peer.display_confirm.record(1.0);
    assert_eq!(peer.display_confirm.ewma_ms, 1.0);
    assert_eq!(peer_row_resend_interval_ms(&peer, 1.0), 63.0);
    for _ in 0..8 {
        peer.display_confirm.record(120.0);
    }
    assert!(peer_row_resend_interval_ms(&peer, 1.0) > 63.0);
}

fn prepared_for_test(seq: u32, wire_bytes: usize) -> PreparedDisplayDatagram {
    prepared_with_utility_for_test(seq, wire_bytes, DisplayUtility::NonCritical)
}

fn prepared_with_utility_for_test(
    seq: u32,
    wire_bytes: usize,
    utility: DisplayUtility,
) -> PreparedDisplayDatagram {
    PreparedDisplayDatagram {
        seq,
        frame_id: 1,
        raw_bytes: wire_bytes,
        encoded_rows: 1,
        utility,
        header_signal: 0,
        frame: vec![0; wire_bytes],
        rows: SentRows::default(),
        compression_attempted: false,
        content_class: ContentClass::Text,
        precomputed_fec_repair: None,
        physical_plan: PreparedPhysicalDatagramPlan::default(),
    }
}

fn valid_header_only_prepared_for_test(
    peer: &mut PeerDisplayState,
    utility: DisplayUtility,
) -> PreparedDisplayDatagram {
    valid_header_only_prepared_with_presentation_for_test(peer, utility, false, true)
}

pub(super) fn valid_header_only_prepared_with_presentation_for_test(
    peer: &mut PeerDisplayState,
    utility: DisplayUtility,
    presentation_coherent: bool,
    presentation_end: bool,
) -> PreparedDisplayDatagram {
    let seq = peer.next_datagram_seq();
    let frame_id = peer.next_frame_id();
    let header = FrameHeader {
        memory_only: false,
        kind: merkur_codec::FrameKind::Delta,
        cols: 2,
        rows: 8,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 0,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 0,
        frame_id,
        presentation_id: frame_id,
        presentation_member_index: 0,
        presentation_member_count: u16::from(presentation_coherent),
        row_predecessor_presentation_id: 0,
        presentation_coherent,
        presentation_end,
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
    let mut frame = Vec::new();
    encode_frame_into(&mut frame, &header, std::iter::empty());
    patch_stream_header(
        &mut frame,
        seq,
        peer.generation,
        peer.latest_input_seq,
        frame_id,
        frame_id,
        presentation_coherent,
        presentation_end,
        0,
        1,
        0,
        u16::from(presentation_coherent),
    )
    .expect("test display header fits");
    PreparedDisplayDatagram {
        seq,
        frame_id,
        raw_bytes: frame.len(),
        encoded_rows: 0,
        utility,
        header_signal: (2u128 << 80) | (8u128 << 64) | (1u128 << 16),
        frame,
        rows: SentRows::default(),
        compression_attempted: false,
        content_class: ContentClass::Text,
        precomputed_fec_repair: None,
        physical_plan: PreparedPhysicalDatagramPlan::default(),
    }
}

pub(super) fn row_predecessor_original_for_test(
    peer: &mut PeerDisplayState,
    rows: &[(u16, u8)],
) -> PreparedDisplayDatagram {
    let mut original = valid_header_only_prepared_with_presentation_for_test(
        peer,
        DisplayUtility::NonCritical,
        !rows.is_empty(),
        true,
    );
    let mut header = merkur_codec::parse_frame_header(&original.frame).unwrap();
    header.cols = peer.display_cache.cols;
    header.rows = peer.display_cache.rows;
    header.row_count = rows.len() as u16;
    for &(row, character) in rows {
        let cells: Arc<[CellRepr]> = (0..header.cols)
            .map(|col| CellRepr {
                codepoint: u32::from(character) + u32::from(col % 8),
                ..CellRepr::BLANK
            })
            .collect::<Vec<_>>()
            .into();
        original.rows.push(SentRow {
            graphics: None,
            row,
            hash: merkur_codec::row_hash(&cells),
            cells,
        });
    }
    encode_frame_into(
        &mut original.frame,
        &header,
        original.rows.iter().map(|row| RowRef {
            graphics: &[],
            row_index: row.row,
            left: 0,
            cells: &row.cells,
        }),
    );
    patch_stream_header(
        &mut original.frame,
        original.seq,
        peer.generation,
        peer.latest_input_seq,
        original.frame_id,
        original.frame_id,
        !rows.is_empty(),
        true,
        0,
        1,
        0,
        u16::from(!rows.is_empty()),
    )
    .unwrap();
    original.encoded_rows = rows.len() as u16;
    original.raw_bytes = original.frame.len();
    original.header_signal =
        (u128::from(header.cols) << 80) | (u128::from(header.rows) << 64) | (1u128 << 16);
    original
}

fn captured_original_headers_for_test(
    rx: &mut mpsc::UnboundedReceiver<(u8, Vec<u8>)>,
    browser: &mut crate::e2e::NoiseTransport,
) -> Vec<(u32, FrameHeader)> {
    let mut headers = Vec::new();
    while let Ok((channel, wire)) = rx.try_recv() {
        if channel != CHANNEL_DISPLAY_DATAGRAM && channel != CHANNEL_DISPLAY_COMMIT {
            continue;
        }
        let lane = crate::e2e::lane_for_channel(channel).unwrap();
        let plain = if channel == CHANNEL_DISPLAY_DATAGRAM {
            browser.open_datagram(lane, &wire)
        } else {
            browser.open_stream(lane, &wire)
        };
        let Ok(plain) = plain else {
            continue; // Idempotent physical replicas share a Noise counter.
        };
        headers.push((
            merkur_codec::parse_stream_header(&plain).unwrap().seq,
            merkur_codec::parse_frame_header(&plain).unwrap(),
        ));
    }
    headers
}

#[tokio::test]
async fn row_predecessor_crosses_end_and_wrap_but_not_full_same_row_replacement() {
    for first_pid in [1, u32::MAX] {
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(2, 8);
        peer.next_frame_id = first_pid;
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        let mut pool = frame_pool_for_test();
        let a = row_predecessor_original_for_test(&mut peer, &[(1, b'a')]);
        let a_pid = a.frame_id;
        let mut prepared = vec![a];
        assert!(
            send_unpaced_display_burst(
                &mut peer,
                &mut prepared,
                &mut pool,
                1,
                100.0,
                &[2, 0, 0, 0],
            )
            .original_admitted
        );
        let a_header = captured_original_headers_for_test(&mut rx, &mut browser)[0].1;
        assert!(a_header.presentation_end);
        assert_eq!(a_header.row_predecessor_presentation_id, 0);
        assert_eq!(peer.row_presentation_head, a_pid);
        assert!(!peer.presentation_end_owed);

        let b = row_predecessor_original_for_test(&mut peer, &[]);
        let b_pid = b.frame_id;
        let mut prepared = vec![b];
        send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 101.0, &[0; 4]);
        let b_header = captured_original_headers_for_test(&mut rx, &mut browser)[0].1;
        assert_eq!(b_header.presentation_id, b_pid);
        assert_eq!(b_header.row_predecessor_presentation_id, a_pid);
        assert!(b_header.presentation_coherent && b_header.presentation_end);
        assert_eq!(b_header.presentation_member_count, 1);
        assert_eq!(
            peer.row_presentation_head, a_pid,
            "headers never advance the row head"
        );

        let c = row_predecessor_original_for_test(&mut peer, &[(1, b'c')]);
        let c_pid = c.frame_id;
        let mut prepared = vec![c];
        send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 102.0, &[2, 0, 0, 0]);
        let c_header = captured_original_headers_for_test(&mut rx, &mut browser)[0].1;
        assert_eq!(
            c_header.row_predecessor_presentation_id, 0,
            "absolute typing replacement is independent"
        );
        assert_eq!(peer.row_presentation_head, c_pid);
        peer.next_generation();
        assert_eq!(peer.row_presentation_head, 0);
        assert_eq!(peer.unresolved_presentation_rows, [0; 4]);
    }
}

#[tokio::test]
async fn row_predecessor_supersession_covers_transitive_ancestors_and_clipped_membership() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.display_cache.resize(2, 8);
    let (tx, mut rx) = mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
    let mut pool = frame_pool_for_test();
    let mut head = 0;
    for (row, character) in [(2, b'z'), (1, b'a'), (1, b'b')] {
        let original = row_predecessor_original_for_test(&mut peer, &[(row, character)]);
        let pid = original.frame_id;
        let mut prepared = vec![original];
        send_unpaced_display_burst(
            &mut peer,
            &mut prepared,
            &mut pool,
            1,
            100.0,
            &[1 << row, 0, 0, 0],
        );
        let header = captured_original_headers_for_test(&mut rx, &mut browser)[0].1;
        assert_eq!(header.row_predecessor_presentation_id, head);
        head = pid;
    }
    assert_eq!(peer.unresolved_presentation_rows, [6, 0, 0, 0]);

    let mut first = row_predecessor_original_for_test(&mut peer, &[(1, b'c')]);
    let mut second = row_predecessor_original_for_test(&mut peer, &[(2, b'd')]);
    let pid = first.frame_id;
    for (index, frame) in [&mut first, &mut second].into_iter().enumerate() {
        patch_stream_header(
            &mut frame.frame,
            frame.seq,
            peer.generation,
            0,
            frame.frame_id,
            pid,
            true,
            index == 1,
            0,
            1,
            index as u16,
            2,
        )
        .unwrap();
    }
    let mut prepared = vec![first, second];
    peer.adaptive.receive_queue_datagrams = 1;
    let outcome =
        send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 101.0, &[6, 0, 0, 0]);
    assert!(outcome.original_admitted && !outcome.all_sent);
    let clipped = captured_original_headers_for_test(&mut rx, &mut browser);
    assert_eq!(clipped.len(), 1);
    assert_eq!(clipped[0].1.row_predecessor_presentation_id, head);
    assert!(!clipped[0].1.presentation_end);
    assert_eq!(clipped[0].1.presentation_member_count, 1);
    assert_eq!(peer.unresolved_presentation_rows, [6, 0, 0, 0]);

    peer.adaptive.receive_queue_datagrams = 256;
    let all = row_predecessor_original_for_test(&mut peer, &[(1, b'e'), (2, b'f')]);
    let mut prepared = vec![all];
    send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 102.0, &[6, 0, 0, 0]);
    assert_eq!(
        captured_original_headers_for_test(&mut rx, &mut browser)[0]
            .1
            .row_predecessor_presentation_id,
        0
    );
}

#[tokio::test]
async fn row_predecessor_late_ack_cannot_prune_a_newer_content_lineage() {
    use crate::display::recv::{DisplayAck, handle_display_ack};
    for content in [b"ac".as_slice(), b"aba".as_slice()] {
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(2, 8);
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        let mut pool = frame_pool_for_test();
        let mut sequences = Vec::new();
        for &character in content {
            let original = row_predecessor_original_for_test(&mut peer, &[(1, character)]);
            sequences.push(original.seq);
            let mut prepared = vec![original];
            send_unpaced_display_burst(
                &mut peer,
                &mut prepared,
                &mut pool,
                1,
                100.0,
                &[2, 0, 0, 0],
            );
            captured_original_headers_for_test(&mut rx, &mut browser);
        }
        let current = peer.display_cache.sent_row_hashes.clone();
        let generation = peer.generation;
        handle_display_ack(
            &mut peer,
            DisplayAck::new(generation, sequences[0], [1, 0, 0, 0]),
            101.0,
            PeerTransport::Edge,
            &current,
            false,
        );
        prune_applied_presentation_rows(&mut peer);
        assert!(!peer.display_cache.sent_row_confirmed[1]);
        assert_eq!(peer.unresolved_presentation_rows, [2, 0, 0, 0]);
        let head = peer.row_presentation_head;
        let mut header = vec![row_predecessor_original_for_test(&mut peer, &[])];
        stamp_row_presentation_predecessor(&mut peer, &mut header, &[0; 4], &mut pool);
        assert_eq!(
            merkur_codec::parse_frame_header(&header[0].frame)
                .unwrap()
                .row_predecessor_presentation_id,
            head
        );
        handle_display_ack(
            &mut peer,
            DisplayAck::new(generation, *sequences.last().unwrap(), [1, 0, 0, 0]),
            102.0,
            PeerTransport::Edge,
            &current,
            false,
        );
        prune_applied_presentation_rows(&mut peer);
        assert!(peer.display_cache.sent_row_confirmed[1]);
        assert_eq!(peer.unresolved_presentation_rows, [0; 4]);
        let mut header = vec![row_predecessor_original_for_test(&mut peer, &[])];
        stamp_row_presentation_predecessor(&mut peer, &mut header, &[0; 4], &mut pool);
        assert_eq!(
            merkur_codec::parse_frame_header(&header[0].frame)
                .unwrap()
                .row_predecessor_presentation_id,
            0
        );
    }
}

#[tokio::test]
async fn row_predecessor_zero_admission_cannot_advance_or_drop_ancestors() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.display_cache.resize(2, 8);
    let (tx, mut rx) = mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
    let mut pool = frame_pool_for_test();
    let first = row_predecessor_original_for_test(&mut peer, &[(1, b'a')]);
    let head = first.frame_id;
    send_unpaced_display_burst(
        &mut peer,
        &mut vec![first],
        &mut pool,
        1,
        100.0,
        &[2, 0, 0, 0],
    );
    captured_original_headers_for_test(&mut rx, &mut browser);
    peer.adaptive.receive_queue_datagrams = 0;
    let replacement = row_predecessor_original_for_test(&mut peer, &[(1, b'b')]);
    let outcome = send_unpaced_display_burst(
        &mut peer,
        &mut vec![replacement],
        &mut pool,
        1,
        101.0,
        &[2, 0, 0, 0],
    );
    assert!(!outcome.original_admitted && !outcome.all_sent);
    assert!(rx.try_recv().is_err());
    assert_eq!(peer.row_presentation_head, head);
    assert_eq!(peer.unresolved_presentation_rows, [2, 0, 0, 0]);
    assert!(peer.display_admission_retry.until_ms > 101.0);
    let mut header = vec![row_predecessor_original_for_test(&mut peer, &[])];
    stamp_row_presentation_predecessor(&mut peer, &mut header, &[0; 4], &mut pool);
    assert_eq!(
        merkur_codec::parse_frame_header(&header[0].frame)
            .unwrap()
            .row_predecessor_presentation_id,
        head
    );
}

#[test]
fn row_predecessor_is_identical_across_raw_compressed_and_recovered_members() {
    for compressed in [false, true] {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.display_cache.resize(128, 8);
        peer.row_presentation_head = 91;
        peer.unresolved_presentation_rows = [1 << 7, 0, 0, 0];
        let mut prepared: Vec<_> = (0..3)
            .map(|row| row_predecessor_original_for_test(&mut peer, &[(row, b'a')]))
            .collect();
        let pid = prepared[0].frame_id;
        let mut compressor = Compressor::new();
        for (index, frame) in prepared.iter_mut().enumerate() {
            patch_stream_header(
                &mut frame.frame,
                frame.seq,
                peer.generation,
                0,
                frame.frame_id,
                pid,
                true,
                index == 2,
                0,
                1,
                index as u16,
                3,
            )
            .unwrap();
            if compressed {
                let mut encoded = Vec::new();
                assert!(
                    compressor
                        .compress_display_frame_into(&frame.frame, None, &mut encoded)
                        .is_some()
                );
                frame.frame = encoded;
            }
        }
        let mut pool = frame_pool_for_test();
        let mut encoder = crate::display::fec::FecEncoder::new();
        precompute_fec_repairs(&mut prepared, 4, peer.generation, &mut encoder, &mut pool);
        let previous_parity = prepared[2].precomputed_fec_repair.clone().unwrap();
        let bodies: Vec<_> = prepared
            .iter()
            .map(|frame| frame.frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..].to_vec())
            .collect();
        stamp_row_presentation_predecessor(&mut peer, &mut prepared, &[7, 0, 0, 0], &mut pool);
        assert_eq!(
            peer.row_presentation_head, 91,
            "preflight cannot advance admission lineage"
        );
        for (index, frame) in prepared.iter().enumerate() {
            let header = merkur_codec::parse_frame_header(&frame.frame).unwrap();
            assert_eq!(header.row_predecessor_presentation_id, 91);
            assert_eq!(header.presentation_id, pid);
            assert_eq!(header.presentation_member_index, index as u16);
            assert_eq!(header.presentation_member_count, 3);
            assert_eq!(header.presentation_end, index == 2);
            assert_eq!(
                &frame.frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..],
                bodies[index]
            );
            assert!(frame.precomputed_fec_repair.is_none());
        }
        precompute_fec_repairs(&mut prepared, 4, peer.generation, &mut encoder, &mut pool);
        let repair = prepared[2].precomputed_fec_repair.as_ref().unwrap();
        assert_ne!(repair, &previous_parity);
        let width = u16::from_be_bytes([repair[10], repair[11]]) as usize;
        let recovery: Vec<&[u8]> = repair[DISPLAY_FEC_HEADER_BYTES..]
            .chunks_exact(width)
            .collect();
        let zero = vec![0u8; width];
        // Members shorter than the parity width are zero-padded to it, as
        // the receiver pads them; compressed members differ in length.
        let padded: Vec<Vec<u8>> = prepared[..2]
            .iter()
            .map(|member| {
                let mut shard = member.frame.clone();
                shard.resize(width, 0);
                shard
            })
            .collect();
        let received: [&[u8]; 3] = [&padded[0], &padded[1], &zero];
        let mut outputs = vec![vec![0u8; width]; 3];
        let mut slices: Vec<_> = outputs.iter_mut().map(Vec::as_mut_slice).collect();
        assert_eq!(
            merkur_fec::decode(0b011, 0b11, &received, &recovery, &mut slices),
            0b100
        );
        assert_eq!(&outputs[2][..prepared[2].frame.len()], &prepared[2].frame);
        // State remains independently applicable in reverse order. The
        // missing predecessor affects only browser presentation timing.
        let mut receiver = term_wasm::Terminal::new_headless(128, 8);
        for frame in prepared.iter().rev() {
            let handle = receiver.stage_display_frame_bytes(&frame.frame);
            assert_ne!(handle, 0, "{:?}", receiver.take_last_error());
            assert!(
                receiver.apply_staged_delta_seq(handle, frame.seq),
                "{:?}",
                receiver.take_last_error()
            );
            receiver.release_staged_frame(handle);
        }
    }
}

#[tokio::test]
async fn fec_exposed_refused_original_survives_revert_and_delayed_recovery() {
    use crate::display::recv::{DisplayAck, handle_display_ack};
    for initial_seq in [1, u32::MAX - 3, u32::MAX - 1] {
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(2, 2);
        peer.next_datagram_seq = initial_seq;
        let generation = peer.generation;
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        let mut pool = frame_pool_for_test();
        let mut receiver = term_wasm::Terminal::new_headless(2, 2);
        let baseline = row_predecessor_original_for_test(&mut peer, &[(0, b'0'), (1, b'0')]);
        let baseline_seq = baseline.seq;
        let baseline_frame = baseline.frame.clone();
        let baseline_hashes: Vec<_> = baseline.rows.iter().map(|row| row.hash).collect();
        assert!(receiver.apply_delta_seq(&baseline_frame, baseline_seq));
        send_unpaced_display_burst(
            &mut peer,
            &mut vec![baseline],
            &mut pool,
            1,
            90.0,
            &[3, 0, 0, 0],
        );
        captured_original_headers_for_test(&mut rx, &mut browser);
        handle_display_ack(
            &mut peer,
            DisplayAck::new(generation, baseline_seq, [1, 0, 0, 0]),
            91.0,
            PeerTransport::Edge,
            &baseline_hashes,
            false,
        );

        let mut group = [
            row_predecessor_original_for_test(&mut peer, &[(0, b'a')]),
            row_predecessor_original_for_test(&mut peer, &[(1, b'b')]),
        ];
        let pid = group[0].frame_id;
        for (index, frame) in group.iter_mut().enumerate() {
            patch_stream_header(
                &mut frame.frame,
                frame.seq,
                generation,
                0,
                frame.frame_id,
                pid,
                true,
                index == 1,
                0,
                1,
                index as u16,
                2,
            )
            .unwrap();
        }
        stamp_row_presentation_predecessor(&mut peer, &mut group, &[3, 0, 0, 0], &mut pool);
        // Exact preflight reservation, followed by a vanished Direct carrier.
        // Its original refuses; the Edge repair reservation stays intact and
        // leaves no spare Edge capacity for an original fallback.
        let mut budget = DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(1, 2);
        group[0].physical_plan = PreparedPhysicalDatagramPlan {
            data_primary: Some(PeerTransport::Edge),
            data_paths: SentPaths::single(PeerTransport::Edge),
            ..Default::default()
        };
        group[1].physical_plan = PreparedPhysicalDatagramPlan {
            data_primary: Some(PeerTransport::WebTransport),
            data_paths: SentPaths::single(PeerTransport::WebTransport),
            repair_primary: Some(PeerTransport::Edge),
            repair_paths: SentPaths::single(PeerTransport::Edge),
            ..Default::default()
        };
        let refused_seq = group[1].seq;
        let refused_hash = group[1].rows.iter().next().unwrap().hash;
        let original_len = group[1].frame.len();
        peer.sim_datagram_metadata.clear();
        let outcome = send_planned_group(
            &mut peer,
            &mut group,
            &mut pool,
            100.0,
            &mut budget,
        );
        assert!(!outcome.all_sent && outcome.original_admitted);
        assert_eq!(peer.last_datagram_seq, group[0].seq);
        assert_eq!(peer.last_display_seq_sent, refused_seq);
        if initial_seq == u32::MAX - 1 {
            assert_eq!((group[0].seq, refused_seq), (u32::MAX, 1));
        }
        assert_eq!(peer.sim_datagram_metadata.len(), 2);
        assert_eq!(peer.sim_datagram_metadata[0].role, SimDatagramRole::Data);
        assert_eq!(peer.sim_datagram_metadata[1].role, SimDatagramRole::Repair);
        let (channel, wire) = rx.try_recv().unwrap();
        let a0 = browser
            .open_datagram(crate::e2e::lane_for_channel(channel).unwrap(), &wire)
            .unwrap();
        assert!(receiver.apply_delta_seq(&a0, group[0].seq));
        let (channel, wire) = rx.try_recv().unwrap();
        let parity = browser
            .open_datagram(crate::e2e::lane_for_channel(channel).unwrap(), &wire)
            .unwrap();
        assert!(rx.try_recv().is_err());

        // Row 1 returns to the exact ACK baseline before its refused
        // original is recovered. Classification must still replace it.
        let next = row_predecessor_original_for_test(&mut peer, &[(0, b'c')]);
        let current_hashes = [next.rows.iter().next().unwrap().hash, baseline_hashes[1]];
        let mut selected = FlushRowSelection::default();
        classify_flush_rows(&peer.display_cache, &current_hashes, 101.0, &mut selected);
        let rows: Vec<_> = selected
            .selected_rows
            .iter()
            .map(|row| (row.row, if row.row == 0 { b'c' } else { b'0' }))
            .collect();
        let c = row_predecessor_original_for_test(&mut peer, &rows);
        let c_seq = c.seq;
        let mut absolute = [0u64; 4];
        for row in &selected.selected_rows {
            if row.force_full {
                absolute[usize::from(row.row) / 64] |= 1 << (row.row % 64);
            }
        }
        send_unpaced_display_burst(&mut peer, &mut vec![c], &mut pool, 1, 101.0, &absolute);
        let (channel, wire) = rx.try_recv().unwrap();
        let c_frame = browser
            .open_datagram(crate::e2e::lane_for_channel(channel).unwrap(), &wire)
            .unwrap();
        assert!(receiver.apply_delta_seq(&c_frame, c_seq));
        let (repair, body) = merkur_fec::repair::parse_repair(&parity).unwrap();
        let mut padded = vec![0; 2 * usize::from(repair.shard_size)];
        let mut recovered = vec![0; padded.len()];
        assert_eq!(
            merkur_fec::repair::recover_batch_into(
                &repair,
                &[Some(&a0), None],
                body,
                &mut padded,
                &mut recovered,
            ),
            2
        );
        let restored = &recovered[usize::from(repair.shard_size)..][..original_len];
        assert!(receiver.apply_delta_seq(restored, refused_seq));
        assert_eq!(receiver.row_hash(0), current_hashes[0]);
        assert_eq!(
            receiver.row_hash(1),
            current_hashes[1],
            "delayed parity must not resurrect content omitted by a baseline reversion"
        );
        let exposed = &peer.display_cache.sent_datagrams[&refused_seq];
        assert_eq!(exposed.rows.iter().next().unwrap().hash, refused_hash);
        assert!(!exposed.sent_via.any());
        assert_eq!(exposed.outcome_path(), None);
        assert_eq!(exposed.evidence_path(), None);
        let confirm_before = peer.display_confirm.ewma_ms;
        handle_display_ack(
            &mut peer,
            DisplayAck::with_recovered(generation, refused_seq, [1, 0, 0, 0], [1, 0, 0, 0]),
            102.0,
            PeerTransport::Edge,
            &current_hashes,
            false,
        );
        assert_eq!(peer.display_cache.acked_row_hashes[1], refused_hash);
        assert_eq!(peer.display_confirm.ewma_ms, confirm_before);
        assert_eq!(peer.display_cache.sent_row_hashes[1], current_hashes[1]);
        assert!(!peer.display_cache.sent_row_confirmed[1]);
        handle_display_ack(
            &mut peer,
            DisplayAck::new(generation, c_seq, [1, 0, 0, 0]),
            103.0,
            PeerTransport::Edge,
            &current_hashes,
            false,
        );
        assert_eq!(peer.display_cache.acked_row_hashes, current_hashes);
        assert!(
            peer.display_cache
                .sent_row_confirmed
                .iter()
                .all(|confirmed| *confirmed)
        );
        assert_eq!(
            peer.display_cache.datagram_outcomes.edge.recovered_by_fec,
            0
        );
    }
}

#[tokio::test]
async fn fec_exposure_requires_reconstructible_admitted_repair_and_preserves_physical_counts() {
    fn apply(receiver: &mut term_wasm::Terminal, bytes: &[u8], seq: u32) {
        let handle = receiver.stage_display_frame_bytes(bytes);
        assert_ne!(handle, 0, "{:?}", receiver.take_last_error());
        assert!(receiver.validate_staged_frame(handle));
        assert!(
            receiver.apply_staged_delta_seq(handle, seq),
            "{:?}",
            receiver.take_last_error()
        );
        receiver.release_staged_frame(handle);
    }
    for compressed in [false, true] {
        for members in [2usize, 3] {
            for admitted_mask in 0u32..(1 << members) {
                for repair_admitted in [false, true] {
                    for ends in [false, true] {
                        let (mut peer, mut browser) = benchmark_noise_pair();
                        peer.display_cache.resize(128, members as u16);
                        peer.presentation_end_owed = true;
                        let (tx, mut rx) = mpsc::unbounded_channel();
                        peer.edge_tunnel =
                            Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
                        let mut group: Vec<_> = (0..members)
                            .map(|row| {
                                row_predecessor_original_for_test(
                                    &mut peer,
                                    &[(row as u16, b'a' + row as u8)],
                                )
                            })
                            .collect();
                        let pid = group[0].frame_id;
                        let first_seq = group[0].seq;
                        let mut compressor = Compressor::new();
                        let snapshots: Vec<_> = group
                            .iter()
                            .map(|frame| Arc::clone(&frame.rows.iter().next().unwrap().cells))
                            .collect();
                        for (index, frame) in group.iter_mut().enumerate() {
                            patch_stream_header(
                                &mut frame.frame,
                                frame.seq,
                                peer.generation,
                                0,
                                frame.frame_id,
                                pid,
                                true,
                                ends && index == members - 1,
                                0,
                                1,
                                index as u16,
                                members as u16,
                            )
                            .unwrap();
                            if compressed {
                                let mut encoded = Vec::new();
                                assert!(
                                    compressor
                                        .compress_display_frame_into(
                                            &frame.frame,
                                            None,
                                            &mut encoded
                                        )
                                        .is_some()
                                );
                                frame.frame = encoded;
                            }
                            let path = if admitted_mask & (1 << index) != 0 {
                                PeerTransport::Edge
                            } else {
                                PeerTransport::WebTransport
                            };
                            frame.physical_plan = PreparedPhysicalDatagramPlan {
                                data_primary: Some(path),
                                data_paths: SentPaths::single(path),
                                ..Default::default()
                            };
                        }
                        let repair_path = if repair_admitted {
                            PeerTransport::Edge
                        } else {
                            PeerTransport::WebTransport
                        };
                        group[members - 1].physical_plan.repair_primary = Some(repair_path);
                        group[members - 1].physical_plan.repair_paths =
                            SentPaths::single(repair_path);
                        let originals = admitted_mask.count_ones() as usize;
                        let expected_physical = originals + usize::from(repair_admitted);
                        let mut budget = DatagramPhysicalBudget::exact(0, 0, 0)
                            .with_reserved_datagrams(
                                members + 1 - expected_physical,
                                expected_physical,
                            );
                        let recovery = fec_recovery_shard_count(
                            members,
                            group.iter().map(|frame| frame.frame.len()).max().unwrap(),
                        );
                        assert!(recovery > 0);
                        let reconstructible = repair_admitted && members - originals <= recovery;
                        let expected_exposed = if reconstructible {
                            (1 << members) - 1
                        } else {
                            admitted_mask
                        };
                        let expected_original_record_bytes: usize = group
                            .iter()
                            .enumerate()
                            .filter(|(index, _)| admitted_mask & (1 << index) != 0)
                            .map(|(_, frame)| frame.frame.len() + 1)
                            .sum();
                        let mut pool = frame_pool_for_test();
                        TEST_ORIGINAL_ADMISSION_TIMING.set(Some(OriginalAdmissionTiming {
                            first: None,
                            last: None,
                            originals: 0,
                        }));
                        let outcome = send_planned_group(
                            &mut peer,
                            &mut group,
                            &mut pool,
                            100.0,
                            &mut budget,
                        );
                        let timing = TEST_ORIGINAL_ADMISSION_TIMING.take().unwrap();
                        assert_eq!(timing.originals, originals);
                        assert_eq!(timing.first.is_some(), originals != 0);
                        assert_eq!(timing.last.is_some(), originals != 0);
                        assert_eq!(outcome.original_admitted, originals != 0);
                        assert_eq!(
                            outcome.presentation_end_admitted,
                            ends && admitted_mask & (1 << (members - 1)) != 0
                        );
                        assert_eq!(peer.last_admitted_sync_epoch, 0);
                        assert_eq!(peer.sim_datagram_metadata.len(), expected_physical);
                        assert_eq!(
                            peer.unresolved_presentation_rows,
                            [u64::from(expected_exposed), 0, 0, 0]
                        );
                        assert_eq!(
                            peer.row_presentation_head,
                            if expected_exposed == 0 { 0 } else { pid }
                        );
                        assert_eq!(
                            peer.presentation_end_owed,
                            !(ends && expected_exposed & (1 << (members - 1)) != 0)
                        );
                        assert_eq!(
                            peer.display_cache.sent_datagrams.len(),
                            expected_exposed.count_ones() as usize
                        );
                        let highest_exposed = if expected_exposed == 0 {
                            0
                        } else {
                            first_seq + 31 - expected_exposed.leading_zeros()
                        };
                        assert_eq!(peer.last_display_seq_sent, highest_exposed);
                        assert_eq!(
                            peer.last_datagram_seq,
                            if admitted_mask == 0 {
                                0
                            } else {
                                first_seq + 31 - admitted_mask.leading_zeros()
                            },
                            "physical datagram high-water excludes repair-only exposure"
                        );
                        for (index, frame) in group.iter().enumerate() {
                            if expected_exposed & (1 << index) == 0 {
                                assert!(!frame.rows.is_empty());
                                continue;
                            }
                            assert!(frame.rows.is_empty());
                            let sent = &peer.display_cache.sent_datagrams[&frame.seq];
                            assert!(Arc::ptr_eq(
                                &sent.rows.iter().next().unwrap().cells,
                                &snapshots[index]
                            ));
                            assert!(Arc::ptr_eq(
                                &peer.display_cache.sent_row_cells[index],
                                &snapshots[index]
                            ));
                            assert_eq!(sent.sent_at_ms, 100.0);
                            assert_eq!(sent.sent_via.any(), admitted_mask & (1 << index) != 0);
                        }
                        let mut captured = 0;
                        let mut received = vec![None; members];
                        let mut parity = None;
                        while let Ok((channel, wire)) = rx.try_recv() {
                            let plain = browser
                                .open_datagram(
                                    crate::e2e::lane_for_channel(channel).unwrap(),
                                    &wire,
                                )
                                .unwrap();
                            if plain[0] == merkur_codec::MSG_TYPE_DISPLAY_FEC_REPAIR {
                                parity = Some(plain);
                            } else {
                                let seq = merkur_codec::parse_stream_header(&plain).unwrap().seq;
                                received[(seq - first_seq) as usize] = Some(plain);
                            }
                            captured += 1;
                        }
                        assert_eq!(captured, expected_physical);
                        // Only captured original submissions spend original
                        // record bytes. Repair-exposed ACK records add no
                        // physical submission, regardless of reconstruction.
                        assert_eq!(
                            received
                                .iter()
                                .flatten()
                                .map(|frame| frame.len() + 1)
                                .sum::<usize>(),
                            expected_original_record_bytes
                        );
                        let mut receiver = term_wasm::Terminal::new_headless(128, members as u16);
                        for (index, original) in received.iter().enumerate() {
                            if let Some(original) = original {
                                apply(&mut receiver, original, group[index].seq);
                            }
                        }
                        if let Some(parity) = parity {
                            let (header, body) = merkur_fec::repair::parse_repair(&parity).unwrap();
                            let span = members * usize::from(header.shard_size);
                            let mut padded = vec![0; span];
                            let mut output = vec![0; span];
                            let references: Vec<_> =
                                received.iter().map(|frame| frame.as_deref()).collect();
                            let restored = merkur_fec::repair::recover_batch_into(
                                &header,
                                &references,
                                body,
                                &mut padded,
                                &mut output,
                            );
                            assert_eq!(restored, expected_exposed & !admitted_mask);
                            for (index, frame) in group.iter().enumerate() {
                                if restored & (1 << index) != 0 {
                                    let bytes = &output[index * usize::from(header.shard_size)..]
                                        [..frame.frame.len()];
                                    assert_eq!(bytes, frame.frame);
                                    apply(&mut receiver, bytes, frame.seq);
                                }
                            }
                        }
                        if expected_exposed != 0 {
                            use crate::display::recv::{DisplayAck, handle_display_ack};
                            let current: Vec<_> = snapshots
                                .iter()
                                .map(|cells| merkur_codec::row_hash(cells))
                                .collect();
                            let mut applied = [0u32; 4];
                            let mut recovered = [0u32; 4];
                            for (index, frame) in group.iter().enumerate() {
                                if expected_exposed & (1 << index) != 0 {
                                    assert_eq!(receiver.row_hash(index as u16), current[index]);
                                    applied[0] |= 1 << (highest_exposed - frame.seq);
                                    if admitted_mask & (1 << index) == 0 {
                                        recovered[0] |= 1 << (highest_exposed - frame.seq);
                                    }
                                }
                            }
                            let generation = peer.generation;
                            handle_display_ack(
                                &mut peer,
                                DisplayAck::with_recovered(
                                    generation,
                                    highest_exposed,
                                    applied,
                                    recovered,
                                ),
                                101.0,
                                PeerTransport::Edge,
                                &current,
                                false,
                            );
                            for (index, &hash) in current.iter().enumerate() {
                                if expected_exposed & (1 << index) != 0 {
                                    assert_eq!(peer.display_cache.acked_row_hashes[index], hash);
                                    assert!(peer.display_cache.sent_row_confirmed[index]);
                                }
                            }
                            assert_eq!(
                                peer.display_cache.datagram_outcomes.edge.received,
                                originals as u64
                            );
                            assert_eq!(
                                peer.display_cache.datagram_outcomes.edge.recovered_by_fec,
                                0
                            );
                            assert_eq!(
                                peer.display_cache.datagram_outcomes.webtransport.received,
                                0
                            );
                        }
                        peer.next_generation();
                        assert!(peer.display_cache.sent_datagrams.is_empty());
                        assert_eq!(peer.unresolved_presentation_rows, [0; 4]);
                        assert_eq!(peer.last_display_seq_sent, 0);
                    }
                }
            }
        }
    }
}

#[test]
fn fec_exposed_snapshot_uses_normal_bounded_history_without_extra_allocation() {
    use crate::edge_tunnel::test_allocations;
    for retained in [0, 11, DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES] {
        let mut peers = [
            PeerDisplayState::new("original".into(), PeerTransport::Edge),
            PeerDisplayState::new("repair".into(), PeerTransport::Edge),
        ];
        for peer in &mut peers {
            peer.display_cache.resize(2, 1);
            for index in 0..retained {
                let mut frame = row_predecessor_original_for_test(peer, &[(0, b'a')]);
                record_sent_datagram_with_protection(
                    peer,
                    &mut frame,
                    index as f64,
                    SentPaths::single(PeerTransport::Edge),
                    DisplayDatagramProtection::Fec,
                );
            }
        }
        let mut tallies = Vec::new();
        for (index, peer) in peers.iter_mut().enumerate() {
            let mut frame = row_predecessor_original_for_test(peer, &[(0, b'b')]);
            let seq = frame.seq;
            let snapshot = Arc::clone(&frame.rows.iter().next().unwrap().cells);
            test_allocations::begin_thread();
            if index == 0 {
                record_sent_datagram_with_protection(
                    peer,
                    &mut frame,
                    retained as f64,
                    SentPaths::single(PeerTransport::Edge),
                    DisplayDatagramProtection::Fec,
                );
            } else {
                record_repair_exposed_original(peer, &mut frame, retained as f64);
            }
            let tally = test_allocations::end_thread();
            tallies.push(tally);
            assert_eq!(
                peer.display_cache.sent_datagrams.len(),
                (retained + 1).min(DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES)
            );
            assert!(Arc::ptr_eq(
                &peer.display_cache.sent_row_cells[0],
                &snapshot
            ));
            assert!(Arc::ptr_eq(
                &peer.display_cache.sent_datagrams[&seq]
                    .rows
                    .iter()
                    .next()
                    .unwrap()
                    .cells,
                &snapshot
            ));
            if retained == DisplayPolicy::SENT_DATAGRAM_MAX_ENTRIES {
                assert!(!peer.display_cache.sent_datagrams.contains_key(&1));
            }
            if index == 1 {
                // Retiring either carrier conservatively reselects a
                // repair-only attempt, but cannot erase its exact snapshot
                // or make a subsequent baseline reversion disappear.
                peer.retire_display_attempts(PeerTransport::WebTransport);
                assert!(peer.display_cache.sent_datagrams.contains_key(&seq));
                assert!(!peer.display_cache.sent_row_confirmed[0]);
                assert!(peer.display_cache.sent_row_force_full_until_confirmed[0]);
            }
        }
        assert_eq!(tallies[0], tallies[1]);
        println!(
            "FEC exposure record retained={retained}: original={:?} repair={:?}; identical Arc snapshots, no additional cell/payload copy",
            tallies[0], tallies[1]
        );
    }
}

#[test]
fn k1_probe_is_noncausal_nonmember_and_never_closes_its_protected_presentation() {
    for (coherent, end) in [(false, true), (true, false), (true, true)] {
        let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
        peer.latest_input_seq = 77;
        let mut template = valid_header_only_prepared_with_presentation_for_test(
            &mut peer,
            DisplayUtility::Critical,
            coherent,
            end,
        );
        template.frame[DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET
            ..DISPLAY_ROW_PREDECESSOR_PRESENTATION_ID_OFFSET + 4]
            .copy_from_slice(&91u32.to_be_bytes());
        template.frame[DISPLAY_PATCH_FLAGS_OFFSET] |= merkur_codec::PATCH_FLAG_MEMORY_ONLY;
        let template_header = merkur_codec::parse_frame_header(&template.frame).unwrap();
        let mut frames = frame_pool_for_test();
        let (probe_seq, probe) =
            build_k1_probe_frame(&mut peer, &template, &mut frames).expect("probe frame");
        let probe_stream = merkur_codec::parse_stream_header(&probe).expect("probe stream");
        let probe_header = merkur_codec::parse_frame_header(&probe).expect("probe header");

        assert_eq!(probe_stream.input_seq, 0, "probe must not confirm input");
        assert!(probe_header.memory_only);
        assert_eq!(probe_header.presentation_member_index, 0);
        assert_eq!(probe_header.presentation_member_count, 0);
        assert!(probe_header.presentation_coherent);
        assert!(!probe_header.presentation_end);
        assert_eq!(probe_header.row_predecessor_presentation_id, 91);
        assert_eq!(peer.row_presentation_head, 0);
        assert_eq!(peer.unresolved_presentation_rows, [0; 4]);
        assert_eq!(
            probe_header.presentation_id, template_header.presentation_id,
            "probe must retain the protected frame's presentation identity"
        );

        for probe_first in [false, true] {
            let mut receiver = term_wasm::Terminal::new_headless(2, 8);
            let ordered = if probe_first {
                [(&probe, probe_seq), (&template.frame, template.seq)]
            } else {
                [(&template.frame, template.seq), (&probe, probe_seq)]
            };
            let mut visual_mutations = 0;
            for (wire, seq) in ordered {
                assert!(receiver.apply_delta_seq(wire, seq));
                visual_mutations += usize::from(receiver.last_apply_visually_changed());
            }
            assert_eq!(
                visual_mutations, 1,
                "same header in either arrival order must produce one visual mutation"
            );
        }
    }
}

/// A frame pool for the burst sends the tests drive directly.
fn frame_pool_for_test() -> BufferPool {
    BufferPool::new(DISPLAY_FRAME_POOL_DEPTH)
}

/// What a burst does with its datagrams once they are sealed: every frame
/// and repair goes back to the pool, so a benchmark loop that builds the
/// next flush measures production's steady state rather than a fresh
/// allocation per frame.
fn recycle_frames_for_test(datagrams: &mut Vec<PreparedDisplayDatagram>, frames: &mut BufferPool) {
    for datagram in datagrams.drain(..) {
        frames.put(datagram.frame);
        if let Some(repair) = datagram.precomputed_fec_repair {
            frames.put(repair);
        }
    }
}

#[test]
fn opening_a_late_continuation_invalidates_the_complete_fec_set() {
    let mut open = prepared_for_test(1, 80);
    open.frame[DISPLAY_PATCH_FLAGS_OFFSET] = PATCH_FLAG_PRESENTATION_COHERENT;
    open.precomputed_fec_repair = Some(vec![0xA1; 32]);
    let mut ending = prepared_for_test(2, 80);
    ending.frame[DISPLAY_PATCH_FLAGS_OFFSET] =
        PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END;
    ending.precomputed_fec_repair = Some(vec![0xB2; 32]);
    let mut buffers = PrepareBuffers {
        datagrams: vec![open, ending],
        ..Default::default()
    };

    mark_prepared_presentation_continues(&mut buffers);

    assert!(buffers.datagrams[0].precomputed_fec_repair.is_none());
    assert!(buffers.datagrams[1].precomputed_fec_repair.is_none());
    for datagram in &buffers.datagrams {
        assert_eq!(
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET]
                & (PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END),
            PATCH_FLAG_PRESENTATION_COHERENT
        );
    }
    let mut fec_encoder = crate::display::fec::FecEncoder::new();
    precompute_fec_repairs(
        &mut buffers.datagrams,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        7,
        &mut fec_encoder,
        &mut buffers.frames,
    );
    assert!(
        buffers
            .datagrams
            .iter()
            .any(|datagram| datagram.precomputed_fec_repair.is_some()),
        "send preparation recomputes parity from the restamped bytes"
    );
}
#[test]
fn sent_datagram_retains_its_original_header_only_classification() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(2, 1);
    let sent_via = SentPaths::single(PeerTransport::Edge);

    let mut row_bearing = prepared_for_test(1, 8);
    row_bearing.rows.push(SentRow {
        graphics: None,
        row: 0,
        hash: 7,
        cells: vec![CellRepr::BLANK; 2].into(),
    });
    record_sent_datagram(&mut peer, &mut row_bearing, 100.0, sent_via);

    peer.display_cache.invalidate_rows(&[0]);
    let invalidated = peer
        .display_cache
        .sent_datagrams
        .get(&1)
        .expect("row-bearing datagram remains as a repair tombstone");
    assert!(invalidated.rows.is_empty());
    assert!(!invalidated.header_only);

    let mut header_only = prepared_for_test(2, 8);
    header_only.encoded_rows = 0;
    record_sent_datagram(&mut peer, &mut header_only, 110.0, sent_via);

    let empty = peer
        .display_cache
        .sent_datagrams
        .get(&2)
        .expect("header-only datagram is retained until ACK");
    assert!(empty.rows.is_empty());
    assert!(empty.header_only);
}

fn flush_summary_for_test(selected_count: u32) -> DisplayFlushSummary {
    DisplayFlushSummary {
        selected_count,
        force_full_count: 0,
        perf_wire_bytes: selected_count as usize * 8,
        input_seq: 1,
        input_to_flush_ms: Some(1.0),
    }
}

fn build_and_activate_test_dictionary(
    peer: &mut PeerDisplayState,
    fill: u8,
) -> Arc<DisplayDictionary> {
    let source: Arc<[u8]> = vec![fill; DISPLAY_DICTIONARY_MIN_BYTES].into();
    let dictionary = peer
        .dictionary
        .build_next_prepared(
            peer.generation,
            Arc::clone(&source),
            dictionary_hash(&source),
        )
        .expect("test dictionary must be due");
    assert!(peer.dictionary.acknowledge(dictionary.id));
    dictionary
}

#[tokio::test]
async fn changed_ack_baseline_discards_worker_result_without_consuming_sequences() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.noise = Some(established_daemon_noise());
    peer.display_cache.resize(2, 1);
    peer.display_cache.acked_row_cells[0] = Arc::from(vec![CellRepr {
        codepoint: u32::from(b'x'),
        ..CellRepr::BLANK
    }]);
    peer.display_prepare_in_flight = Some(9);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 9,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Plain,
        compression_dictionary: None,
        // Captured against a baseline the peer no longer holds.
        buffers: PrepareBuffers {
            rows: vec![prepare_row_for_test(0, Arc::from(vec![CellRepr::BLANK; 2]))],
            ..Default::default()
        },
        summary: flush_summary_for_test(8),
    };

    finish_display_prepare(
        completion,
        4,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert!(peer.needs_full_diff);
    assert_eq!(peer.next_datagram_seq, initial_seq);
    assert_eq!(peer.next_frame_id, initial_frame_id);
}

#[tokio::test]
async fn same_arc_invalidation_discards_worker_result_without_consuming_sequences() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.noise = Some(established_daemon_noise());
    peer.display_cache.resize(2, 1);
    let baseline = Arc::clone(&peer.display_cache.acked_row_cells[0]);
    let mut prepared_row = prepare_row_for_test(0, Arc::clone(&baseline));
    prepared_row.baseline_revision = peer.display_cache.acked_row_revisions[0];
    peer.display_prepare_in_flight = Some(91);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;

    // Loss/resync disowns the semantic baseline but intentionally retains
    // the immutable cells. Arc identity alone would admit this stale delta.
    peer.display_cache.invalidate_rows(&[0]);
    assert!(Arc::ptr_eq(
        &baseline,
        &peer.display_cache.acked_row_cells[0]
    ));

    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 91,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Plain,
        compression_dictionary: None,
        buffers: PrepareBuffers {
            rows: vec![prepared_row],
            ..Default::default()
        },
        summary: flush_summary_for_test(8),
    };

    finish_display_prepare(
        completion,
        4,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert!(peer.needs_full_diff);
    assert_eq!(peer.next_datagram_seq, initial_seq);
    assert_eq!(peer.next_frame_id, initial_frame_id);
}

#[tokio::test]
async fn newer_ack_of_same_exact_arc_preserves_worker_result() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.noise = Some(established_daemon_noise());
    peer.display_cache.resize(2, 1);
    let blank = vec![CellRepr::BLANK; 2];
    let hash = merkur_codec::row_hash(&blank);
    peer.display_cache.prime_from_snapshot(&blank, &[hash], &[]);
    let baseline = Arc::clone(&peer.display_cache.acked_row_cells[0]);
    let baseline_revision = peer.display_cache.acked_row_revisions[0];
    let mut prepared_row = prepare_row_for_test(0, Arc::clone(&baseline));
    prepared_row.baseline_revision = baseline_revision;

    // A later retry ACK advances transport provenance, not the semantic
    // compression baseline. It must not create discard/reprepare churn.
    let retry = SentRow {
        graphics: None,
        row: 0,
        hash,
        cells: Arc::clone(&baseline),
    };
    crate::display::recv::advance_acked_rows_from_sent_snapshot(
        &mut peer.display_cache,
        7,
        [&retry],
        false,
        true,
    );
    assert_eq!(peer.display_cache.acked_row_revisions[0], baseline_revision);

    peer.display_prepare_in_flight = Some(92);
    peer.latest_input_seq = 1;
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 92,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Plain,
        compression_dictionary: None,
        buffers: PrepareBuffers {
            rows: vec![prepared_row],
            ..Default::default()
        },
        summary: flush_summary_for_test(8),
    };

    finish_display_prepare(
        completion,
        3,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert_eq!(peer.next_datagram_seq, initial_seq + 2);
    assert_eq!(peer.next_frame_id, initial_frame_id + 1);
}

#[tokio::test]
async fn input_arriving_during_worker_preparation_rearms_header_flush() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.noise = Some(established_daemon_noise());
    peer.display_prepare_in_flight = Some(10);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 10,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq,
        next_frame_id: initial_frame_id,
        dictionary_class: DictionaryClass::Plain,
        compression_dictionary: None,
        buffers: PrepareBuffers::default(),
        summary: flush_summary_for_test(8),
    };
    peers
        .get_mut("browser-1")
        .expect("test peer is present")
        .latest_input_seq = 2;

    finish_display_prepare(
        completion,
        3,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    assert!(peers["browser-1"].needs_full_diff);
}

#[tokio::test]
async fn one_dictionary_rotation_before_worker_completion_remains_decodable() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.needs_full_diff = false;
    peer.noise = Some(established_daemon_noise());
    let prepared_dictionary = build_and_activate_test_dictionary(&mut peer, b'a');
    for _ in 0..crate::display::compressor::DISPLAY_DICTIONARY_REBUILD_FLUSHES {
        peer.dictionary.observe_flush();
    }
    let current_dictionary = build_and_activate_test_dictionary(&mut peer, b'b');
    assert!(!Arc::ptr_eq(&prepared_dictionary, &current_dictionary));

    peer.display_prepare_in_flight = Some(11);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 11,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Finalized,
        compression_dictionary: Some(prepared_dictionary),
        buffers: PrepareBuffers::default(),
        summary: flush_summary_for_test(8),
    };

    finish_display_prepare(
        completion,
        3,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert_eq!(peer.next_datagram_seq, initial_seq + 2);
    assert_eq!(peer.next_frame_id, initial_frame_id + 1);
    assert!(
        peer.dictionary
            .active()
            .is_some_and(|active| Arc::ptr_eq(active, &current_dictionary))
    );
}

#[tokio::test]
async fn two_dictionary_rotations_before_worker_completion_discard_result() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.needs_full_diff = false;
    peer.noise = Some(established_daemon_noise());
    let prepared_dictionary = build_and_activate_test_dictionary(&mut peer, b'a');
    for fill in *b"bc" {
        for _ in 0..crate::display::compressor::DISPLAY_DICTIONARY_REBUILD_FLUSHES {
            peer.dictionary.observe_flush();
        }
        build_and_activate_test_dictionary(&mut peer, fill);
    }

    peer.display_prepare_in_flight = Some(13);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 13,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Finalized,
        compression_dictionary: Some(prepared_dictionary),
        buffers: PrepareBuffers::default(),
        summary: flush_summary_for_test(8),
    };

    finish_display_prepare(
        completion,
        3,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert!(peer.needs_full_diff);
    assert_eq!(peer.next_datagram_seq, initial_seq);
    assert_eq!(peer.next_frame_id, initial_frame_id);
}

#[tokio::test]
async fn dictionary_free_worker_result_survives_later_dictionary_install() {
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.needs_snapshot = false;
    peer.needs_full_diff = false;
    peer.noise = Some(established_daemon_noise());
    peer.display_prepare_in_flight = Some(12);
    let generation = peer.generation;
    let initial_seq = peer.next_datagram_seq;
    let initial_frame_id = peer.next_frame_id;

    // The request captured None. Installing a dictionary before completion
    // must not invalidate frames that do not reference any dictionary.
    let current_dictionary = build_and_activate_test_dictionary(&mut peer, b'c');
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    let completion = DisplayPrepareCompletion {
        token: 12,
        submitted_at: Instant::now(),
        cpu_time: Duration::ZERO,
        perf_timing: None,
        generation,
        display_revision: 3,
        completed_sync_update_epoch: 0,
        start_seq: initial_seq,
        start_frame_id: initial_frame_id,
        next_seq: initial_seq + 2,
        next_frame_id: initial_frame_id + 1,
        dictionary_class: DictionaryClass::Plain,
        compression_dictionary: None,
        buffers: PrepareBuffers::default(),
        summary: flush_summary_for_test(0),
    };

    finish_display_prepare(
        completion,
        3,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let peer = &peers["browser-1"];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert_eq!(peer.next_datagram_seq, initial_seq + 2);
    assert_eq!(peer.next_frame_id, initial_frame_id + 1);
    assert!(
        peer.dictionary
            .active()
            .is_some_and(|active| Arc::ptr_eq(active, &current_dictionary))
    );
}

fn dictionary_completion_for_test(token: u64) -> DictionaryPrepareCompletion {
    DictionaryPrepareCompletion {
        token,
        display_revision: 7,
        cpu_time: Duration::ZERO,
        source: Arc::<[u8]>::from([]),
        hash: 0,
    }
}

#[tokio::test]
async fn graphics_validation_cannot_publish_a_partial_synchronized_grid() {
    let (tx, _rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(80, 3, tx);
    terminal.apply_bytes(b"old");
    let input = b"\x1b[?2026h\rnew\x1b_Ga=q,f=24,s=1,v=1,i=31;AAAA\x1b\\done\x1b[?2026l";
    let mut accepted = terminal.apply_bytes(input);
    assert!(terminal.display_commit_pending());
    assert!(terminal.stop_synchronized_update());
    assert!(
        terminal.display_commit_pending(),
        "timeout cannot bypass semantic validation"
    );
    let mut scratch = DisplayScratch::new(2);
    scratch.current_row_hashes = vec![u64::MAX; 3];
    let mut worker = idle_prepare_worker_for_test();
    let mut peers = PeerMap::new();
    let mut cursor = DisplayFlushCursor::default();
    let mut perf = PerfTimingTracker::default();
    let clock = FlushClock::Epoch(Instant::now());
    flush_display(
        &mut terminal,
        &mut scratch,
        &mut worker,
        &mut peers,
        &clock,
        &mut cursor,
        &mut perf,
    )
    .await;
    assert_eq!(scratch.current_row_hashes, [u64::MAX; 3]);
    assert!(scratch.flush_row_capture.is_empty());
    assert!(terminal.has_dirty());
    assert_eq!(terminal.completed_sync_update_epoch(), 0);

    let wake = terminal.graphics_wake();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while terminal.graphics_pending() {
            wake.notified().await;
            accepted += terminal.apply_bytes(&input[accepted..]);
        }
    })
    .await
    .expect("image completion must resume the owner");
    assert_eq!(accepted, input.len());
    assert!(!terminal.display_commit_pending());
    assert_eq!(terminal.completed_sync_update_epoch(), 1);
    flush_display(
        &mut terminal,
        &mut scratch,
        &mut worker,
        &mut peers,
        &clock,
        &mut cursor,
        &mut perf,
    )
    .await;
    assert_ne!(scratch.current_row_hashes, [u64::MAX; 3]);
    terminal.shutdown_graphics().await;
}

/// A worker handle whose lanes have no thread behind them.
fn idle_prepare_worker_for_test() -> DisplayPrepareWorker {
    let (interactive_tx, _interactive_rx) = crossbeam_channel::bounded(1);
    let (bulk_tx, _bulk_rx) = crossbeam_channel::bounded(1);
    let (snapshot_tx, _snapshot_rx) = crossbeam_channel::bounded(1);
    let (dictionary_tx, _dictionary_rx) = crossbeam_channel::bounded(1);
    DisplayPrepareWorker {
        interactive_tx,
        bulk_tx,
        snapshot_tx,
        dictionary_tx,
        next_token: 0,
        dictionary_in_flight: None,
        dictionary_ready: None,
        spare: Vec::new(),
    }
}

/// A captured row whose cells equal `baseline`, for completion fences that
/// only look at the baseline identity.
fn prepare_row_for_test(row: u16, baseline: Arc<[CellRepr]>) -> DisplayPrepareRow {
    DisplayPrepareRow {
        request: DisplayRowRequest::literal(row, false),
        sent: CapturedRow {
            graphics: PreparedGraphics::EMPTY,
            row,
            hash: merkur_codec::row_hash(&baseline),
            cells: Arc::clone(&baseline),
        },
        baseline,
        baseline_revision: 0,
        utility: DisplayUtility::NonCritical,
        encoded_size: 1,
        encoding: CellEncoding::default(),
        content: ContentEvidence::default(),
        span: RowSpan::default(),
    }
}

#[test]
fn graphics_only_rows_encode_exactly_and_ack_the_retained_revision() {
    use merkur_graphics::budget::{Budget, Usage};
    use merkur_graphics::geometry::{CELL_UNIT, RowSlice};
    use merkur_graphics::projection::{Content, Fragment, Stack};
    let budget = Budget::new(Usage {
        bytes: 4096,
        objects: 8,
    });
    let make_graphics = |id, scratch: &mut merkur_codec::GraphicsEncodeScratch| {
        let fragment = Fragment {
            content: Content {
                kind: merkur_graphics::projection::ContentKind::Image,
                root: [id; 32],
                width: 1,
                height: 1,
            },
            stack: Stack {
                z: 0,
                image_id: 1,
                placement: 1,
            },
            slice: RowSlice {
                left: 0,
                right: CELL_UNIT,
                top: 0,
                bottom: CELL_UNIT,
                source_left: 0,
                source_right: CELL_UNIT,
                source_top: 0,
                source_bottom: CELL_UNIT,
            },
        };
        PreparedGraphics::new(&budget, 8, &[fragment], scratch).unwrap()
    };
    let mut scratch = merkur_codec::GraphicsEncodeScratch::default();
    let (first, _first_charge) = make_graphics(1, &mut scratch);
    let (second, _second_charge) = make_graphics(2, &mut scratch);
    crate::edge_tunnel::test_allocations::begin_thread();
    let third = make_graphics(3, &mut scratch);
    let construction = crate::edge_tunnel::test_allocations::end_thread();
    assert_eq!(construction.allocations, 2);
    assert_eq!(budget.used().unwrap().objects, 6);
    drop(third);
    let cells: Arc<[CellRepr]> = vec![CellRepr::BLANK; 8].into();
    let mut row = prepare_row_for_test(0, Arc::clone(&cells));
    row.sent.graphics = first.clone();
    row.sent.hash = 1;
    (row.encoded_size, row.encoding, row.content, row.span) =
        encoded_row_size(&row.request, &cells, &cells, None, &row.sent.graphics);
    let (event_tx, _) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 1, event_tx);
    let (snapshot, _) = terminal.encode_snapshot_into(Vec::new());
    let mut header = merkur_codec::parse_frame_header(&snapshot).unwrap();
    header.kind = merkur_codec::FrameKind::Delta;
    let mut frame = Vec::new();
    let sent = encode_captured_rows(header, [&row].into_iter(), &mut frame);
    let decoded = merkur_codec::iter_rows(&frame).next().unwrap().unwrap();
    assert_eq!((decoded.left, decoded.right), (0, 0));
    assert_eq!(decoded.graphics, &first.bytes()[4..]);
    assert_eq!(
        frame.len(),
        STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES + row.encoded_size
    );
    assert!(
        merkur_codec::parse_frame_header(&frame)
            .unwrap()
            .memory_only
    );
    // The provenance a datagram keeps is the row's version, not the row.
    assert_eq!(sent.iter().next().unwrap().graphics, first.version());
    crate::edge_tunnel::test_allocations::begin_thread();
    for _ in 0..16 {
        drop(encode_captured_rows(header, [&row].into_iter(), &mut frame));
    }
    let allocations = crate::edge_tunnel::test_allocations::end_thread();
    assert_eq!(allocations.allocations, 0);

    let mut cache = PerPeerDisplayCache::new();
    cache.resize(8, 1);
    cache.prime_from_snapshot(&cells, &[0], &[]);
    let earlier = SentRow::from(&row.sent);
    cache.record_sent_rows(1, [&earlier], 0.0, 10.0);
    let mut later = row.sent.clone();
    later.graphics = second.clone();
    later.hash = 2;
    let later = SentRow::from(&later);
    cache.record_sent_rows(2, [&later], 1.0, 10.0);
    let before = cache.acked_row_revisions[0];
    crate::display::recv::advance_acked_rows_from_sent_snapshot(
        &mut cache,
        1,
        [&earlier],
        false,
        true,
    );
    assert_eq!(cache.acked_row_graphics[0], first.version());
    assert_eq!(cache.sent_row_graphics[0], second.version());
    assert_eq!(cache.acked_row_revisions[0], before + 1);
    crate::display::recv::advance_acked_rows_from_sent_snapshot(
        &mut cache,
        2,
        [&later],
        false,
        true,
    );
    assert_eq!(cache.acked_row_graphics[0], second.version());
    assert_eq!(cache.acked_row_revisions[0], before + 2);
    crate::display::recv::advance_acked_rows_from_sent_snapshot(
        &mut cache,
        3,
        [&later],
        false,
        true,
    );
    assert_eq!(cache.acked_row_revisions[0], before + 2);

    let mut peer = PeerDisplayState::new("graphics-ack".into(), PeerTransport::Edge);
    peer.display_cache.resize(8, 1);
    peer.display_cache
        .prime_from_snapshot(&cells, &[1], &[row.sent.graphics.version()]);
    peer.display_cache.record_sent_rows(7, [&later], 0.0, 10.0);
    assert!(peer.display_cache.sent_datagrams.is_empty());
    crate::display::recv::advance_acked_rows_from_ack(
        &mut peer,
        &crate::display::recv::DisplayAck::dense(1, 7),
        &[2],
    );
    assert_eq!(peer.display_cache.acked_row_graphics[0], second.version());
    assert!(peer.display_cache.sent_row_confirmed[0]);
    peer.display_cache.reset_for_snapshot();
    assert_eq!(peer.display_cache.acked_row_graphics[0], None);
    assert_eq!(peer.display_cache.sent_row_graphics[0], None);

    row.sent.graphics = PreparedGraphics::EMPTY;
    (row.encoded_size, row.encoding, row.content, row.span) = encoded_row_size(
        &row.request,
        &cells,
        &cells,
        first.version(),
        &row.sent.graphics,
    );
    encode_captured_rows(header, [&row].into_iter(), &mut frame);
    let deleted = merkur_codec::iter_rows(&frame).next().unwrap().unwrap();
    assert_eq!((deleted.left, deleted.right), (0, 0));
    assert!(deleted.graphics.is_empty());
}

#[test]
fn last_readiness_withdrawal_fences_running_dictionary_prepare() {
    let mut worker = idle_prepare_worker_for_test();
    worker.dictionary_in_flight = Some(21);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_dictionary_ready = false;
    let peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);

    fence_dictionary_preparation_without_consumers(&mut worker, &peers);
    assert_eq!(worker.dictionary_in_flight, None);

    // The CPU worker is not cancellable, but its eventual stale token can
    // no longer republish a source after readiness is granted again.
    finish_dictionary_prepare(dictionary_completion_for_test(21), &mut worker);
    assert!(worker.dictionary_ready.is_none());
}

#[test]
fn last_readiness_withdrawal_clears_ready_dictionary_completion() {
    let mut worker = idle_prepare_worker_for_test();
    worker.dictionary_in_flight = Some(22);
    finish_dictionary_prepare(dictionary_completion_for_test(22), &mut worker);
    assert!(worker.dictionary_ready.is_some());

    let peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    let peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    fence_dictionary_preparation_without_consumers(&mut worker, &peers);

    assert!(worker.dictionary_ready.is_none());
}

#[test]
fn one_ready_peer_preserves_shared_dictionary_prepare() {
    let mut worker = idle_prepare_worker_for_test();
    worker.dictionary_in_flight = Some(23);
    let withdrawn = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    let mut ready_peer = PeerDisplayState::new("browser-2".into(), PeerTransport::Edge);
    ready_peer.authenticated = true;
    ready_peer.noise = Some(established_daemon_noise());
    ready_peer.display_dictionary_ready = true;
    let peers = HashMap::from([
        (withdrawn.peer_id.clone(), withdrawn),
        (ready_peer.peer_id.clone(), ready_peer),
    ]);

    fence_dictionary_preparation_without_consumers(&mut worker, &peers);
    assert_eq!(worker.dictionary_in_flight, Some(23));
    finish_dictionary_prepare(dictionary_completion_for_test(23), &mut worker);
    assert!(worker.dictionary_ready.is_some());
}

#[test]
fn fec_groups_split_only_critical_from_the_merged_noncritical_domain() {
    let prepared = vec![
        prepared_with_utility_for_test(1, 8, DisplayUtility::Critical),
        prepared_with_utility_for_test(2, 8, DisplayUtility::NonCritical),
        prepared_with_utility_for_test(3, 8, DisplayUtility::NonCritical),
        prepared_with_utility_for_test(4, 8, DisplayUtility::NonCritical),
        prepared_with_utility_for_test(5, 8, DisplayUtility::NonCritical),
    ];
    assert_eq!(
        fec_group_lengths(&prepared, DisplayPolicy::FEC_GROUP_MAX_SIZE),
        vec![1, 4]
    );
}

#[test]
fn adaptive_replanning_and_parity_precompute_share_exact_group_boundaries() {
    for count in [1usize, 2, 4, 5] {
        let packed = (0..count)
            .map(|_| {
                (
                    BatchPayload::plain(vec![0; 100], ContentClass::Text),
                    SentRows::default(),
                    1,
                    DisplayUtility::NonCritical,
                )
            })
            .collect::<Vec<_>>();
        let expected_open = match count {
            1 => 1,
            2 => 2,
            4 => 0,
            5 => 1,
            _ => unreachable!(),
        };
        assert_eq!(
            pending_packed_fec_group(
                &packed,
                DisplayUtility::NonCritical,
                DisplayPolicy::FEC_GROUP_MAX_SIZE,
            ),
            (expected_open, if expected_open == 0 { 0 } else { 100 }),
        );

        let mut prepared = (0..count)
            .map(|index| prepared_for_test(index as u32 + 1, 100))
            .collect::<Vec<_>>();
        let mut encoder = crate::display::fec::FecEncoder::new();
        let mut frames = frame_pool_for_test();
        precompute_fec_repairs(
            &mut prepared,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            7,
            &mut encoder,
            &mut frames,
        );
        let repair_indices = prepared
            .iter()
            .enumerate()
            .filter_map(|(index, datagram)| {
                datagram.precomputed_fec_repair.is_some().then_some(index)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            repair_indices,
            match count {
                1 => vec![],
                2 => vec![1],
                4 | 5 => vec![3],
                _ => unreachable!(),
            },
            "count={count}",
        );
    }
}

#[test]
fn recovery_shard_count_accounts_for_group_and_wire_width() {
    // The encoder no longer buffers a group and decides for itself how wide
    // its repair should be: both parity producers pass this count straight
    // through. Zero- and one-frame groups use no parity (the latter is
    // replicated as exact sealed bytes), while an ordinary small group gets
    // two recovery shards.
    assert_eq!(fec_recovery_shard_count(0, 64), 0);
    assert_eq!(fec_recovery_shard_count(1, 64), 0);
    for group_len in 2..=DisplayPolicy::FEC_GROUP_MAX_SIZE {
        assert_eq!(
            fec_recovery_shard_count(group_len, 542),
            DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            "16 + 2*542 is the exact m=2 boundary"
        );
        assert_eq!(
            fec_recovery_shard_count(group_len, 543),
            DisplayPolicy::FEC_SINGLE_RECOVERY_SHARD_COUNT,
            "16 + 2*543 is one byte too wide"
        );
        assert_eq!(
            fec_recovery_shard_count(group_len, 1084),
            DisplayPolicy::FEC_SINGLE_RECOVERY_SHARD_COUNT,
            "16 + 1084 is the exact m=1 boundary"
        );
        assert_eq!(
            fec_recovery_shard_count(group_len, 1085),
            0,
            "16 + 1085 cannot ride a display datagram"
        );
    }
    const {
        assert!(DisplayPolicy::FEC_GROUP_MAX_SIZE <= merkur_fec::FEC_MAX_DATA);
    }
}

#[test]
fn selected_repair_width_produces_the_exact_plaintext_wire_size() {
    let mut encoder = crate::display::fec::FecEncoder::new();
    for (shard_size, recovery_shards, repair_len) in [
        (542usize, 2usize, 1100usize),
        (543, 1, 559),
        (1084, 1, 1100),
    ] {
        assert_eq!(fec_recovery_shard_count(2, shard_size), recovery_shards);
        let left = vec![0xA1; shard_size];
        let right = vec![0xB2; shard_size];
        let repair = encoder
            .encode_borrowed_group(1, 7, &[&left, &right], recovery_shards)
            .expect("selected repair encodes");
        assert_eq!(repair.len(), repair_len);
        assert!(repair.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES);
    }
    assert_eq!(fec_recovery_shard_count(2, 1085), 0);
}

fn build_large_interactive_row_for_test(
    transport: PeerTransport,
    critical: bool,
) -> PreparedDisplayDatagram {
    // Sized so one unstyled row still exceeds `DATAGRAM_MAX_PAYLOAD_BYTES`.
    // A default-colored cell costs two bytes (tag + varint codepoint), so
    // the row needs more than ~550 occupied columns to cross the cap.
    const COLS: u16 = 700;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, 4, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), transport);
    peer.display_cache.resize(COLS, 4);
    peer.last_input_at_ms = 100.0;
    let line = (0..690)
        .map(|index| b'a' + (index % 26) as u8)
        .collect::<Vec<_>>();

    let row = if critical {
        terminal.apply_bytes(&line);
        0
    } else {
        terminal.apply_bytes(b"\x1b[2;1H");
        terminal.apply_bytes(&line);
        terminal.apply_bytes(b"\x1b[1;1H");
        peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
        1
    };
    let mut selected_rows = vec![DisplayRowRequest::literal(row, false)];
    let mut compressor = Compressor::new();
    let mut row_capture_scratch = RowCaptureScratch::default();
    let mut flush_row_cache = HashMap::new();
    let mut prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        9,
        100.0,
        &mut compressor,
        &mut row_capture_scratch,
        &mut flush_row_cache,
    );
    assert_eq!(prepared.len(), 1);
    prepared.pop().unwrap()
}

#[test]
fn relayed_large_interactive_critical_row_is_compressed_into_a_datagram() {
    let prepared = build_large_interactive_row_for_test(PeerTransport::Edge, true);

    assert!(
        prepared.raw_bytes > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
        "raw_bytes={}",
        prepared.raw_bytes
    );
    assert!(prepared.frame.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES);
    assert_ne!(
        prepared.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
            & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
        0
    );
    assert!(uses_display_datagram(&prepared));
}

#[test]
fn direct_critical_and_relayed_noncritical_interactive_rows_stay_uncompressed() {
    for prepared in [
        build_large_interactive_row_for_test(PeerTransport::WebTransport, true),
        build_large_interactive_row_for_test(PeerTransport::Edge, false),
    ] {
        assert!(
            prepared.raw_bytes > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
            "raw_bytes={}",
            prepared.raw_bytes
        );
        assert_eq!(prepared.frame.len(), prepared.raw_bytes);
        assert_eq!(
            prepared.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
                & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
            0
        );
        assert!(!uses_display_datagram(&prepared));
    }
}

#[test]
fn cold_interactive_origin_tui_redraw_bootstraps_cross_row_compression() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    const REDRAW_ROWS: u16 = 24;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(COLS, ROWS);
    // The redraw answers a just-received input. That fact must keep a truly
    // small echo out of zstd without making each packet-sized slice of this
    // full presentation masquerade as a small echo too.
    peer.last_input_at_ms = 100.0;
    peer.latest_input_seq = 3;

    let fill = "TUI-CELL-".repeat(10);
    for row in 0..REDRAW_ROWS {
        let red = row.wrapping_mul(37) as u8;
        let green = row.wrapping_mul(67) as u8;
        let blue = row.wrapping_mul(97) as u8;
        terminal.apply_bytes(
            format!(
                "\x1b[{};1H\x1b[38;2;{red};{green};{blue}m\x1b[48;2;{blue};{red};{green}mTUI-{row:02}-{fill}\x1b[0m",
                row + 1,
            )
            .as_bytes(),
        );
    }

    let mut selected_rows = (0..REDRAW_ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect::<Vec<_>>();
    let mut compressor = Compressor::new();
    let mut capture = RowCaptureScratch::default();
    let mut cache = HashMap::new();
    let prepared = build_datagram_batches(
        &mut terminal,
        &mut peer,
        &mut selected_rows,
        3,
        100.0,
        &mut compressor,
        &mut capture,
        &mut cache,
    );

    assert_eq!(
        prepared
            .iter()
            .map(|datagram| usize::from(datagram.encoded_rows))
            .sum::<usize>(),
        usize::from(REDRAW_ROWS),
    );
    eprintln!(
        "cold TUI batches: {:?}",
        prepared
            .iter()
            .map(|datagram| (
                datagram.encoded_rows,
                datagram.raw_bytes,
                datagram.frame.len()
            ))
            .collect::<Vec<_>>()
    );
    assert!(
        prepared.len() <= 8,
        "a cold redraw must fit one ordinary initial QUIC flight, got {} data datagrams",
        prepared.len(),
    );
    assert!(prepared.iter().any(|datagram| {
        datagram.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
            & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
            != 0
    }));
    assert!(
        compressor.display_frame_compression_attempts() > 0,
        "the cold logical redraw must exercise the planner's compression path"
    );
    assert!(prepared.iter().all(|datagram| {
        datagram.frame.len() <= DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES
    }));
}

fn heterogeneous_prepare_row(row: u16, compressible: bool) -> DisplayPrepareRow {
    let baseline: Arc<[CellRepr]> = vec![CellRepr::BLANK; 120].into();
    let mut state = u32::from(row).wrapping_add(1).wrapping_mul(0x9E37_79B9);
    let cells: Arc<[CellRepr]> = (0..120u32)
        .map(|column| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            if compressible {
                CellRepr {
                    codepoint: u32::from(b'!') + column % 90,
                    ..CellRepr::BLANK
                }
            } else {
                CellRepr {
                    codepoint: u32::from(b'!') + (state % 90),
                    fg: state.to_be_bytes()[1..4].try_into().unwrap(),
                    bg: state.rotate_left(13).to_be_bytes()[1..4]
                        .try_into()
                        .unwrap(),
                    attrs: merkur_codec::CellAttrs::NONE
                        .with(merkur_codec::CellAttrs::BOLD, state & 1 != 0)
                        .with(merkur_codec::CellAttrs::ITALIC, state & 2 != 0)
                        .with(merkur_codec::CellAttrs::UNDERLINE, state & 4 != 0),
                    ..CellRepr::BLANK
                }
            }
        })
        .collect::<Vec<_>>()
        .into();
    let request = DisplayRowRequest::literal(row, true);
    let (encoded_size, encoding, content, span) = encoded_row_size(
        &request,
        &baseline,
        &cells,
        None,
        &merkur_codec::PreparedGraphics::EMPTY,
    );
    DisplayPrepareRow {
        request,
        sent: CapturedRow {
            graphics: merkur_codec::PreparedGraphics::EMPTY,
            row,
            hash: merkur_codec::row_hash(&cells),
            cells,
        },
        baseline,
        baseline_revision: 0,
        utility: DisplayUtility::NonCritical,
        encoded_size,
        encoding,
        content,
        span,
    }
}

fn pack_heterogeneous_order(compressible_prefix: bool) -> (usize, usize, Vec<(u16, usize, usize)>) {
    const ROWS: u16 = 8;
    let rows = (0..ROWS)
        .map(|row| {
            let compressible = if compressible_prefix {
                row < 4
            } else {
                row >= 4
            };
            heterogeneous_prepare_row(row, compressible)
        })
        .collect::<Vec<_>>();
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let terminal = TerminalState::new(120, ROWS, event_tx);
    let policy = compression_policy_for_test(ROWS, false, ExecutionLane::Bulk);
    let mut compressor = Compressor::new();
    let mut scratch = PrepareScratch::default();
    // Test packet choices against an exact CPU cost, independently of runner contention.
    scratch.planner.sender_service_us_for_test = Some(20.0);
    let mut frames = BufferPool::new(DISPLAY_FRAME_POOL_DEPTH);
    pack_captured_rows(
        &rows,
        terminal.current_display_header(merkur_codec::FrameKind::Delta),
        &policy,
        None,
        false,
        &mut compressor,
        &mut scratch,
        &mut frames,
    );
    let attempts = compressor.display_frame_compression_attempts();
    let raw_bytes = scratch
        .batches
        .iter()
        .map(|(payload, _, _, _)| payload.raw_bytes)
        .sum();
    let partition = scratch
        .batches
        .iter()
        .map(|(payload, _, rows, _)| (*rows, payload.raw_bytes, payload.len()))
        .collect();
    (attempts, raw_bytes, partition)
}

#[test]
fn heterogeneous_ratio_feedback_is_bounded_in_both_row_orders() {
    let (prefix_attempts, prefix_raw_bytes, prefix_partition) = pack_heterogeneous_order(true);
    let (tail_attempts, tail_raw_bytes, tail_partition) = pack_heterogeneous_order(false);
    eprintln!(
        "heterogeneous planner: compressible-prefix attempts={prefix_attempts} raw={prefix_raw_bytes} partition={prefix_partition:?}; random-prefix attempts={tail_attempts} raw={tail_raw_bytes} partition={tail_partition:?}"
    );
    assert_eq!((prefix_attempts, tail_attempts), (4, 4));
    let encoded_fixture_bytes = 4_872 + 5 * (STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    assert_eq!(
        (prefix_raw_bytes, tail_raw_bytes),
        (encoded_fixture_bytes, encoded_fixture_bytes)
    );
    assert_eq!(
        prefix_partition
            .iter()
            .map(|(rows, _, _)| *rows)
            .collect::<Vec<_>>(),
        vec![4, 1, 1, 1, 1],
    );
    assert_eq!(
        tail_partition
            .iter()
            .map(|(rows, _, _)| *rows)
            .collect::<Vec<_>>(),
        vec![1, 1, 1, 1, 4],
    );
    assert!(prefix_partition[0].2 < prefix_partition[0].1);
    assert!(tail_partition[4].2 < tail_partition[4].1);

    for (attempts, raw_bytes, partition) in [
        (prefix_attempts, prefix_raw_bytes, &prefix_partition),
        (tail_attempts, tail_raw_bytes, &tail_partition),
    ] {
        assert!(
            attempts > 0,
            "the fixture must exercise measured compression"
        );
        assert!(
            attempts <= partition.len() + 1,
            "one heterogeneous boundary may cost one correction, never recursive re-encoding"
        );
        assert_eq!(
            partition
                .iter()
                .map(|(rows, _, _)| usize::from(*rows))
                .sum::<usize>(),
            8,
        );
        assert_eq!(
            partition.iter().map(|(_, raw, _)| raw).sum::<usize>(),
            raw_bytes,
        );
        assert!(
            partition.iter().all(|(_, _, wire)| {
                *wire <= DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES
            })
        );
    }
    assert_ne!(
        prefix_partition, tail_partition,
        "reversing heterogeneous evidence must be measured, not assumed monotone"
    );
}

/// The cohort a selection produced, as owned strings for assertions.
fn selected_ids(cursor: &DisplayFlushCursor) -> Vec<String> {
    cursor.selected.iter().map(|id| id.to_string()).collect()
}

#[test]
fn global_peer_budget_rotates_and_marks_deferred_damage() {
    let mut peers = PeerMap::new();
    for index in 0..DISPLAY_PEERS_PER_FLUSH + 3 {
        let peer_id = format!("browser-{index:02}");
        let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(established_daemon_noise());
        peer.needs_snapshot = false;
        peer.display_cache.initialized = true;
        peers.insert(Arc::clone(&peer.peer_id), peer);
    }
    let mut cursor = DisplayFlushCursor::default();

    take_display_peer_batch(&mut peers, true, 0, &[], &mut cursor, 0.0);
    let first = selected_ids(&cursor);
    assert_eq!(first.len(), DISPLAY_PEERS_PER_FLUSH);
    assert!(cursor.has_deferred_peers(&peers, 0, &[], 0.0));
    assert_eq!(
        first,
        (0..DISPLAY_PEERS_PER_FLUSH)
            .map(|index| format!("browser-{index:02}"))
            .collect::<Vec<_>>()
    );
    let deferred: Vec<String> = peers
        .iter()
        .filter(|(_, peer)| peer.needs_full_diff)
        .map(|(peer_id, _)| peer_id.to_string())
        .collect();
    assert_eq!(deferred.len(), 3);

    // Terminal dirt was cleared by the first flush. Only the explicitly
    // marked deferred peers remain eligible, and they run next rather than
    // being stranded behind the HashMap's iteration order.
    take_display_peer_batch(&mut peers, false, 0, &[], &mut cursor, 0.0);
    let mut second = selected_ids(&cursor);
    second.sort_unstable();
    let mut deferred = deferred;
    deferred.sort_unstable();
    assert_eq!(second, deferred);
    assert!(!cursor.has_deferred_peers(&peers, 0, &[], 0.0));
}

#[test]
fn elapsed_turn_budget_requeues_remaining_peers_in_wire_order() {
    let mut peers = HashMap::new();
    for peer_id in ["browser-a", "browser-b", "browser-c"] {
        let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
        peer.needs_snapshot = false;
        peers.insert(peer_id.into(), peer);
    }
    let mut cursor = DisplayFlushCursor {
        selected: ["browser-a", "browser-b", "browser-c"]
            .into_iter()
            .map(Arc::from)
            .collect(),
        ..DisplayFlushCursor::default()
    };
    defer_display_peers(&mut peers, &mut cursor, 0);

    assert!(cursor.selected.is_empty());
    assert_eq!(
        cursor
            .deferred_peer_ids
            .iter()
            .map(|id| &**id)
            .collect::<Vec<_>>(),
        ["browser-a", "browser-b", "browser-c"],
    );
    assert!(peers.values().all(|peer| peer.needs_full_diff));
}

#[test]
fn one_snapshot_always_yields_before_another_peer() {
    assert!(!display_owner_should_defer(
        0,
        0,
        DISPLAY_OWNER_TURN_BUDGET_MS
    ));
    assert!(display_owner_should_defer(1, 1, 0.0));
    assert!(display_owner_should_defer(
        1,
        0,
        DISPLAY_OWNER_TURN_BUDGET_MS
    ));
    assert!(!display_owner_should_defer(
        1,
        0,
        DISPLAY_OWNER_TURN_BUDGET_MS - f64::EPSILON
    ));
}

#[test]
fn snapshot_fanout_uses_the_same_bounded_peer_cohort() {
    let mut peers = PeerMap::new();
    for index in 0..DISPLAY_PEERS_PER_FLUSH + 3 {
        let peer_id = format!("browser-{index:02}");
        let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(established_daemon_noise());
        peers.insert(Arc::clone(&peer.peer_id), peer);
    }
    let mut cursor = DisplayFlushCursor::default();

    take_display_peer_batch(&mut peers, false, 0, &[], &mut cursor, 0.0);
    let first = selected_ids(&cursor);
    assert_eq!(first.len(), DISPLAY_PEERS_PER_FLUSH);
    assert!(cursor.has_deferred_peers(&peers, 0, &[], 0.0));

    take_display_peer_batch(&mut peers, false, 0, &[], &mut cursor, 0.0);
    let second = selected_ids(&cursor);
    assert_eq!(second.len(), 3);
    assert!(!cursor.has_deferred_peers(&peers, 0, &[], 0.0));

    let mut selected = first;
    selected.extend(second);
    selected.sort_unstable();
    assert_eq!(
        selected,
        (0..DISPLAY_PEERS_PER_FLUSH + 3)
            .map(|index| format!("browser-{index:02}"))
            .collect::<Vec<_>>()
    );
}

/// Three viewers and a cursor rotating through them: once the cursor's
/// scratch is warm, selecting a cohort allocates nothing at all. Every id
/// the selection holds is a refcount bump on the map's own key.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn take_display_peer_batch_allocates_nothing() {
    use crate::edge_tunnel::test_allocations;
    const ROUNDS: usize = 1_000;
    const PEER_IDS: [&str; 3] = ["browser-a", "browser-b", "browser-c"];

    let mut peers = PeerMap::new();
    for peer_id in PEER_IDS {
        let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
        peer.authenticated = true;
        peer.noise = Some(established_daemon_noise());
        peer.needs_snapshot = false;
        peer.display_cache.initialized = true;
        peers.insert(Arc::clone(&peer.peer_id), peer);
    }
    let mut cursor = DisplayFlushCursor::default();

    // Warm-up: the first damaged round grows the retained scratch to its
    // steady size, and establishes the cursor the rounds below rotate.
    let expected = PEER_IDS.map(str::to_string);
    take_display_peer_batch(&mut peers, true, 0, &[], &mut cursor, 0.0);
    assert_eq!(selected_ids(&cursor), expected);
    let eligible_capacity = cursor.eligible.capacity();
    let selected_capacity = cursor.selected.capacity();

    test_allocations::begin();
    for _ in 0..ROUNDS {
        take_display_peer_batch(&mut peers, true, 0, &[], &mut cursor, 0.0);
        std::hint::black_box(&cursor.selected);
        // Compared by iterator: collecting the ids would be this test's
        // own allocation inside the measured region.
        assert!(
            cursor.selected.iter().map(|id| &**id).eq(PEER_IDS),
            "every damaged flush serves the exact sorted cohort"
        );
    }
    let tally = test_allocations::end();
    eprintln!(
        "three-peer cohort, {ROUNDS} rounds: {} allocations, {} bytes",
        tally.allocations, tally.allocated_bytes
    );
    assert_eq!(
        tally.allocations, 0,
        "selecting a display cohort must not allocate once the cursor scratch is warm"
    );
    assert_eq!(tally.allocated_bytes, 0);
    assert_eq!(
        cursor.eligible.capacity(),
        eligible_capacity,
        "scratch must not regrow"
    );
    assert_eq!(
        cursor.selected.capacity(),
        selected_capacity,
        "scratch must not regrow"
    );
    // Every id the selection holds is shared with the map's key and the
    // peer's own `peer_id` field — three holders, plus the cursor's
    // round-robin anchor on the last one — never a copy.
    for (index, peer_id) in cursor.selected.iter().enumerate() {
        let anchored = usize::from(index + 1 == cursor.selected.len());
        assert_eq!(
            Arc::strong_count(peer_id),
            3 + anchored,
            "the id is shared, not copied"
        );
    }
}

#[test]
fn snapshot_chunk_carries_peer_authoritative_input_provenance() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(2, 1, event_tx);
    let (snapshot, encoded_rows) = terminal.encode_snapshot_into(Vec::new());
    assert_eq!(encoded_rows, 1);

    for (peer_id, expected_input_seq) in [("browser-1", 37), ("browser-2", 91), ("new-browser", 0)]
    {
        // A 2x1 grid is far below the compression threshold, so this frame
        // stays uncompressed and its header is directly inspectable.
        let mut frame = snapshot.clone();
        patch_stream_header(
            &mut frame,
            0,
            7,
            expected_input_seq,
            41,
            41,
            false,
            true,
            0,
            1,
            0,
            0,
        )
        .unwrap();
        let header = merkur_codec::parse_frame_header(&frame).unwrap();
        assert_eq!(header.kind, merkur_codec::FrameKind::Snapshot);
        assert_eq!(header.frame_id, 41);
        assert_eq!(header.presentation_id, 41);
        assert!(!header.presentation_coherent);
        assert!(header.presentation_end);
        assert_eq!(u32::from_be_bytes(frame[10..14].try_into().unwrap()), 7);
        assert_eq!(
            u32::from_be_bytes(frame[14..18].try_into().unwrap()),
            expected_input_seq,
            "snapshot input provenance for {peer_id}"
        );
    }
}

fn prepared_snapshot_for_test(
    token: u64,
    terminal: &mut TerminalState,
    peers: &[&PeerDisplayState],
) -> SnapshotPrepareCompletion {
    let mut snapshot_grid = Vec::new();
    let mut snapshot_graphics = Vec::new();
    let mut row_hashes = Vec::new();
    let (snapshot, _) = terminal.encode_snapshot_state_into(
        Vec::new(),
        &mut snapshot_grid,
        &mut row_hashes,
        &mut snapshot_graphics,
    );
    let content_class = classify_snapshot_content(&snapshot_grid);
    let plans = peers
        .iter()
        .map(|peer| SnapshotPeerPlan {
            peer_id: Arc::clone(&peer.peer_id),
            prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
            prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
            profile: peer
                .display_planning
                .snapshot(content_class, DictionaryClass::Plain),
            context: PlanningContext {
                fec_enabled: false,
                ..PlanningContext::default()
            },
        })
        .collect();
    prepare_snapshot_off_loop(
        SnapshotPrepareRequest {
            token,
            submitted_at: Instant::now(),
            display_revision: terminal.display_revision(),
            completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
            cols: terminal.cols,
            rows: terminal.rows,
            header_signal: terminal.current_display_header_signal(),
            content_class,
            snapshot,
            snapshot_grid,
            snapshot_graphics,
            row_hashes,
            peers: plans,
        },
        &mut Compressor::new(),
        &mut GlobalDisplayPlanningModel::default(),
    )
}

#[test]
fn snapshot_content_policy_is_derived_from_the_captured_grid() {
    let mut cells = vec![CellRepr::BLANK; 100];
    assert_eq!(classify_snapshot_content(&cells), ContentClass::Sparse);
    for cell in &mut cells {
        cell.codepoint = u32::from(b'x');
    }
    assert_eq!(classify_snapshot_content(&cells), ContentClass::Text);
    for cell in &mut cells {
        cell.fg = [0x12, 0x34, 0x56];
    }
    assert_eq!(classify_snapshot_content(&cells), ContentClass::Color);
}

#[tokio::test]
async fn stale_snapshot_completion_consumes_no_peer_identity_or_carrier_bytes() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 2, event_tx);
    terminal.apply_bytes(b"\x1b[?2026hsnapshot\x1b[?2026l");
    assert!(terminal.completed_sync_update_epoch() > 0);
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_prepare_in_flight = Some(71);
    peer.row_presentation_head = 91;
    peer.unresolved_presentation_rows = [2, 0, 0, 0];
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let completion = prepared_snapshot_for_test(71, &mut terminal, &[&peer]);
    let generation = peer.generation;
    let next_seq = peer.next_datagram_seq;
    let next_frame_id = peer.next_frame_id;
    let peer_id = Arc::clone(&peer.peer_id);
    let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);

    finish_snapshot_prepare(
        completion,
        terminal.display_revision() + 1,
        &mut BufferPool::new(4),
        &mut peers,
        100.0,
    )
    .await;

    let peer = &peers[&peer_id];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert!(peer.needs_snapshot);
    assert_eq!(peer.snapshot_retry_at_ms, 0.0);
    assert_eq!(peer.generation, generation);
    assert_eq!(peer.next_datagram_seq, next_seq);
    assert_eq!(peer.next_frame_id, next_frame_id);
    assert_eq!(peer.last_admitted_sync_epoch, 0);
    assert_eq!(peer.row_presentation_head, 91);
    assert_eq!(peer.unresolved_presentation_rows, [2, 0, 0, 0]);
    assert!(capture_rx.try_recv().is_err());
}

#[tokio::test]
async fn reliable_snapshot_chunks_share_one_positive_identity_per_peer() {
    const COLS: u16 = 240;
    const ROWS: u16 = 120;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let line = "snapshot-wide-cell".repeat(20);
    terminal.apply_bytes(b"\x1b[?2026h");
    for row in 0..ROWS {
        terminal.apply_bytes(
            format!(
                "\x1b[{};1H\x1b[38;2;{};{};{}m{}",
                row + 1,
                row.wrapping_mul(17) as u8,
                row.wrapping_mul(29) as u8,
                row.wrapping_mul(43) as u8,
                &line[..usize::from(COLS)],
            )
            .as_bytes(),
        );
    }
    terminal.apply_bytes(b"\x1b[?2026l");
    let sync_epoch = terminal.completed_sync_update_epoch();
    assert!(sync_epoch > 0);

    let (mut first, mut first_browser) = benchmark_noise_pair();
    first.peer_id = Arc::from("snapshot-first");
    first.display_prepare_in_flight = Some(73);
    first.row_presentation_head = 91;
    first.unresolved_presentation_rows = [2, 0, 0, 0];
    let (first_tx, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
    first.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        first_tx,
    )));
    let (mut second, mut second_browser) = benchmark_noise_pair();
    second.peer_id = Arc::from("snapshot-second");
    second.display_prepare_in_flight = Some(73);
    second.row_presentation_head = 92;
    second.unresolved_presentation_rows = [4, 0, 0, 0];
    let (second_tx, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
    second.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        second_tx,
    )));
    let completion = prepared_snapshot_for_test(73, &mut terminal, &[&first, &second]);
    assert!(
        completion.raw_chunks.len() > 1,
        "fixture must exercise reliable multi-chunk assembly"
    );
    let expected_chunks = completion.raw_chunks.len();
    let mut peers = PeerMap::from([
        (Arc::clone(&first.peer_id), first),
        (Arc::clone(&second.peer_id), second),
    ]);

    finish_snapshot_prepare(
        completion,
        terminal.display_revision(),
        &mut BufferPool::new(4),
        &mut peers,
        100.0,
    )
    .await;

    for (peer_id, receiver, browser) in [
        ("snapshot-first", &mut first_rx, &mut first_browser),
        ("snapshot-second", &mut second_rx, &mut second_browser),
    ] {
        let mut headers = Vec::new();
        while let Ok((channel, sealed)) = receiver.try_recv() {
            assert_eq!(channel, CHANNEL_DISPLAY_COMMIT);
            let plain = browser
                .open_stream(crate::e2e::lane_for_channel(channel).unwrap(), &sealed)
                .expect("snapshot chunk must authenticate for its peer");
            assert_eq!(
                merkur_codec::parse_stream_header(&plain)
                    .expect("snapshot stream header")
                    .seq,
                0,
                "reliable snapshot chunks stay outside selective delta sequence space",
            );
            headers.push(merkur_codec::parse_frame_header(&plain).unwrap());
        }
        assert_eq!(headers.len(), expected_chunks, "{peer_id} chunk count");
        let identity = headers[0].frame_id;
        assert_ne!(identity, 0, "zero is reserved for no provenance");
        assert!(headers.iter().enumerate().all(|(index, header)| {
            header.kind == merkur_codec::FrameKind::Snapshot
                && header.frame_id == identity
                && header.presentation_id == identity
                && header.row_predecessor_presentation_id == 0
                && header.chunk_index as usize == index
                && header.chunk_count as usize == expected_chunks
                && !header.presentation_coherent
                && header.presentation_end
        }));
        assert!(!peers[peer_id].needs_snapshot);
        assert_eq!(peers[peer_id].last_admitted_sync_epoch, sync_epoch);
        assert_eq!(peers[peer_id].row_presentation_head, 0);
        assert_eq!(peers[peer_id].unresolved_presentation_rows, [0; 4]);
    }
}

#[tokio::test]
async fn synchronized_update_snapshot_epoch_requires_every_reliable_chunk() {
    for accepted_limit in [0, 1, usize::MAX] {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(384, 256, event_tx);
        terminal.apply_bytes(b"\x1b[?2026h");
        terminal.apply_bytes(&terminal_fixture(384, 256, b's'));
        terminal.apply_bytes(b"\x1b[?2026l");
        let epoch = terminal.completed_sync_update_epoch();
        assert!(epoch > 0);
        let (mut peer, _browser) = benchmark_noise_pair();
        peer.display_prepare_in_flight = Some(401);
        peer.row_presentation_head = 91;
        peer.unresolved_presentation_rows = [2, 0, 0, 0];
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(
            crate::edge_tunnel::EdgeTunnel::new_capture_with_reliable_limit(tx, accepted_limit),
        ));
        let completion = prepared_snapshot_for_test(401, &mut terminal, &[&peer]);
        let chunk_count = completion.raw_chunks.len();
        assert!(chunk_count > 1);
        let peer_id = Arc::clone(&peer.peer_id);
        let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
        let mut pool = frame_pool_for_test();
        finish_snapshot_prepare(
            completion,
            terminal.display_revision(),
            &mut pool,
            &mut peers,
            100.0,
        )
        .await;
        let mut admitted = 0;
        while let Ok((channel, bytes)) = rx.try_recv() {
            assert_eq!(channel, CHANNEL_DISPLAY_COMMIT);
            assert!(!bytes.is_empty());
            admitted += 1;
        }
        assert_eq!(admitted, accepted_limit.min(chunk_count));
        let peer = &peers[&peer_id];
        assert_eq!(
            peer.row_presentation_head, 0,
            "snapshot generation roots lineage even when its reliable write must retry"
        );
        assert_eq!(peer.unresolved_presentation_rows, [0; 4]);
        if accepted_limit >= chunk_count {
            assert_eq!(peer.last_admitted_sync_epoch, epoch);
            assert!(!peer.needs_snapshot);
            continue;
        }
        assert_eq!(peer.last_admitted_sync_epoch, 0);
        assert!(peer.needs_snapshot);
        let retry_at = peer.snapshot_retry_at_ms;
        assert!(retry_at > 100.0);
        assert_eq!(
            peer_next_flush_delay_ms(
                peer,
                terminal.pending_display_damage(),
                terminal.current_display_header_signal(),
                &[],
                100.0,
            ),
            Some((retry_at - 100.0).ceil() as u64),
            "an ESU cannot waive an actual failed snapshot's backoff"
        );
        let peer = peers.get_mut(&peer_id).unwrap();
        peer.display_prepare_in_flight = Some(402);
        let (tx, mut retry_rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        let retry = prepared_snapshot_for_test(402, &mut terminal, &[peer]);
        finish_snapshot_prepare(
            retry,
            terminal.display_revision(),
            &mut pool,
            &mut peers,
            retry_at,
        )
        .await;
        assert_eq!(peers[&peer_id].last_admitted_sync_epoch, epoch);
        assert!(!peers[&peer_id].needs_snapshot);
        assert_eq!(peers[&peer_id].snapshot_retry_at_ms, 0.0);
        let mut retry_chunks = 0;
        while retry_rx.try_recv().is_ok() {
            retry_chunks += 1;
        }
        assert_eq!(retry_chunks, chunk_count);
    }
}

fn established_noise_pair() -> (crate::e2e::NoiseTransport, crate::e2e::NoiseTransport) {
    let psk = [7u8; 32];
    let prologue = crate::e2e::derive_prologue("session", "daemon", &[0x42; 64]);
    let (browser_static, _) = crate::e2e::generate_static_keypair().unwrap();
    let (daemon_static, _) = crate::e2e::generate_static_keypair().unwrap();
    let mut browser =
        crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue).unwrap();
    let mut daemon =
        crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    browser
        .read_message(&daemon.write_message(b"").unwrap())
        .unwrap();
    daemon
        .read_message(&browser.write_message(b"").unwrap())
        .unwrap();
    (
        daemon.into_transport().unwrap(),
        browser.into_transport().unwrap(),
    )
}

fn established_daemon_noise() -> crate::e2e::NoiseTransport {
    established_noise_pair().0
}

#[test]
fn pre_e2e_snapshot_is_dormant_even_with_an_unrelated_ready_peer() {
    let mut ready = PeerDisplayState::new("ready".into(), PeerTransport::Edge);
    ready.authenticated = true;
    ready.noise = Some(established_daemon_noise());
    ready.needs_snapshot = false;

    let mut awaiting_noise = PeerDisplayState::new("awaiting-noise".into(), PeerTransport::Edge);
    awaiting_noise.authenticated = true;
    assert!(awaiting_noise.needs_snapshot);

    let mut peers = PeerMap::from([
        (Arc::clone(&ready.peer_id), ready),
        (Arc::clone(&awaiting_noise.peer_id), awaiting_noise),
    ]);
    assert!(has_active_display_peers(&peers));
    assert!(
        !has_runnable_display_work(&peers, false, 0, &[], 0.0),
        "pre-E2E snapshot state must not rearm the display timer"
    );
    let mut cursor = DisplayFlushCursor::default();
    take_display_peer_batch(&mut peers, true, 0, &[], &mut cursor, 0.0);
    assert_eq!(
        selected_ids(&cursor),
        ["ready"],
        "terminal dirt must not pull a pre-E2E peer into the flush cohort"
    );

    peers.get_mut("awaiting-noise").unwrap().noise = Some(established_daemon_noise());
    assert!(
        has_runnable_display_work(&peers, false, 0, &[], 0.0),
        "Noise readiness turns the already-armed snapshot into runnable work"
    );
}

#[test]
fn pre_e2e_peer_cannot_defeat_a_ready_snapshot_backoff() {
    let mut ready = PeerDisplayState::new("ready".into(), PeerTransport::Edge);
    ready.authenticated = true;
    ready.noise = Some(established_daemon_noise());
    ready.snapshot_retry_at_ms = 500.0;

    let mut awaiting_noise = PeerDisplayState::new("awaiting-noise".into(), PeerTransport::Edge);
    awaiting_noise.authenticated = true;
    let mut idle = PeerDisplayState::new("idle".into(), PeerTransport::Edge);
    idle.authenticated = true;
    idle.noise = Some(established_daemon_noise());
    idle.needs_snapshot = false;
    let peers = PeerMap::from([
        (Arc::clone(&ready.peer_id), ready),
        (Arc::clone(&awaiting_noise.peer_id), awaiting_noise),
        (Arc::clone(&idle.peer_id), idle),
    ]);

    assert_eq!(
        compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0,),
        Some(300),
        "only runnable E2E-ready peers participate in timer deadline selection"
    );
}

#[test]
fn resume_safety_deadline_is_scheduled_without_becoming_runnable() {
    let mut waiting = PeerDisplayState::new("waiting".into(), PeerTransport::Edge);
    waiting.authenticated = true;
    waiting.noise = Some(established_daemon_noise());
    waiting.needs_snapshot = false;
    waiting.awaiting_resume_until_ms = Some(500.0);

    let mut ready = PeerDisplayState::new("ready".into(), PeerTransport::Edge);
    ready.authenticated = true;
    ready.noise = Some(established_daemon_noise());
    ready.needs_snapshot = false;

    let mut peers = PeerMap::from([
        (Arc::clone(&waiting.peer_id), waiting),
        (Arc::clone(&ready.peer_id), ready),
    ]);
    assert!(
        !has_runnable_display_work(&peers, false, 0, &[], 0.0),
        "the closed resume gate has no immediate display work"
    );
    assert!(
        compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0,).is_some(),
        "the timer still owns the future safety edge"
    );
    assert_eq!(
        compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0,),
        Some(300),
        "the resume deadline replaces cadence polling"
    );
    assert_eq!(
        compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 499.25,),
        Some(1),
        "fractional remaining time rounds up instead of firing early"
    );

    let mut cursor = DisplayFlushCursor::default();
    take_display_peer_batch(&mut peers, true, 0, &[], &mut cursor, 0.0);
    assert_eq!(
        selected_ids(&cursor),
        ["ready"],
        "unrelated terminal damage cannot bypass the resume gate"
    );
}

#[test]
fn expired_resume_gate_arms_once_and_preserves_snapshot_backoff() {
    let mut peer = PeerDisplayState::new("waiting".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.awaiting_resume_until_ms = Some(500.0);
    // Preserve any independently-owned retry deadline across the safety
    // transition; arming the fallback must never make a backed-off
    // snapshot immediately eligible.
    peer.snapshot_retry_at_ms = 750.0;
    let mut peers = PeerMap::from([("waiting".into(), peer)]);

    assert_eq!(arm_expired_resume_snapshots(&mut peers, 499.99), 0);
    assert_eq!(peers["waiting"].awaiting_resume_until_ms, Some(500.0));
    assert!(!peers["waiting"].needs_snapshot);

    assert_eq!(arm_expired_resume_snapshots(&mut peers, 500.0), 1);
    assert!(peers["waiting"].awaiting_resume_until_ms.is_none());
    assert!(peers["waiting"].needs_snapshot);
    assert_eq!(peers["waiting"].snapshot_retry_at_ms, 750.0);
    assert_eq!(
        arm_expired_resume_snapshots(&mut peers, 500.0),
        0,
        "consuming the deadline makes the transition one-shot"
    );
    assert!(has_runnable_display_work(&peers, false, 0, &[], 0.0));
    assert_eq!(
        compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 500.0,),
        Some(250),
        "ordinary snapshot backoff remains authoritative after arming"
    );
}

fn display_resume_message(peer_id: &str) -> PeerMessage {
    PeerMessage {
        input_permit: None,
        peer_node_id: Arc::from(peer_id),
        channel_id: CHANNEL_CTRL,
        payload: bytes::Bytes::new(),
        via_transport: PeerTransport::Edge,
        delivery: DeliveryMode::Stream,
        connection_id: 0,
        edge_ingress: None,
    }
}

fn display_resume_body(generation: u32, cols: u16, rows: u16) -> Vec<u8> {
    let mut body = Vec::with_capacity(16);
    body.extend_from_slice(&generation.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&1u32.to_be_bytes());
    body.extend_from_slice(&cols.to_be_bytes());
    body.extend_from_slice(&rows.to_be_bytes());
    body
}

/// A resume body carrying row hashes: the browser is stating it preserved
/// its grid, and therefore its dictionary slots too.
fn display_resume_body_with_hashes(
    generation: u32,
    cols: u16,
    rows: u16,
    hashes: &[u64],
) -> Vec<u8> {
    let mut body = display_resume_body(generation, cols, rows);
    body.push(crate::session::resume::DISPLAY_RESUME_HASHES_VERSION);
    body.push(0);
    body.extend_from_slice(&(hashes.len() as u16).to_be_bytes());
    for hash in hashes {
        body.extend_from_slice(&hash.to_be_bytes());
    }
    body
}

/// A carrier swap must not cost a dictionary re-install.
///
/// The browser keeps its dictionary exactly when it preserves its display,
/// and it publishes row hashes under exactly the same condition — so a claim
/// carrying hashes is the peer stating it still holds the dictionary the
/// daemon retained across `carrier_boundary`. Discarding here would force a
/// readiness/install/ack round trip and cold compression on precisely the
/// repair frames the user is waiting for.
#[test]
fn a_resume_claim_with_hashes_keeps_the_compression_dictionary() {
    let peer_id = "rebound";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.generation = 7;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.awaiting_resume_until_ms = Some(500.0);
    peer.display_dictionary_ready = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);

    crate::session::resume::handle_display_resume(
        &display_resume_message(peer_id),
        &display_resume_body_with_hashes(7, 2, 1, &[0, 0]),
        &mut peers,
        &[],
        &HashMap::new(),
    );

    assert!(
        peers[peer_id].display_dictionary_ready,
        "a peer that published row hashes still holds its dictionary"
    );
}

/// The converse, and the reason the retention above is safe: a claim with no
/// hashes is the peer stating it discarded the grid, so anything the daemon
/// still holds describes bytes that are gone.
#[test]
fn a_resume_claim_without_hashes_discards_the_compression_dictionary() {
    let peer_id = "reset";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.generation = 7;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    peer.awaiting_resume_until_ms = Some(500.0);
    peer.display_dictionary_ready = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);

    crate::session::resume::handle_display_resume(
        &display_resume_message(peer_id),
        &display_resume_body(7, 2, 1),
        &mut peers,
        &[],
        &HashMap::new(),
    );

    assert!(
        !peers[peer_id].display_dictionary_ready,
        "a peer that kept no grid cannot be compressed against"
    );
}

/// The claim never arrived, so the daemon cannot know what the peer kept and
/// must fail closed rather than compress against a guess.
#[test]
fn an_expired_resume_deadline_discards_the_compression_dictionary() {
    let peer_id = "timed-out";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.awaiting_resume_until_ms = Some(100.0);
    peer.display_dictionary_ready = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);

    assert_eq!(arm_expired_resume_snapshots(&mut peers, 200.0), 1);
    assert!(!peers[peer_id].display_dictionary_ready);
}

#[test]
fn rejected_display_resume_advances_an_already_armed_safety_deadline() {
    let peer_id = "waiting";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.awaiting_resume_until_ms = Some(500.0);
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);

    let old_delay = compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0);
    assert_eq!(old_delay, Some(300));
    crate::session::resume::handle_display_resume(
        &display_resume_message(peer_id),
        &display_resume_body(99, 80, 24),
        &mut peers,
        &[],
        &HashMap::new(),
    );

    assert!(peers[peer_id].awaiting_resume_until_ms.is_none());
    assert!(peers[peer_id].needs_snapshot);
    let new_delay = compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0);
    assert!(
        new_delay.is_some_and(|new_delay| new_delay < 300),
        "post-message scheduling must replace the old safety deadline: {new_delay:?}"
    );
}

#[test]
fn deadline_snapshot_wins_then_queued_old_resume_is_a_noop() {
    let peer_id = "waiting";
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.generation = 8;
    peer.needs_snapshot = false;
    peer.awaiting_resume_until_ms = None;
    peer.display_cache.resize(2, 1);
    peer.display_cache.initialized = true;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);

    crate::session::resume::handle_display_resume(
        &display_resume_message(peer_id),
        &display_resume_body(7, 2, 1),
        &mut peers,
        &[],
        &HashMap::new(),
    );

    assert_eq!(peers[peer_id].generation, 8);
    assert!(!peers[peer_id].needs_snapshot);
    assert!(
        !peers[peer_id].needs_full_diff,
        "late old-generation resume cannot arm redundant display work"
    );
}

#[test]
fn direct_snapshot_selection_is_strictly_targeted() {
    let mut first = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    first.authenticated = true;
    first.noise = Some(established_daemon_noise());
    let mut second = PeerDisplayState::new("browser-2".into(), PeerTransport::Edge);
    second.authenticated = true;
    second.noise = Some(established_daemon_noise());
    let peers = PeerMap::from([
        (Arc::clone(&first.peer_id), first),
        (Arc::clone(&second.peer_id), second),
    ]);

    assert_eq!(
        pending_snapshot_peer_ids(&peers, 100.0, SnapshotPeerSelection::One("browser-1")),
        [Arc::from("browser-1")]
    );
    assert_eq!(
        pending_snapshot_peer_ids(
            &peers,
            100.0,
            SnapshotPeerSelection::Many(&[Arc::from("browser-1"), Arc::from("browser-2")])
        ),
        [Arc::from("browser-1"), Arc::from("browser-2")]
    );
}

#[test]
fn fence_horizon_tracks_only_datagram_sends() {
    // Reliable-routed frames consume seqs from the shared counter but
    // must not advance the fence horizon — the fence declares "missing
    // seqs up to N are lost", and reliable seqs are never at risk.
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(2, 1);

    // A reliable frame takes seq 1 (allocated, never recorded as datagram).
    let _reliable_seq = peer.next_datagram_seq();
    assert_eq!(peer.last_datagram_seq, 0);

    // A real datagram takes seq 2 and is recorded.
    let mut datagram = PreparedDisplayDatagram {
        seq: peer.next_datagram_seq(),
        frame_id: peer.next_frame_id(),
        raw_bytes: 8,
        encoded_rows: 1,
        utility: DisplayUtility::NonCritical,
        header_signal: 0,
        frame: vec![0u8; 8],
        rows: SentRows::default(),
        compression_attempted: false,
        content_class: ContentClass::Text,
        precomputed_fec_repair: None,
        physical_plan: PreparedPhysicalDatagramPlan::default(),
    };
    record_sent_datagram(
        &mut peer,
        &mut datagram,
        100.0,
        SentPaths::single(PeerTransport::Edge),
    );
    assert_eq!(peer.last_datagram_seq, 2);

    // Generation rollover resets the horizon with the counter.
    peer.next_generation();
    assert_eq!(peer.last_datagram_seq, 0);
    assert_eq!(peer.next_datagram_seq, 1);
}

#[test]
fn display_sequence_rollover_arms_snapshot_at_guard_boundary() {
    let mut below = PeerDisplayState::new("below".into(), PeerTransport::Edge);
    below.needs_snapshot = false;
    below.next_datagram_seq = DISPLAY_SEQ_ROLLOVER_AT - 1;

    let mut boundary = PeerDisplayState::new("boundary".into(), PeerTransport::Edge);
    boundary.needs_snapshot = false;
    boundary.next_datagram_seq = DISPLAY_SEQ_ROLLOVER_AT;
    boundary.snapshot_retry_at_ms = 500.0;

    let mut peers = HashMap::new();
    peers.insert("below".into(), below);
    peers.insert("boundary".into(), boundary);

    assert_eq!(arm_display_seq_rollover_snapshots(&mut peers), 1);
    assert!(!peers["below"].needs_snapshot);
    assert!(peers["boundary"].needs_snapshot);
    assert_eq!(peers["boundary"].snapshot_retry_at_ms, 0.0);
}

/// A passive, hinted peer waits on nothing but evidence of an actual
/// refusal. The hint used to carry a 2-16 ms receiver pacing interval and
/// the scheduler a 10 ms redraw tail; both are gone, and the only floors
/// left are the zero-progress admission retry (bounded by the receiver's
/// own refresh period) and the snapshot send backoff.
#[test]
fn a_passive_hinted_peer_waits_only_on_actual_refusal_evidence() {
    let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
    peer.adaptive.flush_hint_active = true;
    peer.adaptive.presentation_period_ms = 16.0;
    current[1] ^= 1;
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::COHERENT,
            1,
            &current,
            SCHED_NOW_MS
        ),
        Some(0)
    );
    current[1] ^= 1;

    // The same failed critical input/header cannot spend another attempt
    // before its bounded retry elapses.
    for _ in 0..5 {
        note_zero_progress_admission(&mut peer, SCHED_NOW_MS, 1);
    }
    assert_eq!(peer.display_admission_retry.until_ms, SCHED_NOW_MS + 16.0);
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::CLEAN,
            1,
            &current,
            SCHED_NOW_MS
        ),
        Some(16)
    );
    peer.needs_snapshot = true;
    peer.snapshot_retry_at_ms = SCHED_NOW_MS + 25.0;
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            PendingDisplayDamage::CLEAN,
            1,
            &current,
            SCHED_NOW_MS
        ),
        Some(25)
    );
    peer.needs_snapshot = false;
    peer.snapshot_retry_at_ms = 0.0;
    peer.display_admission_retry = Default::default();

    let completed = PendingDisplayDamage {
        completed_sync_update_epoch: 1,
        ..PendingDisplayDamage::COHERENT
    };
    assert_eq!(
        peer_next_flush_delay_ms(&peer, completed, 1, &current, SCHED_NOW_MS),
        Some(0)
    );
}

#[test]
fn flush_delay_respects_snapshot_backoff() {
    // A peer in snapshot back-off should stretch the next flush wake-up to
    // the back-off deadline instead of firing immediately.
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.last_input_at_ms = -1_000.0;
    peer.needs_snapshot = true;
    peer.snapshot_consecutive_failures = 2;
    peer.snapshot_retry_at_ms = 500.0;
    let mut peers = HashMap::new();
    peers.insert("browser-1".into(), peer);

    let delay = compute_next_flush_delay_ms(&peers, PendingDisplayDamage::CLEAN, 0, &[], 200.0);
    assert_eq!(delay, Some(300));
}

fn classify(
    cache: &PerPeerDisplayCache,
    current_row_hashes: &[u64],
) -> (Vec<DisplayRowRequest>, Vec<u16>) {
    classify_at(cache, current_row_hashes, f64::INFINITY)
}

fn classify_at(
    cache: &PerPeerDisplayCache,
    current_row_hashes: &[u64],
    now_ms: f64,
) -> (Vec<DisplayRowRequest>, Vec<u16>) {
    let mut selection = FlushRowSelection::default();
    classify_flush_rows(cache, current_row_hashes, now_ms, &mut selection);
    let rows = selection
        .selected_rows
        .iter()
        .map(|request| request.row)
        .collect();
    (selection.selected_rows, rows)
}

#[test]
fn row_superseding_an_unacked_version_is_sent_full_width() {
    // Exact stale-glyph scenario:
    //   ACKed A = [blank, blank, blank]
    //   speculative B = ['X', 'Y', blank]
    //   live C = ['Z', blank, blank]
    //
    // Two properties matter here, and the second one is the change.
    //
    // 1. C must be SELECTED. `sent_hash != acked_hash` keeps the row on
    //    the wire while B is unconfirmed. Were it skipped, a late B would
    //    be the newest thing the receiver ever saw for this row.
    //
    // 2. C must be FULL-ROW. A plain A->C diff omits column 1 (it is back
    //    at the baseline value), so B's 'Y' would sit there forever — the
    //    receiver's row-version gate only discards frames that arrive LATE,
    //    it cannot undo a B that arrived on time and applied.
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(3, 1, event_tx);
    let mut acked_grid = Vec::new();
    let mut acked_hashes = Vec::new();
    terminal.current_grid_into(&mut acked_grid);
    terminal.current_row_hashes_into(&mut acked_hashes);

    let mut cache = PerPeerDisplayCache::new();
    cache.resize(3, 1);
    cache.prime_from_snapshot(&acked_grid, &acked_hashes, &[]);
    let speculative_cells: Arc<[CellRepr]> = Arc::from(vec![
        CellRepr {
            codepoint: u32::from('X'),
            ..acked_grid[0]
        },
        CellRepr {
            codepoint: u32::from('Y'),
            ..acked_grid[1]
        },
        acked_grid[2],
    ]);
    cache.record_sent_rows(
        2,
        &[SentRow {
            graphics: None,
            row: 0,
            hash: merkur_codec::row_hash(&speculative_cells),
            cells: speculative_cells,
        }],
        0.0,
        DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
    );

    terminal.apply_bytes(b"Z");
    let mut current_hashes = Vec::new();
    terminal.current_row_hashes_into(&mut current_hashes);
    let (selection, _dirty) = classify(&cache, &current_hashes);
    assert_eq!(
        selection.len(),
        1,
        "unconfirmed speculative version keeps the row selected"
    );
    assert!(
        selection[0].force_full,
        "a distinct outstanding version must be superseded by a baseline-independent row"
    );

    let (payload, encoded_rows) =
        terminal.encode_delta_for_rows(&acked_grid, &selection, Vec::new());
    assert_eq!(encoded_rows, 1);
    let row = merkur_codec::iter_rows(&payload)
        .next()
        .expect("encoded row")
        .expect("valid row");
    // The whole row, including the reverted blank at column 1 that erases
    // the speculative 'Y'.
    assert_eq!((row.left, row.right), (0, 2));
    let cells: Vec<CellRepr> = merkur_codec::cell_iter(row.cells)
        .collect::<Result<_, _>>()
        .expect("valid cells");
    assert_eq!(cells[0].codepoint, u32::from('Z'));
    assert_eq!(cells[1], acked_grid[1]);
    assert_eq!(cells[2], acked_grid[2]);
}

#[test]
fn a_row_returning_to_its_acked_hash_stays_full_width_until_reconfirmed() {
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(1, 1);
    cache.prime_from_snapshot(&[CellRepr::BLANK], &[7], &[]);
    let row = |hash, glyph| SentRow {
        graphics: None,
        row: 0,
        hash,
        cells: Arc::from([CellRepr {
            codepoint: glyph,
            ..CellRepr::BLANK
        }]),
    };
    cache.record_sent_rows(1, &[row(9, u32::from('B'))], 0.0, 25.0);
    cache.record_sent_rows(2, &[row(7, u32::from('A'))], 1.0, 25.0);

    let (selection, _) = classify_at(&cache, &[7], 30.0);
    assert_eq!(selection.len(), 1);
    assert!(selection[0].force_full);
    assert!(cache.sent_row_force_full_until_confirmed[0]);
    assert!(
        !cache.sent_row_confirmed[0],
        "the old exact A baseline cannot confirm the newly sent A lineage"
    );
}

#[test]
fn resend_pacing_delays_duplicates_but_never_new_content() {
    // The rate-control half of the design. Idempotent selection alone
    // re-sends the whole unACKed set every tick; at a 50 ms RTT and an 8 ms
    // tick that is ~6x the offered load, and the queueing it causes is
    // itself the impaired tail. Pacing duplicates fixes that — but it must
    // never touch a row whose content actually changed, or it becomes the
    // fixed suppression window it replaced.
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(1, 2);
    for row in 0..2 {
        cache.acked_row_exact[row] = true;
        cache.acked_row_seq[row] = 1;
        cache.acked_row_hashes[row] = 7;
        cache.sent_row_hashes[row] = 9;
        cache.sent_row_latest_seq[row] = 10;
        cache.sent_row_attempt_mask[row][0] = 1;
        cache.sent_row_resend_after_ms[row] = 100.0;
    }

    // Row 0 still holds exactly what was sent; row 1 has changed again.
    let (selection, _) = classify_at(&cache, &[9, 11], 50.0);
    let rows: Vec<u16> = selection.iter().map(|request| request.row).collect();
    assert_eq!(
        rows,
        vec![1],
        "an unchanged in-flight row waits; a changed row goes immediately"
    );

    // Past the deadline the duplicate is re-sent with no event required —
    // this is the whole loss-recovery mechanism, and it costs one RTT-scaled
    // interval rather than the old fixed 160 ms.
    let (selection, _) = classify_at(&cache, &[9, 11], 150.0);
    let rows: Vec<u16> = selection.iter().map(|request| request.row).collect();
    assert_eq!(rows, vec![0, 1]);
}

#[test]
fn unresolved_attempts_keep_deadlines_until_applied_evidence_resolves_them() {
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(1, 4);
    for row in 0..4u16 {
        let hash = 100 + u64::from(row);
        cache.record_sent_rows(
            u32::from(row) + 1,
            &[SentRow {
                graphics: None,
                row,
                hash,
                cells: Arc::from([CellRepr::BLANK]),
            }],
            0.0,
            100.0,
        );
    }
    let current = [100, 101, 102, 103];

    assert_eq!(cache.next_row_resend_due_ms(50.0), Some(100.0));
    assert!(!cache.has_selectable_rows(&current, 50.0));

    let mut selection = FlushRowSelection::default();
    classify_flush_rows(&cache, &current, 100.0, &mut selection);
    assert_eq!(
        selection
            .selected_rows
            .iter()
            .map(|request| request.row)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "allocated later IDs cannot resolve any attempt without applied ACK evidence"
    );
    assert!(cache.has_selectable_rows(&current, 100.0));
    assert!(cache.has_sendable_rows(100.0));

    let changed = [999, 101, 102, 103];
    let mut selection = FlushRowSelection::default();
    classify_flush_rows(&cache, &changed, 50.0, &mut selection);
    assert_eq!(
        selection.selected_rows[0].row, 0,
        "new content bypasses the unresolved-attempt deadline"
    );
}

#[test]
fn resend_interval_tracks_measurements_instead_of_a_fixed_constant() {
    let fast = DisplayPolicy::row_resend_interval_ms(5.0, 1.0, 4.0, 0.5);
    let slow = DisplayPolicy::row_resend_interval_ms(120.0, 10.0, 90.0, 5.0);
    assert_eq!(
        fast, 7.0,
        "a fast link duplicates after its own measured delay"
    );
    assert!(slow > fast, "a slower path waits longer before duplicating");
    assert!(slow <= DisplayPolicy::ROW_RESEND_MAX_MS);
}

#[test]
fn flush_budget_keeps_the_ranked_prefix_and_always_makes_progress() {
    // The budget is what stops idempotent re-selection from re-emitting a
    // full-screen redraw on every tick until its ACK lands. Two properties
    // matter: it clips from the TAIL (so the cursor row, ranked first,
    // survives), and it never selects nothing (which would stall the peer
    // permanently, since dropped rows are only recoverable by re-selection).
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    // A full redraw of a large terminal, styled per cell. The budget is the
    // carrier's measured free datagram buffer, so the fixture states the
    // space it is clipping against rather than importing a constant.
    let mut terminal = TerminalState::new(200, 60, event_tx);
    // Vary the glyph so RLE cannot collapse the row, and give every cell a
    // distinct 24-bit foreground so the row encodes in literal colour mode.
    for row in 0..60u16 {
        terminal.apply_bytes(format!("\x1b[{};1H", row + 1).as_bytes());
        for col in 0..200u16 {
            let seed = row.wrapping_mul(31).wrapping_add(col);
            let glyph = b'!' + (seed % 90) as u8;
            terminal.apply_bytes(
                format!(
                    "\x1b[38;2;{};{};{}m{}",
                    (seed % 251) as u8,
                    (seed.wrapping_mul(7) % 241) as u8,
                    (seed.wrapping_mul(13) % 239) as u8,
                    glyph as char
                )
                .as_bytes(),
            );
        }
    }
    let acked_grid = vec![CellRepr::BLANK; 200 * 60];

    let mut rows: Vec<DisplayRowRequest> = (0..60)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let full_len = rows.len();

    // A carrier whose datagram buffer is mostly full — the case the measured
    // budget exists to handle, and the one a constant could never see.
    const CROWDED_BUFFER_BYTES: usize = 8 * 1024;
    let truncated =
        apply_flush_row_budget(&mut terminal, &acked_grid, &mut rows, CROWDED_BUFFER_BYTES);

    assert!(
        truncated,
        "60 fully styled 200-column rows must exceed 8 KiB of free buffer"
    );
    assert!(!rows.is_empty(), "the budget must never select nothing");
    // The prefix is kept, so whatever was ranked first is still present.
    assert_eq!(rows[0].row, 0);
    assert!(rows.len() < full_len);
}

#[test]
fn flush_budget_keeps_a_single_oversize_row() {
    // Forward progress beats the budget: one row that cannot fit still has
    // to be emitted, or the peer never converges on it.
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(80, 40, event_tx);
    terminal.apply_bytes(&[b'x'; 80]);
    let acked_grid = vec![CellRepr::BLANK; 80 * 40];
    let mut rows = vec![DisplayRowRequest::literal(0, true)];

    assert!(!apply_flush_row_budget(
        &mut terminal,
        &acked_grid,
        &mut rows,
        DATAGRAM_SEND_BUFFER_BYTES,
    ));
    assert_eq!(rows.len(), 1);
}

#[test]
fn acked_and_quiescent_row_is_the_only_skip() {
    // The whole idempotency invariant in one test. A row goes quiet only
    // when the peer confirmed the current content AND nothing speculative
    // is outstanding; every other combination stays on the wire, which is
    // what makes a lost datagram recoverable without a NACK.
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(1, 4);
    for row in 0..4 {
        cache.acked_row_exact[row] = true;
        cache.acked_row_seq[row] = 1;
    }

    // Row 0: confirmed and quiescent -> skipped.
    cache.acked_row_hashes[0] = 7;
    cache.sent_row_hashes[0] = 7;
    cache.sent_row_confirmed[0] = true;
    // Row 1: changed since the ACK -> selected.
    cache.acked_row_hashes[1] = 7;
    cache.sent_row_hashes[1] = 7;
    cache.sent_row_confirmed[1] = true;
    // Row 2: current matches the ACK but a different send is outstanding
    // (the A->B->A case) -> selected, so a late B cannot win.
    cache.acked_row_hashes[2] = 7;
    cache.sent_row_hashes[2] = 9;
    // Row 3: sent but never acknowledged -> selected, and this is the
    // recovery path for a lost datagram: no timer, just re-selection.
    cache.acked_row_hashes[3] = 0;
    cache.sent_row_hashes[3] = 9;

    let (selection, dirty) = classify(&cache, &[7, 8, 7, 9]);

    let rows: Vec<u16> = selection.iter().map(|request| request.row).collect();
    assert_eq!(rows, vec![1, 2, 3]);
    assert_eq!(dirty, vec![1, 2, 3]);
}

#[test]
fn cumulative_ack_of_a_missing_atomic_redraw_stays_scheduled_until_exact() {
    // Seq 10 belonged to a multi-chunk redraw. The browser missed one
    // chunk, so it never applied that atomic frame, then applied seq 11
    // from another frame. ACK 11 numerically covers seq 10 and advances
    // its compression baseline, but it is not proof that row 0 was drawn.
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(3, 1);
    cache.acked_row_hashes[0] = 7;
    cache.sent_row_hashes[0] = 7;
    cache.acked_row_seq[0] = 10;
    cache.sent_row_seq[0] = 10;
    cache.sent_row_latest_seq[0] = 10;
    cache.sent_row_attempt_mask[0][0] = 1;
    cache.acked_row_exact[0] = false;
    cache.sent_row_resend_after_ms[0] = 125.0;

    assert!(cache.has_unacked_rows());
    assert_eq!(cache.next_row_resend_due_ms(100.0), Some(125.0));
    assert!(!cache.has_sendable_rows(124.0));
    assert!(cache.has_sendable_rows(125.0));

    let (selection, dirty) = classify_at(&cache, &[7], 125.0);
    assert_eq!(dirty, vec![0]);
    assert_eq!(selection.len(), 1);
    assert!(
        selection[0].force_full,
        "the confirming resend must not depend on the phantom baseline"
    );

    cache.acked_row_exact[0] = true;
    cache.sent_row_confirmed[0] = true;
    assert!(!cache.has_unacked_rows());
    assert!(!cache.has_sendable_rows(f64::INFINITY));
    assert!(classify(&cache, &[7]).0.is_empty());
}

#[test]
fn classify_keeps_the_normal_post_ack_change_sparse() {
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(3, 1);
    cache.acked_row_hashes[0] = 2;
    cache.sent_row_hashes[0] = 2;
    // The sent seq stays pinned to an identical send's first seq while a
    // later selective ACK may name its resend. Hash lineage, not numeric
    // seq equality, proves that version is acknowledged.
    cache.sent_row_seq[0] = 5;
    cache.acked_row_seq[0] = 7;
    cache.acked_row_exact[0] = true;

    let (selection, dirty) = classify(&cache, &[3]);

    assert_eq!(selection.len(), 1);
    assert!(
        !selection[0].force_full,
        "the common first change after an ACK must retain sparse encoding"
    );
    assert_eq!(dirty, vec![0]);
}

#[test]
fn classify_forces_full_from_a_numeric_max_credited_baseline() {
    // ACK 11 can numerically cover row seq 10 even while seq 10 is still
    // crossing the reliable lane. Keep that baseline for compression
    // progress, but never build a sparse next version on it until the
    // browser explicitly ACKs the row's own seq.
    let mut cache = PerPeerDisplayCache::new();
    cache.resize(3, 1);
    cache.acked_row_hashes[0] = 2;
    cache.sent_row_hashes[0] = 2;
    cache.acked_row_seq[0] = 10;
    cache.sent_row_seq[0] = 10;
    cache.acked_row_exact[0] = false;

    let (selection, dirty) = classify(&cache, &[3]);

    assert_eq!(selection.len(), 1);
    assert!(selection[0].force_full);
    assert_eq!(dirty, vec![0]);
}

#[test]
fn a_full_size_snapshot_is_compressed_once_shared_and_round_trips() {
    use merkur_codec::{DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD, DISPLAY_HEADER_FLAGS_OFFSET};

    // Snapshots are the largest frames in the system and ride the reliable
    // lane; before this they were sent raw.
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(120, 40, event_tx);
    // Every column occupied, so the snapshot is a genuinely full screen and
    // clears `SNAPSHOT_COMPRESSION_MIN_BYTES`. Rows are rotations of one
    // glyph cycle: incompressible within a row, highly compressible across
    // them, which is what a real screenful of text looks like to zstd.
    for row in 0..40u16 {
        terminal.apply_bytes(format!("\x1b[{};1H", row + 1).as_bytes());
        let line: Vec<u8> = (0..120u16)
            .map(|col| b'!' + ((row.wrapping_mul(31) + col) % 90) as u8)
            .collect();
        terminal.apply_bytes(&line);
    }
    let (snapshot, _) = terminal.encode_snapshot_into(Vec::new());

    let mut planner = GlobalDisplayPlanningModel::default();
    let profile = crate::display::planner::PeerDisplayPlanningModel::default()
        .snapshot(ContentClass::Text, DictionaryClass::Plain);
    let context = PlanningContext {
        fec_enabled: false,
        carrier: CarrierDeliveryQuote {
            pacing_rate_bps: 1_000_000,
            ..CarrierDeliveryQuote::default()
        },
        ..PlanningContext::default()
    };
    let completion = prepare_snapshot_off_loop(
        SnapshotPrepareRequest {
            token: 1,
            submitted_at: Instant::now(),
            display_revision: terminal.display_revision(),
            completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
            cols: terminal.cols,
            rows: terminal.rows,
            header_signal: terminal.current_display_header_signal(),
            content_class: ContentClass::Text,
            snapshot,
            snapshot_grid: Vec::new(),
            snapshot_graphics: Vec::new(),
            row_hashes: Vec::new(),
            peers: vec![
                SnapshotPeerPlan {
                    peer_id: Arc::from("browser-1"),
                    prepare_epoch: 1,
                    prepare_epoch_fence: Arc::new(AtomicU64::new(1)),
                    profile,
                    context,
                },
                SnapshotPeerPlan {
                    peer_id: Arc::from("browser-2"),
                    prepare_epoch: 1,
                    prepare_epoch_fence: Arc::new(AtomicU64::new(1)),
                    profile,
                    context,
                },
            ],
        },
        &mut Compressor::new(),
        &mut planner,
    );
    assert_eq!(completion.peers.len(), 2);
    assert_eq!(completion.raw_chunks.len(), 1);
    assert_eq!(completion.compressed_chunks.len(), 1);
    let raw = &completion.raw_chunks[0];
    assert!(
        completion.compression_attempted[0],
        "full snapshot must be selected for a compression attempt"
    );
    let compressed = completion.compressed_chunks[0]
        .as_ref()
        .expect("full snapshot compression must shrink");
    assert_eq!(
        choose_after_compression(
            profile,
            raw.len(),
            compressed.len(),
            DictionaryClass::Plain,
            context,
        ),
        Representation::Compressed,
    );
    let mut frame = compressed.clone();
    patch_stream_header(&mut frame, 0, 7, 13, 53, 53, false, true, 0, 1, 0, 0).unwrap();

    assert_ne!(
        frame[DISPLAY_HEADER_FLAGS_OFFSET] & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD,
        0,
        "a full-size snapshot must take the compressed path"
    );
    assert!(frame.len() < raw.len());
    // The per-peer stream header must survive compression: it is written
    // before the body is compressed, and the envelope copies it verbatim.
    assert_eq!(u32::from_be_bytes(frame[10..14].try_into().unwrap()), 7);
    assert_eq!(u32::from_be_bytes(frame[14..18].try_into().unwrap()), 13);
    let header = merkur_codec::parse_frame_header(&frame).expect("compressed header");
    assert_eq!(header.frame_id, 53);
    assert_eq!(header.presentation_id, 53);
    assert!(!header.presentation_coherent);
    assert!(header.presentation_end);

    // The display header stays visible; only row bytes are compressed.
    let body = crate::display::compressor::decode_display_payload(&frame, None)
        .expect("compressed snapshot body must decompress");
    assert_eq!(body, raw[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..]);
}

// Production-shaped scroll fixtures use distinct text on each row.
fn sized_line(row: u16, cols: u16) -> String {
    const WORDS: [&str; 8] = [
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
    ];
    let mut line = String::new();
    let mut state = u32::from(row).wrapping_mul(2_654_435_761).wrapping_add(97);
    while line.len() + 8 < usize::from(cols) {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        line.push_str(WORDS[(state >> 13) as usize % WORDS.len()]);
        line.push(' ');
    }
    line
}

/// A terminal whose ACKed baseline contains distinct non-blank rows.
fn sized_fixture(cols: u16, rows: u16) -> (TerminalState, PerPeerDisplayCache, Vec<u64>) {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(cols, rows, event_tx);
    for row in 0..rows {
        terminal.apply_bytes(format!("{}\r\n", sized_line(row, cols)).as_bytes());
    }

    let mut cache = PerPeerDisplayCache::new();
    cache.resize(cols, rows);
    let mut grid = Vec::new();
    terminal.current_grid_into(&mut grid);
    let mut hashes = Vec::new();
    let mut scratch = RowCaptureScratch::default();
    for row in 0..usize::from(rows) {
        let hash = terminal.read_row_cells(row, &mut scratch);
        hashes.push(hash);
    }
    cache.prime_from_snapshot(&grid, &hashes, &[]);
    cache.acked_row_seq.fill(1);
    cache.last_applied_ack_seq = 1;
    (terminal, cache, hashes)
}

struct ScrollBenchmarkState {
    terminal: TerminalState,
    peers: Vec<PerPeerDisplayCache>,
    current_hashes: Vec<u64>,
    flush_row_cache: HashMap<u16, CapturedRow>,
    cursor_row: Option<u16>,
}

impl ScrollBenchmarkState {
    fn new(cols: u16, rows: u16, peer_count: usize) -> Self {
        let (mut terminal, baseline, _) = sized_fixture(cols, rows);
        let peers = (0..peer_count)
            .map(|_| clone_display_baseline(&baseline))
            .collect();

        // One line of new output shifts every prior line by one row. The
        // same dirty-row hash pass production runs at the top of a flush
        // supplies both hashes and immutable cells to `flush_row_cache`.
        terminal.apply_bytes(format!("{}\r\n", sized_line(9_999, cols)).as_bytes());
        let mut current_hashes = Vec::new();
        let mut captures = Vec::new();
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut captures);
        assert_eq!(captures.len(), usize::from(rows));
        let flush_row_cache = captures
            .into_iter()
            .map(|capture| (capture.row, capture))
            .collect();
        let cursor_row = terminal.current_cursor_row();

        Self {
            terminal,
            peers,
            current_hashes,
            flush_row_cache,
            cursor_row,
        }
    }
}

fn clone_display_baseline(source: &PerPeerDisplayCache) -> PerPeerDisplayCache {
    let mut clone = PerPeerDisplayCache::new();
    clone.resize(source.cols, source.rows);
    clone.acked_row_cells.clone_from(&source.acked_row_cells);
    clone
        .acked_row_revisions
        .clone_from(&source.acked_row_revisions);
    clone.sent_row_cells.clone_from(&source.sent_row_cells);
    clone.acked_row_hashes.clone_from(&source.acked_row_hashes);
    clone.acked_row_exact.clone_from(&source.acked_row_exact);
    clone.sent_row_hashes.clone_from(&source.sent_row_hashes);
    clone
        .sent_row_confirmed
        .clone_from(&source.sent_row_confirmed);
    clone.last_applied_ack_seq = source.last_applied_ack_seq;
    clone
}

#[test]
fn production_scroll_datagrams_commute_and_loss_costs_only_carried_rows() {
    scroll_datagram_independence_oracle(false);
}

#[test]
fn first_partition_candidate_scroll_datagrams_remain_independent() {
    scroll_datagram_independence_oracle(true);
}

fn scroll_datagram_independence_oracle(first_partition_only: bool) {
    fn permutations(values: &mut [usize], prefix: usize, visit: &mut impl FnMut(&[usize])) {
        if prefix == values.len() {
            visit(values);
            return;
        }
        for next in prefix..values.len() {
            values.swap(prefix, next);
            permutations(values, prefix + 1, visit);
            values.swap(prefix, next);
        }
    }

    for rows in [37, 80] {
        let mut state = ScrollBenchmarkState::new(120, rows, 1);
        let mut peer = benchmark_noise_peer();
        peer.display_cache = clone_display_baseline(&state.peers[0]);
        peer.next_datagram_seq = 2;
        peer.paths.edge.available = true;
        peer.paths.edge.last_ack_at_ms = 100.0;
        peer.paths.edge.network_rtt_ewma_ms = 50.0;
        peer.display_planning.observe_carrier_quote(
            1,
            CarrierDeliveryQuote {
                one_way_us: 25_000.0,
                ..CarrierDeliveryQuote::default()
            },
        );
        let mut selection = FlushRowSelection::default();
        classify_flush_rows(
            &peer.display_cache,
            &state.current_hashes,
            100.0,
            &mut selection,
        );
        prioritize_display_rows(
            &mut selection.selected_rows,
            state.cursor_row,
            rows,
            &peer.display_cache.sent_row_hashes,
            &state.current_hashes,
        );
        let mut request = interactive_request_for_test(
            1,
            &state.terminal,
            &peer,
            0,
            &mut RowCaptureScratch::default(),
            &mut state.flush_row_cache,
        );
        capture_prepare_rows(
            &state.terminal,
            &peer,
            &selection.selected_rows,
            state.cursor_row,
            &mut RowCaptureScratch::default(),
            &mut state.flush_row_cache,
            &mut request.buffers.rows,
        );
        request.header_changed = true;
        request.burst_group_max_size = DisplayPolicy::FEC_GROUP_MAX_SIZE;
        request.compression =
            display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
        let domains = usize::from(!request.buffers.rows.is_empty())
            + request
                .buffers
                .rows
                .windows(2)
                .filter(|pair| {
                    pair[0].utility != pair[1].utility
                        || pair[0].content.class() != pair[1].content.class()
                })
                .count();
        let mut scratch = PrepareScratch {
            experiment: if first_partition_only {
                PackingExperiment::FirstPartition
            } else {
                PackingExperiment::Adaptive
            },
            ..PrepareScratch::default()
        };
        let prepared = prepare_display_off_loop(
            request,
            &mut Compressor::new(),
            &mut crate::display::fec::FecEncoder::new(),
            &mut scratch,
        );
        if first_partition_only {
            assert_eq!(
                scratch.partition_calls, domains,
                "one exact search per immutable domain"
            );
        }
        let frames = &prepared.buffers.datagrams;
        assert!(frames.len() > 1, "must cross a transport boundary");
        assert!(frames.iter().all(uses_display_datagram));
        let mut snapshot_header = state
            .terminal
            .current_display_header(merkur_codec::FrameKind::Snapshot);
        snapshot_header.row_count = rows;
        let mut snapshot = Vec::new();
        encode_frame_into(
            &mut snapshot,
            &snapshot_header,
            peer.display_cache
                .acked_row_cells
                .iter()
                .enumerate()
                .map(|(row, cells)| RowRef {
                    graphics: &[],
                    row_index: row as u16,
                    left: 0,
                    cells,
                }),
        );
        patch_stream_header(
            &mut snapshot,
            1,
            peer.generation,
            0,
            1,
            0,
            false,
            false,
            0,
            1,
            0,
            0,
        )
        .unwrap();
        let apply_order = |order: &[usize], duplicate: bool| {
            let mut viewer = term_wasm::Terminal::new_headless(120, rows);
            assert!(viewer.apply_state_seq(&snapshot, 1));
            let mut expected = peer.display_cache.acked_row_hashes.clone();
            for &index in order {
                let datagram = &frames[index];
                let stream = merkur_codec::parse_stream_header(&datagram.frame).unwrap();
                for _ in 0..if duplicate { 2 } else { 1 } {
                    let handle = viewer.stage_display_frame_bytes(&datagram.frame);
                    assert_ne!(handle, 0, "{:?}", viewer.take_last_error());
                    assert!(viewer.validate_staged_frame(handle));
                    assert!(viewer.apply_staged_delta_seq(handle, stream.seq));
                    viewer.release_staged_frame(handle);
                }
                for sent in datagram.rows.iter() {
                    expected[usize::from(sent.row)] = sent.hash;
                }
            }
            let observed: Vec<_> = (0..rows).map(|row| viewer.row_hash(row)).collect();
            assert_eq!(observed, expected, "rows={rows} order={order:?}");
            observed
        };
        // Every original is complete against the common ACK baseline;
        // applying it twice cannot change the result.
        for index in 0..frames.len() {
            apply_order(&[index], true);
        }
        // Pairwise commutativity plus idempotence proves all permutations
        // for the larger fixture without a factorial test runtime.
        for first in 0..frames.len() {
            for second in first + 1..frames.len() {
                assert_eq!(
                    apply_order(&[first, second], false),
                    apply_order(&[second, first], false)
                );
            }
        }
        let mut order: Vec<_> = (0..frames.len()).collect();
        assert_eq!(apply_order(&order, false), state.current_hashes);
        if rows == 37 {
            if !first_partition_only {
                assert!(frames.len() <= 6, "bounded exhaustive production oracle");
            }
            if frames.len() <= 6 {
                permutations(&mut order, 0, &mut |permutation| {
                    assert_eq!(apply_order(permutation, false), state.current_hashes);
                });
            }
        }
        for missing in 0..frames.len() {
            let admitted: Vec<_> = order.iter().copied().filter(|i| *i != missing).collect();
            // The expected grid derives only from exact carried snapshots:
            // losing this frame cannot reject or suppress any sibling.
            apply_order(&admitted, false);
        }
    }
}

#[test]
#[ignore = "exclusive production scroll preparation profile"]
fn production_scroll_literal_benchmark() {
    use crate::display::fec::FecEncoder;
    use crate::display::planner::{display_datagram_wire_len, display_reliable_record_wire_len};

    const SAMPLES: usize = 200;
    for rtt_ms in [50.0, 120.0, 200.0] {
        for (cols, rows) in [(120, 37), (120, 80), (384, 256)] {
            for learned_peer in [false, true] {
                for finalized_dictionary in [false, true] {
                    let mut state = ScrollBenchmarkState::new(cols, rows, 1);
                    let mut peer = benchmark_noise_peer();
                    peer.display_cache = clone_display_baseline(&state.peers[0]);
                    peer.needs_snapshot = false;
                    peer.paths.edge.available = true;
                    peer.paths.edge.last_ack_at_ms = 100.0;
                    peer.paths.edge.network_rtt_ewma_ms = rtt_ms;
                    let quote = CarrierDeliveryQuote {
                        one_way_us: rtt_ms * 500.0,
                        ..CarrierDeliveryQuote::default()
                    };
                    peer.display_planning.observe_carrier_quote(1, quote);
                    if finalized_dictionary {
                        // Finalize only already-ACKed baseline content.
                        // Training on the post-scroll grid would leak the
                        // new output into a purported before-send source.
                        let prepared = prepare_dictionary_off_loop(
                            DictionaryPrepareRequest {
                                token: 1,
                                display_revision: 0,
                                header: state
                                    .terminal
                                    .current_display_header(merkur_codec::FrameKind::Snapshot),
                                rows: peer
                                    .display_cache
                                    .acked_row_cells
                                    .iter()
                                    .enumerate()
                                    .map(|(row, cells)| CapturedRow {
                                        graphics: PreparedGraphics::EMPTY,
                                        row: row as u16,
                                        hash: peer.display_cache.acked_row_hashes[row],
                                        cells: Arc::clone(cells),
                                    })
                                    .collect(),
                            },
                            &mut Vec::new(),
                            &mut DictionaryScratch::default(),
                        );
                        let dictionary = peer
                            .dictionary
                            .build_next_prepared(peer.generation, prepared.source, prepared.hash)
                            .expect("baseline dictionary is eligible");
                        assert!(peer.dictionary.acknowledge(dictionary.id));
                    }
                    let mut worker = idle_prepare_worker_for_test();
                    let mut compressor = Compressor::new();
                    let mut fec = FecEncoder::new();
                    let mut scratch = PrepareScratch::default();
                    let mut capture = RowCaptureScratch::default();
                    let mut selection = FlushRowScratch::default();
                    let mut cpu = Vec::with_capacity(SAMPLES);
                    let mut wire = Vec::with_capacity(SAMPLES);
                    let mut data_records = Vec::with_capacity(SAMPLES);
                    let mut physical_records = Vec::with_capacity(SAMPLES);
                    let mut allocations = Vec::with_capacity(SAMPLES);
                    let mut serialization = Vec::with_capacity(SAMPLES);
                    for round in 0..SAMPLES + 20 {
                        classify_flush_rows(
                            &peer.display_cache,
                            &state.current_hashes,
                            100.0,
                            &mut selection.selection,
                        );
                        let selected = &mut selection.selection.selected_rows;
                        prioritize_display_rows(
                            selected,
                            state.cursor_row,
                            rows,
                            &peer.display_cache.sent_row_hashes,
                            &state.current_hashes,
                        );
                        let mut buffers = worker.take_buffers();
                        capture_prepare_rows(
                            &state.terminal,
                            &peer,
                            selected,
                            state.cursor_row,
                            &mut capture,
                            &mut state.flush_row_cache,
                            &mut buffers.rows,
                        );
                        let compression =
                            display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
                        let completion = prepare_display_off_loop(
                            DisplayPrepareRequest {
                                token: round as u64 + 1,
                                prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
                                prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
                                submitted_at: Instant::now(),
                                perf_flush_started_at: Some(FlushStart::now()),
                                generation: peer.generation,
                                display_revision: state.terminal.display_revision(),
                                completed_sync_update_epoch: state
                                    .terminal
                                    .completed_sync_update_epoch(),
                                start_seq: peer.next_datagram_seq,
                                start_frame_id: peer.next_frame_id,
                                presentation_continues: false,
                                causal_input_advanced: false,
                                input_seq: 1,
                                header_signal: state.terminal.current_display_header_signal(),
                                header_changed: true,
                                header: state
                                    .terminal
                                    .current_display_header(merkur_codec::FrameKind::Delta),
                                buffers,
                                compression,
                                compression_dictionary: peer.dictionary.active().cloned(),
                                burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
                                summary: flush_summary_for_test(selected.len() as u32),
                            },
                            &mut compressor,
                            &mut fec,
                            &mut scratch,
                        );
                        if learned_peer {
                            for datagram in &completion.buffers.datagrams {
                                observe_display_compression_outcome(
                                    &mut peer,
                                    datagram.frame.len(),
                                    datagram.raw_bytes,
                                    datagram.compression_attempted,
                                    datagram.content_class,
                                    completion.dictionary_class,
                                );
                            }
                        }
                        if round >= 20 {
                            let mut bytes = 0usize;
                            let mut count = 0usize;
                            for datagram in &completion.buffers.datagrams {
                                bytes += if datagram.frame.len()
                                    <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
                                {
                                    display_datagram_wire_len(datagram.frame.len())
                                } else {
                                    display_reliable_record_wire_len(datagram.frame.len())
                                };
                                count += 1;
                                if let Some(repair) = &datagram.precomputed_fec_repair {
                                    bytes += display_datagram_wire_len(repair.len());
                                    count += 1;
                                }
                            }
                            cpu.push(completion.cpu_time.as_secs_f64() * 1e6);
                            wire.push(bytes as f64);
                            data_records.push(completion.buffers.datagrams.len() as f64);
                            physical_records.push(count as f64);
                            allocations.push(
                                completion.perf_timing.unwrap().allocations.allocations as f64,
                            );
                            serialization.push(quote.serialization_us(bytes));
                        }
                        worker.recycle(completion.buffers);
                    }
                    for (stage, mut values) in [
                        ("prepare-us", cpu),
                        ("primary-wire-bytes", wire),
                        ("data-records", data_records),
                        ("data-plus-fec-records", physical_records),
                        ("rust-allocations", allocations),
                        ("quoted-serialization-us", serialization),
                    ] {
                        values.sort_by(f64::total_cmp);
                        let at = |p: f64| values[(SAMPLES as f64 * p).ceil() as usize - 1];
                        eprintln!(
                            "SCROLL_AB quote_rtt_ms={rtt_ms} cols={cols} rows={rows} learned_peer={learned_peer} finalized_dictionary={finalized_dictionary} samples={SAMPLES} stage={stage} p50={:.3} p95={:.3} p99={:.3} max={:.3}",
                            at(0.5),
                            at(0.95),
                            at(0.99),
                            values[SAMPLES - 1]
                        );
                    }
                }
            }
        }
    }
}

/// Datagram-count diagnostic for the partition follow-up. It runs the
/// production capture -> policy -> preparation chain on redraws whose rows
/// alternate content classes and prints the utility/content domains the
/// batcher forms before the planner sees any row, next to the datagrams
/// that come out. It changes nothing and asserts nothing.
#[test]
#[ignore = "planner partition diagnostic"]
fn display_partition_domain_diagnostic() {
    use crate::display::fec::FecEncoder;

    const COLS: u16 = 120;
    const ROWS: u16 = 40;

    fn probe_line(visible: usize, seed: u32, colored: bool) -> String {
        const WORDS: [&str; 8] = [
            "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
        ];
        let mut text = String::new();
        let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(97);
        while text.len() < visible {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            text.push_str(WORDS[(state >> 13) as usize % WORDS.len()]);
            text.push(' ');
        }
        text.truncate(visible);
        if colored {
            format!("\x1b[38;2;200;{};90m{text}\x1b[0m", (seed * 37) % 255)
        } else {
            text
        }
    }

    // (visible characters, colored) for each row of a 40-row redraw.
    type RowShape = fn(u16) -> (usize, bool);
    let shapes: [(&str, RowShape); 6] = [
        ("uniform-text", |_| (100, false)),
        ("shell-mixed-lengths", |row| {
            ([8, 60, 15, 90, 5, 40][usize::from(row) % 6], false)
        }),
        ("alternating-sparse-text", |row| {
            (if row % 2 == 0 { 3 } else { 80 }, false)
        }),
        ("alternating-color-text", |row| (80, row % 2 == 0)),
        ("tui-color-headers", |row| (100, row % 5 == 0)),
        ("uniform-color", |_| (100, true)),
    ];

    for (label, shape) in shapes {
        for learned in [false, true] {
            let (mut terminal, baseline, _) = sized_fixture(COLS, ROWS);
            let mut screen = String::from("\x1b[H");
            for row in 0..ROWS {
                let (visible, colored) = shape(row);
                screen.push_str(&probe_line(visible, u32::from(row) + 11, colored));
                screen.push_str("\x1b[K");
                if row + 1 < ROWS {
                    screen.push_str("\r\n");
                }
            }
            terminal.apply_bytes(screen.as_bytes());
            let mut current_hashes = Vec::new();
            let mut captures = Vec::new();
            terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut captures);
            assert_eq!(current_hashes.len(), usize::from(ROWS));
            let mut flush_row_cache: HashMap<u16, CapturedRow> = captures
                .into_iter()
                .map(|capture| (capture.row, capture))
                .collect();
            let cursor_row = terminal.current_cursor_row();

            let mut peer = benchmark_noise_peer();
            peer.display_cache = clone_display_baseline(&baseline);
            peer.needs_snapshot = false;
            peer.paths.edge.available = true;
            peer.paths.edge.last_ack_at_ms = 100.0;
            peer.paths.edge.network_rtt_ewma_ms = 50.0;
            peer.display_planning.observe_carrier_quote(
                1,
                CarrierDeliveryQuote {
                    one_way_us: 25_000.0,
                    ..CarrierDeliveryQuote::default()
                },
            );
            let mut worker = idle_prepare_worker_for_test();
            let mut compressor = Compressor::new();
            let mut fec = FecEncoder::new();
            let mut scratch = PrepareScratch::default();
            let mut capture = RowCaptureScratch::default();
            let mut selection = FlushRowScratch::default();
            let rounds = if learned { 21 } else { 1 };
            for round in 0..rounds {
                classify_flush_rows(
                    &peer.display_cache,
                    &current_hashes,
                    100.0,
                    &mut selection.selection,
                );
                let selected = &mut selection.selection.selected_rows;
                prioritize_display_rows(
                    selected,
                    cursor_row,
                    ROWS,
                    &peer.display_cache.sent_row_hashes,
                    &current_hashes,
                );
                let mut buffers = worker.take_buffers();
                capture_prepare_rows(
                    &terminal,
                    &peer,
                    selected,
                    cursor_row,
                    &mut capture,
                    &mut flush_row_cache,
                    &mut buffers.rows,
                );
                let compression =
                    display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
                let completion = prepare_display_off_loop(
                    DisplayPrepareRequest {
                        token: round as u64 + 1,
                        prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
                        prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
                        submitted_at: Instant::now(),
                        perf_flush_started_at: None,
                        generation: peer.generation,
                        display_revision: terminal.display_revision(),
                        completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
                        start_seq: peer.next_datagram_seq,
                        start_frame_id: peer.next_frame_id,
                        presentation_continues: false,
                        causal_input_advanced: false,
                        input_seq: 1,
                        header_signal: terminal.current_display_header_signal(),
                        header_changed: true,
                        header: terminal.current_display_header(merkur_codec::FrameKind::Delta),
                        buffers,
                        compression,
                        compression_dictionary: None,
                        burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
                        summary: flush_summary_for_test(selected.len() as u32),
                    },
                    &mut compressor,
                    &mut fec,
                    &mut scratch,
                );
                if learned {
                    for datagram in &completion.buffers.datagrams {
                        observe_display_compression_outcome(
                            &mut peer,
                            datagram.frame.len(),
                            datagram.raw_bytes,
                            datagram.compression_attempted,
                            datagram.content_class,
                            completion.dictionary_class,
                        );
                    }
                }
                if round + 1 == rounds {
                    let mut domains: Vec<(DisplayUtility, ContentClass, usize, usize)> = Vec::new();
                    for row in &completion.buffers.rows {
                        let class = row.content.class();
                        match domains.last_mut() {
                            Some((utility, last_class, count, bytes))
                                if *utility == row.utility && *last_class == class =>
                            {
                                *count += 1;
                                *bytes += row.encoded_size;
                            }
                            _ => domains.push((row.utility, class, 1, row.encoded_size)),
                        }
                    }
                    let domain_list = domains
                        .iter()
                        .map(|(utility, class, count, bytes)| {
                            format!(
                                "{}/{:?}:{count}r/{bytes}B",
                                if *utility == DisplayUtility::Critical {
                                    "C"
                                } else {
                                    "N"
                                },
                                class
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    let datagrams = &completion.buffers.datagrams;
                    let wire: usize = datagrams.iter().map(|d| d.frame.len()).sum();
                    let raw: usize = datagrams.iter().map(|d| d.raw_bytes).sum();
                    let parity = datagrams
                        .iter()
                        .filter(|d| d.precomputed_fec_repair.is_some())
                        .count();
                    let datagram_list = datagrams
                        .iter()
                        .map(|d| {
                            format!(
                                "{}r/{}B{}",
                                d.encoded_rows,
                                d.frame.len(),
                                if d.frame.len() < d.raw_bytes { "z" } else { "" }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(",");
                    eprintln!(
                        "PARTITION_PROBE workload={label} learned={learned} rows={} domains={} datagrams={} parity={} wire_bytes={wire} raw_bytes={raw} fill_bound={} domain_list=[{domain_list}] datagram_list=[{datagram_list}]",
                        completion.buffers.rows.len(),
                        domains.len(),
                        datagrams.len(),
                        parity,
                        wire.div_ceil(DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES),
                    );
                }
                worker.recycle(completion.buffers);
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum BenchmarkWireRoute {
    Direct,
    Edge,
    Redundant,
}

impl BenchmarkWireRoute {
    const fn name(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Edge => "edge",
            Self::Redundant => "redundant",
        }
    }

    const fn carrier_count(self) -> usize {
        match self {
            Self::Direct | Self::Edge => 1,
            Self::Redundant => 2,
        }
    }
}

struct BenchmarkWireCase {
    route: BenchmarkWireRoute,
    frame: Vec<u8>,
}

struct LegacyWireStage {
    primary: Vec<u8>,
    secondary: Option<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WireAllocationTally {
    allocations: usize,
    bytes: usize,
}

/// Current native ownership model: Noise allocates the sealed frame, then
/// each selected carrier allocates `[channel || sealed]` and copies into it.
fn benchmark_legacy_stage_ciphertext(
    ciphertext: &[u8],
    route: BenchmarkWireRoute,
) -> LegacyWireStage {
    let stage_one = || {
        let mut wire = Vec::with_capacity(1 + ciphertext.len());
        wire.push(CHANNEL_DISPLAY_DATAGRAM);
        wire.extend_from_slice(ciphertext);
        wire
    };
    LegacyWireStage {
        primary: stage_one(),
        secondary: (route.carrier_count() == 2).then(stage_one),
    }
}

/// Benchmark-only reference for the proposed ownership model. Noise writes
/// directly behind the channel byte in the final allocation. A redundant
/// send observes the same immutable bytes twice; it does not clone them.
fn benchmark_fused_seal(peer: &mut PeerDisplayState, plaintext: &[u8]) -> Vec<u8> {
    peer.seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, plaintext)
        .expect("benchmark fused seal")
}

fn benchmark_legacy_allocation_tally(
    plaintext_len: usize,
    route: BenchmarkWireRoute,
) -> WireAllocationTally {
    let ciphertext_len = plaintext_len + crate::e2e::FRAME_OVERHEAD;
    let wire_len = 1 + ciphertext_len;
    let carriers = route.carrier_count();
    WireAllocationTally {
        allocations: 1 + carriers,
        bytes: ciphertext_len + carriers * wire_len,
    }
}

fn benchmark_fused_allocation_tally(plaintext_len: usize) -> WireAllocationTally {
    WireAllocationTally {
        allocations: 1,
        bytes: 1 + plaintext_len + crate::e2e::FRAME_OVERHEAD,
    }
}

fn observe_wire(wire: &[u8]) -> usize {
    let wire = std::hint::black_box(wire);
    wire.len()
        ^ usize::from(wire.first().copied().unwrap_or_default())
        ^ usize::from(wire.last().copied().unwrap_or_default())
}

fn benchmark_legacy_seal_once(
    peer: &mut PeerDisplayState,
    plaintext: &[u8],
    route: BenchmarkWireRoute,
) -> usize {
    let ciphertext = peer
        .seal_datagram(CHANNEL_DISPLAY_DATAGRAM, plaintext)
        .expect("benchmark Noise transport");
    let staged = benchmark_legacy_stage_ciphertext(&ciphertext, route);
    let mut checksum = observe_wire(&staged.primary);
    if let Some(secondary) = staged.secondary.as_deref() {
        checksum ^= observe_wire(secondary);
    }
    checksum
}

fn benchmark_fused_seal_once(
    peer: &mut PeerDisplayState,
    plaintext: &[u8],
    route: BenchmarkWireRoute,
) -> usize {
    let wire = benchmark_fused_seal(peer, plaintext);
    let mut checksum = observe_wire(&wire);
    if route.carrier_count() == 2 {
        checksum ^= observe_wire(&wire);
    }
    checksum
}

/// Build payloads through the production capture/encode/compression path.
/// The smallest and largest ordinary datagrams represent direct and edge
/// single-carrier staging; the smallest critical datagram represents the
/// latency-sensitive frame which is raced over both carriers.
fn benchmark_display_wire_cases() -> Vec<BenchmarkWireCase> {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'w'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let requests: Vec<_> = (0..ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let mut captures = Vec::new();
    capture_prepare_rows(
        &terminal,
        &peer,
        &requests,
        terminal.current_cursor_row(),
        &mut capture_scratch,
        &mut flush_cache,
        &mut captures,
    );
    let mut compressor = Compressor::new();
    let mut prepare_scratch = PrepareScratch::default();
    let mut frames = frame_pool_for_test();
    let mut datagrams = Vec::new();
    build_captured_datagram_batches(
        terminal.display_header_state(),
        &mut terminal,
        &mut peer,
        &captures,
        0,
        true,
        false,
        false,
        1,
        10_000.0,
        &mut compressor,
        &mut prepare_scratch,
        &mut frames,
        &mut datagrams,
    );
    let ordinary = datagrams
        .iter()
        .filter(|datagram| datagram.utility == DisplayUtility::NonCritical)
        .collect::<Vec<_>>();
    let critical = datagrams
        .iter()
        .filter(|datagram| datagram.utility == DisplayUtility::Critical)
        .min_by_key(|datagram| datagram.frame.len())
        .expect("production fixture must produce a critical datagram");
    let direct = ordinary
        .iter()
        .min_by_key(|datagram| datagram.frame.len())
        .expect("production fixture must produce an ordinary datagram");
    let edge = ordinary
        .iter()
        .max_by_key(|datagram| datagram.frame.len())
        .expect("production fixture must produce an ordinary datagram");
    vec![
        BenchmarkWireCase {
            route: BenchmarkWireRoute::Direct,
            frame: direct.frame.clone(),
        },
        BenchmarkWireCase {
            route: BenchmarkWireRoute::Edge,
            frame: edge.frame.clone(),
        },
        BenchmarkWireCase {
            route: BenchmarkWireRoute::Redundant,
            frame: critical.frame.clone(),
        },
    ]
}

#[test]
fn fused_wire_staging_is_byte_exact_and_preserves_noise_invariants() {
    let (mut fused_sender, mut fused_receiver) = benchmark_noise_pair();
    let (mut legacy_sender, mut legacy_receiver) = benchmark_noise_pair();
    let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM)
        .expect("display datagram Noise lane");

    for (expected_counter, case) in benchmark_display_wire_cases().into_iter().enumerate() {
        let fused = benchmark_fused_seal(&mut fused_sender, &case.frame);
        assert_eq!(fused[0], CHANNEL_DISPLAY_DATAGRAM);
        assert_eq!(
            u64::from_be_bytes(fused[1..9].try_into().expect("Noise counter")),
            expected_counter as u64,
            "{} uses the expected equivalent Noise counter state",
            case.route.name()
        );

        // Given the exact ciphertext from that counter, current per-carrier
        // prefix staging and fused staging must produce identical wire bytes.
        let legacy = benchmark_legacy_stage_ciphertext(&fused[1..], case.route);
        assert_eq!(legacy.primary, fused, "{} primary", case.route.name());
        if let Some(secondary) = legacy.secondary.as_ref() {
            assert_eq!(secondary, &fused, "{} secondary", case.route.name());
        }

        assert_eq!(
            fused_receiver
                .open_datagram(lane, &fused[1..])
                .expect("fused wire decrypts"),
            case.frame,
            "{} plaintext round trip",
            case.route.name()
        );
        assert_eq!(
            fused_receiver.open_datagram(lane, &fused[1..]),
            Err(crate::e2e::OpenReject::Replay),
            "{} duplicate is rejected",
            case.route.name()
        );

        // Exercise the legacy allocating seal independently as well. The
        // sessions have different random Noise keys, but start at the same
        // counter and perform exactly one seal per case, matching the A/B.
        let legacy_ciphertext = legacy_sender
            .seal_datagram(CHANNEL_DISPLAY_DATAGRAM, &case.frame)
            .expect("legacy benchmark seal");
        assert_eq!(
            u64::from_be_bytes(
                legacy_ciphertext[..8]
                    .try_into()
                    .expect("legacy Noise counter")
            ),
            expected_counter as u64,
            "{} legacy and fused counter schedules match",
            case.route.name()
        );
        let legacy_wire = benchmark_legacy_stage_ciphertext(&legacy_ciphertext, case.route);
        assert_eq!(
            legacy_receiver
                .open_datagram(lane, &legacy_wire.primary[1..])
                .expect("legacy wire decrypts"),
            case.frame,
            "{} legacy plaintext round trip",
            case.route.name()
        );
        let replay = legacy_wire
            .secondary
            .as_deref()
            .unwrap_or(&legacy_wire.primary);
        assert_eq!(
            legacy_receiver.open_datagram(lane, &replay[1..]),
            Err(crate::e2e::OpenReject::Replay),
            "{} legacy duplicate is rejected",
            case.route.name()
        );

        let legacy_tally = benchmark_legacy_allocation_tally(case.frame.len(), case.route);
        let fused_tally = benchmark_fused_allocation_tally(case.frame.len());
        assert_eq!(legacy_tally.allocations, 1 + case.route.carrier_count());
        assert_eq!(fused_tally.allocations, 1);
        assert!(fused_tally.bytes < legacy_tally.bytes);
    }
}

#[tokio::test]
async fn datagram_fec_repair_uses_the_same_channel_framed_noise_wire() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let repair = b"display-fec-repair".to_vec();

    let mut budget = DatagramPhysicalBudget::exact(0, 1 << 20, 16);
    let sent = send_repair_frame(&mut peer, &repair, 1, 100.0, &mut budget);
    assert!(sent.sent_via.edge);

    let (channel_id, ciphertext) = capture_rx.try_recv().expect("one repair datagram");
    assert_eq!(channel_id, CHANNEL_DISPLAY_DATAGRAM);
    assert_eq!(u64::from_be_bytes(ciphertext[..8].try_into().unwrap()), 0);
    let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    assert_eq!(browser.open_datagram(lane, &ciphertext).unwrap(), repair);
    assert!(capture_rx.try_recv().is_err());
}

#[test]
fn physical_budget_charges_exact_carrier_bytes_and_receiver_packets() {
    let mut budget =
        DatagramPhysicalBudget::exact(100 + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 60, 3);
    assert!(budget.reserve(PeerTransport::WebTransport, 60));
    assert!(budget.reserve(PeerTransport::Edge, 60));
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(40 + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 0, 1,)
            .with_reserved_datagrams(1, 1),
    );
    assert!(
        !budget.reserve(PeerTransport::WebTransport, 41),
        "sender bytes bind at the exact next byte"
    );
    assert!(budget.reserve(PeerTransport::WebTransport, 40));
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(2, 1),
    );
    budget.release(PeerTransport::WebTransport, 40);
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(40 + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 0, 1,)
            .with_reserved_datagrams(1, 1),
    );
}

#[test]
fn reported_space_for_one_entry_cannot_overadmit_a_second_quinn_datagram() {
    let wire_len = 89;
    let mut one_only = DatagramPhysicalBudget::exact(0, 2 * wire_len, 2);
    assert!(one_only.reserve(PeerTransport::Edge, wire_len));
    assert!(
        !one_only.reserve(PeerTransport::Edge, wire_len),
        "the second entry also owns Quinn's per-datagram metadata"
    );

    let mut exact_two =
        DatagramPhysicalBudget::exact(0, 2 * wire_len + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 2);
    assert!(exact_two.reserve(PeerTransport::Edge, wire_len));
    assert!(exact_two.reserve(PeerTransport::Edge, wire_len));
    assert_eq!(exact_two.edge_bytes, 0);
    assert_eq!(exact_two.receiver_packets, 0);
}

#[tokio::test]
async fn loss_enabled_one_frame_group_replays_the_exact_sealed_wire_on_its_sole_path() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.display_cache.resize(2, 8);
    peer.display_cache
        .fec_evidence
        .get_mut(PeerTransport::Edge)
        .observe(
            DisplayDatagramProtection::Unprotected,
            crate::connection::DisplayDatagramOutcome::Lost,
        );
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let datagram = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::NonCritical);
    let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
    let mut group = [datagram];
    let mut pool = frame_pool_for_test();
    let mut budget =
        DatagramPhysicalBudget::exact(0, 2 * wire_len + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 2);

    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);
    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: true,
            original_admitted: true,
            stop: false,
            presentation_end_admitted: true,
            probe_path: None,
        }
    );

    let first = capture_rx.try_recv().expect("data copy");
    let second = capture_rx.try_recv().expect("exact replay");
    assert_eq!(first, second, "k=1 must reuse ciphertext and Noise counter");
    assert!(capture_rx.try_recv().is_err());
    let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    let plain = browser
        .open_datagram(lane, &first.1)
        .expect("first copy opens");
    assert_eq!(plain, group[0].frame);
    let header = merkur_codec::parse_frame_header(&plain).unwrap();
    assert!(header.presentation_coherent && header.presentation_end);
    assert_eq!(
        (
            header.presentation_member_index,
            header.presentation_member_count
        ),
        (0, 1)
    );
    assert_eq!(plain[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED, 0);
    assert_eq!(
        browser.open_datagram(lane, &second.1),
        Err(crate::e2e::OpenReject::Replay),
    );
    let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
    assert_eq!(physical.len(), 2);
    assert_eq!(physical[0].role, SimDatagramRole::Data);
    assert_eq!(physical[1].role, SimDatagramRole::Replica);
    assert!(
        physical
            .iter()
            .all(|frame| frame.path == PeerTransport::Edge)
    );
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(0, 2),
    );
}

#[tokio::test]
async fn one_frame_group_adds_no_third_copy_after_dual_admission() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        edge_tx,
    )));
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
        Arc::clone(&peer.peer_id),
        direct_tx,
        None,
    ));
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);

    let mut datagram = prepared_with_utility_for_test(1, 0, DisplayUtility::Critical);
    datagram.frame = vec![0xC3; 64];
    let mut group = [datagram];
    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(89, 89, 2);
    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);
    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: true,
            original_admitted: true,
            stop: false,
            presentation_end_admitted: false,
            probe_path: None,
        }
    );
    let direct_wire = direct_rx.try_recv().expect("direct copy").1;
    let (_, edge_ciphertext) = edge_rx.try_recv().expect("edge copy");
    let mut edge_wire = Vec::with_capacity(1 + edge_ciphertext.len());
    edge_wire.push(CHANNEL_DISPLAY_DATAGRAM);
    edge_wire.extend_from_slice(&edge_ciphertext);
    assert_eq!(direct_wire, edge_wire);
    assert!(direct_rx.try_recv().is_err());
    assert!(edge_rx.try_recv().is_err());
    let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
    assert_eq!(physical.len(), 2);
    assert!(
        physical
            .iter()
            .all(|frame| frame.role == SimDatagramRole::Data)
    );
    assert!(
        physical
            .iter()
            .any(|frame| frame.path == PeerTransport::WebTransport)
    );
    assert!(
        physical
            .iter()
            .any(|frame| frame.path == PeerTransport::Edge)
    );
}

#[tokio::test]
async fn cross_carrier_k1_advances_once_and_records_protected_provenance() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        edge_tx,
    )));
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
        Arc::clone(&peer.peer_id),
        direct_tx,
        None,
    ));
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
    peer.paths.webtransport.seed_rtt(5.0);
    peer.paths.edge.seed_rtt(20.0);
    let owner = pick_path(
        &peer.paths,
        SendIntent::Redundant,
        100.0,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    )
    .primary();
    peer.display_cache.fec_evidence.get_mut(owner).observe(
        DisplayDatagramProtection::Unprotected,
        crate::connection::DisplayDatagramOutcome::Lost,
    );
    assert!(
        peer.display_cache
            .fec_evidence
            .get(owner)
            .replication_enabled()
    );
    let progress_before = peer
        .display_cache
        .fec_evidence
        .get(owner)
        .replication_progress();

    let datagram = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::Critical);
    let seq = datagram.seq;
    let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
    let mut group = [datagram];
    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(wire_len, wire_len, 2);
    let admitted = admit_prepared_physical_prefix(
        &mut peer,
        &mut group,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &mut budget,
    );
    assert_eq!(admitted, 1);
    assert_eq!(group[0].physical_plan.k1_protection_path, Some(owner));
    assert_eq!(
        group[0].physical_plan.data_paths,
        SentPaths {
            webtransport: true,
            edge: true,
        }
    );
    assert_eq!(group[0].physical_plan.replica_path, None);
    assert_eq!(
        peer.display_cache
            .fec_evidence
            .get(owner)
            .replication_progress(),
        progress_before,
        "planning trials mutate only their copied evidence state",
    );

    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);
    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: true,
            original_admitted: true,
            stop: false,
            presentation_end_admitted: true,
            probe_path: None,
        }
    );
    assert_eq!(
        peer.display_cache
            .fec_evidence
            .get(owner)
            .replication_progress(),
        (progress_before.0 + 1, progress_before.1 + 1, 0),
        "one protected logical group advances exactly once, not once per carrier",
    );
    let record = peer
        .display_cache
        .sent_datagrams
        .get(&seq)
        .expect("sent data record");
    assert_eq!(
        record.protection,
        DisplayDatagramProtection::K1Replicated { owner }
    );
    assert_eq!(
        record.sent_via,
        SentPaths {
            webtransport: true,
            edge: true,
        },
    );
    let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
    assert_eq!(physical.len(), 2);
    assert!(
        physical
            .iter()
            .all(|frame| frame.role == SimDatagramRole::Data),
        "cross-carrier protection is two data submissions, not a third same-path replay",
    );
    assert!(direct_rx.try_recv().is_ok());
    assert!(edge_rx.try_recv().is_ok());
}

#[tokio::test]
async fn cross_carrier_k1_probe_cadence_reaches_clean_disable_without_double_counting() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        edge_tx,
    )));
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
        Arc::clone(&peer.peer_id),
        direct_tx,
        None,
    ));
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
    peer.paths.webtransport.seed_rtt(5.0);
    peer.paths.edge.seed_rtt(20.0);
    let owner = pick_path(
        &peer.paths,
        SendIntent::Redundant,
        100.0,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    )
    .primary();
    peer.display_cache.fec_evidence.get_mut(owner).observe(
        DisplayDatagramProtection::Unprotected,
        crate::connection::DisplayDatagramOutcome::Lost,
    );

    let mut pool = frame_pool_for_test();
    let mut successful_groups = 0u16;
    let mut clean_probes = 0u8;
    for _ in 0..2_048 {
        let decision_before = peer.display_cache.fec_evidence.get_mut(owner).decide_k1();
        assert_ne!(decision_before, K1ProtectionDecision::Single);
        let progress_before = peer
            .display_cache
            .fec_evidence
            .get(owner)
            .replication_progress();
        let datagram = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::Critical);
        let data_seq = datagram.seq;
        let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
        let probe_wire_len =
            sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
        let mut group = [datagram];
        let (webtransport_bytes, edge_bytes) = match owner {
            PeerTransport::WebTransport => (
                wire_len + probe_wire_len + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
                wire_len,
            ),
            PeerTransport::Edge => (
                wire_len,
                wire_len + probe_wire_len + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
            ),
        };
        let mut budget = DatagramPhysicalBudget::exact(webtransport_bytes, edge_bytes, 3);
        let outcome = send_planned_group(
            &mut peer,
            &mut group,
            &mut pool,
            100.0,
            &mut budget,
        );
        assert!(outcome.all_sent && !outcome.stop);
        group[0].physical_plan.probe_path = outcome.probe_path;
        send_prepared_k1_probe_tail(&mut peer, &mut group[0], &mut pool, &mut budget, 100.0);
        successful_groups = successful_groups.saturating_add(1);

        let progress_after_send = peer
            .display_cache
            .fec_evidence
            .get(owner)
            .replication_progress();
        assert_eq!(
            progress_after_send.0,
            progress_before.0 + 1,
            "a successful dual-carrier group advances once",
        );
        let record = peer
            .display_cache
            .sent_datagrams
            .get(&data_seq)
            .expect("data provenance");
        assert_eq!(
            record.protection,
            DisplayDatagramProtection::K1Replicated { owner }
        );
        assert_eq!(
            record.sent_via,
            SentPaths {
                webtransport: true,
                edge: true,
            },
        );

        let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
        assert_eq!(
            physical
                .iter()
                .filter(|frame| frame.role == SimDatagramRole::Data)
                .count(),
            2,
        );
        assert!(
            physical
                .iter()
                .all(|frame| frame.role != SimDatagramRole::Replica),
        );
        let probes: Vec<_> = physical
            .iter()
            .filter(|frame| frame.role == SimDatagramRole::Probe)
            .collect();
        assert_eq!(
            probes.len(),
            usize::from(decision_before == K1ProtectionDecision::ReplicateAndProbe),
            "a probe appears only at the controller's actual interval",
        );
        if let Some(probe) = probes.first() {
            let probe_record = peer
                .display_cache
                .sent_datagrams
                .get(&probe.wire_seq)
                .expect("probe provenance");
            assert_eq!(probe.path, owner);
            assert_eq!(probe_record.protection, DisplayDatagramProtection::K1Probe);
            assert_eq!(probe_record.sent_via, SentPaths::single(owner));
            peer.display_cache.fec_evidence.get_mut(owner).observe(
                DisplayDatagramProtection::K1Probe,
                crate::connection::DisplayDatagramOutcome::Received,
            );
            clean_probes = clean_probes.saturating_add(1);
        }

        while direct_rx.try_recv().is_ok() {}
        while edge_rx.try_recv().is_ok() {}
        if !peer
            .display_cache
            .fec_evidence
            .get(owner)
            .replication_enabled()
        {
            break;
        }
    }

    assert!(
        clean_probes > 1,
        "clean disable must require a probe streak"
    );
    assert!(successful_groups > u16::from(clean_probes));
    assert!(
        !peer
            .display_cache
            .fec_evidence
            .get(owner)
            .replication_enabled(),
        "the successful clean probe streak must disable k=1 replication",
    );
    assert_eq!(
        peer.display_cache
            .fec_evidence
            .get(owner)
            .replication_progress(),
        (0, 0, 0),
    );
}

#[tokio::test]
async fn partial_cross_carrier_k1_copy_is_unprotected_and_does_not_advance() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (edge_tx, edge_rx) = tokio::sync::mpsc::unbounded_channel();
    drop(edge_rx);
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        edge_tx,
    )));
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
        Arc::clone(&peer.peer_id),
        direct_tx,
        None,
    ));
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
    peer.paths.webtransport.seed_rtt(5.0);
    peer.paths.edge.seed_rtt(20.0);
    let owner = pick_path(
        &peer.paths,
        SendIntent::Redundant,
        100.0,
        SessionPolicy::PATH_STALE_THRESHOLD_MS,
    )
    .primary();
    let evidence = peer.display_cache.fec_evidence.get_mut(owner);
    evidence.observe(
        DisplayDatagramProtection::Unprotected,
        crate::connection::DisplayDatagramOutcome::Lost,
    );
    while evidence.decide_k1() != K1ProtectionDecision::ReplicateAndProbe {
        evidence.record_k1_replica_admitted(false);
    }
    let progress_before = evidence.replication_progress();

    let datagram = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::Critical);
    let seq = datagram.seq;
    let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
    let probe_wire_len =
        sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES);
    let mut group = [datagram];
    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(wire_len + probe_wire_len, wire_len, 3);
    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);

    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: false,
            original_admitted: true,
            stop: true,
            presentation_end_admitted: true,
            probe_path: None,
        },
        "one delivered data copy is progress but not fulfilled k=1 protection",
    );
    let header = merkur_codec::parse_frame_header(&group[0].frame).unwrap();
    assert!(header.presentation_coherent && header.presentation_end);
    assert_eq!(
        (
            header.presentation_member_index,
            header.presentation_member_count
        ),
        (0, 1),
        "a refused protection copy cannot make the admitted original wait for a probe"
    );
    assert!(!peer.presentation_end_owed);
    let record = peer
        .display_cache
        .sent_datagrams
        .get(&seq)
        .expect("partial data provenance");
    assert_eq!(record.sent_via, SentPaths::single(owner));
    assert_eq!(record.protection, DisplayDatagramProtection::Unprotected);
    let progress_after = peer
        .display_cache
        .fec_evidence
        .get(owner)
        .replication_progress();
    assert_eq!(
        progress_after.0, progress_before.0,
        "a failed required copy cannot advance the successful-group counter",
    );
    assert_eq!(progress_after.2, progress_before.2);
    assert_eq!(
        peer.display_cache.fec_evidence.get_mut(owner).decide_k1(),
        K1ProtectionDecision::ReplicateAndProbe,
        "the refused probe remains due",
    );
    let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
    assert_eq!(physical.len(), 1);
    assert_eq!(physical[0].path, owner);
    assert_eq!(physical[0].role, SimDatagramRole::Data);
    let (_, sealed) = direct_rx.try_recv().unwrap();
    let lane = crate::e2e::lane_for_channel(sealed[0]).unwrap();
    let delivered = browser.open_datagram(lane, &sealed[1..]).unwrap();
    assert_eq!(delivered, group[0].frame);
    assert!(direct_rx.try_recv().is_err());
}

#[tokio::test]
async fn redundant_send_keeps_progressing_on_edge_when_direct_budget_is_persistently_full() {
    let (mut peer, _browser) = benchmark_noise_pair();
    let (edge_tx, mut edge_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        edge_tx,
    )));
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
        Arc::clone(&peer.peer_id),
        direct_tx,
        None,
    ));
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
    peer.paths.webtransport.seed_rtt(5.0);
    peer.paths.edge.seed_rtt(20.0);
    let wire = bytes::Bytes::from_static(&[CHANNEL_DISPLAY_DATAGRAM; 89]);

    for _ in 0..3 {
        // Direct is one byte short and the browser has room for exactly one
        // physical packet. Edge admission must therefore remain useful.
        let mut budget = DatagramPhysicalBudget::exact(88, wire.len(), 1);
        let result = send_display_wire_budgeted(
            &mut peer,
            &wire,
            100.0,
            SendIntent::Redundant,
            PhysicalDatagramKind::Data { seq: 1 },
            &mut budget,
        );
        assert_eq!(result.sent_via, SentPaths::single(PeerTransport::Edge));
        assert!(result.budget_refused);
        assert_eq!(
            budget,
            DatagramPhysicalBudget::exact(88, 0, 0).with_reserved_datagrams(0, 1),
        );
    }

    assert!(direct_rx.try_recv().is_err());
    for _ in 0..3 {
        assert!(edge_rx.try_recv().is_ok());
    }
    assert!(edge_rx.try_recv().is_err());
    assert_eq!(peer.paths.webtransport.consecutive_send_failures, 0);
    assert_eq!(peer.sim_datagram_metadata.len(), 3);
    assert!(
        peer.sim_datagram_metadata
            .iter()
            .all(|frame| frame.path == PeerTransport::Edge)
    );
}

#[tokio::test]
async fn required_replica_is_admitted_atomically_before_data_or_burst_tail() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let mut first = prepared_with_utility_for_test(1, 0, DisplayUtility::NonCritical);
    first.frame = vec![0xA1; 80];
    let mut tail = prepared_with_utility_for_test(2, 0, DisplayUtility::Critical);
    tail.frame = vec![0xB2; 80];
    let mut prepared = vec![first, tail];
    let mut pool = frame_pool_for_test();
    peer.display_cache
        .fec_evidence
        .get_mut(PeerTransport::Edge)
        .observe(
            DisplayDatagramProtection::Unprotected,
            crate::connection::DisplayDatagramOutcome::Lost,
        );
    peer.adaptive.receive_queue_datagrams = 1;

    let burst_outcome = send_unpaced_display_burst(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &[0; 4],
    );
    assert!(!burst_outcome.all_sent);
    assert!(!burst_outcome.presentation_end_admitted);
    // `finish_peer_display_flush` applies this exact aggregate once. Keep
    // the group sender free of a second score increment on the same event.
    peer.record_backpressure(!burst_outcome.all_sent);
    assert!(peer.backpressure_score > 0);
    assert!(
        capture_rx.try_recv().is_err(),
        "a k=1 frame is not emitted unprotected when its required replay does not fit"
    );
    assert!(peer.sim_datagram_metadata.is_empty());
}

#[tokio::test]
async fn clipped_burst_keeps_presentation_open_until_a_later_end_is_admitted() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(2, 8);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    peer.adaptive.receive_queue_datagrams = 1;
    let mut prepared = vec![
        valid_header_only_prepared_with_presentation_for_test(
            &mut peer,
            DisplayUtility::NonCritical,
            true,
            false,
        ),
        valid_header_only_prepared_with_presentation_for_test(
            &mut peer,
            DisplayUtility::Critical,
            true,
            true,
        ),
    ];
    let mut pool = frame_pool_for_test();

    let prefix = send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 100.0, &[0; 4]);
    assert!(!prefix.all_sent);
    assert!(!prefix.presentation_end_admitted);
    assert!(peer.presentation_end_owed);
    assert_eq!(
        peer.display_admission_retry.failures, 0,
        "partial progress is not refusal"
    );
    assert!(capture_rx.try_recv().is_ok(), "one independent prefix sent");
    assert!(capture_rx.try_recv().is_err());

    let mut continuation = vec![valid_header_only_prepared_with_presentation_for_test(
        &mut peer,
        DisplayUtility::Critical,
        true,
        true,
    )];
    let ending =
        send_unpaced_display_burst(&mut peer, &mut continuation, &mut pool, 1, 101.0, &[0; 4]);
    assert!(ending.all_sent);
    assert!(ending.presentation_end_admitted);
    assert!(!peer.presentation_end_owed);
    assert!(
        capture_rx.try_recv().is_ok(),
        "later END sent independently"
    );
    assert!(capture_rx.try_recv().is_err());
}

#[tokio::test]
async fn k1_probe_tail_follows_all_originals_across_groups_paths_and_sequence_wrap() {
    use crate::display::policy::DISPLAY_ACK_MASK_WORDS;
    use crate::display::recv::{DisplayAck, handle_display_ack};

    for first in [1, u32::MAX - 2] {
        for path_mode in 0..3 {
            let mixed_paths = path_mode != 0;
            let refuse_secondary = path_mode == 2;
            for group_count in [4, 96] {
                let (mut peer, _browser) = benchmark_noise_pair();
                peer.display_cache.resize(2, 8);
                peer.next_datagram_seq = first;
                peer.adaptive.receive_queue_datagrams = 256;
                let (edge_tx, edge_rx) = mpsc::unbounded_channel();
                let _edge_rx = (!refuse_secondary).then_some(edge_rx);
                peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
                    edge_tx,
                )));
                let (direct_tx, _direct_rx) = mpsc::unbounded_channel();
                if mixed_paths {
                    peer.direct_session = Some(crate::webtransport::DirectSession::new_capture(
                        Arc::clone(&peer.peer_id),
                        direct_tx,
                        None,
                    ));
                    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
                    peer.paths.webtransport.seed_rtt(5.0);
                    peer.paths.edge.seed_rtt(20.0);
                }
                for path in [PeerTransport::Edge, PeerTransport::WebTransport] {
                    let evidence = peer.display_cache.fec_evidence.get_mut(path);
                    evidence.observe(
                        DisplayDatagramProtection::Unprotected,
                        crate::connection::DisplayDatagramOutcome::Lost,
                    );
                    for _ in 0..32 {
                        evidence.record_k1_replica_admitted(false);
                    }
                    assert_eq!(
                        evidence.decide_k1(),
                        K1ProtectionDecision::ReplicateAndProbe
                    );
                }
                let mut prepared: Vec<_> = (0..group_count)
                    .map(|index| {
                        valid_header_only_prepared_for_test(
                            &mut peer,
                            if refuse_secondary || (mixed_paths && index % 2 == 1) {
                                DisplayUtility::Critical
                            } else {
                                DisplayUtility::NonCritical
                            },
                        )
                    })
                    .collect();
                let original_ids: Vec<_> = prepared.iter().map(|frame| frame.seq).collect();
                let last_original = *original_ids.last().unwrap();
                let reserved_tip = peer.next_datagram_seq;
                let mut pool = frame_pool_for_test();
                let outcome = send_unpaced_display_burst(
                    &mut peer,
                    &mut prepared,
                    &mut pool,
                    1,
                    100.0,
                    &[0; 4],
                );
                assert!(prepared.is_empty());
                let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
                if refuse_secondary {
                    assert!(!outcome.all_sent);
                    assert!(outcome.presentation_end_admitted);
                    assert_eq!(physical.len(), 1);
                    assert_eq!(physical[0].role, SimDatagramRole::Data);
                    assert_eq!(physical[0].wire_seq, first);
                    assert_eq!(physical[0].path, PeerTransport::WebTransport);
                    assert_eq!(peer.next_datagram_seq, first.wrapping_add(1).max(1));
                    assert_ne!(
                        peer.next_datagram_seq, reserved_tip,
                        "only never-attempted groups are reclaimed; the failed protection earns no probe"
                    );
                    continue;
                }
                assert!(outcome.all_sent);
                let first_probe = physical
                    .iter()
                    .position(|frame| frame.role == SimDatagramRole::Probe)
                    .expect("prepaid probe was admitted");
                let sent_original_ids: Vec<_> = physical[..first_probe]
                    .iter()
                    .filter(|frame| frame.role == SimDatagramRole::Data)
                    .map(|frame| frame.wire_seq)
                    .fold(Vec::new(), |mut ids, seq| {
                        if ids.last() != Some(&seq) {
                            ids.push(seq);
                        }
                        ids
                    });
                assert_eq!(
                    sent_original_ids, original_ids,
                    "no probe may supply later-ACK evidence before every original was attempted"
                );
                assert!(
                    physical[first_probe..]
                        .iter()
                        .all(|frame| frame.role == SimDatagramRole::Probe)
                );
                assert!(
                    physical.windows(2).all(|pair| {
                        pair[1].wire_seq.wrapping_sub(pair[0].wire_seq) < 0x8000_0000
                    })
                );
                if mixed_paths {
                    for path in [PeerTransport::Edge, PeerTransport::WebTransport] {
                        assert!(physical.iter().any(|frame| frame.path == path));
                    }
                }
                let probes = &physical[first_probe..];
                if group_count == 96 {
                    assert!(probes.len() >= 3);
                    // Separate and reordered ACKs retain the original until
                    // three actually later physical probes prove progress.
                    let mut applied = Vec::new();
                    let mut largest_index = 0;
                    for probe_index in [1, 0, 2] {
                        applied.push(probes[probe_index].wire_seq);
                        largest_index = largest_index.max(probe_index);
                        let head = probes[largest_index].wire_seq;
                        let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
                        for &seq in &applied {
                            let offset = head.wrapping_sub(seq) as usize;
                            mask[offset / 32] |= 1 << (offset % 32);
                        }
                        let generation = peer.generation;
                        handle_display_ack(
                            &mut peer,
                            DisplayAck::new(generation, head, mask),
                            101.0,
                            PeerTransport::Edge,
                            &[0; 8],
                            false,
                        );
                        assert_eq!(
                            peer.display_cache
                                .sent_datagrams
                                .contains_key(&last_original),
                            applied.len() < 3
                        );
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn k1_original_membership_is_truthful_before_raw_or_compressed_copies_are_sealed() {
    for compressed in [false, true] {
        for (coherent, end) in [(false, true), (true, true), (true, false)] {
            for probe_capacity in [false, true] {
                let (mut peer, mut browser) = benchmark_noise_pair();
                peer.display_cache.resize(120, 8);
                peer.latest_input_seq = 77;
                let (tx, mut rx) = mpsc::unbounded_channel();
                peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
                let evidence = peer.display_cache.fec_evidence.get_mut(PeerTransport::Edge);
                evidence.observe(
                    DisplayDatagramProtection::Unprotected,
                    crate::connection::DisplayDatagramOutcome::Lost,
                );
                while evidence.decide_k1() != K1ProtectionDecision::ReplicateAndProbe {
                    evidence.record_k1_replica_admitted(false);
                }

                let mut datagram = valid_header_only_prepared_with_presentation_for_test(
                    &mut peer,
                    DisplayUtility::Critical,
                    coherent,
                    end,
                );
                let mut header = merkur_codec::parse_frame_header(&datagram.frame).unwrap();
                header.cols = 120;
                header.cursor_col = 1;
                header.row_count = 1;
                // A K1 physical group can be a member of a larger logical
                // presentation; keep that global metadata byte-exact.
                header.presentation_member_index = if coherent { 2 } else { 0 };
                header.presentation_member_count = if coherent { 3 } else { 0 };
                let row = heterogeneous_prepare_row(0, true).sent;
                let expected_hash = row.hash;
                encode_frame_into(
                    &mut datagram.frame,
                    &header,
                    std::iter::once(RowRef {
                        graphics: &[],
                        row_index: 0,
                        left: 0,
                        cells: &row.cells,
                    }),
                );
                patch_stream_header(
                    &mut datagram.frame,
                    datagram.seq,
                    peer.generation,
                    peer.latest_input_seq,
                    datagram.frame_id,
                    header.presentation_id,
                    coherent,
                    end,
                    0,
                    1,
                    header.presentation_member_index,
                    header.presentation_member_count,
                )
                .unwrap();
                datagram.header_signal =
                    (120u128 << 80) | (8u128 << 64) | (1u128 << 48) | (1u128 << 16);
                datagram.encoded_rows = 1;
                datagram.rows.push(SentRow::from(&row));
                datagram.raw_bytes = datagram.frame.len();
                if compressed {
                    let mut encoded = Vec::new();
                    assert!(
                        Compressor::new()
                            .compress_display_frame_into(&datagram.frame, None, &mut encoded)
                            .is_some()
                    );
                    datagram.frame = encoded;
                    datagram.compression_attempted = true;
                }
                let body_before =
                    datagram.frame[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..].to_vec();
                let wire_len = sealed_display_datagram_wire_len(datagram.frame.len());
                let mut group = [datagram];
                let mut pool = frame_pool_for_test();
                let mut budget = if probe_capacity {
                    DatagramPhysicalBudget::exact(0, 4096, 64)
                } else {
                    DatagramPhysicalBudget::exact(
                        0,
                        wire_len * 2 + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
                        2,
                    )
                };
                let outcome = send_planned_group(
                    &mut peer,
                    &mut group,
                    &mut pool,
                    100.0,
                    &mut budget,
                );
                assert!(outcome.all_sent && !outcome.stop);
                assert_eq!(outcome.presentation_end_admitted, end);
                assert_eq!(outcome.probe_path.is_some(), probe_capacity);
                assert_eq!(peer.presentation_end_owed, !end);
                group[0].physical_plan.probe_path = outcome.probe_path;
                send_prepared_k1_probe_tail(
                    &mut peer,
                    &mut group[0],
                    &mut pool,
                    &mut budget,
                    100.0,
                );

                let (channel, original) = rx.try_recv().unwrap();
                let (_, replica) = rx.try_recv().unwrap();
                assert_eq!(
                    original, replica,
                    "both copies seal the restamped bytes once"
                );
                let lane = crate::e2e::lane_for_channel(channel).unwrap();
                let original = browser.open_datagram(lane, &original).unwrap();
                assert_eq!(original, group[0].frame);
                assert_eq!(
                    original[STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES..],
                    body_before,
                    "membership stamping never rewrites raw/compressed row bytes"
                );
                let actual = merkur_codec::parse_frame_header(&original).unwrap();
                assert!(actual.presentation_coherent);
                assert_eq!(actual.presentation_end, end);
                assert_eq!(actual.presentation_id, header.presentation_id);
                assert_eq!(
                    actual.presentation_member_index,
                    if coherent { 2 } else { 0 }
                );
                assert_eq!(
                    actual.presentation_member_count,
                    if coherent { 3 } else { 1 }
                );
                assert_eq!(original[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED, 0);
                assert!(group[0].precomputed_fec_repair.is_none());
                assert_eq!(
                    peer.display_cache.sent_datagrams[&group[0].seq]
                        .rows
                        .iter()
                        .next()
                        .unwrap()
                        .hash,
                    expected_hash
                );
                let probe = probe_capacity.then(|| {
                    let (_, sealed) = rx.try_recv().unwrap();
                    let probe = browser.open_datagram(lane, &sealed).unwrap();
                    let header = merkur_codec::parse_frame_header(&probe).unwrap();
                    assert!(header.presentation_coherent && !header.presentation_end);
                    assert_eq!(header.presentation_member_count, 0);
                    assert_eq!(header.presentation_id, actual.presentation_id);
                    probe
                });
                assert!(rx.try_recv().is_err());
                for probe_first in [false, true] {
                    let mut receiver = term_wasm::Terminal::new_headless(120, 8);
                    let apply = |receiver: &mut term_wasm::Terminal, frame: &[u8]| {
                        let seq = merkur_codec::parse_stream_header(frame).unwrap().seq;
                        let handle = receiver.stage_display_frame_bytes(frame);
                        assert_ne!(handle, 0, "{:?}", receiver.take_last_error());
                        assert!(receiver.validate_staged_frame(handle));
                        assert!(receiver.apply_staged_delta_seq(handle, seq));
                        receiver.release_staged_frame(handle);
                    };
                    if probe_first && let Some(probe) = &probe {
                        apply(&mut receiver, probe);
                    }
                    apply(&mut receiver, &original);
                    if !probe_first && let Some(probe) = &probe {
                        apply(&mut receiver, probe);
                    }
                    assert_eq!(receiver.row_hash(0), expected_hash);
                }
            }
        }
    }
}

#[tokio::test]
async fn k1_probe_tail_refusal_releases_its_reservation_once_without_retracting_data() {
    for refusal in 0..3 {
        let (mut peer, _browser) = benchmark_noise_pair();
        peer.display_cache.resize(2, 8);
        let (tx, rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        let evidence = peer.display_cache.fec_evidence.get_mut(PeerTransport::Edge);
        evidence.observe(
            DisplayDatagramProtection::Unprotected,
            crate::connection::DisplayDatagramOutcome::Lost,
        );
        for _ in 0..32 {
            evidence.record_k1_replica_admitted(false);
        }
        let datagram = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::NonCritical);
        let data_seq = datagram.seq;
        let mut group = [datagram];
        let mut pool = frame_pool_for_test();
        let mut budget = DatagramPhysicalBudget::exact(0, 4096, 64);
        let outcome = send_planned_group(
            &mut peer,
            &mut group,
            &mut pool,
            100.0,
            &mut budget,
        );
        assert!(outcome.all_sent && !outcome.stop && outcome.presentation_end_admitted);
        assert_eq!(outcome.probe_path, Some(PeerTransport::Edge));
        let header = merkur_codec::parse_frame_header(&group[0].frame).unwrap();
        assert!(header.presentation_coherent && header.presentation_end);
        assert_eq!(
            (
                header.presentation_member_index,
                header.presentation_member_count
            ),
            (0, 1)
        );
        assert!(!peer.presentation_end_owed);
        group[0].physical_plan.probe_path = outcome.probe_path;
        match refusal {
            0 => drop(rx), // The carrier rejects the probe, after accepting both data copies.
            1 => peer.noise = None, // Sealing fails closed; no plaintext reaches the carrier.
            _ => group[0].frame.clear(), // Invalid template cannot manufacture a probe.
        }
        let mut expected = budget;
        expected.release(
            PeerTransport::Edge,
            sealed_display_datagram_wire_len(STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES),
        );
        send_prepared_k1_probe_tail(&mut peer, &mut group[0], &mut pool, &mut budget, 100.0);
        assert_eq!(budget, expected);
        assert_eq!(group[0].physical_plan.probe_path, None);
        assert_eq!(peer.last_display_seq_sent, data_seq);
        assert_eq!(peer.sim_datagram_metadata.len(), 2);
        assert!(peer.display_cache.sent_datagrams.contains_key(&data_seq));
        assert_eq!(
            peer.display_cache
                .fec_evidence
                .get_mut(PeerTransport::Edge)
                .decide_k1(),
            K1ProtectionDecision::ReplicateAndProbe
        );
        send_prepared_k1_probe_tail(&mut peer, &mut group[0], &mut pool, &mut budget, 100.0);
        assert_eq!(
            budget, expected,
            "a consumed probe reservation cannot be released twice"
        );
    }
}

#[tokio::test]
async fn clipped_256_original_suffix_is_reclaimed_before_a_k1_probe() {
    for first in [2, u32::MAX - 1] {
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.display_cache.resize(2, 8);
        peer.next_datagram_seq = first;
        peer.last_display_seq_sent = first - 1;
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
        peer.adaptive.receive_queue_datagrams = 3;
        let evidence = peer.display_cache.fec_evidence.get_mut(PeerTransport::Edge);
        evidence.observe(
            DisplayDatagramProtection::Unprotected,
            crate::connection::DisplayDatagramOutcome::Lost,
        );
        for _ in 0..32 {
            evidence.record_k1_replica_admitted(false);
        }
        assert_eq!(
            evidence.decide_k1(),
            K1ProtectionDecision::ReplicateAndProbe
        );
        let mut prepared: Vec<_> = (0..256)
            .map(|_| {
                valid_header_only_prepared_with_presentation_for_test(
                    &mut peer,
                    DisplayUtility::NonCritical,
                    true,
                    true,
                )
            })
            .collect();
        let reserved_tip = peer.next_datagram_seq;
        let mut pool = frame_pool_for_test();
        assert!(
            !send_unpaced_display_burst(&mut peer, &mut prepared, &mut pool, 1, 100.0, &[0; 4],)
                .all_sent
        );
        let (channel, original) = rx.try_recv().unwrap();
        let (_, replica) = rx.try_recv().unwrap();
        let (_, probe) = rx.try_recv().unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(
            original, replica,
            "same-path replay has one identity and ciphertext"
        );
        let lane = crate::e2e::lane_for_channel(channel).unwrap();
        let data = browser.open_datagram(lane, &original).unwrap();
        let probe = browser.open_datagram(lane, &probe).unwrap();
        let probe_header = merkur_codec::parse_frame_header(&probe).unwrap();
        let data_seq = u32::from_be_bytes(data[6..10].try_into().unwrap());
        let probe_seq = u32::from_be_bytes(probe[6..10].try_into().unwrap());
        assert_eq!(data_seq, first);
        assert_eq!(probe_seq, first.wrapping_add(1).max(1));
        assert_eq!(probe_header.presentation_member_count, 0);
        assert_ne!(
            peer.next_datagram_seq, reserved_tip,
            "255 untouched IDs were released"
        );
        let next = valid_header_only_prepared_for_test(&mut peer, DisplayUtility::Critical);
        assert_eq!(next.seq, probe_seq.wrapping_add(1).max(1));
        assert!(
            probe_seq.wrapping_sub(first - 1) < crate::display::policy::DISPLAY_ACK_MASK_WINDOW,
            "the probe cannot expire a real predecessor through unsent IDs"
        );
    }
}

#[test]
fn post_stop_suffix_reclaim_preserves_every_attempt_and_exact_reservation_ownership() {
    for first in [1, u32::MAX - 2] {
        for total in [4usize, 16, 256] {
            for admitted in [total / 2, total] {
                for attempted in [1usize, admitted.min(4), admitted] {
                    for some_sent in [false, true] {
                        let (mut peer, _) = benchmark_noise_pair();
                        peer.display_cache.resize(2, 8);
                        peer.next_datagram_seq = first;
                        let prepared: Vec<_> = (0..total)
                            .map(|_| {
                                valid_header_only_prepared_for_test(
                                    &mut peer,
                                    DisplayUtility::NonCritical,
                                )
                            })
                            .collect();
                        // Exact preflight clip, before any original attempt.
                        reclaim_unadmitted_display_suffix(&mut peer, &prepared, admitted);
                        let admitted_tip = peer.next_datagram_seq;
                        peer.last_display_seq_sent = if some_sent {
                            prepared[attempted - 1].seq
                        } else {
                            0
                        };
                        let next = prepared[attempted - 1].seq.wrapping_add(1).max(1);
                        // A completely failed/stopped FEC group is preserved
                        // in full, not inferred from successful admissions.
                        reclaim_unadmitted_display_suffix(
                            &mut peer,
                            &prepared[..admitted],
                            attempted,
                        );
                        assert_eq!(peer.next_datagram_seq, next);
                        if attempted < admitted {
                            assert_ne!(peer.next_datagram_seq, admitted_tip);
                        }
                        let mut pool = frame_pool_for_test();
                        let (probe_seq, probe) =
                            build_k1_probe_frame(&mut peer, &prepared[0], &mut pool).unwrap();
                        assert_eq!(probe_seq, next);
                        assert!(
                            !prepared[..attempted]
                                .iter()
                                .any(|frame| frame.seq == probe_seq)
                        );
                        pool.put(probe);
                        assert_eq!(peer.next_datagram_seq, probe_seq.wrapping_add(1).max(1));
                    }
                }
            }
        }
    }

    let (mut peer, _) = benchmark_noise_pair();
    let mut prepared: Vec<_> = (0..8)
        .map(|_| valid_header_only_prepared_for_test(&mut peer, DisplayUtility::NonCritical))
        .collect();
    let tip = peer.next_datagram_seq;
    let untouched = prepared[2].seq;
    peer.last_display_seq_sent = untouched;
    reclaim_unadmitted_display_suffix(&mut peer, &prepared, 2);
    assert_eq!(
        peer.next_datagram_seq, tip,
        "already admitted IDs cannot be reclaimed"
    );
    peer.last_display_seq_sent = prepared[1].seq;
    prepared[3].seq = prepared[4].seq;
    reclaim_unadmitted_display_suffix(&mut peer, &prepared, 2);
    assert_eq!(
        peer.next_datagram_seq, tip,
        "noncontiguous suffix evidence fails closed"
    );
}

#[test]
fn unadmitted_suffix_requires_exact_unspent_reservation_tip() {
    let (mut peer, _) = benchmark_noise_pair();
    peer.display_cache.resize(2, 8);
    for first in [1, u32::MAX] {
        peer.last_display_seq_sent = 0;
        peer.next_datagram_seq = first;
        let mut prepared: Vec<_> = (0..256)
            .map(|_| valid_header_only_prepared_for_test(&mut peer, DisplayUtility::Critical))
            .collect();
        let tip = peer.next_datagram_seq;
        peer.next_datagram_seq(); // An intervening owner consumes the tip.
        let newer_tip = peer.next_datagram_seq;
        reclaim_unadmitted_display_suffix(&mut peer, &prepared, 0);
        assert_eq!(peer.next_datagram_seq, newer_tip);
        peer.next_datagram_seq = tip;
        peer.last_display_seq_sent = first;
        reclaim_unadmitted_display_suffix(&mut peer, &prepared, 0);
        assert_eq!(
            peer.next_datagram_seq, tip,
            "never reuse an admitted identity"
        );
        peer.last_display_seq_sent = 0;
        let mut pool = frame_pool_for_test();
        let mut budget = DatagramPhysicalBudget::exact(0, 0, 0);
        assert_eq!(
            admit_prepared_physical_prefix(
                &mut peer,
                &mut prepared,
                &mut pool,
                1,
                100.0,
                &mut budget
            ),
            0
        );
        assert_eq!(
            peer.next_datagram_seq, first,
            "no physical operation ran before reclaiming an empty prefix"
        );
    }
}

#[tokio::test]
async fn reliable_jumbo_admission_reports_presentation_end() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(700, 4);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let mut prepared = vec![build_large_interactive_row_for_test(
        PeerTransport::WebTransport,
        true,
    )];
    assert!(!uses_display_datagram(&prepared[0]));
    assert!(prepared_frame_ends_presentation(&prepared[0]));
    let mut pool = frame_pool_for_test();

    let outcome = send_unpaced_display_burst(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &[0; 4],
    );
    assert!(outcome.all_sent);
    assert!(outcome.presentation_end_admitted);
    let (channel, _) = capture_rx.try_recv().expect("reliable jumbo record");
    assert_eq!(channel, CHANNEL_DISPLAY_COMMIT);
    assert!(capture_rx.try_recv().is_err());
}

/// End-to-end oracle for the inline group's parity: the repair is now
/// encoded over the group's own frames rather than over buffered copies of
/// them, so what matters is that a datagram lost in flight is still
/// reconstructible from the parity that followed it.
#[tokio::test]
async fn inline_group_parity_recovers_a_lost_datagram() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));

    // Distinct, unequal-length frames so parity genuinely depends on each
    // one and on the zero padding to the widest shard.
    let widest = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES + 7;
    let mut frames: Vec<Vec<u8>> = vec![
        vec![0xA1; widest],
        vec![0xB2; STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES],
        vec![0xC3; 57],
    ];
    for (index, frame) in frames.iter_mut().enumerate() {
        frame[merkur_codec::DISPLAY_PATCH_FLAGS_OFFSET] = PATCH_FLAG_PRESENTATION_COHERENT
            | if index + 1 == 3 {
                PATCH_FLAG_PRESENTATION_END
            } else {
                0
            };
        frame[merkur_codec::DISPLAY_PRESENTATION_ID_OFFSET
            ..merkur_codec::DISPLAY_PRESENTATION_ID_OFFSET + 4]
            .copy_from_slice(&73u32.to_be_bytes());
        frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
            .copy_from_slice(&(index as u16).to_be_bytes());
        frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
            ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
            .copy_from_slice(&3u16.to_be_bytes());
    }
    let mut group: Vec<PreparedDisplayDatagram> = frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
            let mut datagram =
                prepared_with_utility_for_test(index as u32 + 1, 0, DisplayUtility::NonCritical);
            datagram.frame = frame.clone();
            datagram
        })
        .collect();

    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(0, 1 << 20, 16);
    assert!(
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget,)
            .all_sent
    );

    let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    let mut opened = Vec::new();
    while let Ok((channel_id, ciphertext)) = capture_rx.try_recv() {
        assert_eq!(channel_id, CHANNEL_DISPLAY_DATAGRAM);
        opened.push(
            browser
                .open_datagram(lane, &ciphertext)
                .expect("sealed frame"),
        );
    }
    // Three data frames plus exactly one parity shard for the group.
    assert_eq!(opened.len(), frames.len() + 1);
    let repair = opened.pop().expect("parity frame");
    assert_eq!(repair[0], merkur_codec::MSG_TYPE_DISPLAY_FEC_REPAIR);
    for (sent, original) in opened.iter().zip(&frames) {
        // Every covered frame is marked FEC-protected, and parity was
        // computed over exactly these post-flag bytes.
        assert_eq!(
            sent[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED,
            DISPLAY_HEADER_FLAG_FEC_PROTECTED
        );
        assert_eq!(sent.len(), original.len());
    }

    let data_count = repair[8] as usize;
    let recovery_count = repair[9] as usize;
    let shard_size = u16::from_be_bytes([repair[10], repair[11]]) as usize;
    assert_eq!(u32::from_be_bytes(repair[4..8].try_into().unwrap()), 1);
    assert_eq!(
        u32::from_be_bytes(repair[12..16].try_into().unwrap()),
        peer.generation
    );
    assert_eq!(data_count, frames.len());
    assert_eq!(recovery_count, DisplayPolicy::FEC_RECOVERY_SHARD_COUNT);
    assert_eq!(shard_size, widest);

    let padded: Vec<Vec<u8>> = opened
        .iter()
        .map(|frame| {
            let mut shard = vec![0u8; shard_size];
            shard[..frame.len()].copy_from_slice(frame);
            shard
        })
        .collect();
    let body = &repair[merkur_codec::DISPLAY_FEC_HEADER_BYTES..];
    let recovery: Vec<&[u8]> = (0..recovery_count)
        .map(|j| &body[j * shard_size..(j + 1) * shard_size])
        .collect();

    // Lose the END-bearing datagram; the parity that rode behind it
    // restores both the independently applicable transformation and its
    // presentation-only advisory bytes.
    let zero = vec![0u8; shard_size];
    let received: Vec<&[u8]> = vec![&padded[0], &padded[1], &zero];
    let mut output = vec![vec![0u8; shard_size]; data_count];
    let restored = {
        let mut output_refs: Vec<&mut [u8]> = output
            .iter_mut()
            .map(|shard| shard.as_mut_slice())
            .collect();
        merkur_fec::decode(0b011, 0b11, &received, &recovery, &mut output_refs)
    };
    assert_eq!(restored, 0b100);
    assert_eq!(output[2], padded[2]);
    assert_eq!(
        u32::from_be_bytes(
            output[2][merkur_codec::DISPLAY_PRESENTATION_ID_OFFSET
                ..merkur_codec::DISPLAY_PRESENTATION_ID_OFFSET + 4]
                .try_into()
                .unwrap()
        ),
        73
    );
    assert_eq!(
        output[2][merkur_codec::DISPLAY_PATCH_FLAGS_OFFSET]
            & (PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END),
        PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END
    );
}

/// Physical admission is group-atomic: no carrier capacity means no
/// FEC-marked data, no fictional repair attempt, and no send bookkeeping.
#[tokio::test]
async fn refused_physical_group_sends_and_records_nothing() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    // No edge tunnel and no live path: every send is refused.
    peer.edge_tunnel = None;

    let frames: Vec<Vec<u8>> = vec![vec![0xA1; 64], vec![0xB2; 40], vec![0xC3; 57]];
    let mut group: Vec<PreparedDisplayDatagram> = frames
        .iter()
        .enumerate()
        .map(|(index, frame)| {
            let mut datagram =
                prepared_with_utility_for_test(index as u32 + 1, 0, DisplayUtility::NonCritical);
            datagram.frame = frame.clone();
            datagram
        })
        .collect();

    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(0, 0, 16);
    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);
    assert!(
        !outcome.all_sent,
        "the group must report that it was refused"
    );
    assert!(
        outcome.stop,
        "a physical-budget refusal must stop the burst"
    );
    assert_eq!(peer.display_cache.waste.datagram_send_failures, 0);
    assert_eq!(
        peer.display_cache.waste.fec_repairs_sent, 0,
        "a refused repair must never be reported as sent",
    );
    assert_eq!(peer.display_cache.waste.fec_repairs_refused, 0);
    assert!(peer.sim_datagram_metadata.is_empty());
}

#[tokio::test]
async fn repair_capacity_is_reserved_before_any_fec_marked_data_is_sent() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let mut group = [
        prepared_with_utility_for_test(1, 64, DisplayUtility::NonCritical),
        prepared_with_utility_for_test(2, 64, DisplayUtility::NonCritical),
    ];
    group[0].frame = vec![0xA1; 64];
    group[1].frame = vec![0xB2; 64];
    let mut pool = frame_pool_for_test();
    // Exactly two 64-byte plaintext data frames plus the 25-byte final
    // channel/Noise overhead. Sender bytes and receiver packets are both
    // exhausted before the repair is considered.
    let mut budget =
        DatagramPhysicalBudget::exact(0, 2 * 89 + QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES, 2);
    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);
    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: false,
            original_admitted: false,
            stop: true,
            presentation_end_admitted: false,
            probe_path: None,
        }
    );
    peer.record_backpressure(!outcome.all_sent);
    assert!(peer.backpressure_score > 0);
    assert!(peer.sim_datagram_metadata.is_empty());
    assert_eq!(peer.display_cache.waste.fec_repairs_refused, 0);
    assert!(capture_rx.try_recv().is_err());
}

#[tokio::test]
async fn exact_fec_group_budget_always_carries_its_parity() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let mut group = [
        valid_header_only_prepared_with_presentation_for_test(
            &mut peer,
            DisplayUtility::NonCritical,
            true,
            false,
        ),
        valid_header_only_prepared_with_presentation_for_test(
            &mut peer,
            DisplayUtility::NonCritical,
            true,
            true,
        ),
    ];
    let data_wire_len = sealed_display_datagram_wire_len(group[0].frame.len());
    assert_eq!(group[0].frame.len(), group[1].frame.len());
    let repair_wire_len = sealed_display_datagram_wire_len(
        DISPLAY_FEC_HEADER_BYTES + DisplayPolicy::FEC_RECOVERY_SHARD_COUNT * group[0].frame.len(),
    );
    let mut pool = frame_pool_for_test();
    let mut budget = DatagramPhysicalBudget::exact(
        0,
        2 * data_wire_len + repair_wire_len + 2 * QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
        3,
    );

    let outcome =
        send_planned_group(&mut peer, &mut group, &mut pool, 100.0, &mut budget);

    assert_eq!(
        outcome,
        GroupSendOutcome {
            all_sent: true,
            original_admitted: true,
            stop: false,
            presentation_end_admitted: true,
            probe_path: None,
        }
    );
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(0, 3),
    );
    let physical: Vec<_> = peer.sim_datagram_metadata.drain(..).collect();
    assert_eq!(physical.len(), 3);
    assert_eq!(physical[0].role, SimDatagramRole::Data);
    assert_eq!(physical[1].role, SimDatagramRole::Data);
    assert_eq!(physical[2].role, SimDatagramRole::Repair);
    assert_eq!(peer.display_cache.waste.fec_repairs_sent, 1);
    assert!(capture_rx.try_recv().is_ok());
    assert!(capture_rx.try_recv().is_ok());
    assert!(capture_rx.try_recv().is_ok());
    assert!(capture_rx.try_recv().is_err());
}

#[test]
fn post_encode_admission_uses_the_maximal_complete_prefix_and_opens_its_presentation() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let mut prepared: Vec<_> = (1..=3)
        .map(|seq| {
            let mut datagram = prepared_with_utility_for_test(seq, 80, DisplayUtility::NonCritical);
            datagram.frame = vec![0xA0 | seq as u8; 80];
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] =
                PATCH_FLAG_PRESENTATION_COHERENT | PATCH_FLAG_PRESENTATION_END;
            datagram
        })
        .collect();
    let data_wire_len = sealed_display_datagram_wire_len(80);
    let repair_wire_len = sealed_display_datagram_wire_len(
        DISPLAY_FEC_HEADER_BYTES + DisplayPolicy::FEC_RECOVERY_SHARD_COUNT * 80,
    );
    let mut budget = DatagramPhysicalBudget::exact(
        0,
        2 * data_wire_len + repair_wire_len + 2 * QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
        3,
    );
    let mut pool = frame_pool_for_test();

    let admitted = admit_prepared_physical_prefix(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &mut budget,
    );

    assert_eq!(admitted, 2, "k=2+parity is the largest fitting prefix");
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(0, 3),
    );
    assert!(prepared[0].physical_plan.data_paths.edge);
    assert!(prepared[1].physical_plan.data_paths.edge);
    assert!(prepared[1].physical_plan.repair_paths.edge);
    assert!(!prepared[2].physical_plan.data_paths.any());
    assert!(prepared[1].precomputed_fec_repair.is_some());
    for (index, datagram) in prepared[..admitted].iter().enumerate() {
        assert_eq!(
            u16::from_be_bytes(
                datagram.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                    ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2]
                    .try_into()
                    .unwrap()
            ),
            index as u16
        );
        assert_eq!(
            u16::from_be_bytes(
                datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                    ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2]
                    .try_into()
                    .unwrap()
            ),
            admitted as u16
        );
    }
    for datagram in &prepared {
        assert_ne!(
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_PRESENTATION_COHERENT,
            0,
        );
        assert_eq!(
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_PRESENTATION_END,
            0,
            "a physically clipped redraw must never advertise completion",
        );
    }
    assert_ne!(prepared[0].frame[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED, 0,);
    assert_ne!(prepared[1].frame[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED, 0,);
    assert_eq!(prepared[2].frame[1] & DISPLAY_HEADER_FLAG_FEC_PROTECTED, 0,);
}

fn awaits_grant_stamped(datagram: &PreparedDisplayDatagram) -> bool {
    datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] & PATCH_FLAG_DEMAND_AWAITS_GRANT != 0
}

/// Three coherent END'd frames, each predicted at admission to await a
/// grant, on a peer whose paced run has just spent its only grant.
fn awaiting_burst_for_test() -> (PeerDisplayState, Vec<PreparedDisplayDatagram>) {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let generation = peer.generation;
    peer.display_credit.admit_state(generation, 1, true);
    assert!(
        peer.display_credit
            .awaits_grant(generation, 100.0, peer.adaptive.presentation_period_ms),
        "fixture: a paced run with nothing banked"
    );
    let prepared = (1..=3)
        .map(|seq| {
            let mut datagram = prepared_with_utility_for_test(seq, 80, DisplayUtility::NonCritical);
            datagram.frame = vec![0xA0 | seq as u8; 80];
            datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] = PATCH_FLAG_PRESENTATION_COHERENT
                | PATCH_FLAG_PRESENTATION_END
                | PATCH_FLAG_DEMAND_AWAITS_GRANT;
            datagram
        })
        .collect();
    (peer, prepared)
}

#[test]
fn a_clipped_prefix_never_says_its_remainder_waits_for_a_grant() {
    let (mut peer, mut prepared) = awaiting_burst_for_test();
    let data_wire_len = sealed_display_datagram_wire_len(80);
    let repair_wire_len = sealed_display_datagram_wire_len(
        DISPLAY_FEC_HEADER_BYTES + DisplayPolicy::FEC_RECOVERY_SHARD_COUNT * 80,
    );
    let mut budget = DatagramPhysicalBudget::exact(
        0,
        2 * data_wire_len + repair_wire_len + 2 * QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES,
        3,
    );
    let mut pool = frame_pool_for_test();
    let admitted = admit_prepared_physical_prefix(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &mut budget,
    );
    assert_eq!(admitted, 2, "fixture: the burst is clipped");
    // The remainder is a grant-exempt continuation of this same state.
    assert!(
        prepared
            .iter()
            .all(|datagram| !awaits_grant_stamped(datagram))
    );
    assert!(
        prepared[1].precomputed_fec_repair.is_some(),
        "the clipped prefix's parity covers the restamped bytes"
    );
}

#[test]
fn the_send_instant_settles_whether_a_newer_state_awaits_a_grant() {
    let mut pool = frame_pool_for_test();
    let admit = |peer: &mut PeerDisplayState,
                 prepared: &mut Vec<PreparedDisplayDatagram>,
                 pool: &mut BufferPool| {
        precompute_fec_repairs(
            prepared,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut peer.display_cache.fec_encoder,
            pool,
        );
        assert!(prepared[2].precomputed_fec_repair.is_some());
        let mut budget = DatagramPhysicalBudget::exact(0, 1 << 20, 16);
        let admitted = admit_prepared_physical_prefix(
            peer,
            prepared,
            pool,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            100.0,
            &mut budget,
        );
        assert_eq!(admitted, prepared.len(), "fixture: nothing is clipped");
    };

    // The prediction held: nothing moves, and the worker's parity stands.
    let (mut peer, mut prepared) = awaiting_burst_for_test();
    admit(&mut peer, &mut prepared, &mut pool);
    assert!(prepared.iter().all(awaits_grant_stamped));
    assert!(prepared[2].precomputed_fec_repair.is_some());

    // A grant landed while the worker encoded: the next state may leave at
    // once, so no frame of this one may say otherwise. Parity covered the
    // old flag byte and is rebuilt by the send loop over the new one.
    let (mut peer, mut prepared) = awaiting_burst_for_test();
    let generation = peer.generation;
    assert!(peer.display_credit.observe_grant(generation, 2, true));
    admit(&mut peer, &mut prepared, &mut pool);
    assert!(
        prepared
            .iter()
            .all(|datagram| !awaits_grant_stamped(datagram))
    );
    assert!(
        prepared
            .iter()
            .all(|datagram| datagram.precomputed_fec_repair.is_none())
    );

    // The other way: admitted free, but the free window closed during the
    // encode and nothing is banked.
    let (mut peer, mut prepared) = awaiting_burst_for_test();
    for datagram in &mut prepared {
        datagram.frame[DISPLAY_PATCH_FLAGS_OFFSET] &= !PATCH_FLAG_DEMAND_AWAITS_GRANT;
    }
    admit(&mut peer, &mut prepared, &mut pool);
    assert!(prepared.iter().all(awaits_grant_stamped));
    assert!(
        prepared
            .iter()
            .all(|datagram| datagram.precomputed_fec_repair.is_none())
    );
}

#[test]
fn receiver_packet_budget_counts_parity_and_selects_the_exact_prefix() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.display_cache.resize(8, 2);
    let mut prepared: Vec<_> = (1..=8)
        .map(|seq| {
            let mut datagram = prepared_with_utility_for_test(seq, 80, DisplayUtility::NonCritical);
            datagram.frame = vec![0x80 | seq as u8; 80];
            datagram
        })
        .collect();
    let mut budget = DatagramPhysicalBudget::exact(0, 1 << 20, 9);
    let mut pool = frame_pool_for_test();

    let admitted = admit_prepared_physical_prefix(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &mut budget,
    );

    // k=4 + parity consumes five packets; the remaining four slots admit
    // exactly k=3 + parity, never eight data followed by refused repairs.
    assert_eq!(admitted, 7);
    assert_eq!(budget.receiver_packets, 0);
    assert!(prepared[3].physical_plan.repair_paths.edge);
    assert!(prepared[6].physical_plan.repair_paths.edge);
    assert!(!prepared[7].physical_plan.data_paths.any());
}

#[test]
fn exact_dual_path_plan_charges_every_critical_copy_and_repair_copy() {
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.paths.webtransport = crate::connection::PathHealth::fresh_available(100.0);
    peer.paths.webtransport.consecutive_send_failures = 1;
    peer.display_cache.resize(8, 2);
    let mut prepared: Vec<_> = (1..=2)
        .map(|seq| {
            let mut datagram = prepared_with_utility_for_test(seq, 64, DisplayUtility::Critical);
            datagram.frame = vec![0x60 | seq as u8; 64];
            datagram
        })
        .collect();
    let data_wire_len = sealed_display_datagram_wire_len(64);
    let repair_wire_len = sealed_display_datagram_wire_len(
        DISPLAY_FEC_HEADER_BYTES + DisplayPolicy::FEC_RECOVERY_SHARD_COUNT * 64,
    );
    let per_path = 2 * data_wire_len + repair_wire_len + 2 * QUINN_DATAGRAM_ENTRY_OVERHEAD_BYTES;
    let mut budget = DatagramPhysicalBudget::exact(per_path, per_path, 6);
    let mut pool = frame_pool_for_test();

    let admitted = admit_prepared_physical_prefix(
        &mut peer,
        &mut prepared,
        &mut pool,
        DisplayPolicy::FEC_GROUP_MAX_SIZE,
        100.0,
        &mut budget,
    );

    assert_eq!(admitted, 2);
    assert_eq!(
        budget,
        DatagramPhysicalBudget::exact(0, 0, 0).with_reserved_datagrams(3, 3),
    );
    assert!(
        prepared
            .iter()
            .all(|datagram| datagram.physical_plan.data_paths
                == SentPaths {
                    webtransport: true,
                    edge: true,
                })
    );
    assert_eq!(
        prepared[1].physical_plan.repair_paths,
        SentPaths {
            webtransport: true,
            edge: true,
        }
    );
}

/// Exact allocation oracle for the three per-group allocations this path
/// used to pay: one zeroed wire buffer per seal, one owned payload copy
/// per FEC-covered datagram, and the repair frame itself. All three are now
/// zero: the seal writes into the peer's retained wire buffer and parity
/// writes into the pooled frame the burst hands it.
///
/// Ignored because the counting allocator is process-wide: run it alone.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn steady_group_seal_and_fec_are_allocation_free() {
    use crate::edge_tunnel::test_allocations;
    const SAMPLES: usize = 1_000;

    let (mut peer, _browser) = benchmark_noise_pair();
    let frames: [Vec<u8>; 3] = [vec![0xA1; 900], vec![0xB2; 512], vec![0xC3; 57]];
    let borrowed: Vec<&[u8]> = frames.iter().map(Vec::as_slice).collect();
    let mut encoder = crate::display::fec::FecEncoder::new();
    let mut wire = Vec::new();

    // Warm both retained buffers to the high-water sizes the measured loop
    // uses. Steady state is what production sees; first-frame growth is a
    // one-time cost and is deliberately outside the measured region.
    for frame in &frames {
        peer.seal_datagram_wire_into(&mut wire, CHANNEL_DISPLAY_DATAGRAM, frame)
            .expect("warm-up seal");
    }
    let mut repair = Vec::new();
    assert!(
        encoder.encode_borrowed_group_into(
            1,
            1,
            &borrowed,
            DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            &mut repair,
        ),
        "warm-up repair"
    );
    let repair_bytes = repair.len();
    let wire_high_water = wire.len();

    // 1. Sealing into the retained buffer allocates nothing at all.
    test_allocations::begin();
    for _ in 0..SAMPLES {
        for frame in &frames {
            let wire_len = peer
                .seal_datagram_wire_into(&mut wire, CHANNEL_DISPLAY_DATAGRAM, frame)
                .expect("established transport");
            std::hint::black_box(wire_len);
        }
    }
    let seal_tally = test_allocations::end();
    assert_eq!(seal_tally.allocations, 0, "seal must not allocate");
    assert_eq!(seal_tally.allocated_bytes, 0);
    assert_eq!(wire.len(), wire_high_water, "buffer must not regrow");

    // 2. Parity over borrowed frames into a retained buffer — the pooled
    //    frame the burst hands it — allocates nothing at all.
    test_allocations::begin();
    for _ in 0..SAMPLES {
        assert!(encoder.encode_borrowed_group_into(
            1,
            1,
            &borrowed,
            DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            &mut repair,
        ));
        std::hint::black_box(&repair);
    }
    let parity_tally = test_allocations::end();
    assert_eq!(
        parity_tally.allocations, 0,
        "parity into a retained buffer must allocate nothing at all"
    );
    assert_eq!(parity_tally.allocated_bytes, 0);
    assert_eq!(
        repair.len(),
        repair_bytes,
        "the repair must not change shape"
    );

    // Superseded arms, measured in the same process so the delta is
    // observed rather than asserted. `seal_datagram_wire` is the retained
    // allocating seal; the staging loop reproduces exactly what
    // `FecEncoder::add` did before parity moved to borrowed frames.
    test_allocations::begin();
    for _ in 0..SAMPLES {
        for frame in &frames {
            let sealed = peer
                .seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, frame)
                .expect("established transport");
            std::hint::black_box(sealed);
        }
    }
    let baseline_seal = test_allocations::end();

    // `payloads` was constructed once with the group capacity and the
    // borrowed view was a stack array, so the staging cost was exactly one
    // owned copy per covered datagram — reproduced faithfully here.
    let mut staging: Vec<Vec<u8>> = Vec::with_capacity(merkur_fec::FEC_MAX_DATA);
    test_allocations::begin();
    for _ in 0..SAMPLES {
        for frame in &frames {
            staging.push(frame.to_vec());
        }
        let mut staged = [&[][..]; merkur_fec::FEC_MAX_DATA];
        for (slot, payload) in staged.iter_mut().zip(&staging) {
            *slot = payload;
        }
        let repair = encoder
            .encode_borrowed_group(
                1,
                1,
                &staged[..staging.len()],
                DisplayPolicy::FEC_RECOVERY_SHARD_COUNT,
            )
            .expect("repair frame");
        std::hint::black_box(repair);
        staging.clear();
    }
    let baseline_parity = test_allocations::end();

    println!(
        "seal allocations/frame: {:.3} -> {:.3}; bytes/frame: {:.1} -> {:.1}",
        baseline_seal.allocations as f64 / (SAMPLES * frames.len()) as f64,
        seal_tally.allocations as f64 / (SAMPLES * frames.len()) as f64,
        baseline_seal.allocated_bytes as f64 / (SAMPLES * frames.len()) as f64,
        seal_tally.allocated_bytes as f64 / (SAMPLES * frames.len()) as f64,
    );
    println!(
        "parity allocations/group: {:.3} -> {:.3}; bytes/group: {:.1} -> {:.1}",
        baseline_parity.allocations as f64 / SAMPLES as f64,
        parity_tally.allocations as f64 / SAMPLES as f64,
        baseline_parity.allocated_bytes as f64 / SAMPLES as f64,
        parity_tally.allocated_bytes as f64 / SAMPLES as f64,
    );
    assert!(baseline_seal.allocations > seal_tally.allocations);
    assert!(baseline_parity.allocations > parity_tally.allocations);
}

/// Superseded owner-loop peer access: take the peer out of the map, touch
/// it, put it back. Retained here only as the benchmark's baseline arm.
fn legacy_peer_map_access(
    peers: &mut PeerMap,
    peer_id: &str,
    allow_header_only_delta: bool,
) -> bool {
    let Some((peer_key, mut peer)) = peers.remove_entry(peer_id) else {
        return false;
    };
    let busy = peer.display_prepare_in_flight.is_some();
    if busy {
        peer.needs_full_diff |= allow_header_only_delta;
    }
    peers.insert(peer_key, peer);
    busy
}

/// Production owner-loop peer access.
fn borrowed_peer_map_access(
    peers: &mut PeerMap,
    peer_id: &str,
    allow_header_only_delta: bool,
) -> bool {
    let Some(peer) = peers.get_mut(peer_id) else {
        return false;
    };
    let busy = peer.display_prepare_in_flight.is_some();
    if busy {
        peer.needs_full_diff |= allow_header_only_delta;
    }
    busy
}

fn measure_peer_map_access(
    peers: &mut PeerMap,
    peer_id: &str,
    batch_size: usize,
    access: fn(&mut PeerMap, &str, bool) -> bool,
    checksum: &mut usize,
) -> f64 {
    let started = Instant::now();
    for _ in 0..batch_size {
        *checksum += usize::from(access(peers, peer_id, true));
    }
    started.elapsed().as_nanos() as f64 / batch_size as f64
}

/// Owner-loop cost of reaching one peer in the display map.
///
/// `flush_display` services peers by id, and its most common exits do no
/// display work at all: preparation already in flight for that peer, a
/// cache/terminal dimension mismatch, or nothing selected to send. Those
/// calls used to move the entire `PeerDisplayState` out of the map and back
/// in and hash the peer id twice, so the map access *was* the whole cost.
/// The peer is built by the production constructor, which is what makes the
/// moved size representative rather than a synthetic one.
///
/// Both shapes run in one process, alternating rounds, because the baseline
/// shape no longer exists in production and cannot be measured by checking
/// out an older revision of this file.
#[test]
#[ignore = "production performance workload"]
fn production_peer_map_access_benchmark() {
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(200);
    let batch_size = std::env::var("BENCH_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(2_048);

    // A peer carrying live Noise state and a primed display cache, i.e. the
    // shape the owner loop actually moves.
    let mut peer = benchmark_noise_pair().0;
    peer.display_cache.resize(120, 40);
    peer.display_prepare_in_flight = Some(1);
    let peer_id = peer.peer_id.clone();
    let mut peers: PeerMap = HashMap::new();
    peers.insert(peer_id.clone(), peer);

    let mut legacy_samples = Vec::with_capacity(samples);
    let mut borrowed_samples = Vec::with_capacity(samples);
    let mut checksum = 0usize;

    for _ in 0..batch_size.min(4_096) {
        checksum += usize::from(legacy_peer_map_access(&mut peers, &peer_id, true));
        checksum += usize::from(borrowed_peer_map_access(&mut peers, &peer_id, true));
    }

    // Alternate the order every sample so neither arm systematically owns
    // the warm-cache position.
    for sample in 0..samples {
        let (first, second) = if sample % 2 == 0 {
            (
                legacy_peer_map_access as fn(&mut PeerMap, &str, bool) -> bool,
                borrowed_peer_map_access as fn(&mut PeerMap, &str, bool) -> bool,
            )
        } else {
            (
                borrowed_peer_map_access as fn(&mut PeerMap, &str, bool) -> bool,
                legacy_peer_map_access as fn(&mut PeerMap, &str, bool) -> bool,
            )
        };
        let first_ns =
            measure_peer_map_access(&mut peers, &peer_id, batch_size, first, &mut checksum);
        let second_ns =
            measure_peer_map_access(&mut peers, &peer_id, batch_size, second, &mut checksum);
        if sample % 2 == 0 {
            legacy_samples.push(first_ns);
            borrowed_samples.push(second_ns);
        } else {
            borrowed_samples.push(first_ns);
            legacy_samples.push(second_ns);
        }
    }

    emit_benchmark_metric_with_unit(
        "display-peer-map-access-legacy",
        &mut legacy_samples,
        samples,
        "ns/op",
    );
    emit_benchmark_metric_with_unit(
        "display-peer-map-access-borrowed",
        &mut borrowed_samples,
        samples,
        "ns/op",
    );
    // Exact, measurement-independent counterpart to the timings: the old
    // shape moved the peer twice per access, the new one moves nothing.
    emit_benchmark_exact_metric(
        "display-peer-map-access-legacy-moved-bytes",
        2 * std::mem::size_of::<PeerDisplayState>(),
        samples,
        "bytes/access",
    );
    emit_benchmark_exact_metric(
        "display-peer-map-access-borrowed-moved-bytes",
        0,
        samples,
        "bytes/access",
    );
    std::hint::black_box(checksum);
}

fn measure_wire_staging(
    iterations: usize,
    peer: &mut PeerDisplayState,
    case: &BenchmarkWireCase,
    implementation: fn(&mut PeerDisplayState, &[u8], BenchmarkWireRoute) -> usize,
) -> (f64, usize) {
    let started = Instant::now();
    let mut checksum = 0usize;
    for _ in 0..iterations {
        checksum ^= implementation(peer, &case.frame, case.route);
    }
    (
        started.elapsed().as_nanos() as f64 / iterations as f64,
        checksum,
    )
}

/// Focused sibling of `production_display_pipeline_benchmark`: payloads
/// come from the real display pipeline, while the timed region isolates
/// Noise plus caller-visible channel-prefix allocation/copy ownership.
#[test]
#[ignore = "production performance workload"]
fn production_display_wire_staging_benchmark() {
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(100_000);
    let rounds = std::env::var("BENCH_ROUNDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(9)
        .min(samples);
    let mut checksum = 0usize;

    for case in benchmark_display_wire_cases() {
        let mut legacy_samples = Vec::with_capacity(rounds);
        let mut fused_samples = Vec::with_capacity(rounds);
        for round in 0..rounds {
            let iterations = samples / rounds + usize::from(round < samples % rounds);
            let (mut legacy_peer, mut fused_peer) =
                (benchmark_noise_peer(), benchmark_noise_peer());
            let warmup = iterations.min(64);
            for _ in 0..warmup {
                checksum ^= benchmark_legacy_seal_once(&mut legacy_peer, &case.frame, case.route);
                checksum ^= benchmark_fused_seal_once(&mut fused_peer, &case.frame, case.route);
            }

            let run_legacy = |peer: &mut PeerDisplayState| {
                measure_wire_staging(iterations, peer, &case, benchmark_legacy_seal_once)
            };
            let run_fused = |peer: &mut PeerDisplayState| {
                measure_wire_staging(iterations, peer, &case, benchmark_fused_seal_once)
            };
            if round & 1 == 0 {
                let (legacy_ns, legacy_checksum) = run_legacy(&mut legacy_peer);
                let (fused_ns, fused_checksum) = run_fused(&mut fused_peer);
                legacy_samples.push(legacy_ns);
                fused_samples.push(fused_ns);
                checksum ^= legacy_checksum ^ fused_checksum;
            } else {
                let (fused_ns, fused_checksum) = run_fused(&mut fused_peer);
                let (legacy_ns, legacy_checksum) = run_legacy(&mut legacy_peer);
                legacy_samples.push(legacy_ns);
                fused_samples.push(fused_ns);
                checksum ^= legacy_checksum ^ fused_checksum;
            }
        }

        let prefix = format!("display-wire-staging-{}", case.route.name());
        emit_benchmark_metric_with_unit(
            &format!("{prefix}-legacy"),
            &mut legacy_samples,
            samples,
            "ns/frame",
        );
        emit_benchmark_metric_with_unit(
            &format!("{prefix}-fused"),
            &mut fused_samples,
            samples,
            "ns/frame",
        );
        let legacy_tally = benchmark_legacy_allocation_tally(case.frame.len(), case.route);
        let fused_tally = benchmark_fused_allocation_tally(case.frame.len());
        emit_benchmark_exact_metric(
            &format!("{prefix}-legacy-allocations"),
            legacy_tally.allocations,
            samples,
            "allocations/frame",
        );
        emit_benchmark_exact_metric(
            &format!("{prefix}-fused-allocations"),
            fused_tally.allocations,
            samples,
            "allocations/frame",
        );
        emit_benchmark_exact_metric(
            &format!("{prefix}-legacy-allocated-bytes"),
            legacy_tally.bytes,
            samples,
            "bytes/frame",
        );
        emit_benchmark_exact_metric(
            &format!("{prefix}-fused-allocated-bytes"),
            fused_tally.bytes,
            samples,
            "bytes/frame",
        );
        emit_benchmark_exact_metric(
            &format!("{prefix}-plaintext-bytes"),
            case.frame.len(),
            samples,
            "bytes/frame",
        );
    }

    std::hint::black_box(checksum);
}

struct AsyncDictionaryBenchmarkState {
    terminal: TerminalState,
    compressor: Compressor,
    worker: DisplayPrepareWorker,
    completion_rx: mpsc::Receiver<DisplayPrepareCompletion>,
    peers: PeerMap,
    current_hashes: Vec<u64>,
    flush_row_scratch: FlushRowScratch,
    prepare_scratch: PrepareScratch,
    flush_row_cache: HashMap<u16, CapturedRow>,
    dictionary: Arc<DisplayDictionary>,
}

struct AsyncDictionaryBenchmarkSample {
    owner_submit_ms: f64,
    worker_cpu_ms: f64,
    completion_latency_ms: f64,
    completion: DisplayPrepareCompletion,
}

impl AsyncDictionaryBenchmarkState {
    async fn sample(&mut self) -> AsyncDictionaryBenchmarkSample {
        const PEER_ID: &str = "browser-bench";
        let started = Instant::now();
        let mut perf_timing = PerfTimingTracker::default();
        send_peer_datagram_delta_with_worker(
            &mut self.terminal,
            &mut self.compressor,
            &mut self.worker,
            &mut self.prepare_scratch,
            &mut self.peers,
            PEER_ID,
            10_000.0,
            &self.current_hashes,
            &mut self.flush_row_scratch,
            &mut self.flush_row_cache,
            true,
            &mut perf_timing,
            None,
        );
        let owner_submit_ms = started.elapsed().as_secs_f64() * 1_000.0;
        assert!(
            self.peers[PEER_ID].display_prepare_in_flight.is_some(),
            "production admission must select the async worker"
        );

        let completion = self
            .completion_rx
            .recv()
            .await
            .expect("display worker completion");
        let completion_latency_ms = completion.submitted_at.elapsed().as_secs_f64() * 1_000.0;
        let worker_cpu_ms = completion.cpu_time.as_secs_f64() * 1_000.0;
        let peer = self.peers.get_mut(PEER_ID).expect("benchmark peer");
        assert_eq!(
            peer.display_prepare_in_flight.take(),
            Some(completion.token),
            "completion must own the admitted request"
        );
        // Stop before transport admission. Keeping the immutable ACK
        // baseline and sequence owner unchanged makes every sample the
        // same production-shaped redraw.
        peer.needs_full_diff = true;

        AsyncDictionaryBenchmarkSample {
            owner_submit_ms,
            worker_cpu_ms,
            completion_latency_ms,
            completion,
        }
    }
}

struct AsyncDictionaryWireTally {
    display_bytes: usize,
    fec_bytes: usize,
    datagrams: usize,
    dictionary_frames: usize,
}

impl AsyncDictionaryWireTally {
    fn combined_bytes(&self) -> usize {
        self.display_bytes.saturating_add(self.fec_bytes)
    }
}

fn async_dictionary_benchmark_state() -> AsyncDictionaryBenchmarkState {
    const COLS: u16 = 120;
    // Tall enough that one screen of unstyled rows still saturates
    // `DISPLAY_DICTIONARY_MAX_BYTES`, so the dictionary source truncation
    // path stays covered. At ~248 encoded bytes per 120-column row, 40 rows
    // no longer reach the 16 KiB cap.
    const ROWS: u16 = 70;
    const PEER_ID: &str = "browser-bench";

    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let mut blank_grid = Vec::new();
    let mut blank_hashes = Vec::new();
    terminal.current_grid_into(&mut blank_grid);
    terminal.current_row_hashes_into(&mut blank_hashes);

    // Derive the active dictionary from the immediately preceding screen,
    // then update to structurally similar content. This exercises real row
    // capture, batching, worker compression, and FEC rather than a direct
    // compressor microbenchmark.
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'a'));
    let requests: Vec<_> = (0..ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let mut capture_scratch = RowCaptureScratch::default();
    let mut dictionary_row_cache = HashMap::new();
    let dictionary_rows = capture_rows(
        &terminal,
        requests.iter().map(|request| request.row),
        &mut capture_scratch,
        &mut dictionary_row_cache,
    );
    let mut dictionary_frame = Vec::new();
    let prepared_dictionary = prepare_dictionary_off_loop(
        DictionaryPrepareRequest {
            token: 1,
            display_revision: terminal.display_revision(),
            header: terminal.current_display_header(merkur_codec::FrameKind::Snapshot),
            rows: dictionary_rows,
        },
        &mut dictionary_frame,
        &mut DictionaryScratch::default(),
    );
    assert_eq!(
        prepared_dictionary.source.len(),
        DISPLAY_DICTIONARY_MAX_BYTES,
        "fixture must exercise the calibrated dictionary cap"
    );

    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'b'));
    let mut current_hashes = Vec::new();
    terminal.current_row_hashes_into(&mut current_hashes);

    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    peer.display_cache
        .prime_from_snapshot(&blank_grid, &blank_hashes, &[]);
    peer.needs_snapshot = false;
    peer.display_dictionary_ready = true;
    // One confirmed keystroke ahead of the advertised high-water, so the
    // benchmark exercises the same stale-advertisement path production does.
    peer.latest_input_seq = 1;
    let dictionary = peer
        .dictionary
        .build_next_prepared(
            peer.generation,
            Arc::clone(&prepared_dictionary.source),
            prepared_dictionary.hash,
        )
        .expect("benchmark dictionary");
    assert!(peer.dictionary.acknowledge(dictionary.id));
    assert!(
        peer.dictionary
            .active()
            .is_some_and(|active| Arc::ptr_eq(active, &dictionary)),
        "benchmark dictionary must be acknowledged and active"
    );

    let (worker, completion_rx, _snapshot_completion_rx, _dictionary_completion_rx) =
        start_display_prepare_worker();
    AsyncDictionaryBenchmarkState {
        terminal,
        compressor: Compressor::new(),
        worker,
        completion_rx,
        peers: PeerMap::from([(PEER_ID.into(), peer)]),
        current_hashes,
        flush_row_scratch: FlushRowScratch::default(),
        prepare_scratch: PrepareScratch::default(),
        flush_row_cache: HashMap::new(),
        dictionary,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn async_worker_retains_only_the_dictionary_referenced_by_output_frames() {
    let mut dictionary_state = async_dictionary_benchmark_state();
    let expected_dictionary = Arc::clone(&dictionary_state.dictionary);
    let dictionary_sample = dictionary_state.sample().await;
    assert!(
        dictionary_sample
            .completion
            .buffers
            .datagrams
            .iter()
            .any(|datagram| {
                datagram.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
                    & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT
                    != 0
            })
    );
    assert!(
        dictionary_sample
            .completion
            .compression_dictionary
            .as_ref()
            .is_some_and(|retained| Arc::ptr_eq(retained, &expected_dictionary))
    );

    let mut plain_state = async_dictionary_benchmark_state();
    let peer = plain_state
        .peers
        .get_mut("browser-bench")
        .expect("benchmark peer");
    // Drive the plain arm by giving the peer no dictionary to reference.
    //
    // This used to be manufactured by setting the link to 100 Gbit/s so the
    // batcher's bandwidth term declined compression. That term is gone: the
    // batcher now sizes datagrams by their compressed length, so pricing its
    // own compression against bandwidth split a repaint into more packets on
    // exactly the fastest links (measured 60 datagrams and 46,902 wire bytes
    // at 250 Mbit/s against 12 and 11,037 below it). Clearing the dictionary
    // states the property under test directly — nothing referenced it, so
    // nothing is retained — instead of depending on a policy constant to
    // produce that state as a side effect.
    peer.dictionary.reset();
    let plain_sample = plain_state.sample().await;
    assert!(
        plain_sample
            .completion
            .buffers
            .datagrams
            .iter()
            .all(|datagram| {
                datagram.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
                    & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT
                    == 0
            })
    );
    assert!(plain_sample.completion.compression_dictionary.is_none());
}

fn decode_async_dictionary_benchmark_frame(
    datagram: &PreparedDisplayDatagram,
    dictionary: &DisplayDictionary,
) -> Vec<u8> {
    use merkur_codec::{
        DISPLAY_COMPRESSED_LENGTH_OFFSET, DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET,
        DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD, DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT,
        DISPLAY_HEADER_FLAGS_OFFSET,
    };

    let frame = &datagram.frame;
    let flags = frame[DISPLAY_HEADER_FLAGS_OFFSET];
    if flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD == 0 {
        assert_eq!(frame.len(), datagram.raw_bytes);
        return frame.clone();
    }

    let rows_offset = STREAM_HEADER_BYTES + FRAME_HEADER_BODY_BYTES;
    let declared_rows = u32::from_be_bytes(
        frame[DISPLAY_COMPRESSED_LENGTH_OFFSET..DISPLAY_COMPRESSED_LENGTH_OFFSET + 4]
            .try_into()
            .expect("compressed length"),
    ) as usize;
    let uses_dictionary = flags & DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0;
    if uses_dictionary {
        let generation = u32::from_be_bytes(frame[10..14].try_into().expect("display generation"));
        let id_offset = DISPLAY_DICT_COMPRESSED_PAYLOAD_OFFSET - 8;
        let id = u32::from_be_bytes(
            frame[id_offset..id_offset + 4]
                .try_into()
                .expect("dictionary id"),
        );
        let hash = u32::from_be_bytes(
            frame[id_offset + 4..id_offset + 8]
                .try_into()
                .expect("dictionary hash"),
        );
        assert_eq!(
            (generation, id, hash),
            (dictionary.generation, dictionary.id, dictionary.hash)
        );
    }

    let body = crate::display::compressor::decode_display_payload(
        frame,
        uses_dictionary.then_some(&dictionary.bytes[..]),
    )
    .expect("benchmark display frame must decode");
    assert_eq!(body.len(), declared_rows);
    let mut decoded = Vec::with_capacity(rows_offset.saturating_add(declared_rows));
    decoded.extend_from_slice(&frame[..rows_offset]);
    decoded.extend_from_slice(&body);
    assert_eq!(decoded.len(), datagram.raw_bytes);
    decoded[DISPLAY_HEADER_FLAGS_OFFSET] &=
        !(DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD | DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT);
    decoded
}

fn preflight_async_dictionary_completion(
    state: &mut AsyncDictionaryBenchmarkState,
    completion: &DisplayPrepareCompletion,
) -> AsyncDictionaryWireTally {
    const PEER_ID: &str = "browser-bench";
    let dictionary = Arc::clone(&state.dictionary);
    let peer = state.peers.get_mut(PEER_ID).expect("benchmark peer");
    let mut tally = AsyncDictionaryWireTally {
        display_bytes: 0,
        fec_bytes: 0,
        datagrams: completion.buffers.datagrams.len(),
        dictionary_frames: 0,
    };
    let mut decoded_checksum = 0u64;

    for datagram in &completion.buffers.datagrams {
        let flags = datagram.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET];
        tally.dictionary_frames +=
            usize::from(flags & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD_DICT != 0);
        let decoded = decode_async_dictionary_benchmark_frame(datagram, &dictionary);
        decoded_checksum ^= merkur_codec::hash_bytes(&decoded);
        tally.display_bytes = tally.display_bytes.saturating_add(
            peer.seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, &datagram.frame)
                .expect("benchmark display Noise wire")
                .len(),
        );
        if let Some(repair) = datagram.precomputed_fec_repair.as_ref() {
            tally.fec_bytes = tally.fec_bytes.saturating_add(
                peer.seal_datagram_wire(CHANNEL_DISPLAY_DATAGRAM, repair)
                    .expect("benchmark FEC Noise wire")
                    .len(),
            );
        }
    }

    assert!(tally.datagrams >= DISPLAY_ASYNC_PREPARE_MIN_ROWS);
    std::hint::black_box(decoded_checksum);
    tally
}

/// Production-path oracle for async dictionary propagation.
///
/// The common harness intentionally sees zero dictionary frames before the
/// product change. It still proves both variants decode, exercises the real
/// admission/worker/FEC path, and reports exact post-Noise bytes.
#[tokio::test(flavor = "current_thread")]
#[ignore = "production performance workload"]
async fn production_async_dictionary_pipeline_benchmark() {
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1_000);
    let warmups = std::env::var("BENCH_WARMUPS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100);
    let mut state = async_dictionary_benchmark_state();

    let preflight = state.sample().await;
    let exact = preflight_async_dictionary_completion(&mut state, &preflight.completion);
    drop(preflight);
    for _ in 0..warmups {
        let sample = state.sample().await;
        std::hint::black_box(sample.completion.buffers.datagrams.len());
    }

    let mut owner_submit_samples = Vec::with_capacity(samples);
    let mut worker_cpu_samples = Vec::with_capacity(samples);
    let mut completion_latency_samples = Vec::with_capacity(samples);
    let mut checksum = 0usize;
    for _ in 0..samples {
        let sample = state.sample().await;
        owner_submit_samples.push(sample.owner_submit_ms);
        worker_cpu_samples.push(sample.worker_cpu_ms);
        completion_latency_samples.push(sample.completion_latency_ms);
        checksum ^= sample
            .completion
            .buffers
            .datagrams
            .iter()
            .map(|datagram| {
                datagram.frame.len() + datagram.precomputed_fec_repair.as_ref().map_or(0, Vec::len)
            })
            .sum::<usize>();
    }

    emit_benchmark_metric(
        "display-async-dictionary-owner-submit",
        &mut owner_submit_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-async-dictionary-worker-cpu",
        &mut worker_cpu_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-async-dictionary-completion-latency",
        &mut completion_latency_samples,
        samples,
    );
    emit_benchmark_exact_metric(
        "display-async-dictionary-display-wire-bytes",
        exact.display_bytes,
        samples,
        "bytes/flush",
    );
    emit_benchmark_exact_metric(
        "display-async-dictionary-fec-wire-bytes",
        exact.fec_bytes,
        samples,
        "bytes/flush",
    );
    emit_benchmark_exact_metric(
        "display-async-dictionary-combined-wire-bytes",
        exact.combined_bytes(),
        samples,
        "bytes/flush",
    );
    emit_benchmark_exact_metric(
        "display-async-dictionary-datagrams",
        exact.datagrams,
        samples,
        "datagrams/flush",
    );
    emit_benchmark_exact_metric_with_direction(
        "display-async-dictionary-frames",
        exact.dictionary_frames,
        samples,
        "frames/flush",
        "higher",
    );
    std::hint::black_box(checksum);
}

/// Production-shaped benchmark kept inside the binary crate so it can call
/// the real private display pipeline instead of maintaining a benchmark-only
/// imitation. Run through `scripts/bench-display-pipeline-rust.ts`.
#[test]
#[ignore = "production performance workload"]
fn production_display_pipeline_benchmark() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(200);
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let fixtures = [
        terminal_fixture(COLS, ROWS, b'a'),
        terminal_fixture(COLS, ROWS, b'b'),
    ];
    terminal.apply_bytes(&fixtures[0]);

    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let legacy_acked_grid = vec![CellRepr::BLANK; usize::from(COLS) * usize::from(ROWS)];
    let requests: Vec<DisplayRowRequest> = (0..ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let mut current_hashes = Vec::new();
    let mut dirty_captures = Vec::new();
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let mut compressor = Compressor::new();
    let mut prepare_fec_encoder = crate::display::fec::FecEncoder::new();
    let mut frames = frame_pool_for_test();
    // Retained across samples exactly as production retains them: the
    // owner loop's `PrepareScratch` and one pooled `PrepareBuffers` pair.
    let mut prepare_scratch = PrepareScratch::default();
    let mut captures = Vec::new();
    let mut datagrams = Vec::new();
    let mut pipeline_samples = Vec::with_capacity(samples);
    let mut checksum = 0usize;

    for sample in 0..samples {
        flush_cache.clear();
        let started = Instant::now();
        terminal.apply_bytes(&fixtures[sample & 1]);
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
        for capture in &dirty_captures {
            flush_cache.insert(capture.row, capture.clone());
        }
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        recycle_frames_for_test(&mut datagrams, &mut frames);
        build_captured_datagram_batches(
            terminal.display_header_state(),
            &mut terminal,
            &mut peer,
            &captures,
            0,
            true,
            false,
            false,
            1,
            10_000.0,
            &mut compressor,
            &mut prepare_scratch,
            &mut frames,
            &mut datagrams,
        );
        precompute_fec_repairs(
            &mut datagrams,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut prepare_fec_encoder,
            &mut frames,
        );
        // Seal through the peer's retained wire buffer, exactly as
        // `send_prepared_datagram_group_inner` does, so the measured
        // pipeline includes production's allocation behaviour rather than
        // one fresh wire allocation per frame.
        for datagram in &datagrams {
            let wire = peer
                .seal_display_wire(&datagram.frame)
                .expect("benchmark Noise transport");
            checksum ^= wire.len();
            if let Some(repair) = datagram.precomputed_fec_repair.as_ref() {
                let wire = peer
                    .seal_display_wire(repair)
                    .expect("benchmark Noise FEC transport");
                checksum ^= wire.len();
            }
        }
        pipeline_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }

    // A/B the eliminated repeated-conversion path in the same process.
    let mut legacy_samples = Vec::with_capacity(samples);
    let mut captured_samples = Vec::with_capacity(samples);
    let mut snapshot_legacy_samples = Vec::with_capacity(samples);
    let mut snapshot_one_pass_samples = Vec::with_capacity(samples);
    let mut dictionary_legacy_owner_samples = Vec::with_capacity(samples);
    let mut dictionary_shared_owner_samples = Vec::with_capacity(samples);
    let mut interactive_direct_samples = Vec::with_capacity(samples);
    let mut interactive_enqueue_samples = Vec::with_capacity(samples);
    let mut interactive_roundtrip_samples = Vec::with_capacity(samples);
    let mut interactive_two_row_direct_samples = Vec::with_capacity(samples);
    let mut interactive_two_row_enqueue_samples = Vec::with_capacity(samples);
    let mut interactive_two_row_roundtrip_samples = Vec::with_capacity(samples);
    flush_cache.clear();
    let dictionary_rows = capture_rows(
        &terminal,
        requests.iter().map(|request| request.row),
        &mut capture_scratch,
        &mut flush_cache,
    );
    let mut dictionary_frame = Vec::new();
    let prepared_dictionary = prepare_dictionary_off_loop(
        DictionaryPrepareRequest {
            token: 1,
            display_revision: terminal.display_revision(),
            header: terminal.current_display_header(merkur_codec::FrameKind::Snapshot),
            rows: dictionary_rows,
        },
        &mut dictionary_frame,
        &mut DictionaryScratch::default(),
    );
    let mut legacy_dictionary_states: Vec<_> = (0..8)
        .map(|_| crate::display::compressor::PeerDictionaryState::default())
        .collect();
    let mut shared_dictionary_states: Vec<_> = (0..8)
        .map(|_| crate::display::compressor::PeerDictionaryState::default())
        .collect();
    let mut interactive_rows = Vec::new();
    capture_prepare_rows(
        &terminal,
        &peer,
        &requests[..2],
        terminal.current_cursor_row(),
        &mut capture_scratch,
        &mut flush_cache,
        &mut interactive_rows,
    );
    let interactive_generation = peer.generation;
    let interactive_revision = terminal.display_revision();
    let interactive_header = terminal.current_display_header(merkur_codec::FrameKind::Delta);
    let interactive_prepare_epoch = peer.display_prepare_epoch.load(Ordering::Acquire);
    let interactive_prepare_epoch_fence = Arc::clone(&peer.display_prepare_epoch);
    let make_interactive_request = |token, row_count: usize| DisplayPrepareRequest {
        token,
        prepare_epoch: interactive_prepare_epoch,
        prepare_epoch_fence: Arc::clone(&interactive_prepare_epoch_fence),
        submitted_at: Instant::now(),
        perf_flush_started_at: None,
        generation: interactive_generation,
        display_revision: interactive_revision,
        completed_sync_update_epoch: 0,
        start_seq: 1,
        start_frame_id: 1,
        presentation_continues: false,
        causal_input_advanced: false,
        input_seq: 1,
        header_signal: 0,
        header_changed: false,
        header: interactive_header,
        buffers: PrepareBuffers {
            rows: interactive_rows[..row_count].to_vec(),
            ..Default::default()
        },
        compression: compression_policy_for_test(ROWS, true, ExecutionLane::Interactive),
        compression_dictionary: None,
        burst_group_max_size: 1,
        summary: flush_summary_for_test(1),
    };
    let (
        interactive_worker,
        mut interactive_completions,
        _snapshot_completions,
        _dictionary_completions,
    ) = start_display_prepare_worker();
    for _ in 0..samples {
        flush_cache.clear();
        let started = Instant::now();
        let estimated: usize = requests
            .iter()
            .map(|request| terminal.estimate_row_delta_size(&legacy_acked_grid, *request))
            .sum();
        let (frame, _) = terminal.encode_delta_for_rows(&legacy_acked_grid, &requests, Vec::new());
        let sent = capture_rows(
            &terminal,
            requests.iter().map(|request| request.row),
            &mut capture_scratch,
            &mut flush_cache,
        );
        checksum ^= estimated ^ frame.len() ^ sent.len();
        legacy_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        flush_cache.clear();
        let started = Instant::now();
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        let estimated: usize = captures.iter().map(captured_row_encoded_size).sum();
        let mut frame = Vec::new();
        let sent = encode_captured_rows(
            terminal.current_display_header(merkur_codec::FrameKind::Delta),
            captures.iter(),
            &mut frame,
        );
        checksum ^= estimated ^ frame.len() ^ sent.len();
        captured_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        let (frame, _) = terminal.encode_snapshot_into(Vec::new());
        let mut grid = Vec::new();
        let mut hashes = Vec::new();
        terminal.current_grid_into(&mut grid);
        terminal.current_row_hashes_into(&mut hashes);
        checksum ^= frame.len() ^ grid.len() ^ hashes.len();
        snapshot_legacy_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        let mut grid = Vec::new();
        let mut hashes = Vec::new();
        let (frame, _) = terminal.encode_snapshot_state_into(
            Vec::new(),
            &mut grid,
            &mut hashes,
            &mut Vec::new(),
        );
        checksum ^= frame.len() ^ grid.len() ^ hashes.len();
        snapshot_one_pass_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        for state in &mut legacy_dictionary_states {
            state.reset();
        }
        let started = Instant::now();
        for state in &mut legacy_dictionary_states {
            let (snapshot, _) = terminal.encode_snapshot_into(Vec::new());
            let source = snapshot[STREAM_HEADER_BYTES.min(snapshot.len())..].to_vec();
            checksum ^= state
                .build_next(1, source)
                .map_or(0, |dictionary| dictionary.bytes.len());
        }
        dictionary_legacy_owner_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        for state in &mut shared_dictionary_states {
            state.reset();
        }
        let started = Instant::now();
        for state in &mut shared_dictionary_states {
            checksum ^= state
                .build_next_prepared(
                    1,
                    Arc::clone(&prepared_dictionary.source),
                    prepared_dictionary.hash,
                )
                .map_or(0, |dictionary| dictionary.bytes.len());
        }
        dictionary_shared_owner_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let request = make_interactive_request(1, 1);
        let started = Instant::now();
        std::hint::black_box(prepare_display_off_loop(
            request,
            &mut compressor,
            &mut prepare_fec_encoder,
            &mut prepare_scratch,
        ));
        interactive_direct_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let request = make_interactive_request(1, 1);
        let started = Instant::now();
        interactive_worker
            .interactive_tx
            .try_send(request)
            .expect("interactive worker lane available");
        interactive_enqueue_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        std::hint::black_box(
            interactive_completions
                .blocking_recv()
                .expect("interactive worker completion"),
        );
        interactive_roundtrip_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let request = make_interactive_request(1, 2);
        let started = Instant::now();
        std::hint::black_box(prepare_display_off_loop(
            request,
            &mut compressor,
            &mut prepare_fec_encoder,
            &mut prepare_scratch,
        ));
        interactive_two_row_direct_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let request = make_interactive_request(1, 2);
        let started = Instant::now();
        interactive_worker
            .interactive_tx
            .try_send(request)
            .expect("interactive worker lane available");
        interactive_two_row_enqueue_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        std::hint::black_box(
            interactive_completions
                .blocking_recv()
                .expect("interactive worker completion"),
        );
        interactive_two_row_roundtrip_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }

    emit_benchmark_metric(
        "display-production-pipeline",
        &mut pipeline_samples,
        samples,
    );
    emit_benchmark_metric("display-row-capture-legacy", &mut legacy_samples, samples);
    emit_benchmark_metric(
        "display-row-capture-one-pass",
        &mut captured_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-snapshot-three-pass",
        &mut snapshot_legacy_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-snapshot-one-pass",
        &mut snapshot_one_pass_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-dictionary-owner-legacy-eight-peers",
        &mut dictionary_legacy_owner_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-dictionary-owner-shared-eight-peers",
        &mut dictionary_shared_owner_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-direct-prepare",
        &mut interactive_direct_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-worker-enqueue",
        &mut interactive_enqueue_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-worker-roundtrip",
        &mut interactive_roundtrip_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-two-row-direct-prepare",
        &mut interactive_two_row_direct_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-two-row-worker-enqueue",
        &mut interactive_two_row_enqueue_samples,
        samples,
    );
    emit_benchmark_metric(
        "display-interactive-two-row-worker-roundtrip",
        &mut interactive_two_row_roundtrip_samples,
        samples,
    );
    let baseline_cell_bytes = usize::from(COLS)
        .saturating_mul(usize::from(ROWS))
        .saturating_mul(std::mem::size_of::<CellRepr>());
    emit_benchmark_exact_metric(
        "display-snapshot-baseline-cell-copy-bytes-legacy",
        baseline_cell_bytes.saturating_mul(3),
        samples,
        "bytes/snapshot",
    );
    emit_benchmark_exact_metric(
        "display-snapshot-baseline-cell-copy-bytes",
        baseline_cell_bytes,
        samples,
        "bytes/snapshot",
    );
    emit_benchmark_exact_metric(
        "display-peer-baseline-resident-cell-bytes-legacy",
        baseline_cell_bytes.saturating_mul(3),
        samples,
        "bytes/peer",
    );
    emit_benchmark_exact_metric(
        "display-peer-baseline-resident-cell-bytes",
        baseline_cell_bytes,
        samples,
        "bytes/peer",
    );
    emit_benchmark_exact_metric(
        "display-peer-redundant-flat-grid-allocations-legacy",
        2,
        samples,
        "allocations/peer-resize",
    );
    emit_benchmark_exact_metric(
        "display-peer-redundant-flat-grid-allocations",
        0,
        samples,
        "allocations/peer-resize",
    );
    std::hint::black_box(checksum);
}

/// `fixture` with `links` OSC 8 web links laid evenly across every row. Each
/// redraw emits new regions, as a program re-rendering linked output does;
/// with `fresh_uris` the targets change with the seed too.
fn linked_terminal_fixture(
    cols: u16,
    rows: u16,
    seed: u8,
    links: u16,
    fresh_uris: bool,
) -> Vec<u8> {
    let uri_seed = if fresh_uris { seed } else { 0 };
    let mut fixture = Vec::with_capacity(usize::from(cols) * usize::from(rows) * 2);
    let span = cols / links.max(1);
    for row in 0..rows {
        fixture.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        for col in 0..cols {
            if links > 0 && col % span == 0 && col / span < links {
                if col > 0 {
                    fixture.extend_from_slice(b"\x1b]8;;\x1b\\");
                }
                fixture.extend_from_slice(
                    format!(
                        "\x1b]8;;https://example.com/{uri_seed}/{row}/{}\x1b\\",
                        col / span
                    )
                    .as_bytes(),
                );
            }
            fixture.push(b' ' + ((seed.wrapping_add(row as u8).wrapping_add(col as u8)) % 95));
        }
        if links > 0 {
            fixture.extend_from_slice(b"\x1b]8;;\x1b\\");
        }
    }
    fixture
}

/// What linked rows cost the daemon against the same text without links:
/// the full production prepare (capture, hash, encode, compress, FEC, seal)
/// with every row redrawn, a snapshot encode, and the link table a reset
/// delivers. Same process, same text, so the difference is the links.
#[test]
#[ignore = "benchmark; run with --ignored --nocapture"]
fn production_link_rows_benchmark() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(200);
    let requests: Vec<DisplayRowRequest> = (0..ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    for (name, links, fresh_uris) in [
        ("plain", 0u16, false),
        ("links-8-per-row", 8, false),
        ("link-full-row", 1, false),
        ("links-8-per-row-new-uris", 8, true),
    ] {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
        let fixtures = [
            linked_terminal_fixture(COLS, ROWS, b'a', links, fresh_uris),
            linked_terminal_fixture(COLS, ROWS, b'b', links, fresh_uris),
        ];
        terminal.apply_bytes(&fixtures[0]);
        let mut peer = benchmark_noise_peer();
        peer.display_cache.resize(COLS, ROWS);
        let mut current_hashes = Vec::new();
        let mut dirty_captures = Vec::new();
        let mut capture_scratch = RowCaptureScratch::default();
        let mut flush_cache = HashMap::new();
        let mut compressor = Compressor::new();
        let mut fec_encoder = crate::display::fec::FecEncoder::new();
        let mut frames = frame_pool_for_test();
        let mut prepare_scratch = PrepareScratch::default();
        let mut captures = Vec::new();
        let mut datagrams = Vec::new();
        let mut apply_samples = Vec::with_capacity(samples);
        let mut pipeline_samples = Vec::with_capacity(samples);
        let mut capture_samples = Vec::with_capacity(samples);
        // What `send_link_table_if_changed` would put on one peer's CTRL
        // lane per redraw, summed over the run.
        let mut link_table_sent: Option<(u64, u32)> = None;
        let mut delivered_link_bytes = 0usize;
        let mut delivered_resets = 0usize;
        let mut snapshot_samples = Vec::with_capacity(samples);
        let mut link_table_samples = Vec::with_capacity(samples);
        let mut wire_bytes = 0usize;
        let mut snapshot_bytes = 0usize;
        let mut link_table_bytes = 0usize;

        for sample in 0..samples {
            flush_cache.clear();
            let started = Instant::now();
            terminal.apply_bytes(&fixtures[sample & 1]);
            apply_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            let started = Instant::now();
            terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
            for capture in &dirty_captures {
                flush_cache.insert(capture.row, capture.clone());
            }
            capture_prepare_rows(
                &terminal,
                &peer,
                &requests,
                terminal.current_cursor_row(),
                &mut capture_scratch,
                &mut flush_cache,
                &mut captures,
            );
            capture_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            {
                let table = terminal.link_table();
                let current = (table.generation(), table.newest_id());
                let delivery = match link_table_sent {
                    Some(sent) if sent == current => None,
                    Some((generation, newest)) if generation == current.0 => {
                        Some(encode_link_table_frames(false, table.issued_after(newest)))
                    }
                    _ => {
                        delivered_resets += 1;
                        Some(encode_link_table_frames(true, table.live()))
                    }
                };
                if let Some(frames) = delivery {
                    delivered_link_bytes += frames.iter().map(Vec::len).sum::<usize>();
                }
                link_table_sent = Some(current);
            }
            recycle_frames_for_test(&mut datagrams, &mut frames);
            build_captured_datagram_batches(
                terminal.display_header_state(),
                &mut terminal,
                &mut peer,
                &captures,
                0,
                true,
                false,
                false,
                1,
                10_000.0,
                &mut compressor,
                &mut prepare_scratch,
                &mut frames,
                &mut datagrams,
            );
            precompute_fec_repairs(
                &mut datagrams,
                DisplayPolicy::FEC_GROUP_MAX_SIZE,
                peer.generation,
                &mut fec_encoder,
                &mut frames,
            );
            wire_bytes = 0;
            for datagram in &datagrams {
                wire_bytes += peer
                    .seal_display_wire(&datagram.frame)
                    .expect("benchmark Noise transport")
                    .len();
                if let Some(repair) = datagram.precomputed_fec_repair.as_ref() {
                    wire_bytes += peer
                        .seal_display_wire(repair)
                        .expect("benchmark Noise FEC transport")
                        .len();
                }
            }
            pipeline_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            let started = Instant::now();
            let (frame, _) = terminal.encode_snapshot_into(Vec::new());
            snapshot_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            snapshot_bytes = frame.len();
            std::hint::black_box(frame);

            let started = Instant::now();
            let table = terminal.link_table();
            let frames = encode_link_table_frames(true, table.live());
            drop(table);
            link_table_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            link_table_bytes = frames.iter().map(Vec::len).sum();
        }

        let live_links = terminal.link_table().live().len();
        emit_benchmark_metric(
            &format!("display-links-{name}-vte-apply"),
            &mut apply_samples,
            samples,
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-definition-bytes-per-redraw"),
            delivered_link_bytes / samples,
            samples,
            "bytes/redraw",
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-resets"),
            delivered_resets,
            samples,
            "resets/run",
        );
        emit_benchmark_metric(
            &format!("display-links-{name}-pipeline"),
            &mut pipeline_samples,
            samples,
        );
        emit_benchmark_metric(
            &format!("display-links-{name}-capture"),
            &mut capture_samples,
            samples,
        );
        emit_benchmark_metric(
            &format!("display-links-{name}-snapshot"),
            &mut snapshot_samples,
            samples,
        );
        emit_benchmark_metric(
            &format!("display-links-{name}-link-table-reset"),
            &mut link_table_samples,
            samples,
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-wire-bytes"),
            wire_bytes,
            samples,
            "bytes/frame",
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-snapshot-bytes"),
            snapshot_bytes,
            samples,
            "bytes/snapshot",
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-link-table-bytes"),
            link_table_bytes,
            samples,
            "bytes/reset",
        );
        emit_benchmark_exact_metric(
            &format!("display-links-{name}-live-links"),
            live_links,
            samples,
            "links",
        );
    }
}

#[test]
fn display_prepare_policy_keeps_one_row_inline_and_prioritizes_small_batches() {
    assert!(!display_prepare_is_interactive(0));
    assert!(!display_prepare_is_interactive(1));
    assert!(display_prepare_is_interactive(
        DISPLAY_ASYNC_PREPARE_MIN_ROWS
    ));
    assert!(display_prepare_is_interactive(
        DISPLAY_BULK_PREPARE_MIN_ROWS - 1
    ));
    assert!(!display_prepare_is_interactive(
        DISPLAY_BULK_PREPARE_MIN_ROWS
    ));
}

#[test]
fn prepared_dictionary_source_is_shared_across_peers() {
    let rows: Vec<CapturedRow> = (0..24u16)
        .map(|row| {
            let cells: Arc<[CellRepr]> = (0..120u32)
                .map(|column| CellRepr {
                    codepoint: 0x21 + ((u32::from(row) * 120 + column) % 90),
                    ..CellRepr::BLANK
                })
                .collect::<Vec<_>>()
                .into();
            CapturedRow {
                graphics: PreparedGraphics::EMPTY,
                row,
                hash: merkur_codec::row_hash(&cells),
                cells,
            }
        })
        .collect();
    let mut dictionary_frame = Vec::new();
    let completion = prepare_dictionary_off_loop(
        DictionaryPrepareRequest {
            token: 1,
            display_revision: 9,
            header: FrameHeader {
                memory_only: false,
                kind: merkur_codec::FrameKind::Snapshot,
                cols: 120,
                rows: 24,
                cursor_col: 0,
                cursor_row: 0,
                cursor_shape: 0,
                cursor_visible: 1,
                mode_flags: 0,
                row_count: 0,
                frame_id: 0,
                presentation_id: 0,
                presentation_member_index: 0,
                presentation_member_count: 0,
                row_predecessor_presentation_id: 0,
                presentation_coherent: false,
                presentation_end: false,
                chunk_index: 0,
                chunk_count: 1,
                demand_serial: 0,
                demand_limited: false,
                demand_prompt: false,
                demand_awaits_grant: false,
                closure_digest: 0,
                scroll_serial: 0,
                echo_horizon: 0,
            },
            rows,
        },
        &mut dictionary_frame,
        &mut DictionaryScratch::default(),
    );
    assert!(completion.source.len() >= DISPLAY_DICTIONARY_MIN_BYTES);
    assert!(completion.source.len() <= DISPLAY_DICTIONARY_MAX_BYTES);
    assert_eq!(completion.hash, dictionary_hash(&completion.source));

    let mut first = crate::display::compressor::PeerDictionaryState::default();
    let mut second = crate::display::compressor::PeerDictionaryState::default();
    let first = first
        .build_next_prepared(3, Arc::clone(&completion.source), completion.hash)
        .expect("first dictionary");
    let second = second
        .build_next_prepared(7, Arc::clone(&completion.source), completion.hash)
        .expect("second dictionary");
    assert!(Arc::ptr_eq(&first.bytes, &second.bytes));
    assert_eq!(first.hash, second.hash);
    assert_ne!(first.generation, second.generation);
}

fn terminal_fixture(cols: u16, rows: u16, seed: u8) -> Vec<u8> {
    let mut fixture = Vec::with_capacity(usize::from(cols) * usize::from(rows));
    for row in 0..rows {
        fixture.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        for col in 0..cols {
            fixture.push(b' ' + ((seed.wrapping_add(row as u8).wrapping_add(col as u8)) % 95));
        }
    }
    fixture
}

#[test]
fn owned_display_records_survive_size_changes_and_peer_retirement() {
    let (mut peer, mut browser) = benchmark_noise_pair();
    let mut queued = Vec::new();
    for len in [0usize, 1, 38, 39, 40, 41, 63, 64, 1099, 1100] {
        let plaintext = vec![len as u8; len];
        let direct = peer.seal_display_wire(&plaintext).unwrap();
        let edge = direct.clone();
        assert_eq!(direct.as_ptr(), edge.as_ptr());
        assert_eq!(direct.len(), 1 + crate::e2e::FRAME_OVERHEAD + len);
        queued.push((plaintext, direct, edge));
    }
    // A displaced generation can still be packetizing its immutable owners.
    drop(peer);
    let lane = crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
    for (plaintext, direct, edge) in queued {
        assert_eq!(direct[0], CHANNEL_DISPLAY_DATAGRAM);
        assert_eq!(direct, edge);
        assert_eq!(
            browser.open_datagram(lane, &direct[1..]).unwrap(),
            plaintext
        );
    }
}

/// Paired full seal/pool/admission cost on a real loopback WebTransport
/// carrier. Network draining and decryption are correctness oracles outside
/// the timed, non-yielding owner turn. Copies model scalar replication.
#[tokio::test(flavor = "current_thread")]
#[ignore = "paired release-mode owned display admission profile"]
async fn owned_display_admission_profile() {
    use crate::edge_tunnel::test_allocations;
    use std::hint::black_box;
    use wtransport::{ClientConfig, Endpoint, Identity, ServerConfig};

    for payload_len in [32usize, 231, 1075] {
        for copies in [1usize, 2] {
            let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"]).unwrap();
            let certificate_hash = identity.certificate_chain().as_slice()[0].hash();
            let server = Endpoint::server(
                ServerConfig::builder()
                    .with_bind_default(0)
                    .with_identity(identity)
                    .build(),
            )
            .unwrap();
            let client = Endpoint::client(
                ClientConfig::builder()
                    .with_bind_default()
                    .with_server_certificate_hashes([certificate_hash])
                    .build(),
            )
            .unwrap();
            let server_connect =
                async { server.accept().await.await.unwrap().accept().await.unwrap() };
            let (sender, receiver) = tokio::join!(
                server_connect,
                client.connect(format!(
                    "https://[::1]:{}",
                    server.local_addr().unwrap().port()
                ))
            );
            let receiver = receiver.unwrap();
            let (mut peer, mut browser) = benchmark_noise_pair();
            let mut scratch = Vec::new();
            let plaintext = vec![0x61; payload_len];
            for burst in [1usize, 24] {
                for round in 0..80 {
                    for owned in if round % 2 == 0 {
                        [false, true, true, false]
                    } else {
                        [true, false, false, true]
                    } {
                        // Allocation accounting is a separate pass, never
                        // inside the timing samples.
                        if round == 79 {
                            test_allocations::begin_thread();
                        }
                        let started = Instant::now();
                        for _ in 0..burst {
                            if owned {
                                let wire = peer.seal_display_wire(black_box(&plaintext)).unwrap();
                                for _ in 0..copies {
                                    sender.send_datagram_owned(wire.clone()).unwrap();
                                }
                            } else {
                                let len = peer
                                    .seal_datagram_wire_into(
                                        &mut scratch,
                                        CHANNEL_DISPLAY_DATAGRAM,
                                        black_box(&plaintext),
                                    )
                                    .unwrap();
                                for _ in 0..copies {
                                    sender.send_datagram(&scratch[..len]).unwrap();
                                }
                            }
                        }
                        let ns = started.elapsed().as_nanos() / burst as u128;
                        if round == 79 {
                            let tally = test_allocations::end_thread();
                            println!(
                                "display-owned-alloc bytes={payload_len} copies={copies} burst={burst} owned={owned} allocations={} allocated_bytes={}",
                                tally.allocations, tally.allocated_bytes
                            );
                            if owned {
                                assert_eq!(tally.allocations, 0);
                            }
                        }
                        for _ in 0..burst {
                            let wire = tokio::time::timeout(
                                Duration::from_secs(2),
                                receiver.receive_datagram(),
                            )
                            .await
                            .unwrap()
                            .unwrap();
                            assert_eq!(wire[0], CHANNEL_DISPLAY_DATAGRAM);
                            let lane =
                                crate::e2e::lane_for_channel(CHANNEL_DISPLAY_DATAGRAM).unwrap();
                            assert_eq!(browser.open_datagram(lane, &wire[1..]).unwrap(), plaintext);
                            for _ in 1..copies {
                                let replica = tokio::time::timeout(
                                    Duration::from_secs(2),
                                    receiver.receive_datagram(),
                                )
                                .await
                                .unwrap()
                                .unwrap();
                                assert_eq!(&*replica, &*wire);
                            }
                        }
                        if (20..79).contains(&round) {
                            println!(
                                "display-owned-time bytes={payload_len} copies={copies} burst={burst} owned={owned} round={round} ns={ns}"
                            );
                        }
                    }
                }
            }
        }
    }
}

fn benchmark_noise_peer() -> PeerDisplayState {
    benchmark_noise_pair().0
}

fn benchmark_noise_pair() -> (PeerDisplayState, crate::e2e::NoiseTransport) {
    let psk = [0x11u8; 32];
    let prologue =
        crate::e2e::derive_prologue("display-pipeline-benchmark", "browser-bench", &[0x42; 64]);
    let (browser_static, _) = crate::e2e::generate_static_keypair().expect("browser key");
    let (daemon_static, _) = crate::e2e::generate_static_keypair().expect("daemon key");
    let mut initiator = crate::e2e::NoiseHandshake::new_initiator(&browser_static, &psk, &prologue)
        .expect("initiator");
    let mut responder = crate::e2e::NoiseHandshake::new_responder(&daemon_static, &psk, &prologue)
        .expect("responder");
    responder
        .read_message(&initiator.write_message(b"").expect("message 1"))
        .expect("read message 1");
    initiator
        .read_message(&responder.write_message(b"").expect("message 2"))
        .expect("read message 2");
    responder
        .read_message(&initiator.write_message(b"").expect("message 3"))
        .expect("read message 3");
    let mut peer = PeerDisplayState::new("browser-bench".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(responder.into_transport().expect("transport"));
    (peer, initiator.into_transport().expect("browser transport"))
}

/// Stage decomposition of `production_display_pipeline_benchmark`.
///
/// Diagnostic only: it runs the same production calls in the same order and
/// attributes the flush cost per stage, plus the per-flush allocation tally.
/// Optimizing the pipeline without this attribution risks improving a term
/// that is not the dominant one.
#[test]
#[ignore = "production performance workload"]
fn production_display_pipeline_stage_decomposition() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(200);
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let fixtures = [
        terminal_fixture(COLS, ROWS, b'a'),
        terminal_fixture(COLS, ROWS, b'b'),
    ];
    terminal.apply_bytes(&fixtures[0]);

    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let requests: Vec<DisplayRowRequest> = (0..ROWS)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let mut current_hashes = Vec::new();
    let mut dirty_captures = Vec::new();
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let mut compressor = Compressor::new();
    let mut prepare_fec_encoder = crate::display::fec::FecEncoder::new();
    let mut frames = frame_pool_for_test();
    // Retained across samples exactly as production retains them: the
    // owner loop's `PrepareScratch` and one pooled `PrepareBuffers` pair.
    let mut prepare_scratch = PrepareScratch::default();
    let mut captures = Vec::new();
    let mut datagrams = Vec::new();
    let mut checksum = 0usize;

    let mut apply_samples = Vec::with_capacity(samples);
    let mut hash_samples = Vec::with_capacity(samples);
    let mut capture_samples = Vec::with_capacity(samples);
    let mut batch_samples = Vec::with_capacity(samples);
    let mut fec_samples = Vec::with_capacity(samples);
    let mut seal_samples = Vec::with_capacity(samples);

    // One untimed warm pass so first-touch growth is not attributed to a
    // steady-state stage.
    for sample in 0..samples.min(4) {
        flush_cache.clear();
        terminal.apply_bytes(&fixtures[sample & 1]);
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
        for capture in &dirty_captures {
            flush_cache.insert(capture.row, capture.clone());
        }
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        recycle_frames_for_test(&mut datagrams, &mut frames);
        build_captured_datagram_batches(
            terminal.display_header_state(),
            &mut terminal,
            &mut peer,
            &captures,
            0,
            true,
            false,
            false,
            1,
            10_000.0,
            &mut compressor,
            &mut prepare_scratch,
            &mut frames,
            &mut datagrams,
        );
        precompute_fec_repairs(
            &mut datagrams,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut prepare_fec_encoder,
            &mut frames,
        );
        std::hint::black_box(&datagrams);
    }

    for sample in 0..samples {
        flush_cache.clear();

        let started = Instant::now();
        terminal.apply_bytes(&fixtures[sample & 1]);
        apply_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
        for capture in &dirty_captures {
            flush_cache.insert(capture.row, capture.clone());
        }
        hash_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        capture_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        recycle_frames_for_test(&mut datagrams, &mut frames);
        build_captured_datagram_batches(
            terminal.display_header_state(),
            &mut terminal,
            &mut peer,
            &captures,
            0,
            true,
            false,
            false,
            1,
            10_000.0,
            &mut compressor,
            &mut prepare_scratch,
            &mut frames,
            &mut datagrams,
        );
        batch_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        precompute_fec_repairs(
            &mut datagrams,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut prepare_fec_encoder,
            &mut frames,
        );
        fec_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

        let started = Instant::now();
        for datagram in &datagrams {
            let wire = peer
                .seal_display_wire(&datagram.frame)
                .expect("benchmark Noise transport");
            checksum ^= wire.len();
            if let Some(repair) = datagram.precomputed_fec_repair.as_ref() {
                let wire = peer
                    .seal_display_wire(repair)
                    .expect("benchmark Noise FEC transport");
                checksum ^= wire.len();
            }
        }
        seal_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
    }

    // Exact shape of the flush the timings above describe.
    let mut shape_datagrams = 0usize;
    let mut shape_repairs = 0usize;
    let mut shape_plaintext_bytes = 0usize;
    let shape_row_bytes;
    {
        flush_cache.clear();
        terminal.apply_bytes(&fixtures[0]);
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
        for capture in &dirty_captures {
            flush_cache.insert(capture.row, capture.clone());
        }
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        recycle_frames_for_test(&mut datagrams, &mut frames);
        build_captured_datagram_batches(
            terminal.display_header_state(),
            &mut terminal,
            &mut peer,
            &captures,
            0,
            true,
            false,
            false,
            1,
            10_000.0,
            &mut compressor,
            &mut prepare_scratch,
            &mut frames,
            &mut datagrams,
        );
        precompute_fec_repairs(
            &mut datagrams,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut prepare_fec_encoder,
            &mut frames,
        );
        for datagram in &datagrams {
            shape_datagrams += 1;
            shape_plaintext_bytes += datagram.frame.len();
            if let Some(repair) = datagram.precomputed_fec_repair.as_ref() {
                shape_repairs += 1;
                shape_plaintext_bytes += repair.len();
            }
        }
        shape_row_bytes = captures.iter().map(captured_row_encoded_size).sum();
        // What the allocation tally below is made of: one `Arc` capture
        // per dirty row, and one heap spill per datagram carrying more
        // rows than `SentRows` holds inline.
        println!(
            "display-stage-shape: dirty rows captured={} rows per datagram={:?} \
             datagrams spilling past {} inline rows={}",
            dirty_captures.len(),
            datagrams
                .iter()
                .map(|datagram| datagram.rows.len())
                .collect::<Vec<_>>(),
            crate::connection::INLINE_SENT_ROWS,
            datagrams
                .iter()
                .filter(|datagram| datagram.rows.len() > crate::connection::INLINE_SENT_ROWS)
                .count(),
        );
    }
    emit_benchmark_exact_metric_with_direction(
        "display-stage-encoded-row-bytes",
        shape_row_bytes,
        1,
        "bytes/flush",
        "lower",
    );
    emit_benchmark_exact_metric_with_direction(
        "display-stage-datagrams",
        shape_datagrams,
        1,
        "datagrams/flush",
        "lower",
    );
    emit_benchmark_exact_metric_with_direction(
        "display-stage-repairs",
        shape_repairs,
        1,
        "repairs/flush",
        "lower",
    );
    emit_benchmark_exact_metric_with_direction(
        "display-stage-sealed-plaintext-bytes",
        shape_plaintext_bytes,
        1,
        "bytes/flush",
        "lower",
    );

    // Exact per-flush allocation tally over the same production sequence.
    const ALLOCATION_SAMPLES: usize = 200;
    let mut captured_rows_total = 0usize;
    let mut spilled_datagrams_total = 0usize;
    crate::edge_tunnel::test_allocations::begin();
    for sample in 0..ALLOCATION_SAMPLES {
        flush_cache.clear();
        terminal.apply_bytes(&fixtures[sample & 1]);
        terminal.update_hashes_for_dirty_rows(&mut current_hashes, &mut dirty_captures);
        captured_rows_total += dirty_captures.len();
        for capture in &dirty_captures {
            flush_cache.insert(capture.row, capture.clone());
        }
        capture_prepare_rows(
            &terminal,
            &peer,
            &requests,
            terminal.current_cursor_row(),
            &mut capture_scratch,
            &mut flush_cache,
            &mut captures,
        );
        recycle_frames_for_test(&mut datagrams, &mut frames);
        build_captured_datagram_batches(
            terminal.display_header_state(),
            &mut terminal,
            &mut peer,
            &captures,
            0,
            true,
            false,
            false,
            1,
            10_000.0,
            &mut compressor,
            &mut prepare_scratch,
            &mut frames,
            &mut datagrams,
        );
        precompute_fec_repairs(
            &mut datagrams,
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            peer.generation,
            &mut prepare_fec_encoder,
            &mut frames,
        );
        spilled_datagrams_total += datagrams
            .iter()
            .filter(|datagram| datagram.rows.len() > crate::connection::INLINE_SENT_ROWS)
            .count();
        for datagram in &datagrams {
            let wire = peer
                .seal_display_wire(&datagram.frame)
                .expect("benchmark Noise transport");
            checksum ^= wire.len();
        }
    }
    let tally = crate::edge_tunnel::test_allocations::end();
    // The tally's two remaining sources, so a change to either is
    // attributable: the per-dirty-row `Arc` capture (measured and kept,
    // see PERF.md) and the `SentRows` heap spill of a datagram carrying
    // more rows than the record holds inline.
    println!(
        "display-stage-allocations: {} allocations over {} flushes = {} row captures + {} \
         SentRows spills + {} other",
        tally.allocations,
        ALLOCATION_SAMPLES,
        captured_rows_total,
        spilled_datagrams_total,
        tally
            .allocations
            .saturating_sub(captured_rows_total + spilled_datagrams_total),
    );

    emit_benchmark_metric("display-stage-apply-bytes", &mut apply_samples, samples);
    emit_benchmark_metric("display-stage-dirty-hash", &mut hash_samples, samples);
    emit_benchmark_metric("display-stage-capture-rows", &mut capture_samples, samples);
    emit_benchmark_metric("display-stage-batch-encode", &mut batch_samples, samples);
    emit_benchmark_metric("display-stage-fec", &mut fec_samples, samples);
    emit_benchmark_metric("display-stage-seal", &mut seal_samples, samples);
    emit_benchmark_exact_metric_with_direction(
        "display-stage-allocations",
        tally.allocations / ALLOCATION_SAMPLES,
        ALLOCATION_SAMPLES,
        "allocations/flush",
        "lower",
    );
    emit_benchmark_exact_metric_with_direction(
        "display-stage-allocated-bytes",
        tally.allocated_bytes / ALLOCATION_SAMPLES,
        ALLOCATION_SAMPLES,
        "bytes/flush",
        "lower",
    );
    std::hint::black_box(checksum);
}

/// Isolate the duplicated RLE walk paid by `encoded_cells_size` followed
/// by `encode_cells`, and the extra encode paid when a fitted batch must
/// split. This is an upper-bound harness for the proposed encoded-row
/// arena: it deliberately excludes owner-loop capture, Arc provenance,
/// compression, FEC, and sealing, all measured by the production pipeline
/// benchmark beside it.
#[test]
#[ignore = "production performance workload"]
fn production_single_pass_row_encoding_benchmark() {
    const COLS: usize = 120;
    const ROWS: usize = 40;
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(2_000);
    let shapes = [
        (
            "rle",
            (0..ROWS)
                .map(|row| {
                    let mut cells = vec![CellRepr::BLANK; COLS];
                    cells[0].codepoint = b'$' as u32 + (row % 2) as u32;
                    cells
                })
                .collect::<Vec<_>>(),
        ),
        (
            "text",
            (0..ROWS)
                .map(|row| {
                    (0..COLS)
                        .map(|col| CellRepr {
                            codepoint: 0x21 + ((row * COLS + col) % 90) as u32,
                            ..CellRepr::BLANK
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
        ),
        (
            "truecolor",
            (0..ROWS)
                .map(|row| {
                    (0..COLS)
                        .map(|col| CellRepr {
                            codepoint: 0x21 + ((row + col) % 90) as u32,
                            fg: [(row * 17) as u8, (col * 11) as u8, ((row + col) * 7) as u8],
                            bg: [
                                (row * 5) as u8,
                                (col * 3) as u8,
                                ((row * 3 + col) * 13) as u8,
                            ],
                            ..CellRepr::BLANK
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
        ),
    ];

    let mut checksum = 0usize;
    for (shape, rows) in shapes {
        let mut current_samples = Vec::with_capacity(samples);
        let mut single_samples = Vec::with_capacity(samples);
        let mut split_samples = Vec::with_capacity(samples);
        let mut out = Vec::with_capacity(64 * 1024);

        for _ in 0..samples {
            let started = Instant::now();
            let exact_bytes: usize = rows.iter().map(|row| encoded_cells_size(row)).sum();
            out.clear();
            for row in &rows {
                merkur_codec::encode_cells(&mut out, row);
            }
            checksum ^= exact_bytes ^ out.len();
            current_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            let started = Instant::now();
            out.clear();
            for row in &rows {
                merkur_codec::encode_cells(&mut out, row);
            }
            checksum ^= out.len();
            single_samples.push(started.elapsed().as_secs_f64() * 1_000.0);

            // A failed full candidate followed by two fitted halves is the
            // recursive batcher's worst common correction: every row is
            // encoded twice. An encoded-row arena performs the first loop
            // once, then copies byte ranges into either half.
            let started = Instant::now();
            for range in [&rows[..], &rows[..ROWS / 2], &rows[ROWS / 2..]] {
                out.clear();
                for row in range {
                    merkur_codec::encode_cells(&mut out, row);
                }
                checksum ^= out.len();
            }
            split_samples.push(started.elapsed().as_secs_f64() * 1_000.0);
        }

        emit_benchmark_metric(
            &format!("display-row-{shape}-size-plus-encode"),
            &mut current_samples,
            samples,
        );
        emit_benchmark_metric(
            &format!("display-row-{shape}-single-encode"),
            &mut single_samples,
            samples,
        );
        emit_benchmark_metric(
            &format!("display-row-{shape}-split-reencode"),
            &mut split_samples,
            samples,
        );
    }
    std::hint::black_box(checksum);
}

fn emit_benchmark_metric_with_unit(
    name: &str,
    samples: &mut [f64],
    sample_size: usize,
    unit: &str,
) {
    samples.sort_by(f64::total_cmp);
    let percentile = |ratio: f64| {
        let index = ((samples.len() as f64 * ratio).ceil() as usize)
            .saturating_sub(1)
            .min(samples.len().saturating_sub(1));
        samples[index]
    };
    for ratio in [0.50, 0.95, 0.99] {
        let value = percentile(ratio);
        println!(
            "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"lower\",\"percentile\":{ratio},\"sampleSize\":{sample_size}}}"
        );
    }
}

fn emit_benchmark_exact_metric_with_direction(
    name: &str,
    value: usize,
    sample_size: usize,
    unit: &str,
    direction: &str,
) {
    println!(
        "@@merkur-perf {{\"name\":\"{name}\",\"value\":{value},\"unit\":\"{unit}\",\"direction\":\"{direction}\",\"sampleSize\":{sample_size}}}"
    );
}

fn emit_benchmark_exact_metric(name: &str, value: usize, sample_size: usize, unit: &str) {
    emit_benchmark_exact_metric_with_direction(name, value, sample_size, unit, "lower");
}

fn emit_benchmark_metric(name: &str, samples: &mut [f64], sample_size: usize) {
    emit_benchmark_metric_with_unit(name, samples, sample_size, "ms/op");
}

fn dictionary_request_for_test(
    token: u64,
    terminal: &TerminalState,
    capture_scratch: &mut RowCaptureScratch,
    flush_cache: &mut HashMap<u16, CapturedRow>,
) -> DictionaryPrepareRequest {
    let rows = capture_rows(terminal, 0..terminal.rows, capture_scratch, flush_cache);
    DictionaryPrepareRequest {
        token,
        display_revision: terminal.display_revision(),
        header: terminal.current_display_header(merkur_codec::FrameKind::Snapshot),
        rows,
    }
}

fn interactive_request_for_test(
    token: u64,
    terminal: &TerminalState,
    peer: &PeerDisplayState,
    row_count: u16,
    capture_scratch: &mut RowCaptureScratch,
    flush_cache: &mut HashMap<u16, CapturedRow>,
) -> DisplayPrepareRequest {
    let requests: Vec<DisplayRowRequest> = (0..row_count)
        .map(|row| DisplayRowRequest::literal(row, true))
        .collect();
    let mut buffers = PrepareBuffers::default();
    capture_prepare_rows(
        terminal,
        peer,
        &requests,
        terminal.current_cursor_row(),
        capture_scratch,
        flush_cache,
        &mut buffers.rows,
    );
    DisplayPrepareRequest {
        token,
        prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
        prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
        submitted_at: Instant::now(),
        perf_flush_started_at: None,
        generation: peer.generation,
        display_revision: terminal.display_revision(),
        completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
        start_seq: peer.next_datagram_seq,
        start_frame_id: peer.next_frame_id,
        presentation_continues: false,
        causal_input_advanced: false,
        input_seq: 1,
        header_signal: 0,
        header_changed: false,
        header: terminal.current_display_header(merkur_codec::FrameKind::Delta),
        buffers,
        compression: compression_policy_for_test(terminal.rows, true, ExecutionLane::Interactive),
        compression_dictionary: None,
        burst_group_max_size: 1,
        summary: flush_summary_for_test(u32::from(row_count)),
    }
}

fn snapshot_request_for_worker_test(
    token: u64,
    terminal: &mut TerminalState,
) -> SnapshotPrepareRequest {
    let mut snapshot_grid = Vec::new();
    let mut snapshot_graphics = Vec::new();
    let mut row_hashes = Vec::new();
    let (snapshot, _) = terminal.encode_snapshot_state_into(
        Vec::new(),
        &mut snapshot_grid,
        &mut row_hashes,
        &mut snapshot_graphics,
    );
    SnapshotPrepareRequest {
        token,
        submitted_at: Instant::now(),
        display_revision: terminal.display_revision(),
        completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
        cols: terminal.cols,
        rows: terminal.rows,
        header_signal: terminal.current_display_header_signal(),
        content_class: classify_snapshot_content(&snapshot_grid),
        snapshot,
        snapshot_grid,
        snapshot_graphics,
        row_hashes,
        peers: Vec::new(),
    }
}

#[test]
fn prepare_scheduler_bounds_interactive_priority_for_bulk_and_snapshot() {
    const COLS: u16 = 8;
    const ROWS: u16 = 8;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'p'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let mut pending = Vec::new();
    for token in 1..=5 {
        pending.push(interactive_request_for_test(
            token,
            &terminal,
            &peer,
            2,
            &mut capture_scratch,
            &mut flush_cache,
        ));
    }
    let mut bulk = interactive_request_for_test(
        10,
        &terminal,
        &peer,
        ROWS,
        &mut capture_scratch,
        &mut flush_cache,
    );
    bulk.compression.execution_lane = ExecutionLane::Bulk;
    pending.push(bulk);
    let snapshots = [snapshot_request_for_worker_test(20, &mut terminal)];
    let mut fairness = PrepareFairness {
        consecutive_interactive: MAX_INTERACTIVE_PREPARE_STREAK,
        consecutive_deltas: MAX_DELTA_PREPARE_STREAK,
    };

    assert_eq!(
        select_prepare_work(&pending, &snapshots, fairness, true, true),
        Some(PrepareSelection::Snapshot(0)),
        "four delta jobs force one recovery/snapshot opportunity"
    );
    fairness.record_snapshot();
    assert!(matches!(
        select_prepare_work(&pending, &[], fairness, true, true),
        Some(PrepareSelection::Delta(index))
            if pending[index].compression.execution_lane == ExecutionLane::Bulk
    ));

    let fresh = PrepareFairness::default();
    assert!(matches!(
        select_prepare_work(&pending, &snapshots, fresh, true, true),
        Some(PrepareSelection::Delta(index))
            if pending[index].compression.execution_lane == ExecutionLane::Interactive
    ));
}

#[test]
fn prepare_lane_admission_exposes_bulk_despite_continuous_interactive_arrivals() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let terminal = TerminalState::new(8, 8, event_tx);
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(8, 8);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let mut request = |token, lane| {
        let mut request = interactive_request_for_test(
            token,
            &terminal,
            &peer,
            2,
            &mut capture_scratch,
            &mut flush_cache,
        );
        request.compression.execution_lane = lane;
        request
    };
    let (interactive_tx, interactive_rx) = crossbeam_channel::bounded(DISPLAY_PREPARE_QUEUE_DEPTH);
    let (bulk_tx, bulk_rx) = crossbeam_channel::bounded(DISPLAY_PREPARE_QUEUE_DEPTH);
    let mut pending = ArrayVec::new();
    let mut interactive_open = true;
    let mut bulk_open = true;
    for token in 1..=DISPLAY_PREPARE_QUEUE_DEPTH as u64 {
        interactive_tx
            .try_send(request(token, ExecutionLane::Interactive))
            .expect("initial interactive cohort fits");
    }
    assert!(drain_prepare_lane(
        &mut pending,
        &interactive_rx,
        ExecutionLane::Interactive,
        &mut interactive_open,
    ));

    // Another cohort is already ready by the next scheduler turn. The old
    // unpartitioned drain consumed all remaining pending capacity here,
    // leaving the bulk request outside the scheduler's fairness domain.
    for token in 1..=DISPLAY_PREPARE_QUEUE_DEPTH as u64 {
        interactive_tx
            .try_send(request(100 + token, ExecutionLane::Interactive))
            .expect("second interactive cohort fits its channel");
    }
    bulk_tx
        .try_send(request(1000, ExecutionLane::Bulk))
        .expect("bulk channel has room");
    let mut fairness = PrepareFairness::default();
    let mut interactive_served = 0;
    loop {
        drain_prepare_lane(
            &mut pending,
            &interactive_rx,
            ExecutionLane::Interactive,
            &mut interactive_open,
        );
        drain_prepare_lane(&mut pending, &bulk_rx, ExecutionLane::Bulk, &mut bulk_open);
        let Some(PrepareSelection::Delta(index)) =
            select_prepare_work(&pending, &[], fairness, true, true)
        else {
            panic!("queued work must remain selectable");
        };
        let selected = pending.swap_remove(index);
        if selected.compression.execution_lane == ExecutionLane::Bulk {
            assert_eq!(selected.token, 1000);
            break;
        }
        interactive_served += 1;
        assert!(interactive_served <= MAX_INTERACTIVE_PREPARE_STREAK);
        fairness.record_delta(ExecutionLane::Interactive);
        // Keep the source saturated while the worker makes progress.
        while interactive_tx.len() < DISPLAY_PREPARE_QUEUE_DEPTH {
            interactive_tx
                .try_send(request(2000, ExecutionLane::Interactive))
                .expect("only refill available channel slots");
        }
    }
    assert_eq!(interactive_served, MAX_INTERACTIVE_PREPARE_STREAK);
    assert!(!interactive_rx.is_empty());
    assert_eq!(pending.len(), DISPLAY_PREPARE_QUEUE_DEPTH);
}

#[tokio::test(flavor = "current_thread")]
async fn full_snapshot_completion_lane_does_not_block_interactive_preparation() {
    const COLS: u16 = 8;
    const ROWS: u16 = 2;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b's'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let (worker, mut completion_rx, snapshot_rx, _dictionary_rx) = start_display_prepare_worker();

    // Fill both the Tokio output channel and the worker's bounded local
    // snapshot completion backlog. The old blocking_send stopped the sole
    // preparation thread on the ninth item, so the delta below timed out.
    for token in 1..=(2 * DISPLAY_PREPARE_QUEUE_DEPTH) as u64 {
        worker
            .snapshot_tx
            .send(snapshot_request_for_worker_test(token, &mut terminal))
            .expect("snapshot lane open");
    }
    let started = Instant::now();
    while snapshot_rx.len() < DISPLAY_PREPARE_QUEUE_DEPTH {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::yield_now();
    }

    worker
        .interactive_tx
        .send(interactive_request_for_test(
            99,
            &terminal,
            &peer,
            ROWS,
            &mut capture_scratch,
            &mut flush_cache,
        ))
        .expect("interactive lane open");
    let completion = tokio::time::timeout(Duration::from_secs(5), completion_rx.recv())
        .await
        .expect("interactive completion cannot wait on the snapshot consumer")
        .expect("display worker alive");
    assert_eq!(completion.token, 99);
}

#[tokio::test(flavor = "current_thread")]
async fn queued_prepare_is_cancelled_before_compression_at_peer_epoch_boundary() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'c'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let request = interactive_request_for_test(
        101,
        &terminal,
        &peer,
        ROWS,
        &mut capture_scratch,
        &mut flush_cache,
    );
    peer.display_prepare_in_flight = Some(101);
    assert!(peer.cancel_display_prepare());
    let (worker, mut completion_rx, _snapshot_rx, _dictionary_rx) = start_display_prepare_worker();
    worker.bulk_tx.send(request).expect("bulk lane open");
    let completion = tokio::time::timeout(Duration::from_secs(5), completion_rx.recv())
        .await
        .expect("cancelled buffers must return without compression")
        .expect("display worker alive");
    assert_eq!(completion.token, 101);
    assert_eq!(completion.cpu_time, Duration::ZERO);
    assert!(completion.buffers.datagrams.is_empty());
    assert_eq!(completion.buffers.rows.len(), usize::from(ROWS));
}

fn maximum_prepare_fixture(cols: u16, rows: u16, entropy: bool, variant: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut random = 0x243f6a88u32 ^ u32::from(variant);
    for row in 0..rows {
        bytes.extend_from_slice(format!("\x1b[{};1H", row + 1).as_bytes());
        for col in 0..cols {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            if entropy || col == 0 {
                let color = if entropy { random } else { 0x123456 };
                bytes.extend_from_slice(
                    format!(
                        "\x1b[{};38;2;{};{};{}m",
                        if color & 1 == 0 { 1 } else { 22 },
                        color & 255,
                        (color >> 8) & 255,
                        (color >> 16) & 255
                    )
                    .as_bytes(),
                );
            }
            bytes.push(if entropy {
                b'!' + (random % 90) as u8
            } else {
                b'a' + variant
            });
        }
    }
    bytes
}

fn with_packing_experiment<T>(experiment: PackingExperiment, run: impl FnOnce() -> T) -> T {
    struct Restore(PackingExperiment);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_PACKING_EXPERIMENT.set(self.0);
        }
    }
    let _restore = Restore(TEST_PACKING_EXPERIMENT.replace(experiment));
    run()
}

fn partition_comparison_arm(experiment: PackingExperiment) -> &'static str {
    match experiment {
        PackingExperiment::Adaptive => "adaptive",
        PackingExperiment::FirstPartition => "first-partition",
        PackingExperiment::WholeSpan => "whole-span",
    }
}

/// Predeclared before any WholeSpan timing. This is an extreme whole-redraw
/// contender: utility/content domains may merge and a Critical span may
/// become reliable. The capture carrier measures submission, never stream
/// delivery, packetization, network loss, GPU completion or photons.
fn print_whole_span_comparison_contract() {
    eprintln!(concat!(
        "WHOLE_SPAN_COMPARISON_CONTRACT ",
        "coverage=plain-dictionary,single-edge,clean-loss ",
        "cold=cold-planning-model,warmed-worker-and-compressor ",
        "learned=arm-specific-emitted-online-trajectory ",
        "snapshot-stage=identical-thermal-control-not-candidate-evidence ",
        "primary=input-to-complete-admission,cold-model,384x256,50ms ",
        "primary-p95-required-reduction=25-percent ",
        "ordinary-and-learned-p95-regression-guard=max(5-percent,25us) ",
        "bulk-completion-and-first-last-original-admission-p95-regression-guard=max(5-percent,25us) ",
        "all-case-p99-regression-guard-each-AB-BA-stratum=max(10-percent,100us) ",
        "max=diagnostic ",
        "physical-bytes-and-records=exact-no-increase-for-unqualified-advancement ",
        "promotion-requires=real-reliable-backlog,loss,jitter,first-and-completed-pixel-noninferiority"
    ));
}

/// Prepared primary originals plus computed parity only. Optional K1
/// replicas/probes, transport retransmission and actual admission are not
/// fabricated here; the owner comparison records actual capture submissions.
fn prepared_primary_traffic(datagrams: &[PreparedDisplayDatagram]) -> (usize, usize, usize) {
    use crate::display::planner::{display_datagram_wire_len, display_reliable_record_wire_len};
    let mut bytes = 0;
    let mut unreliable = 0;
    let mut reliable = 0;
    for datagram in datagrams {
        if datagram.frame.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES {
            bytes += display_datagram_wire_len(datagram.frame.len());
            unreliable += 1;
        } else {
            bytes += display_reliable_record_wire_len(datagram.frame.len());
            reliable += 1;
        }
        if let Some(repair) = &datagram.precomputed_fec_repair {
            bytes += display_datagram_wire_len(repair.len());
            unreliable += 1;
        }
    }
    (bytes, unreliable, reliable)
}

#[test]
fn first_partition_candidate_fits_actual_sizes_without_crossing_planned_spans() {
    for entropy in [false, true] {
        const COLS: u16 = 120;
        const ROWS: u16 = 40;
        let (mut terminal, baseline, _) = sized_fixture(COLS, ROWS);
        let mut snapshot_header =
            terminal.current_display_header(merkur_codec::FrameKind::Snapshot);
        snapshot_header.row_count = ROWS;
        let mut snapshot = Vec::new();
        encode_frame_into(
            &mut snapshot,
            &snapshot_header,
            baseline
                .acked_row_cells
                .iter()
                .enumerate()
                .map(|(row, cells)| RowRef {
                    graphics: &[],
                    row_index: row as u16,
                    left: 0,
                    cells,
                }),
        );
        patch_stream_header(&mut snapshot, 1, 1, 0, 1, 0, false, false, 0, 1, 0, 0).unwrap();
        terminal.apply_bytes(&maximum_prepare_fixture(COLS, ROWS, entropy, 0));
        let mut peer = benchmark_noise_peer();
        peer.display_cache = baseline;
        peer.next_datagram_seq = 2;
        peer.paths.edge.available = true;
        peer.paths.edge.last_ack_at_ms = 100.0;
        peer.paths.edge.network_rtt_ewma_ms = 50.0;
        peer.display_planning.observe_carrier_quote(
            1,
            CarrierDeliveryQuote {
                one_way_us: 25_000.0,
                ..CarrierDeliveryQuote::default()
            },
        );
        let mut request = interactive_request_for_test(
            1,
            &terminal,
            &peer,
            ROWS,
            &mut RowCaptureScratch::default(),
            &mut HashMap::new(),
        );
        for row in &mut request.buffers.rows {
            row.utility = DisplayUtility::NonCritical;
        }
        assert!(
            request
                .buffers
                .rows
                .windows(2)
                .all(|pair| pair[0].content.class() == pair[1].content.class())
        );
        request.compression =
            display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
        if entropy {
            // Deliberately stale but legitimate historical evidence: the
            // actual fitter must split a newly incompressible selected
            // span, never turn it into a multi-datagram correctness unit.
            for profile in &mut request.compression.planning_profiles {
                for _ in 0..100 {
                    for exponent in 6..21 {
                        profile.observe_actual_ratio(1usize << exponent, 0.01);
                    }
                }
            }
        }
        request.burst_group_max_size = DisplayPolicy::FEC_GROUP_MAX_SIZE;
        let expected: Vec<_> = request
            .buffers
            .rows
            .iter()
            .map(|row| row.sent.hash)
            .collect();
        let mut scratch = PrepareScratch {
            experiment: PackingExperiment::FirstPartition,
            ..PrepareScratch::default()
        };
        let prepared = prepare_display_off_loop(
            request,
            &mut Compressor::new(),
            &mut crate::display::fec::FecEncoder::new(),
            &mut scratch,
        );
        assert_eq!(scratch.partition_calls, 1);
        let ends: Vec<_> = (0..usize::from(ROWS))
            .filter_map(|index| scratch.partition.get(index).map(|(end, _)| end))
            .collect();
        assert_eq!(ends.last(), Some(&usize::from(ROWS)));
        if entropy {
            assert!(
                prepared.buffers.datagrams.len() > ends.len(),
                "optimistic evidence must exercise the exact fitted split"
            );
        }
        let mut next_row = 0usize;
        for (index, datagram) in prepared.buffers.datagrams.iter().enumerate() {
            let header = merkur_codec::parse_frame_header(&datagram.frame).unwrap();
            assert_eq!(header.chunk_count, 1);
            assert_eq!(header.presentation_member_index, index as u16);
            assert_eq!(
                usize::from(header.presentation_member_count),
                prepared.buffers.datagrams.len()
            );
            let planned_end = *ends.iter().find(|&&end| end > next_row).unwrap();
            assert!(
                datagram.frame.len() <= DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES
                    || datagram.rows.len() == 1
            );
            let mut viewer = term_wasm::Terminal::new_headless(COLS, ROWS);
            assert!(viewer.apply_state_seq(&snapshot, 1));
            let handle = viewer.stage_display_frame_bytes(&datagram.frame);
            assert_ne!(handle, 0, "{:?}", viewer.take_last_error());
            assert!(viewer.validate_staged_frame(handle));
            let seq = merkur_codec::parse_stream_header(&datagram.frame)
                .unwrap()
                .seq;
            assert!(viewer.apply_staged_delta_seq(handle, seq));
            assert!(viewer.apply_staged_delta_seq(handle, seq));
            viewer.release_staged_frame(handle);
            for sent in datagram.rows.iter() {
                assert_eq!(usize::from(sent.row), next_row);
                assert!(
                    next_row < planned_end,
                    "fitting cannot merge across the retained boundary"
                );
                assert_eq!(viewer.row_hash(sent.row), expected[next_row]);
                next_row += 1;
            }
            // Every omitted sibling retains the ACK baseline exactly.
            for row in 0..ROWS {
                if !datagram.rows.iter().any(|sent| sent.row == row) {
                    assert_eq!(
                        viewer.row_hash(row),
                        peer.display_cache.acked_row_hashes[usize::from(row)]
                    );
                }
            }
        }
        assert_eq!(next_row, usize::from(ROWS));
    }
}

fn whole_span_fixture_for_test(
    cols: u16,
    rows: u16,
    entropy: bool,
    heterogeneous: bool,
    finalized_dictionary: bool,
) -> (PeerDisplayState, DisplayPrepareCompletion) {
    let (mut terminal, baseline, _) = sized_fixture(cols, rows);
    terminal.apply_bytes(&maximum_prepare_fixture(cols, rows, entropy, 0));
    if heterogeneous {
        // Alternating styles/entropy must not acquire a shared model or
        // any cross-record source dependency from whole-span grouping.
        for row in 0..rows {
            if entropy && row % 2 != 0 {
                continue;
            }
            let style = if row % 2 == 0 { "0" } else { "38;2;18;52;86" };
            let mut text = format!("\x1b[{};1H\x1b[{style}m", row + 1).into_bytes();
            text.extend((0..cols).map(|col| b'a' + (col % 2) as u8));
            terminal.apply_bytes(&text);
        }
    }
    let mut peer = benchmark_noise_peer();
    peer.display_cache = baseline;
    peer.next_datagram_seq = 2;
    peer.paths.edge.available = true;
    peer.paths.edge.last_ack_at_ms = 100.0;
    peer.paths.edge.network_rtt_ewma_ms = 50.0;
    peer.display_planning.observe_carrier_quote(
        1,
        CarrierDeliveryQuote {
            one_way_us: 25_000.0,
            ..CarrierDeliveryQuote::default()
        },
    );
    let mut request = interactive_request_for_test(
        1,
        &terminal,
        &peer,
        rows,
        &mut RowCaptureScratch::default(),
        &mut HashMap::new(),
    );
    if finalized_dictionary {
        // Learn only acknowledged pre-update cells, never the candidate's
        // new content. This is the same finalized/ACKed dictionary path
        // production captures by Arc for the worker.
        let finalized = prepare_dictionary_off_loop(
            DictionaryPrepareRequest {
                token: 1,
                display_revision: 0,
                header: request.header,
                rows: peer
                    .display_cache
                    .acked_row_cells
                    .iter()
                    .enumerate()
                    .map(|(row, cells)| CapturedRow {
                        graphics: PreparedGraphics::EMPTY,
                        row: row as u16,
                        hash: peer.display_cache.acked_row_hashes[row],
                        cells: Arc::clone(cells),
                    })
                    .collect(),
            },
            &mut Vec::new(),
            &mut DictionaryScratch::default(),
        );
        let dictionary = peer
            .dictionary
            .build_next_prepared(peer.generation, finalized.source, finalized.hash)
            .unwrap();
        assert!(peer.dictionary.acknowledge(dictionary.id));
        request.compression_dictionary = Some(dictionary);
    }
    request.header_changed = true;
    request.compression = display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
    request.burst_group_max_size = DisplayPolicy::FEC_GROUP_MAX_SIZE;
    let mut scratch = PrepareScratch {
        experiment: PackingExperiment::WholeSpan,
        ..PrepareScratch::default()
    };
    let prepared = prepare_display_off_loop(
        request,
        &mut Compressor::new(),
        &mut crate::display::fec::FecEncoder::new(),
        &mut scratch,
    );
    assert_eq!(
        scratch.partition_calls, 0,
        "whole-span contender performs no guessed-size search"
    );
    (peer, prepared)
}

#[test]
fn whole_span_candidate_preserves_shared_header_promotion() {
    let (peer, mut prepared) = whole_span_fixture_for_test(384, 256, true, false, false);
    for row in &mut prepared.buffers.rows {
        row.utility = DisplayUtility::NonCritical;
    }
    let header = merkur_codec::parse_frame_header(&prepared.buffers.datagrams[0].frame).unwrap();
    let policy = display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0);
    for header_changed in [false, true] {
        let mut scratch = PrepareScratch {
            experiment: PackingExperiment::WholeSpan,
            ..PrepareScratch::default()
        };
        pack_captured_rows(
            &prepared.buffers.rows,
            header,
            &policy,
            None,
            header_changed,
            &mut Compressor::new(),
            &mut scratch,
            &mut frame_pool_for_test(),
        );
        assert!(scratch.batches.len() > 1);
        assert_eq!(
            scratch
                .batches
                .iter()
                .filter(|batch| batch.3 == DisplayUtility::Critical)
                .count(),
            usize::from(header_changed)
        );
        if header_changed {
            assert_eq!(scratch.batches[0].3, DisplayUtility::Critical);
            assert_eq!(
                scratch.batches[0].0.len(),
                scratch
                    .batches
                    .iter()
                    .map(|batch| batch.0.len())
                    .min()
                    .unwrap()
            );
        }
    }
}

#[test]
fn whole_span_candidate_preserves_interactive_bytes() {
    let (mut terminal, baseline, _) = sized_fixture(120, 40);
    terminal.apply_bytes(b"\x1b[1;1HX");
    let mut peer = benchmark_noise_peer();
    peer.display_cache = baseline;
    let mut outputs = Vec::new();
    for experiment in [PackingExperiment::Adaptive, PackingExperiment::WholeSpan] {
        let mut request = interactive_request_for_test(
            1,
            &terminal,
            &peer,
            1,
            &mut RowCaptureScratch::default(),
            &mut HashMap::new(),
        );
        request.header_changed = true;
        request.causal_input_advanced = true;
        assert_eq!(
            captured_presentation_workload(&request.buffers.rows, &request.compression),
            DisplayWorkload::Interactive
        );
        let prepared = prepare_display_off_loop(
            request,
            &mut Compressor::new(),
            &mut crate::display::fec::FecEncoder::new(),
            &mut PrepareScratch {
                experiment,
                ..PrepareScratch::default()
            },
        );
        outputs.push(
            prepared
                .buffers
                .datagrams
                .into_iter()
                .map(|frame| (frame.frame, frame.utility))
                .collect::<Vec<_>>(),
        );
    }
    assert_eq!(outputs[0], outputs[1]);
}

#[test]
fn whole_span_candidate_actual_quote_crossover_keeps_lane_and_fec_bounds() {
    let mut saw_fec = false;
    let mut observed_shapes = Vec::new();
    for loss_upper in [0.0, 0.01, 0.03, 0.09] {
        for (cols, rows, entropy, expected) in [
            (120, 40, false, Some(PeerTransport::WebTransport)),
            (384, 256, false, None),
            (384, 256, true, Some(PeerTransport::Edge)),
        ] {
            let (mut peer, mut prepared) =
                whole_span_fixture_for_test(cols, rows, entropy, rows > 40 && !entropy, true);
            for (path, rtt_ms, rate) in [
                (PeerTransport::WebTransport, 50.0, 8_000_000),
                (PeerTransport::Edge, 53.0, 80_000_000),
            ] {
                let health = peer.paths.get_mut(path);
                health.available = true;
                health.last_ack_at_ms = 100.0;
                health.network_rtt_ewma_ms = rtt_ms;
                peer.display_planning.observe_carrier_quote(
                    usize::from(path == PeerTransport::Edge),
                    CarrierDeliveryQuote {
                        one_way_us: rtt_ms * 500.0,
                        pacing_rate_bps: rate,
                        loss_upper,
                        ..CarrierDeliveryQuote::default()
                    },
                );
            }
            let frames = &mut prepared.buffers.datagrams;
            observed_shapes.push((
                cols,
                rows,
                entropy,
                frames
                    .iter()
                    .map(|frame| (frame.frame.len(), frame.raw_bytes, frame.utility))
                    .collect::<Vec<_>>(),
            ));
            let count = frames.len();
            let mut budget = DatagramPhysicalBudget::exact(2_000_000, 2_000_000, 1_024);
            let preferred = prepared_display_transport(
                &peer,
                frames,
                DisplayPolicy::FEC_GROUP_MAX_SIZE,
                100.0,
                &budget,
            );
            if loss_upper == 0.0
                && let Some(expected) = expected
            {
                assert_eq!(preferred, expected, "loss={loss_upper} entropy={entropy}");
            }
            // Reliable loss changes the completion objective; enumerate
            // both complete actual layouts instead of forcing a clean
            // network's winner on a different loss quote.
            let mut costs = Vec::new();
            for candidate in [PeerTransport::WebTransport, PeerTransport::Edge] {
                let mut trial = budget;
                assert_eq!(
                    plan_required_physical_prefix(
                        &peer,
                        candidate,
                        frames,
                        DisplayPolicy::FEC_GROUP_MAX_SIZE,
                        100.0,
                        &mut trial
                    ),
                    count
                );
                costs.push((
                    candidate,
                    prepared_carrier_delivery_us(&peer, frames, DisplayPolicy::FEC_GROUP_MAX_SIZE),
                ));
            }
            costs.sort_by(|left, right| left.1.total_cmp(&right.1));
            assert_eq!(preferred, costs[0].0, "actual layout costs={costs:?}");
            assert_eq!(
                admit_prepared_physical_prefix(
                    &mut peer,
                    frames,
                    &mut frame_pool_for_test(),
                    DisplayPolicy::FEC_GROUP_MAX_SIZE,
                    100.0,
                    &mut budget
                ),
                count
            );
            for frame in frames {
                assert_eq!(frame.physical_plan.data_primary, Some(preferred));
                if let Some(repair_primary) = frame.physical_plan.repair_primary {
                    saw_fec = true;
                    assert_eq!(repair_primary, preferred);
                }
                if let Some(parity) = &frame.precomputed_fec_repair {
                    assert!(parity.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES);
                }
                assert_eq!(
                    uses_display_datagram(frame),
                    frame.frame.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
                );
            }
            assert!(budget.webtransport_bytes <= 2_000_000 && budget.edge_bytes <= 2_000_000);
        }
    }
    assert!(
        saw_fec,
        "the actual candidate must exercise a protected multi-record shape: {observed_shapes:?}"
    );
}

#[test]
fn whole_span_candidate_records_are_bounded_independent_and_loss_local() {
    for (cols, rows, entropy, heterogeneous, finalized_dictionary) in [
        (120, 40, false, false, false),
        (120, 40, false, false, true),
        (120, 40, true, false, true),
        (384, 256, false, true, true),
        (384, 256, true, true, false),
        (512, 192, true, false, true),
    ] {
        let (peer, prepared) =
            whole_span_fixture_for_test(cols, rows, entropy, heterogeneous, finalized_dictionary);
        let frames = &prepared.buffers.datagrams;
        assert!(!frames.is_empty());
        assert!(frames.len() <= usize::from(rows));
        if !entropy {
            assert!(
                frames
                    .iter()
                    .any(|frame| frame.frame.len() < frame.raw_bytes),
                "known compressible rows must actually exercise zstd"
            );
        }
        let mut baseline_frames = Vec::with_capacity(usize::from(rows));
        for (row, cells) in peer.display_cache.acked_row_cells.iter().enumerate() {
            // Seed a common ACK baseline one independent row at a time;
            // even the maximum grid never needs an oversize test frame.
            let mut header = merkur_codec::parse_frame_header(&frames[0].frame).unwrap();
            header.row_count = 1;
            header.presentation_member_index = 0;
            header.presentation_member_count = 0;
            let mut baseline = Vec::new();
            encode_frame_into(
                &mut baseline,
                &header,
                [RowRef {
                    graphics: &[],
                    row_index: row as u16,
                    left: 0,
                    cells,
                }]
                .into_iter(),
            );
            patch_stream_header(
                &mut baseline,
                1,
                peer.generation,
                0,
                1,
                0,
                false,
                false,
                0,
                1,
                0,
                0,
            )
            .unwrap();
            baseline_frames.push(baseline);
        }
        let presentation = merkur_codec::parse_frame_header(&frames[0].frame)
            .unwrap()
            .presentation_id;
        let mut seen = vec![false; usize::from(rows)];
        let mut expected_full = peer.display_cache.acked_row_hashes.clone();
        for (index, frame) in frames.iter().enumerate() {
            let stream = merkur_codec::parse_stream_header(&frame.frame).unwrap();
            let header = merkur_codec::parse_frame_header(&frame.frame).unwrap();
            assert!(frame.raw_bytes <= STREAM_HEADER_BYTES + usize::from(u16::MAX));
            assert_eq!(
                stream.body_len as usize + STREAM_HEADER_BYTES,
                frame.frame.len()
            );
            assert_eq!(header.chunk_count, 1);
            assert_eq!(header.chunk_index, 0);
            assert_eq!(header.presentation_id, presentation);
            assert_eq!(header.presentation_member_index, index as u16);
            assert_eq!(usize::from(header.presentation_member_count), frames.len());
            assert_eq!(
                uses_display_datagram(frame),
                frame.frame.len() <= DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES
            );
            for row in frame.rows.iter() {
                assert!(!std::mem::replace(&mut seen[usize::from(row.row)], true));
                expected_full[usize::from(row.row)] = row.hash;
            }
        }
        assert!(seen.iter().all(|seen| *seen));
        let apply_order = |order: &[usize], duplicate: bool| {
            let mut viewer = term_wasm::Terminal::new_headless(cols, rows);
            if let Some(dictionary) = &prepared.compression_dictionary {
                assert!(viewer.install_display_dictionary(
                    dictionary.generation,
                    dictionary.id,
                    dictionary.hash,
                    &dictionary.bytes
                ));
            }
            for baseline in &baseline_frames {
                assert!(viewer.apply_delta_seq(baseline, 1));
            }
            let mut expected = peer.display_cache.acked_row_hashes.clone();
            for &index in order {
                let frame = &frames[index];
                let seq = merkur_codec::parse_stream_header(&frame.frame).unwrap().seq;
                let handle = viewer.stage_display_frame_bytes(&frame.frame);
                assert_ne!(handle, 0, "{:?}", viewer.take_last_error());
                assert!(viewer.validate_staged_frame(handle));
                assert!(viewer.apply_staged_delta_seq(handle, seq));
                if duplicate {
                    assert!(viewer.apply_staged_delta_seq(handle, seq));
                }
                viewer.release_staged_frame(handle);
                for row in frame.rows.iter() {
                    expected[usize::from(row.row)] = row.hash;
                }
            }
            let observed: Vec<_> = (0..rows).map(|row| viewer.row_hash(row)).collect();
            assert_eq!(
                observed, expected,
                "{cols}x{rows} entropy={entropy} order={order:?}"
            );
            observed
        };
        for index in 0..frames.len() {
            apply_order(&[index], true);
        }
        let mut order: Vec<_> = (0..frames.len()).collect();
        assert_eq!(apply_order(&order, false), expected_full);
        order.reverse();
        assert_eq!(apply_order(&order, false), expected_full);
        for missing in 0..frames.len() {
            let retained: Vec<_> = order
                .iter()
                .copied()
                .filter(|&index| index != missing)
                .collect();
            apply_order(&retained, false);
        }
        // Exact disjoint row ownership above proves every permutation;
        // also execute every pair for the small multi-record fixture.
        if rows == 40 {
            for first in 0..frames.len() {
                for second in first + 1..frames.len() {
                    assert_eq!(
                        apply_order(&[first, second], false),
                        apply_order(&[second, first], false)
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn whole_span_candidate_reliable_refusal_credits_only_actual_records() {
    for accepted_limit in [0, 1, usize::MAX] {
        let (mut peer, mut prepared) = whole_span_fixture_for_test(384, 256, true, true, false);
        assert!(prepared.buffers.datagrams.len() > 1);
        assert!(
            prepared
                .buffers
                .datagrams
                .iter()
                .all(|frame| !uses_display_datagram(frame))
        );
        let members = prepared.buffers.datagrams.len();
        let mut expected = peer.display_cache.sent_row_hashes.clone();
        for frame in prepared.buffers.datagrams.iter().take(accepted_limit) {
            for row in frame.rows.iter() {
                expected[usize::from(row.row)] = row.hash;
            }
        }
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(
            crate::edge_tunnel::EdgeTunnel::new_capture_with_reliable_limit(tx, accepted_limit),
        ));
        let outcome = send_unpaced_display_burst(
            &mut peer,
            &mut prepared.buffers.datagrams,
            &mut frame_pool_for_test(),
            DisplayPolicy::FEC_GROUP_MAX_SIZE,
            100.0,
            &[u64::MAX; 4],
        );
        let admitted = accepted_limit.min(members);
        assert_eq!(outcome.original_admitted, admitted != 0);
        assert_eq!(outcome.all_sent, admitted == members);
        assert_eq!(peer.display_cache.sent_datagrams.len(), admitted);
        assert_eq!(peer.display_cache.sent_row_hashes, expected);
        let mut captured = 0;
        while let Ok((channel, _)) = rx.try_recv() {
            assert_eq!(channel, CHANNEL_DISPLAY_COMMIT);
            captured += 1;
        }
        assert_eq!(captured, admitted);
        assert_eq!(outcome.presentation_end_admitted, admitted == members);
    }
}

#[test]
fn maximum_dense_prepare_reuses_frame_storage() {
    assert_eq!(prepare_allocation_case::<false>(384, 256, true, 2), 0);
    assert_eq!(prepare_allocation_case::<false>(512, 192, true, 2), 0);
}

#[test]
fn maximum_dense_prepare_reuses_compressed_storage_when_sender_cost_switches_to_raw() {
    assert_eq!(prepare_allocation_case::<true>(384, 256, true, 2), 0);
    assert_eq!(prepare_allocation_case::<true>(512, 192, true, 2), 0);
}

#[test]
#[ignore = "exclusive preparation allocation and CPU profile"]
fn production_prepare_allocation_profile() {
    // Exercise bulk work first so tiny jobs are not the process's first
    // CPU work. Each shape still has ten untimed storage warmup rounds.
    for (cols, rows, entropy) in [
        (384, 256, true),
        (512, 192, true),
        (384, 256, false),
        (120, 40, false),
        (120, 2, false),
        (120, 1, false),
    ] {
        prepare_allocation_case::<false>(cols, rows, entropy, 100);
    }
}

/// Capture, output validation, logging and pool accounting are outside timing.
fn prepare_allocation_case<const SWITCH_TO_RAW: bool>(
    cols: u16,
    rows: u16,
    entropy: bool,
    samples: usize,
) -> usize {
    use std::hash::Hasher;

    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(cols, rows, event_tx);
    terminal.apply_bytes(&maximum_prepare_fixture(cols, rows, entropy, 0));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(cols, rows);
    peer.paths.edge.available = true;
    peer.paths.edge.last_ack_at_ms = 100.0;
    peer.paths.edge.network_rtt_ewma_ms = 120.0;
    peer.display_planning.observe_carrier_quote(
        1,
        CarrierDeliveryQuote {
            one_way_us: 60_000.0,
            ..CarrierDeliveryQuote::default()
        },
    );
    let seed = interactive_request_for_test(
        1,
        &terminal,
        &peer,
        rows,
        &mut RowCaptureScratch::default(),
        &mut HashMap::new(),
    );
    let header = seed.header;
    let mut buffers = seed.buffers;
    let captures = buffers.rows.clone();
    let mut compressor = Compressor::new();
    let mut fec = crate::display::fec::FecEncoder::new();
    let mut scratch = PrepareScratch::default();
    let mut observations = Vec::with_capacity(samples);
    // Prepared frames by the compression flag the receiver decodes them by,
    // as `[warm-up, measured]`. The switching case exists only if the cost
    // step really turned warm compressed output into measured raw output;
    // otherwise it is the non-switching case under another name.
    let mut compressed_frames = [0usize; 2];
    let mut raw_frames = [0usize; 2];
    for round in 0..samples + 10 {
        if SWITCH_TO_RAW {
            // Deterministic reproduction: compressed frames have capacity for
            // the final raw bytes, but not the encoder's former discarded
            // indexed-color attempt. A cost step makes those same buffers
            // become raw output instead of reusing one oversized scratch.
            scratch.planner = GlobalDisplayPlanningModel::default();
            if round >= 10 {
                for bytes in [512, 1024, 2048, 4096, 8192, 16384] {
                    for _ in 0..32 {
                        scratch.planner.observe_sender_service(
                            ExecutionLane::Bulk,
                            bytes,
                            ContentClass::Color,
                            DictionaryClass::Plain,
                            1_000_000.0,
                        );
                    }
                }
            }
        }
        let request = DisplayPrepareRequest {
            token: 1,
            prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
            prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
            submitted_at: Instant::now(),
            perf_flush_started_at: Some(FlushStart::now()),
            generation: peer.generation,
            display_revision: terminal.display_revision(),
            completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
            start_seq: 1,
            start_frame_id: 1,
            presentation_continues: false,
            causal_input_advanced: false,
            input_seq: 1,
            header_signal: 0,
            header_changed: false,
            header,
            buffers,
            compression: display_compression_policy(&peer, 100.0, true, ExecutionLane::Bulk, 0),
            compression_dictionary: None,
            burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
            summary: flush_summary_for_test(u32::from(rows)),
        };
        let completion = prepare_display_off_loop(request, &mut compressor, &mut fec, &mut scratch);
        let timing = completion.perf_timing.expect("instrumented preparation");
        buffers = completion.buffers;
        let mut fingerprint = std::collections::hash_map::DefaultHasher::new();
        let mut row_count = 0;
        // Sender service observations may legitimately change representation
        // between rounds. Check decoded authority, not a frozen wire choice.
        // Receiver work stays outside the preparation allocation/timing scope.
        let mut receiver = term_wasm::Terminal::new_headless(cols, rows);
        let phase = usize::from(round >= 10);
        for datagram in &buffers.datagrams {
            fingerprint.write(&datagram.frame);
            if datagram.frame[merkur_codec::DISPLAY_HEADER_FLAGS_OFFSET]
                & merkur_codec::DISPLAY_HEADER_FLAG_COMPRESSED_ZSTD
                != 0
            {
                compressed_frames[phase] += 1;
            } else {
                raw_frames[phase] += 1;
            }
            let handle = receiver.stage_display_frame_bytes(&datagram.frame);
            assert_ne!(handle, 0, "prepared frame must stage");
            assert!(receiver.apply_staged_delta_seq(handle, datagram.seq));
            receiver.release_staged_frame(handle);
            if let Some(repair) = &datagram.precomputed_fec_repair {
                fingerprint.write(repair);
            }
            for row in &datagram.rows {
                let captured = captures
                    .iter()
                    .find(|capture| capture.sent.row == row.row)
                    .expect("sent row was captured");
                assert_eq!(row.hash, captured.sent.hash);
                assert!(Arc::ptr_eq(&row.cells, &captured.sent.cells));
                row_count += 1;
            }
        }
        assert_eq!(row_count, usize::from(rows));
        for capture in &captures {
            assert_eq!(receiver.row_hash(capture.sent.row), capture.sent.hash);
        }
        let result = (
            fingerprint.finish(),
            prepared_primary_traffic(&buffers.datagrams),
        );
        // Warm-up admits reusable storage; it does not freeze the planner's
        // sender-service observations. Even warm rounds can choose different
        // wire bytes under load. The receiver row hashes above are the exact
        // output oracle; retain wire fingerprints as benchmark observations.
        if round >= 10 {
            observations.push((completion.cpu_time, timing.allocations, result));
        }
        recycle_frames_for_test(&mut buffers.datagrams, &mut buffers.frames);
    }
    if SWITCH_TO_RAW {
        assert!(
            compressed_frames[0] > 0,
            "warm-up rounds prepared no compressed frame, so the cost step had \
             nothing to switch: {} raw",
            raw_frames[0]
        );
        assert_eq!(
            compressed_frames[1], 0,
            "the injected sender cost left measured rounds compressed"
        );
        assert!(raw_frames[1] > 0, "measured rounds prepared no frame");
    }
    let parked: Vec<_> = (0..buffers.frames.parked())
        .map(|_| buffers.frames.take(0))
        .collect();
    let retained_bytes: usize = parked.iter().map(Vec::capacity).sum();
    let max_allocations = observations
        .iter()
        .map(|(_, tally, _)| tally.allocations)
        .max()
        .unwrap();
    for (sample, (cpu, tally, (fingerprint, (wire, datagrams, reliable)))) in
        observations.into_iter().enumerate()
    {
        eprintln!(
            "PREPARE_ALLOCATION cols={cols} rows={rows} entropy={entropy} sample={sample} cpu_us={} allocations={} allocated_bytes={} retained_frame_bytes={retained_bytes} frame_slots={DISPLAY_FRAME_POOL_DEPTH} fingerprint={fingerprint} primary_wire_bytes={wire} primary_datagrams={datagrams} primary_reliable_records={reliable}",
            cpu.as_secs_f64() * 1e6,
            tally.allocations,
            tally.allocated_bytes
        );
    }
    max_allocations
}

#[test]
#[ignore = "exclusive full-job and worker head-of-line performance workload"]
fn production_maximum_prepare_job_benchmark() {
    maximum_prepare_job_comparison(&[PackingExperiment::Adaptive]);
}

#[test]
#[ignore = "exclusive paired first-partition candidate full-job comparison"]
fn first_partition_candidate_full_job_benchmark() {
    maximum_prepare_job_comparison(&[
        PackingExperiment::Adaptive,
        PackingExperiment::FirstPartition,
    ]);
}

#[test]
#[ignore = "exclusive paired whole-span candidate full-job comparison"]
fn whole_span_candidate_full_job_benchmark() {
    maximum_prepare_job_comparison(&[PackingExperiment::Adaptive, PackingExperiment::WholeSpan]);
}

fn maximum_prepare_job_comparison(arms: &[PackingExperiment]) {
    if arms.contains(&PackingExperiment::WholeSpan) {
        print_whole_span_comparison_contract();
    }
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200)
        .max(100);
    for (case_index, (rtt_ms, cols, rows, entropy, learned_peer)) in [50.0, 120.0, 200.0]
        .into_iter()
        .flat_map(|rtt| {
            [
                (120u16, 40u16, false),
                (384, 256, false),
                (384, 256, true),
                (512, 192, true),
            ]
            .into_iter()
            .flat_map(move |(cols, rows, entropy)| {
                [false, true].map(move |learned| (rtt, cols, rows, entropy, learned))
            })
        })
        .enumerate()
    {
        // Repeat this identical case in AB and BA order, not merely
        // alternate different scenarios. Keep raw pass labels so thermal
        // drift can be checked before pooling the two populations.
        for order_pass in 0..arms.len() {
            for arm_index in 0..arms.len() {
                let experiment = arms[(arm_index + case_index + order_pass) % arms.len()];
                let arm = partition_comparison_arm(experiment);
                assert!(usize::from(cols) * usize::from(rows) <= merkur_codec::MAX_TERMINAL_CELLS);
                let (event_tx, _event_rx) = crossbeam_channel::unbounded();
                let mut terminal = TerminalState::new(cols, rows, event_tx);
                let bytes = maximum_prepare_fixture(cols, rows, entropy, 0);
                terminal.apply_bytes(&bytes);
                let mut peer = benchmark_noise_peer();
                peer.display_cache.resize(cols, rows);
                peer.last_input_at_ms = 100.0;
                peer.paths.edge.available = true;
                peer.paths.edge.last_ack_at_ms = 100.0;
                peer.paths.edge.network_rtt_ewma_ms = rtt_ms;
                peer.display_planning.observe_carrier_quote(
                    1,
                    CarrierDeliveryQuote {
                        one_way_us: rtt_ms * 500.0,
                        ..CarrierDeliveryQuote::default()
                    },
                );
                let mut capture = RowCaptureScratch::default();
                let mut cache = HashMap::new();
                let (mut worker, mut completions, _snapshots, _dictionaries) =
                    with_packing_experiment(experiment, start_display_prepare_worker);
                let mut capture_us = Vec::with_capacity(samples);
                let mut capture_allocations = Vec::with_capacity(samples);
                let mut capture_allocated_bytes = Vec::with_capacity(samples);
                let mut bulk_us = Vec::with_capacity(samples);
                let mut bulk_allocations = Vec::with_capacity(samples);
                let mut bulk_allocated_bytes = Vec::with_capacity(samples);
                let mut partition_us = Vec::with_capacity(samples);
                let mut first_partition_us = Vec::with_capacity(samples);
                let mut largest_partition_us = Vec::with_capacity(samples);
                let mut compression_us = Vec::with_capacity(samples);
                let mut partition_calls = Vec::with_capacity(samples);
                let mut first_partition_gain_us = Vec::with_capacity(samples);
                let mut first_partition_gap_us = Vec::with_capacity(samples);
                let mut datagram_counts = Vec::with_capacity(samples);
                let mut fec_bytes = Vec::with_capacity(samples);
                let mut primary_wire_bytes = Vec::with_capacity(samples);
                let mut primary_datagrams = Vec::with_capacity(samples);
                let mut primary_reliable_records = Vec::with_capacity(samples);
                let mut interactive_queue_us = Vec::with_capacity(samples);
                let mut interactive_cpu_us = Vec::with_capacity(samples);
                let mut bulk_before_interactive = 0;
                let row_requests: Vec<_> = (0..rows)
                    .map(|row| DisplayRowRequest::literal(row, true))
                    .collect();
                let mut capture_request =
                    |token,
                     row_count: u16,
                     lane,
                     clear_cache,
                     worker: &mut DisplayPrepareWorker,
                     peer: &PeerDisplayState| {
                        let mut buffers = worker.take_buffers();
                        if clear_cache {
                            cache.clear();
                        }
                        crate::edge_tunnel::test_allocations::begin_thread();
                        let started = Instant::now();
                        capture_prepare_rows(
                            &terminal,
                            peer,
                            &row_requests[..usize::from(row_count)],
                            terminal.current_cursor_row(),
                            &mut capture,
                            &mut cache,
                            &mut buffers.rows,
                        );
                        let capture_us = started.elapsed().as_secs_f64() * 1e6;
                        let allocations = crate::edge_tunnel::test_allocations::end_thread();
                        let compression = display_compression_policy(peer, 100.0, true, lane, 0);
                        (
                            DisplayPrepareRequest {
                                token,
                                prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
                                prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
                                submitted_at: Instant::now(),
                                perf_flush_started_at: Some(FlushStart::now()),
                                generation: peer.generation,
                                display_revision: terminal.display_revision(),
                                completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
                                start_seq: peer.next_datagram_seq,
                                start_frame_id: peer.next_frame_id,
                                presentation_continues: false,
                                causal_input_advanced: false,
                                input_seq: 1,
                                header_signal: terminal.current_display_header_signal(),
                                header_changed: false,
                                header: terminal
                                    .current_display_header(merkur_codec::FrameKind::Delta),
                                buffers,
                                compression,
                                compression_dictionary: None,
                                burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
                                summary: flush_summary_for_test(u32::from(row_count)),
                            },
                            capture_us,
                            allocations,
                        )
                    };
                for round in 0..samples + 10 {
                    let (mut bulk, captured, captured_allocations) = capture_request(
                        (round * 2 + 1) as u64,
                        rows,
                        ExecutionLane::Bulk,
                        true,
                        &mut worker,
                        &peer,
                    );
                    bulk.submitted_at = Instant::now();
                    let bulk_token = bulk.token;
                    worker.bulk_tx.send(bulk).expect("bulk worker alive");
                    // This is real host scheduling, not a virtual delay. Record
                    // both observed orders rather than dropping fast/no-HOL cases.
                    std::thread::sleep(Duration::from_micros(100));
                    let (mut interactive, _, _) = capture_request(
                        (round * 2 + 2) as u64,
                        2,
                        ExecutionLane::Interactive,
                        false,
                        &mut worker,
                        &peer,
                    );
                    interactive.submitted_at = Instant::now();
                    worker
                        .interactive_tx
                        .send(interactive)
                        .expect("interactive worker alive");
                    let first = completions.blocking_recv().expect("first completion");
                    let second = completions.blocking_recv().expect("second completion");
                    let bulk_first = first.token == bulk_token;
                    let (bulk, interactive) = if bulk_first {
                        (first, second)
                    } else {
                        (second, first)
                    };
                    if round >= 10 {
                        capture_us.push(captured);
                        capture_allocations.push(captured_allocations.allocations as f64);
                        capture_allocated_bytes.push(captured_allocations.allocated_bytes as f64);
                        bulk_us.push(bulk.cpu_time.as_secs_f64() * 1e6);
                        let bulk_timing = bulk.perf_timing.expect("instrumented bulk job");
                        bulk_allocations.push(bulk_timing.allocations.allocations as f64);
                        bulk_allocated_bytes.push(bulk_timing.allocations.allocated_bytes as f64);
                        partition_us.push(bulk_timing.partition_time.as_secs_f64() * 1e6);
                        first_partition_us
                            .push(bulk_timing.first_partition_time.as_secs_f64() * 1e6);
                        largest_partition_us
                            .push(bulk_timing.largest_partition_time.as_secs_f64() * 1e6);
                        compression_us.push(bulk_timing.compression_time.as_secs_f64() * 1e6);
                        partition_calls.push(bulk_timing.partition_calls as f64);
                        first_partition_gain_us.push(bulk_timing.first_partition_gain_us);
                        first_partition_gap_us.push(bulk_timing.first_partition_gap_us);
                        datagram_counts.push(bulk.buffers.datagrams.len() as f64);
                        fec_bytes.push(
                            bulk.buffers
                                .datagrams
                                .iter()
                                .map(|frame| {
                                    frame.precomputed_fec_repair.as_ref().map_or(0, Vec::len)
                                })
                                .sum::<usize>() as f64,
                        );
                        let (wire, datagrams, reliable) =
                            prepared_primary_traffic(&bulk.buffers.datagrams);
                        primary_wire_bytes.push(wire as f64);
                        primary_datagrams.push(datagrams as f64);
                        primary_reliable_records.push(reliable as f64);
                        let timing = interactive.perf_timing.expect("instrumented job");
                        interactive_queue_us.push(
                            timing
                                .prepare_started_at
                                .duration_since(timing.prepare_queued_at)
                                .as_secs_f64()
                                * 1e6,
                        );
                        interactive_cpu_us.push(interactive.cpu_time.as_secs_f64() * 1e6);
                        bulk_before_interactive += usize::from(bulk_first);
                    }
                    if learned_peer {
                        // Apply the same achieved-content evidence as the owner
                        // completion path. Keep the other population cold to
                        // measure a new-content worst case even with warm storage.
                        for datagram in &bulk.buffers.datagrams {
                            observe_display_compression_outcome(
                                &mut peer,
                                datagram.frame.len(),
                                datagram.raw_bytes,
                                datagram.compression_attempted,
                                datagram.content_class,
                                bulk.dictionary_class,
                            );
                        }
                    }
                    worker.recycle(bulk.buffers);
                    worker.recycle(interactive.buffers);
                }
                // Print only after all timed rounds: I/O never delays the queued
                // interactive job. Keep unsorted observations for independent tails.
                for sample in 0..samples {
                    eprintln!(
                        "FULL_PREPARE_SAMPLE arm={arm} order_pass={order_pass} quote_rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned_peer={learned_peer} sample={sample} capture_us={} capture_allocations={} capture_allocated_bytes={} bulk_us={} bulk_allocations={} bulk_allocated_bytes={} partition_us={} first_partition_us={} compression_us={} partition_calls={} records={} fec_bytes={} primary_wire_bytes={} primary_datagrams={} primary_reliable_records={} interactive_queue_us={} interactive_cpu_us={}",
                        capture_us[sample],
                        capture_allocations[sample],
                        capture_allocated_bytes[sample],
                        bulk_us[sample],
                        bulk_allocations[sample],
                        bulk_allocated_bytes[sample],
                        partition_us[sample],
                        first_partition_us[sample],
                        compression_us[sample],
                        partition_calls[sample],
                        datagram_counts[sample],
                        fec_bytes[sample],
                        primary_wire_bytes[sample],
                        primary_datagrams[sample],
                        primary_reliable_records[sample],
                        interactive_queue_us[sample],
                        interactive_cpu_us[sample],
                    );
                }
                let mut snapshot_us = Vec::with_capacity(samples);
                let mut snapshot_allocations = Vec::with_capacity(samples);
                let mut snapshot_allocated_bytes = Vec::with_capacity(samples);
                let mut snapshot_grid = Vec::new();
                let mut snapshot_hashes = Vec::new();
                let (snapshot, _) = terminal.encode_snapshot_state_into(
                    Vec::new(),
                    &mut snapshot_grid,
                    &mut snapshot_hashes,
                    &mut Vec::new(),
                );
                let mut snapshot_compressor = Compressor::new();
                let mut snapshot_planner = GlobalDisplayPlanningModel::default();
                for round in 0..samples + 10 {
                    let request = SnapshotPrepareRequest {
                        token: 1,
                        submitted_at: Instant::now(),
                        display_revision: terminal.display_revision(),
                        completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
                        cols,
                        rows,
                        header_signal: terminal.current_display_header_signal(),
                        content_class: ContentClass::Color,
                        snapshot: snapshot.clone(),
                        snapshot_grid: snapshot_grid.clone(),
                        snapshot_graphics: Vec::new(),
                        row_hashes: snapshot_hashes.clone(),
                        peers: vec![SnapshotPeerPlan {
                            peer_id: Arc::clone(&peer.peer_id),
                            prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
                            prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
                            profile: peer
                                .display_planning
                                .snapshot(ContentClass::Color, DictionaryClass::Plain),
                            context: display_planning_context(&peer, 100.0, 0),
                        }],
                    };
                    crate::edge_tunnel::test_allocations::begin_thread();
                    let completion = prepare_snapshot_off_loop(
                        request,
                        &mut snapshot_compressor,
                        &mut snapshot_planner,
                    );
                    let allocations = crate::edge_tunnel::test_allocations::end_thread();
                    if round >= 10 {
                        snapshot_us.push(completion.cpu_time.as_secs_f64() * 1e6);
                        snapshot_allocations.push(allocations.allocations as f64);
                        snapshot_allocated_bytes.push(allocations.allocated_bytes as f64);
                    }
                }
                for (stage, mut values) in [
                    ("owner-capture", capture_us),
                    ("owner-capture-allocation-count", capture_allocations),
                    ("owner-capture-allocated-bytes", capture_allocated_bytes),
                    ("bulk-job", bulk_us),
                    ("bulk-job-allocation-count", bulk_allocations),
                    ("bulk-job-allocated-bytes", bulk_allocated_bytes),
                    ("partition-job", partition_us),
                    ("partition-first", first_partition_us),
                    ("partition-largest", largest_partition_us),
                    ("compression-job", compression_us),
                    ("partition-count", partition_calls),
                    (
                        "partition-first-modeled-refinement-gain",
                        first_partition_gain_us,
                    ),
                    ("partition-first-relaxed-gap", first_partition_gap_us),
                    ("record-count", datagram_counts),
                    ("fec-bytes", fec_bytes),
                    ("prepared-primary-wire-bytes", primary_wire_bytes),
                    ("prepared-primary-datagram-count", primary_datagrams),
                    (
                        "prepared-primary-reliable-record-count",
                        primary_reliable_records,
                    ),
                    ("interactive-queue", interactive_queue_us),
                    ("interactive-job", interactive_cpu_us),
                    ("snapshot-job", snapshot_us),
                    ("snapshot-job-allocation-count", snapshot_allocations),
                    ("snapshot-job-allocated-bytes", snapshot_allocated_bytes),
                ] {
                    values.sort_by(f64::total_cmp);
                    let at = |p: f64| {
                        values[((samples as f64 * p).ceil() as usize)
                            .saturating_sub(1)
                            .min(samples - 1)]
                    };
                    let unit = if stage.ends_with("-count") {
                        "count"
                    } else if stage.ends_with("-bytes") {
                        "bytes"
                    } else {
                        "us"
                    };
                    eprintln!(
                        "FULL_PREPARE arm={arm} order_pass={order_pass} quote_rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned_peer={learned_peer} samples={samples} stage={stage} p50_{unit}={:.3} p95_{unit}={:.3} p99_{unit}={:.3} max_{unit}={:.3} bulk_completed_first={bulk_before_interactive}",
                        at(0.5),
                        at(0.95),
                        at(0.99),
                        values[samples - 1]
                    );
                }
            }
        }
    }
}

#[test]
fn worker_prepare_keeps_frame_loss_local_and_groups_only_presentation() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'p'));
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let request = interactive_request_for_test(
        1,
        &terminal,
        &peer,
        ROWS,
        &mut capture_scratch,
        &mut flush_cache,
    );
    let mut compressor = Compressor::new();
    let mut fec_encoder = crate::display::fec::FecEncoder::new();
    let mut scratch = PrepareScratch::default();

    let completion =
        prepare_display_off_loop(request, &mut compressor, &mut fec_encoder, &mut scratch);
    assert!(
        completion.buffers.datagrams.len() > 1,
        "fixture must cross the datagram cap"
    );
    let presentation_id = merkur_codec::parse_frame_header(&completion.buffers.datagrams[0].frame)
        .unwrap()
        .presentation_id;
    let mut frame_ids = std::collections::HashSet::new();
    for (index, datagram) in completion.buffers.datagrams.iter().enumerate() {
        let header = merkur_codec::parse_frame_header(&datagram.frame).unwrap();
        assert!(frame_ids.insert(header.frame_id));
        assert_eq!(header.frame_id, datagram.frame_id);
        assert_eq!(header.presentation_id, presentation_id);
        assert!(header.presentation_coherent);
        assert_eq!(
            header.presentation_end,
            index + 1 == completion.buffers.datagrams.len()
        );
        assert_eq!(header.presentation_member_index, index as u16);
        assert_eq!(
            header.presentation_member_count,
            completion.buffers.datagrams.len() as u16
        );
        assert_eq!(header.chunk_count, 1);
    }
}

#[tokio::test]
async fn cursor_feedback_waits_for_bulk_token_then_runs_without_a_coalescing_tail() {
    const ROWS: u16 = 3;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, ROWS, event_tx);
    let (mut peer, _browser) = benchmark_noise_pair();
    peer.needs_snapshot = false;
    peer.display_cache.resize(8, ROWS);
    let (capture_tx, mut capture_rx) = mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    terminal.apply_bytes(b"\x1b[?2026h");
    terminal.apply_bytes(&terminal_fixture(8, ROWS, b'a'));
    terminal.apply_bytes(b"\x1b[?2026l");
    assert!(terminal.completed_sync_update_epoch() > 0);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let request = interactive_request_for_test(
        91,
        &terminal,
        &peer,
        ROWS,
        &mut capture_scratch,
        &mut flush_cache,
    );
    peer.display_prepare_in_flight = Some(91);
    let mut compressor = Compressor::new();
    let mut prepare_scratch = PrepareScratch::default();
    // Holding a bulk result must not let its cursor row escape as an
    // urgent partial repaint. Completion wakes the follow-up immediately;
    // the existing token prevents duplicate work and zero-delay spins.
    let completion = prepare_display_off_loop(
        request,
        &mut compressor,
        &mut crate::display::fec::FecEncoder::new(),
        &mut prepare_scratch,
    );
    terminal.clear_dirty();
    terminal.apply_bytes(b"\rZ");
    let damage = terminal.pending_display_damage();
    assert_eq!(damage.rows, PendingRowDamage::CursorOnly);
    let mut hashes = Vec::new();
    terminal.current_row_hashes_into(&mut hashes);
    peer.latest_input_seq = 2;
    peer.last_input_at_ms = 100.0;
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            damage,
            terminal.current_display_header_signal(),
            &hashes,
            100.0
        ),
        None
    );
    let other_row = (0..ROWS)
        .find(|row| Some(*row) != damage.cursor_row)
        .unwrap() as usize;
    let other_sent_before = peer.display_cache.sent_row_hashes[other_row];
    assert_ne!(other_sent_before, hashes[other_row]);
    let peer_id = peer.peer_id.clone();
    let mut peers = PeerMap::from([(peer_id.clone(), peer)]);
    let mut worker = idle_prepare_worker_for_test();
    let mut rows = FlushRowScratch::default();
    // The normal hash pass may clear the terminal damage edge.
    terminal.clear_dirty();
    flush_cache.clear();
    send_peer_datagram_delta_with_worker(
        &mut terminal,
        &mut compressor,
        &mut worker,
        &mut prepare_scratch,
        &mut peers,
        &peer_id,
        100.0,
        &hashes,
        &mut rows,
        &mut flush_cache,
        true,
        &mut PerfTimingTracker::default(),
        None,
    );
    let peer = &peers[&peer_id];
    assert_eq!(peer.display_prepare_in_flight, Some(91));
    assert_ne!(peer.last_advertised_input_seq, 2);
    assert_eq!(
        peer.display_cache.sent_row_hashes[other_row],
        other_sent_before
    );
    assert!(capture_rx.try_recv().is_err());
    finish_display_prepare(
        completion,
        terminal.display_revision(),
        &mut peers,
        &mut worker,
        200.0,
        None,
    )
    .await;
    let peer = &peers[&peer_id];
    assert_eq!(peer.display_prepare_in_flight, None);
    assert_eq!(
        peer.last_admitted_sync_epoch, 0,
        "a stale captured ESU must not consume the current revision's scheduling hint"
    );
    assert_ne!(peer.last_advertised_input_seq, 2);
    assert_eq!(
        peer.display_cache.sent_row_hashes[other_row],
        hashes[other_row]
    );
    assert!(peer.needs_full_diff);
    assert!(peer.display_cache.has_selectable_rows(&hashes, 200.0));
    assert_eq!(
        peer_next_flush_delay_ms(
            peer,
            terminal.pending_display_damage(),
            terminal.current_display_header_signal(),
            &hashes,
            200.0
        ),
        Some(0),
        "the newer causal cursor row must not inherit the bulk coalescing tail"
    );
    assert_eq!(
        worker.spare.len(),
        1,
        "only the original buffer set is retained"
    );
}

/// Real owner selection/capture, bounded worker, completion fencing and
/// physical carrier admission. This measures native injected PTY effects,
/// not browser input, network transit or pixels. Capture-carrier copies are
/// included. All injected events are retained, including already-ready jobs.
#[tokio::test(flavor = "current_thread")]
#[ignore = "exclusive actual owner-loop bulk/interactive interference profile"]
async fn production_owner_loop_bulk_interference_benchmark() {
    owner_loop_bulk_interference_comparison(&[PackingExperiment::Adaptive]).await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "exclusive paired first-partition actual owner-loop comparison"]
async fn first_partition_candidate_owner_loop_benchmark() {
    owner_loop_bulk_interference_comparison(&[
        PackingExperiment::Adaptive,
        PackingExperiment::FirstPartition,
    ])
    .await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "exclusive paired whole-span actual owner-loop comparison"]
async fn whole_span_candidate_owner_loop_benchmark() {
    owner_loop_bulk_interference_comparison(&[
        PackingExperiment::Adaptive,
        PackingExperiment::WholeSpan,
    ])
    .await;
}

async fn owner_loop_bulk_interference_comparison(arms: &[PackingExperiment]) {
    if arms.contains(&PackingExperiment::WholeSpan) {
        print_whole_span_comparison_contract();
    }
    use crate::display::recv::{DisplayAck, handle_display_ack};
    let samples = std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200)
        .max(100);
    let mut case_index = 0;
    for rtt_ms in [50.0, 120.0, 200.0] {
        for (cols, rows, entropy) in [(120, 40, false), (384, 256, false), (384, 256, true)] {
            for learned in [false, true] {
                for header_only in [false, true] {
                    for order_pass in 0..arms.len() {
                        for arm_index in 0..arms.len() {
                            let experiment =
                                arms[(arm_index + case_index + order_pass) % arms.len()];
                            let arm = partition_comparison_arm(experiment);
                            let fixtures = [
                                maximum_prepare_fixture(cols, rows, entropy, 0),
                                maximum_prepare_fixture(cols, rows, entropy, 1),
                            ];
                            let (mut terminal, baseline, _) = sized_fixture(cols, rows);
                            let (mut peer, _) = benchmark_noise_pair();
                            peer.authenticated = true;
                            peer.needs_snapshot = false;
                            peer.display_cache = baseline;
                            // The fixture's exact baseline was ACKed at sequence 1.
                            peer.next_datagram_seq = 2;
                            peer.last_display_seq_sent = 1;
                            let (tx, mut rx) = mpsc::unbounded_channel();
                            peer.edge_tunnel =
                                Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
                            let peer_id = Arc::clone(&peer.peer_id);
                            let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
                            let (mut worker, mut completions, _snapshots, _dictionaries) =
                                with_packing_experiment(experiment, start_display_prepare_worker);
                            let mut scratch = DisplayScratch::new(DISPLAY_FRAME_POOL_DEPTH);
                            scratch.prepare.experiment = experiment;
                            let mut cursor = DisplayFlushCursor::default();
                            let mut timing = PerfTimingTracker::default();
                            let clock =
                                FlushClock::Epoch(Instant::now() - Duration::from_millis(100));
                            let mut owner_capture = Vec::with_capacity(samples);
                            let mut input_effect = Vec::with_capacity(samples);
                            let mut token_wait = Vec::with_capacity(samples);
                            let mut complete_admission = Vec::with_capacity(samples);
                            let mut first_original_admission = Vec::with_capacity(samples);
                            let mut last_original_admission = Vec::with_capacity(samples);
                            let mut original_admission_count = Vec::with_capacity(samples);
                            let mut bulk_cpu = Vec::with_capacity(samples);
                            let mut followup_arm = Vec::with_capacity(samples);
                            let mut owner_wakes = Vec::with_capacity(samples);
                            let mut admitted_records = Vec::with_capacity(samples);
                            let mut admitted_sealed_bytes = Vec::with_capacity(samples);
                            let mut ready_at_input = 0usize;
                            for round in 0..samples + 10 {
                                terminal.apply_bytes(&fixtures[round & 1]);
                                let before = clock.now_ms();
                                let peer = peers.get_mut(&peer_id).unwrap();
                                if !learned {
                                    peer.display_planning = Default::default();
                                }
                                peer.display_planning.observe_carrier_quote(
                                    1,
                                    CarrierDeliveryQuote {
                                        one_way_us: rtt_ms * 500.0,
                                        ..CarrierDeliveryQuote::default()
                                    },
                                );
                                peer.paths.edge.available = true;
                                peer.paths.edge.last_ack_at_ms = before;
                                peer.paths.edge.network_rtt_ewma_ms = rtt_ms;
                                peer.last_input_at_ms = before;
                                peer.latest_input_seq = round as u32 * 2 + 1;
                                peer.last_advertised_input_seq = peer.latest_input_seq;
                                TEST_ORIGINAL_ADMISSION_TIMING.set(Some(OriginalAdmissionTiming {
                                    first: None,
                                    last: None,
                                    originals: 0,
                                }));
                                let capture_started = Instant::now();
                                flush_display(
                                    &mut terminal,
                                    &mut scratch,
                                    &mut worker,
                                    &mut peers,
                                    &clock,
                                    &mut cursor,
                                    &mut timing,
                                )
                                .await;
                                let captured_us = capture_started.elapsed().as_secs_f64() * 1e6;
                                let bulk_token = peers[&peer_id]
                                    .display_prepare_in_flight
                                    .expect("representative bulk job was submitted");
                                std::thread::sleep(Duration::from_micros(100));
                                let already_ready = !completions.is_empty();
                                let injected = Instant::now();
                                terminal.apply_bytes(if header_only {
                                    if round & 1 == 0 {
                                        b"\x1b[?25l"
                                    } else {
                                        b"\x1b[?25h"
                                    }
                                } else {
                                    b"\rZ"
                                });
                                let effect_us = injected.elapsed().as_secs_f64() * 1e6;
                                let input_seq = round as u32 * 2 + 2;
                                peers.get_mut(&peer_id).unwrap().latest_input_seq = input_seq;
                                peers.get_mut(&peer_id).unwrap().last_input_at_ms = clock.now_ms();
                                let mut first_completion_us = None;
                                let mut this_bulk_cpu = 0.0;
                                let mut maximum_arm_ms = 0;
                                let mut wakes = 0;
                                loop {
                                    assert!(
                                        injected.elapsed() < Duration::from_secs(5),
                                        "owner feedback never completed"
                                    );
                                    if peers[&peer_id].display_prepare_in_flight.is_some() {
                                        let completion = tokio::time::timeout(
                                            Duration::from_secs(5),
                                            completions.recv(),
                                        )
                                        .await
                                        .unwrap()
                                        .unwrap();
                                        wakes += 1;
                                        if completion.token == bulk_token {
                                            first_completion_us =
                                                Some(injected.elapsed().as_secs_f64() * 1e6);
                                            this_bulk_cpu = completion.cpu_time.as_secs_f64() * 1e6;
                                        }
                                        finish_display_prepare(
                                            completion,
                                            terminal.display_revision(),
                                            &mut peers,
                                            &mut worker,
                                            clock.now_ms(),
                                            None,
                                        )
                                        .await;
                                    }
                                    let peer = &peers[&peer_id];
                                    if peer.last_advertised_input_seq == input_seq
                                        && !peer.presentation_end_owed
                                        && !terminal.has_dirty()
                                        && peer.display_cache.sent_row_hashes
                                            == scratch.current_row_hashes
                                    {
                                        break;
                                    }
                                    let due = peer_next_flush_delay_ms(
                                        peer,
                                        terminal.pending_display_damage(),
                                        terminal.current_display_header_signal(),
                                        &scratch.current_row_hashes,
                                        clock.now_ms(),
                                    )
                                    .expect("injected state remains scheduled after completion");
                                    maximum_arm_ms = maximum_arm_ms.max(due);
                                    if due > 0 {
                                        tokio::time::sleep(Duration::from_millis(due)).await;
                                    }
                                    wakes += 1;
                                    flush_display(
                                        &mut terminal,
                                        &mut scratch,
                                        &mut worker,
                                        &mut peers,
                                        &clock,
                                        &mut cursor,
                                        &mut timing,
                                    )
                                    .await;
                                }
                                let admitted_us = injected.elapsed().as_secs_f64() * 1e6;
                                let admission_timing = TEST_ORIGINAL_ADMISSION_TIMING
                                    .replace(None)
                                    .expect("owner-only admission timing enabled");
                                if round >= 10 {
                                    owner_capture.push(captured_us);
                                    input_effect.push(effect_us);
                                    token_wait.push(first_completion_us.unwrap());
                                    complete_admission.push(admitted_us);
                                    first_original_admission.push(
                                        admission_timing
                                            .first
                                            .unwrap()
                                            .duration_since(capture_started)
                                            .as_secs_f64()
                                            * 1e6,
                                    );
                                    last_original_admission.push(
                                        admission_timing
                                            .last
                                            .unwrap()
                                            .duration_since(capture_started)
                                            .as_secs_f64()
                                            * 1e6,
                                    );
                                    original_admission_count
                                        .push(admission_timing.originals as f64);
                                    bulk_cpu.push(this_bulk_cpu);
                                    followup_arm.push(maximum_arm_ms as f64 * 1000.0);
                                    owner_wakes.push(wakes as f64);
                                    ready_at_input += usize::from(already_ready);
                                }
                                // The capture carrier delivered every admitted unit.
                                // Confirm each exact snapshot outside the timed span;
                                // neither unseen IDs nor current terminal cells are ACKed.
                                let peer = peers.get_mut(&peer_id).unwrap();
                                let sequences: Vec<_> =
                                    peer.display_cache.sent_datagrams.keys().copied().collect();
                                let acknowledged_sequences = sequences.clone();
                                for seq in sequences {
                                    handle_display_ack(
                                        peer,
                                        DisplayAck::new(peer.generation, seq, [1, 0, 0, 0]),
                                        clock.now_ms(),
                                        PeerTransport::Edge,
                                        &scratch.current_row_hashes,
                                        false,
                                    );
                                }
                                assert_eq!(
                                    peer.display_cache.acked_row_hashes,
                                    scratch.current_row_hashes,
                                    "header_only={header_only} round={round} sequences={acknowledged_sequences:?} latest={:?} acked={:?} confirmed={:?}",
                                    peer.display_cache.sent_row_latest_seq,
                                    peer.display_cache.acked_row_seq,
                                    peer.display_cache.sent_row_confirmed
                                );
                                let mut records = 0;
                                let mut sealed_bytes = 0;
                                while let Ok((_channel, payload)) = rx.try_recv() {
                                    records += 1;
                                    // Real capture submissions include replicas and
                                    // probes. This is channel + sealed application
                                    // data, not invented UDP/QUIC packet accounting.
                                    sealed_bytes += 1 + payload.len();
                                }
                                if round >= 10 {
                                    admitted_records.push(records as f64);
                                    admitted_sealed_bytes.push(sealed_bytes as f64);
                                }
                            }
                            for sample in 0..samples {
                                eprintln!(
                                    "OWNER_INTERFERENCE_SAMPLE arm={arm} order_pass={order_pass} quote_rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned_peer={learned} header_only={header_only} sample={sample} owner_capture_us={} input_effect_us={} token_wait_us={} complete_admission_us={} bulk_cpu_us={} followup_arm_us={} owner_wakes={} admitted_records={} admitted_sealed_bytes={} first_original_admission_us={} last_original_admission_us={} original_admission_count={}",
                                    owner_capture[sample],
                                    input_effect[sample],
                                    token_wait[sample],
                                    complete_admission[sample],
                                    bulk_cpu[sample],
                                    followup_arm[sample],
                                    owner_wakes[sample],
                                    admitted_records[sample],
                                    admitted_sealed_bytes[sample],
                                    first_original_admission[sample],
                                    last_original_admission[sample],
                                    original_admission_count[sample],
                                );
                            }
                            for (stage, mut values) in [
                                ("owner-selection-capture", owner_capture),
                                ("injected-pty-effect", input_effect),
                                ("input-to-bulk-completion", token_wait),
                                ("input-to-complete-admission", complete_admission),
                                (
                                    "owner-start-to-first-original-admission",
                                    first_original_admission,
                                ),
                                (
                                    "owner-start-to-last-original-admission",
                                    last_original_admission,
                                ),
                                ("original-admission-count", original_admission_count),
                                ("bulk-worker-cpu", bulk_cpu),
                                ("maximum-followup-arm", followup_arm),
                                ("owner-wake-count", owner_wakes),
                                ("admitted-record-count", admitted_records),
                                ("admitted-sealed-bytes", admitted_sealed_bytes),
                            ] {
                                values.sort_by(f64::total_cmp);
                                let q = |p: f64| {
                                    values[((p * samples as f64).ceil() as usize)
                                        .saturating_sub(1)
                                        .min(samples - 1)]
                                };
                                eprintln!(
                                    "OWNER_INTERFERENCE arm={arm} order_pass={order_pass} quote_rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned_peer={learned} header_only={header_only} samples={samples} stage={stage} p50={:.3} p95={:.3} p99={:.3} max={:.3} ready_at_input={ready_at_input} unit={}",
                                    q(0.5),
                                    q(0.95),
                                    q(0.99),
                                    values[samples - 1],
                                    if stage.ends_with("-count") {
                                        "count"
                                    } else if stage.ends_with("-bytes") {
                                        "bytes"
                                    } else {
                                        "us"
                                    }
                                );
                            }
                        }
                    }
                    case_index += 1;
                }
            }
        }
    }
}

#[tokio::test]
async fn continuation_discovered_after_worker_prepare_clears_end_before_send() {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(8, 1, event_tx);
    terminal.apply_bytes(b"x");
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.needs_snapshot = false;
    peer.display_cache.resize(8, 1);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let token = 91;
    let mut request = interactive_request_for_test(
        token,
        &terminal,
        &peer,
        1,
        &mut capture_scratch,
        &mut flush_cache,
    );
    request.causal_input_advanced = true;
    let display_revision = terminal.display_revision();
    let mut compressor = Compressor::new();
    let mut fec_encoder = crate::display::fec::FecEncoder::new();
    let mut scratch = PrepareScratch::default();
    let completion =
        prepare_display_off_loop(request, &mut compressor, &mut fec_encoder, &mut scratch);
    let prepared_header =
        merkur_codec::parse_frame_header(&completion.buffers.datagrams[0].frame).unwrap();
    assert!(!prepared_header.presentation_coherent);
    assert!(prepared_header.presentation_end);
    assert_eq!(prepared_header.presentation_member_count, 0);

    peer.display_prepare_in_flight = Some(token);
    peer.latest_input_seq = 2;
    let mut peers = PeerMap::from([(Arc::clone(&peer.peer_id), peer)]);
    finish_display_prepare(
        completion,
        display_revision,
        &mut peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;

    let (channel, ciphertext) = capture_rx.recv().await.expect("display datagram");
    assert_eq!(channel, CHANNEL_DISPLAY_DATAGRAM);
    let lane = crate::e2e::lane_for_channel(channel).unwrap();
    let plain = browser
        .open_datagram(lane, &ciphertext)
        .expect("sealed display datagram");
    let sent_header = merkur_codec::parse_frame_header(&plain).unwrap();
    assert!(sent_header.presentation_coherent);
    assert!(!sent_header.presentation_end);
    assert_eq!(sent_header.presentation_member_index, 0);
    assert_eq!(sent_header.presentation_member_count, 1);
    assert!(peers["browser-bench"].needs_full_diff);
}

#[test]
fn late_continuation_restamps_original_members_before_rebuilding_fec() {
    let mut prepared: Vec<_> = (1..=3)
        .map(|seq| prepared_with_utility_for_test(seq, 80, DisplayUtility::NonCritical))
        .collect();
    let mut pool = frame_pool_for_test();
    let mut encoder = crate::display::fec::FecEncoder::new();
    precompute_fec_repairs(&mut prepared, 4, 7, &mut encoder, &mut pool);
    let old_repair = prepared[2].precomputed_fec_repair.clone().unwrap();
    mark_prepared_datagrams_presentation_continues(&mut prepared, &mut pool);
    for (index, datagram) in prepared.iter().enumerate() {
        assert!(datagram.precomputed_fec_repair.is_none());
        assert_eq!(
            &datagram.frame[DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_INDEX_OFFSET + 2],
            &(index as u16).to_be_bytes()
        );
        assert_eq!(
            &datagram.frame[DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET
                ..DISPLAY_PRESENTATION_MEMBER_COUNT_OFFSET + 2],
            &3u16.to_be_bytes()
        );
    }
    precompute_fec_repairs(&mut prepared, 4, 7, &mut encoder, &mut pool);
    let repair = prepared[2].precomputed_fec_repair.as_ref().unwrap();
    assert_ne!(*repair, old_repair);
    let shard_size = u16::from_be_bytes([repair[10], repair[11]]) as usize;
    assert_eq!(shard_size, 80);
    assert_eq!(repair[8], 3);
    assert_eq!(repair[9], 2);
    let recovery: Vec<&[u8]> = repair[DISPLAY_FEC_HEADER_BYTES..]
        .chunks_exact(shard_size)
        .collect();
    let zero = [0u8; 80];
    let received: [&[u8]; 3] = [&prepared[0].frame, &prepared[1].frame, &zero];
    let mut output = [[0u8; 80]; 3];
    let restored = {
        let mut outputs: Vec<&mut [u8]> = output.iter_mut().map(|v| &mut v[..]).collect();
        merkur_fec::decode(0b011, 0b11, &received, &recovery, &mut outputs)
    };
    assert_eq!(restored, 0b100);
    assert_eq!(&output[2][..], &prepared[2].frame);
}

#[tokio::test]
async fn worker_causal_watermark_requires_one_actual_send_but_not_the_whole_burst() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    const INPUT_SEQ: u32 = 7;

    let build_completion =
        |token: u64,
         terminal: &TerminalState,
         peer: &PeerDisplayState,
         capture_scratch: &mut RowCaptureScratch,
         flush_cache: &mut HashMap<u16, CapturedRow>| {
            let mut request = interactive_request_for_test(
                token,
                terminal,
                peer,
                ROWS,
                capture_scratch,
                flush_cache,
            );
            request.causal_input_advanced = true;
            request.input_seq = INPUT_SEQ;
            request.summary.input_seq = INPUT_SEQ;
            let mut compressor = Compressor::new();
            let mut fec_encoder = crate::display::fec::FecEncoder::new();
            let mut scratch = PrepareScratch::default();
            prepare_display_off_loop(request, &mut compressor, &mut fec_encoder, &mut scratch)
        };

    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(b"\x1b[?2026h");
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'w'));
    terminal.apply_bytes(b"\x1b[?2026l");
    let sync_epoch = terminal.completed_sync_update_epoch();
    assert!(sync_epoch > 0);

    // First prove the all-refused arm. Preparation consumes wire sequence
    // numbers, but no carrier admission means the causal predicate must
    // remain stale and runnable.
    let (mut refused_peer, _browser) = benchmark_noise_pair();
    refused_peer.needs_snapshot = false;
    refused_peer.display_cache.resize(COLS, ROWS);
    refused_peer.latest_input_seq = INPUT_SEQ;
    refused_peer.last_advertised_input_seq = INPUT_SEQ - 1;
    let refused_token = 301;
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let refused_completion = build_completion(
        refused_token,
        &terminal,
        &refused_peer,
        &mut capture_scratch,
        &mut flush_cache,
    );
    assert!(refused_completion.buffers.datagrams.len() > 1);
    refused_peer.display_prepare_in_flight = Some(refused_token);
    let refused_peer_id = Arc::clone(&refused_peer.peer_id);
    let mut refused_peers = PeerMap::from([(refused_peer_id.clone(), refused_peer)]);
    finish_display_prepare(
        refused_completion,
        terminal.display_revision(),
        &mut refused_peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;
    let refused = &refused_peers[&refused_peer_id];
    assert_eq!(refused.last_display_seq_sent, 0);
    assert_eq!(refused.last_advertised_input_seq, INPUT_SEQ - 1);
    assert_eq!(refused.last_admitted_sync_epoch, 0);
    assert!(refused.needs_full_diff);

    // Now constrain a real carrier to one physical packet. The first
    // independently applicable frame carries the causal input sequence, so
    // a clipped tail must advance the watermark even though `all_sent` is
    // false and the remaining rows stay armed for the next flush.
    let (mut partial_peer, _browser) = benchmark_noise_pair();
    partial_peer.needs_snapshot = false;
    partial_peer.display_cache.resize(COLS, ROWS);
    partial_peer.latest_input_seq = INPUT_SEQ;
    partial_peer.last_advertised_input_seq = INPUT_SEQ - 1;
    partial_peer.adaptive.receive_queue_datagrams = 1;
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    partial_peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    let partial_token = 302;
    capture_scratch = RowCaptureScratch::default();
    flush_cache.clear();
    let partial_completion = build_completion(
        partial_token,
        &terminal,
        &partial_peer,
        &mut capture_scratch,
        &mut flush_cache,
    );
    assert!(partial_completion.buffers.datagrams.len() > 1);
    partial_peer.display_prepare_in_flight = Some(partial_token);
    let partial_peer_id = Arc::clone(&partial_peer.peer_id);
    let mut partial_peers = PeerMap::from([(partial_peer_id.clone(), partial_peer)]);
    finish_display_prepare(
        partial_completion,
        terminal.display_revision(),
        &mut partial_peers,
        &mut idle_prepare_worker_for_test(),
        100.0,
        None,
    )
    .await;
    let partial = &partial_peers[&partial_peer_id];
    assert_ne!(partial.last_display_seq_sent, 0);
    assert_eq!(partial.last_advertised_input_seq, INPUT_SEQ);
    assert_eq!(partial.last_admitted_sync_epoch, sync_epoch);
    assert!(partial.presentation_end_owed);
    assert!(
        partial.needs_full_diff,
        "the clipped redraw tail remains pending"
    );
    assert!(capture_rx.try_recv().is_ok(), "one data frame was admitted");
    assert!(
        capture_rx.try_recv().is_err(),
        "the advertised one-packet receive budget is exact"
    );
}

#[tokio::test]
async fn synchronized_update_jumbo_epoch_consumes_on_first_original_not_last() {
    for accepted_limit in [0, 1, usize::MAX] {
        let (event_tx, _event_rx) = crossbeam_channel::unbounded();
        let mut terminal = TerminalState::new(512, 4, event_tx);
        terminal.apply_bytes(b"\x1b[?2026h");
        terminal.apply_bytes(&maximum_prepare_fixture(512, 4, true, 0));
        terminal.apply_bytes(b"\x1b[?2026l");
        let epoch = terminal.completed_sync_update_epoch();
        assert!(epoch > 0);
        let (mut peer, _) = benchmark_noise_pair();
        peer.needs_snapshot = false;
        peer.display_cache.resize(512, 4);
        let (tx, mut rx) = mpsc::unbounded_channel();
        peer.edge_tunnel = Some(Arc::new(
            crate::edge_tunnel::EdgeTunnel::new_capture_with_reliable_limit(tx, accepted_limit),
        ));
        let request = interactive_request_for_test(
            403,
            &terminal,
            &peer,
            4,
            &mut RowCaptureScratch::default(),
            &mut HashMap::new(),
        );
        let completion = prepare_display_off_loop(
            request,
            &mut Compressor::new(),
            &mut crate::display::fec::FecEncoder::new(),
            &mut PrepareScratch::default(),
        );
        let count = completion.buffers.datagrams.len();
        assert!(count > 1);
        assert!(
            completion
                .buffers
                .datagrams
                .iter()
                .all(|frame| !uses_display_datagram(frame)),
            "entropy fixture must exercise actual reliable jumbo admission"
        );
        peer.display_prepare_in_flight = Some(403);
        let peer_id = Arc::clone(&peer.peer_id);
        let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
        finish_display_prepare(
            completion,
            terminal.display_revision(),
            &mut peers,
            &mut idle_prepare_worker_for_test(),
            100.0,
            None,
        )
        .await;
        let mut admitted = 0;
        while let Ok((channel, _)) = rx.try_recv() {
            assert_eq!(channel, CHANNEL_DISPLAY_COMMIT);
            admitted += 1;
        }
        assert_eq!(admitted, accepted_limit.min(count));
        assert_eq!(
            peers[&peer_id].last_admitted_sync_epoch,
            if admitted == 0 { 0 } else { epoch }
        );
        if admitted < count {
            assert!(peers[&peer_id].needs_full_diff);
        }
    }
}

/// A dictionary build parked on its completion channel must not hold up an
/// interactive delta. Deterministic: the dictionary side is driven until it
/// is provably parked (the completion channel is full and the request slot
/// is empty), so the only way the interactive completion arrives is a
/// second thread. Single-threaded preparation deadlocks here.
///
/// The drained dictionary completions are the control: each finalized a
/// real dictionary from a production-shaped 120x40 screen, and their
/// `cpu_time` is the finalize cost this test reports with `--nocapture`.
#[tokio::test(flavor = "current_thread")]
async fn a_dictionary_prepare_does_not_block_an_interactive_delta() {
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'a'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let (mut worker, mut completion_rx, _snapshot_rx, mut dictionary_rx) =
        start_display_prepare_worker();

    // One more build than the completion channel holds: the last one parks
    // its thread on `blocking_send`.
    for _ in 0..=DISPLAY_PREPARE_QUEUE_DEPTH {
        let token = worker.next_token();
        let request =
            dictionary_request_for_test(token, &terminal, &mut capture_scratch, &mut flush_cache);
        worker
            .dictionary_tx
            .send(request)
            .expect("dictionary lane open");
    }
    let mut waited = 0u32;
    while !(dictionary_rx.len() == DISPLAY_PREPARE_QUEUE_DEPTH && worker.dictionary_tx.is_empty()) {
        waited += 1;
        assert!(
            waited < 20_000,
            "the dictionary builds never filled their completion channel"
        );
        std::thread::sleep(Duration::from_millis(1));
    }

    let request = interactive_request_for_test(
        7,
        &terminal,
        &peer,
        2,
        &mut capture_scratch,
        &mut flush_cache,
    );
    worker
        .interactive_tx
        .try_send(request)
        .expect("interactive lane open");
    let completion = tokio::time::timeout(Duration::from_secs(5), completion_rx.recv())
        .await
        .expect("an interactive delta must not wait behind a parked dictionary build")
        .expect("display preparation alive");
    assert_eq!(completion.token, 7);
    assert!(!completion.buffers.datagrams.is_empty());

    let mut dictionary_cpu = Vec::new();
    for _ in 0..=DISPLAY_PREPARE_QUEUE_DEPTH {
        let prepared = dictionary_rx.recv().await.expect("dictionary completion");
        assert!(prepared.source.len() >= DISPLAY_DICTIONARY_MIN_BYTES);
        dictionary_cpu.push(prepared.cpu_time);
    }
    println!(
        "interactive two-row prepare cpu_time={:?}; {}x{} dictionary finalize cpu_time={:?}",
        completion.cpu_time, COLS, ROWS, dictionary_cpu
    );
}

/// Losing the dictionary consumer stops dictionary builds and nothing else.
/// Bounded: the request loop ends exactly when the dictionary thread has
/// observed its dead consumer and exited, which disconnects its lane.
#[tokio::test(flavor = "current_thread")]
async fn a_dead_dictionary_consumer_does_not_stop_display_preparation() {
    const COLS: u16 = 8;
    const ROWS: u16 = 2;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'a'));
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut capture_scratch = RowCaptureScratch::default();
    let mut flush_cache = HashMap::new();
    let (mut worker, mut completion_rx, _snapshot_rx, dictionary_rx) =
        start_display_prepare_worker();
    drop(dictionary_rx);

    let mut attempts = 0u32;
    loop {
        let token = worker.next_token();
        let request =
            dictionary_request_for_test(token, &terminal, &mut capture_scratch, &mut flush_cache);
        match worker.dictionary_tx.try_send(request) {
            Err(crossbeam_channel::TrySendError::Disconnected(_)) => break,
            Ok(()) | Err(crossbeam_channel::TrySendError::Full(_)) => {
                attempts += 1;
                assert!(
                    attempts < 20_000,
                    "the dictionary thread never observed its dead consumer"
                );
                std::thread::yield_now();
            }
        }
    }

    let request = interactive_request_for_test(
        7,
        &terminal,
        &peer,
        2,
        &mut capture_scratch,
        &mut flush_cache,
    );
    worker
        .interactive_tx
        .try_send(request)
        .expect("the display lane must outlive the dictionary consumer");
    let completion = tokio::time::timeout(Duration::from_secs(5), completion_rx.recv())
        .await
        .expect("display preparation must continue without a dictionary consumer")
        .expect("display preparation alive");
    assert_eq!(completion.token, 7);
}

/// A selection whose rows all encode to zero bytes must still carry a
/// stale `input_seq` advertisement out as a header-only delta.
///
/// The advertisement is the browser's causal barrier release: after an
/// unmodelled keystroke it refuses to predict until authoritative display
/// covers that input. The send path records the advertisement before it
/// captures rows; if the rows then all encode to zero bytes and nothing is
/// emitted, the browser waits on a frame that never comes, the daemon reads
/// its silence as more unmodelled input, and prediction is revoked for the
/// rest of the line.
#[tokio::test]
async fn an_all_zero_selection_still_advertises_input_seq() {
    const COLS: u16 = 8;
    const ROWS: u16 = 3;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(b"\x1b[?2026h\x1b[?2026l");
    let sync_epoch = terminal.completed_sync_update_epoch();
    assert!(sync_epoch > 0);
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(
        capture_tx,
    )));
    // The screen still matches the baseline, but the baseline was credited
    // without a per-sequence proof: every row is selected, and every row
    // encodes to zero bytes.
    let mut grid = Vec::new();
    let mut current_row_hashes = Vec::new();
    terminal.current_grid_into(&mut grid);
    terminal.current_row_hashes_into(&mut current_row_hashes);
    peer.display_cache
        .prime_from_snapshot(&grid, &current_row_hashes, &[]);
    peer.display_cache.acked_row_exact.fill(false);
    // A keystroke the browser is holding its prediction barrier on, which
    // no earlier frame has advertised.
    peer.latest_input_seq = 5;
    assert_ne!(peer.last_advertised_input_seq, 5);
    let peer_id = peer.peer_id.clone();
    let mut peers = HashMap::from([(peer_id.clone(), peer)]);
    let mut compressor = Compressor::new();
    let mut worker = idle_prepare_worker_for_test();
    let mut prepare_scratch = PrepareScratch::default();
    let mut flush_row_scratch = FlushRowScratch::default();
    let mut flush_cache = HashMap::new();

    send_peer_datagram_delta_with_worker(
        &mut terminal,
        &mut compressor,
        &mut worker,
        &mut prepare_scratch,
        &mut peers,
        &peer_id,
        100.0,
        &current_row_hashes,
        &mut flush_row_scratch,
        &mut flush_cache,
        false,
        &mut PerfTimingTracker::default(),
        None,
    );

    // The premise: every row is selected (none is acknowledged exactly)
    // and every one encodes to zero bytes, so no row batch can carry the
    // advertisement.
    assert_eq!(
        flush_row_scratch.selection.selected_rows.len(),
        usize::from(ROWS),
        "every row is selected"
    );
    let peer = &peers[&peer_id];
    assert_eq!(
        peer.last_advertised_input_seq, 5,
        "the advertisement is recorded"
    );
    assert_eq!(
        peer.last_admitted_sync_epoch, sync_epoch,
        "an actually admitted header-only original consumes its captured ESU"
    );
    assert_eq!(
        peer.display_cache.waste.datagram_send_failures, 0,
        "an all-zero selection with a stale input_seq must still emit one header-only delta"
    );
    assert!(
        capture_rx.try_recv().is_ok(),
        "one header-only delta was sent"
    );
    assert!(capture_rx.try_recv().is_err());
    assert_eq!(
        worker.spare.len(),
        1,
        "the inline arm returns its buffers to the pool"
    );
}

/// A causal sequence is advertised only by a frame that actually entered
/// a carrier. Encoding it, consuming a display sequence, or attempting a
/// zero-capacity burst is not enough: otherwise the failed attempt erases
/// the only predicate that schedules the header-only retry, leaving the
/// browser's speculative-input fence closed indefinitely.
#[tokio::test]
async fn a_refused_causal_header_remains_pending_until_a_carrier_accepts_it() {
    const COLS: u16 = 8;
    const ROWS: u16 = 3;
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    let mut peer = benchmark_noise_peer();
    peer.display_cache.resize(COLS, ROWS);
    let mut grid = Vec::new();
    let mut current_row_hashes = Vec::new();
    terminal.current_grid_into(&mut grid);
    terminal.current_row_hashes_into(&mut current_row_hashes);
    peer.display_cache
        .prime_from_snapshot(&grid, &current_row_hashes, &[]);
    peer.latest_input_seq = 5;

    let peer_id = peer.peer_id.clone();
    let mut peers = HashMap::from([(peer_id.clone(), peer)]);
    let mut compressor = Compressor::new();
    let mut worker = idle_prepare_worker_for_test();
    let mut prepare_scratch = PrepareScratch::default();
    let mut flush_row_scratch = FlushRowScratch::default();
    let mut flush_cache = HashMap::new();
    let mut perf_timing = PerfTimingTracker::default();

    send_peer_datagram_delta_with_worker(
        &mut terminal,
        &mut compressor,
        &mut worker,
        &mut prepare_scratch,
        &mut peers,
        &peer_id,
        100.0,
        &current_row_hashes,
        &mut flush_row_scratch,
        &mut flush_cache,
        false,
        &mut perf_timing,
        None,
    );

    let refused_seq = peers[&peer_id].next_datagram_seq;
    assert_eq!(peers[&peer_id].last_display_seq_sent, 0);
    assert_ne!(
        peers[&peer_id].last_advertised_input_seq, 5,
        "a carrier refusal must preserve the causal retry predicate"
    );
    assert!(
        peer_has_header_only_reason(&peers[&peer_id], terminal.current_display_header_signal()),
        "the next owner-loop turn must still see runnable header work"
    );

    let (capture_tx, mut capture_rx) = tokio::sync::mpsc::unbounded_channel();
    peers.get_mut(&peer_id).expect("peer").edge_tunnel = Some(Arc::new(
        crate::edge_tunnel::EdgeTunnel::new_capture(capture_tx),
    ));
    send_peer_datagram_delta_with_worker(
        &mut terminal,
        &mut compressor,
        &mut worker,
        &mut prepare_scratch,
        &mut peers,
        &peer_id,
        101.0,
        &current_row_hashes,
        &mut flush_row_scratch,
        &mut flush_cache,
        false,
        &mut perf_timing,
        None,
    );

    assert!(
        peers[&peer_id].next_datagram_seq != refused_seq,
        "the retry consumes a fresh independent display sequence"
    );
    assert_ne!(peers[&peer_id].last_display_seq_sent, 0);
    assert_eq!(peers[&peer_id].last_advertised_input_seq, 5);
    assert!(
        capture_rx.try_recv().is_ok(),
        "the retry reaches the carrier"
    );
    assert!(capture_rx.try_recv().is_err());
}

/// Exact allocation oracle for the offloaded-flush handoff: production
/// admission, the lane, the completion channel and completion admission
/// allocate nothing beyond what encoding the frames itself allocates.
///
/// Arm A counts a direct `prepare_display_off_loop` and the admission of
/// its completion through `finish_display_prepare`, with the request built
/// outside the counted region from pooled buffers — the encode and the
/// burst, nothing else. Arm B counts the production path end to end:
/// `send_peer_datagram_delta_with_worker` selects, captures, builds the
/// request and submits it to the prepare thread; the completion comes
/// back over the channel; `finish_display_prepare` admits it. Both arms
/// burst to a peer with no carrier, so every send is refused identically.
/// Equal counts and equal bytes mean selection, capture, the request, both
/// channels and completion admission allocated nothing; the printed arm A
/// is the encode's own per-flush cost, which is the frames.
///
/// The prepare thread's allocations count too — the allocator is
/// process-wide — which is the point: batching state built per request on
/// that thread shows up here as B > A.
///
/// Ignored because that allocator is process-wide: run it alone, in
/// release, with `--exact --nocapture`.
#[test]
#[ignore = "exact allocation oracle; the counting allocator is process-wide"]
fn display_prepare_handoff_allocates_only_the_frames() {
    use crate::edge_tunnel::test_allocations;
    const COLS: u16 = 120;
    const ROWS: u16 = 40;
    // Past two tokio mpsc blocks, so the completion channel's block list
    // has reached its steady state (blocks are reclaimed and reused) and
    // every pooled buffer has grown to its high-water size before anything
    // is counted.
    const WARM_UP: usize = 64;
    const ROUNDS: usize = 200;
    const PEER_ID: &str = "browser-bench";

    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(COLS, ROWS, event_tx);
    terminal.apply_bytes(&terminal_fixture(COLS, ROWS, b'a'));
    let mut peer = benchmark_noise_peer();
    assert_eq!(&*peer.peer_id, PEER_ID);
    peer.display_cache.resize(COLS, ROWS);
    let mut peers = PeerMap::from([(PEER_ID.into(), peer)]);
    let mut current_row_hashes = Vec::new();
    terminal.current_row_hashes_into(&mut current_row_hashes);
    let mut compressor = Compressor::new();
    let mut fec_encoder = crate::display::fec::FecEncoder::new();
    let mut prepare_scratch = PrepareScratch::default();
    let mut flush_row_scratch = FlushRowScratch::default();
    let mut flush_cache: HashMap<u16, CapturedRow> = HashMap::new();
    // Production owns one tracker for the daemon lifetime. Constructing a
    // fresh pair of bounded VecDeques inside the counted display turn would
    // measure test-fixture setup as two hot-path allocations.
    let mut perf_timing = PerfTimingTracker::default();
    let (mut worker, mut completion_rx, _snapshot_rx, _dictionary_rx) =
        start_display_prepare_worker();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test runtime");
    // Advanced between rounds so the passive-viewer rate interval never
    // defers a flush; both arms see the same clock.
    let mut now_ms = 10_000.0;
    let accumulate =
        |total: &mut test_allocations::Tally, round: usize, tally: test_allocations::Tally| {
            if round >= WARM_UP {
                total.allocations += tally.allocations;
                total.allocated_bytes += tally.allocated_bytes;
            }
        };

    // Arm A: the encode and the burst, with the request built beforehand.
    let arm_a = runtime.block_on(async {
        let mut total = test_allocations::Tally {
            allocations: 0,
            allocated_bytes: 0,
        };
        let mut datagrams_per_round = 0usize;
        for round in 0..WARM_UP + ROUNDS {
            now_ms += 100.0;
            let cursor_row = terminal.current_cursor_row();
            let peer = peers.get_mut(PEER_ID).expect("benchmark peer");
            classify_flush_rows(
                &peer.display_cache,
                &current_row_hashes,
                now_ms,
                &mut flush_row_scratch.selection,
            );
            let selected_rows = &mut flush_row_scratch.selection.selected_rows;
            prioritize_display_rows(
                selected_rows,
                cursor_row,
                terminal.rows,
                &peer.display_cache.sent_row_hashes,
                &current_row_hashes,
            );
            let mut buffers = worker.take_buffers();
            capture_prepare_rows(
                &terminal,
                peer,
                selected_rows,
                cursor_row,
                &mut flush_row_scratch.capture,
                &mut flush_cache,
                &mut buffers.rows,
            );
            let header_signal = terminal.current_display_header_signal();
            let relayed = display_primary_is_edge(peer, now_ms);
            let token = worker.next_token();
            let compression =
                display_compression_policy(peer, now_ms, relayed, ExecutionLane::Bulk, 0);
            let request = DisplayPrepareRequest {
                token,
                prepare_epoch: peer.display_prepare_epoch.load(Ordering::Acquire),
                prepare_epoch_fence: Arc::clone(&peer.display_prepare_epoch),
                submitted_at: Instant::now(),
                perf_flush_started_at: None,
                generation: peer.generation,
                display_revision: terminal.display_revision(),
                completed_sync_update_epoch: terminal.completed_sync_update_epoch(),
                start_seq: peer.next_datagram_seq,
                start_frame_id: peer.next_frame_id,
                presentation_continues: false,
                causal_input_advanced: false,
                input_seq: 1,
                header_signal,
                header_changed: header_signal != peer.last_admitted_critical_header_signal,
                header: terminal.current_display_header(merkur_codec::FrameKind::Delta),
                buffers,
                compression,
                compression_dictionary: peer.dictionary.active().cloned(),
                burst_group_max_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
                summary: flush_summary_for_test(0),
            };
            peer.display_prepare_in_flight = Some(token);
            let revision = terminal.display_revision();

            test_allocations::begin();
            let completion = prepare_display_off_loop(
                request,
                &mut compressor,
                &mut fec_encoder,
                &mut prepare_scratch,
            );
            datagrams_per_round = completion.datagram_count();
            finish_display_prepare(completion, revision, &mut peers, &mut worker, now_ms, None)
                .await;
            accumulate(&mut total, round, test_allocations::end());
        }
        (total, datagrams_per_round)
    });

    // Arm B: the production path through the prepare thread.
    let arm_b = runtime.block_on(async {
        let mut total = test_allocations::Tally {
            allocations: 0,
            allocated_bytes: 0,
        };
        let mut datagrams_per_round = 0usize;
        for round in 0..WARM_UP + ROUNDS {
            now_ms += 100.0;
            let revision = terminal.display_revision();

            test_allocations::begin();
            send_peer_datagram_delta_with_worker(
                &mut terminal,
                &mut compressor,
                &mut worker,
                &mut prepare_scratch,
                &mut peers,
                PEER_ID,
                now_ms,
                &current_row_hashes,
                &mut flush_row_scratch,
                &mut flush_cache,
                false,
                &mut perf_timing,
                None,
            );
            assert!(
                peers[PEER_ID].display_prepare_in_flight.is_some(),
                "production admission must offload a whole-screen repaint"
            );
            let completion = completion_rx.recv().await.expect("prepare thread alive");
            datagrams_per_round = completion.datagram_count();
            finish_display_prepare(completion, revision, &mut peers, &mut worker, now_ms, None)
                .await;
            accumulate(&mut total, round, test_allocations::end());
        }
        (total, datagrams_per_round)
    });

    let (tally_a, datagrams_a) = arm_a;
    let (tally_b, datagrams_b) = arm_b;
    assert!(datagrams_a > 0, "the repaint must build frames");
    assert_eq!(
        datagrams_a, datagrams_b,
        "both arms must build the same burst"
    );
    println!(
        "encode and burst alone (arm A): {:.3} allocations/flush, {:.1} bytes/flush, \
         {} datagrams/flush; production handoff (arm B): {:.3} allocations/flush, \
         {:.1} bytes/flush",
        tally_a.allocations as f64 / ROUNDS as f64,
        tally_a.allocated_bytes as f64 / ROUNDS as f64,
        datagrams_a,
        tally_b.allocations as f64 / ROUNDS as f64,
        tally_b.allocated_bytes as f64 / ROUNDS as f64,
    );
    assert_eq!(
        tally_b.allocations, tally_a.allocations,
        "the handoff must allocate nothing beyond the frames"
    );
    assert_eq!(
        tally_b.allocated_bytes, tally_a.allocated_bytes,
        "the handoff must allocate no bytes beyond the frames"
    );
}

/// The virtual instant the scheduling oracles below are asked at.
const SCHED_NOW_MS: f64 = 5_000.0;

/// One way to give a converged peer a reason to emit: mutate the peer or
/// the terminal's hashes, and say what the owner loop passes alongside
/// (`terminal_dirty`, `header_signal`).
type EmitReason = fn(&mut PeerDisplayState, &mut Vec<u64>) -> (bool, u128);

/// One row shape laid over a converged peer.
type RowShape = fn(&mut PeerDisplayState, &mut Vec<u64>);

/// A converged four-row screen: every row sent, exactly acknowledged, and
/// matching the terminal. Passive (no recent input), so only the refusal
/// floors can stretch its next wake.
fn converged_peer_for_scheduling(now_ms: f64) -> (PeerDisplayState, Vec<u64>) {
    use crate::connection::PerPeerDisplayCache;
    let mut peer = PeerDisplayState::new("browser-1".into(), PeerTransport::Edge);
    peer.authenticated = true;
    peer.noise = Some(established_daemon_noise());
    peer.needs_snapshot = false;
    peer.last_input_at_ms = now_ms - 10_000.0;
    peer.display_cache = PerPeerDisplayCache::new();
    peer.display_cache.resize(2, 4);
    for row in 0..4 {
        let hash = 0x3000 + row as u64;
        peer.display_cache.acked_row_hashes[row] = hash;
        peer.display_cache.sent_row_hashes[row] = hash;
        peer.display_cache.acked_row_exact[row] = true;
        peer.display_cache.sent_row_confirmed[row] = true;
    }
    let current: Vec<u64> = (0..4).map(|row| 0x3000 + row as u64).collect();
    (peer, current)
}

/// An explicit application boundary (ESU) never waives an actual refusal:
/// the zero-progress admission retry holds until it elapses, whatever the
/// path RTT or the receiver's refresh period, and does not spin.
#[test]
fn synchronized_update_completion_never_waives_actual_refusal_evidence() {
    for rtt in [50.0, 120.0, 200.0] {
        for hz in [60.0, 120.0, 240.0, 480.0] {
            let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
            peer.paths.edge.network_rtt_ewma_ms = rtt;
            peer.adaptive.presentation_period_ms = 1000.0 / hz;
            current[3] ^= 1;
            let complete = PendingDisplayDamage {
                completed_sync_update_epoch: 9,
                ..PendingDisplayDamage::COHERENT
            };
            assert_eq!(
                peer_next_flush_delay_ms(&peer, complete, 0, &current, SCHED_NOW_MS),
                Some(0),
            );
            assert_eq!(
                peer.last_admitted_sync_epoch, 0,
                "selection is not admission"
            );

            note_zero_progress_admission(&mut peer, SCHED_NOW_MS, 0);
            let retry_at = peer.display_admission_retry.until_ms;
            for _ in 0..10 {
                assert_eq!(
                    peer_next_flush_delay_ms(&peer, complete, 0, &current, SCHED_NOW_MS),
                    Some((retry_at - SCHED_NOW_MS).ceil() as u64)
                );
                assert_eq!(peer.display_admission_retry.failures, 1);
                assert_eq!(peer.display_admission_retry.until_ms, retry_at);
            }
            assert!(retry_at > SCHED_NOW_MS, "no zero-capacity timer spin");
            assert_eq!(
                peer_next_flush_delay_ms(&peer, complete, 0, &current, retry_at),
                Some(0)
            );
            let (other, _) = converged_peer_for_scheduling(SCHED_NOW_MS);
            assert_eq!(
                peer_next_flush_delay_ms(&other, complete, 0, &current, SCHED_NOW_MS),
                Some(0),
                "each peer independently consumes the same terminal boundary"
            );
        }
    }
}

#[test]
fn synchronized_update_epoch_is_not_itself_an_emit_reason() {
    let (mut terminal, baseline, hashes) = sized_fixture(2, 4);
    let (mut peer, _) = benchmark_noise_pair();
    peer.needs_snapshot = false;
    peer.display_cache = baseline;
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    terminal.clear_dirty();
    terminal.apply_bytes(b"\x1b[?2026h\x1b[?2026l");
    assert!(terminal.completed_sync_update_epoch() > 0);
    terminal.clear_dirty();
    assert_eq!(
        peer_next_flush_delay_ms(
            &peer,
            terminal.pending_display_damage(),
            terminal.current_display_header_signal(),
            &hashes,
            SCHED_NOW_MS,
        ),
        None,
        "a no-op app boundary parks without allocating a header or worker token"
    );
    terminal.apply_bytes(b"\x1b[1;1Hx");
    assert_eq!(terminal.completed_sync_update_epoch(), 0);
    assert_eq!(peer.last_admitted_sync_epoch, 0);
}

/// A clipped redraw's owed continuation is scheduled by the remainder
/// itself (`needs_full_diff`), not by a sender-side window: the next turn
/// re-selects it, whatever the path RTT or the receiver's refresh period.
#[test]
fn a_clipped_redraw_continuation_is_immediate_whatever_the_path_or_refresh() {
    for rtt in [50.0, 120.0, 200.0] {
        for hz in [60.0, 120.0, 240.0, 480.0] {
            let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
            peer.last_input_at_ms = SCHED_NOW_MS;
            peer.paths.edge.network_rtt_ewma_ms = rtt;
            peer.adaptive.presentation_period_ms = 1000.0 / hz;
            peer.needs_full_diff = true;
            current[3] ^= 1;
            for at in [SCHED_NOW_MS, SCHED_NOW_MS + 0.1, SCHED_NOW_MS + 100.0] {
                assert_eq!(
                    peer_next_flush_delay_ms(
                        &peer,
                        PendingDisplayDamage::COHERENT,
                        0,
                        &current,
                        at
                    ),
                    Some(0)
                );
            }
            peer.next_generation();
            assert_eq!(peer.display_admission_retry.until_ms, 0.0);
        }
    }
}

#[tokio::test]
async fn owed_same_grid_end_retries_without_spinning_and_parks_after_admission() {
    let (mut terminal, baseline, current) = sized_fixture(2, 8);
    terminal.clear_dirty();
    let (mut peer, mut browser) = benchmark_noise_pair();
    peer.authenticated = true;
    peer.needs_snapshot = false;
    peer.display_cache = baseline;
    peer.next_datagram_seq = 2;
    peer.last_input_at_ms = 100.0;
    peer.last_admitted_critical_header_signal = terminal.current_display_header_signal();
    let (tx, mut rx) = mpsc::unbounded_channel();
    peer.edge_tunnel = Some(Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx)));
    let mut first = vec![valid_header_only_prepared_with_presentation_for_test(
        &mut peer,
        DisplayUtility::NonCritical,
        true,
        false,
    )];
    let mut pool = frame_pool_for_test();
    assert!(
        send_unpaced_display_burst(&mut peer, &mut first, &mut pool, 1, 100.0, &[0; 4]).all_sent
    );
    assert!(peer.presentation_end_owed);
    assert!(rx.try_recv().is_ok());
    assert!(rx.try_recv().is_err());
    peer.adaptive.receive_queue_datagrams = 0;
    let peer_id = Arc::clone(&peer.peer_id);
    let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
    let mut worker = idle_prepare_worker_for_test();
    let mut compressor = Compressor::new();
    let mut prepare = PrepareScratch::default();
    let mut row_scratch = FlushRowScratch::default();
    let mut capture = HashMap::new();
    let mut timing = PerfTimingTracker::default();
    let mut first_refused_seq = 0;
    for attempt in 0..3 {
        send_peer_datagram_delta_with_worker(
            &mut terminal,
            &mut compressor,
            &mut worker,
            &mut prepare,
            &mut peers,
            &peer_id,
            100.0,
            &current,
            &mut row_scratch,
            &mut capture,
            false,
            &mut timing,
            None,
        );
        let peer = &peers[&peer_id];
        if attempt == 0 {
            first_refused_seq = peer.next_datagram_seq;
        }
        assert_eq!(
            peer.next_datagram_seq, first_refused_seq,
            "ordinary observations cannot re-encode inside the refusal deadline"
        );
        assert_eq!(peer.display_admission_retry.until_ms, 101.0);
        assert_eq!(peer.display_admission_retry.failures, 1);
        assert!(peer.presentation_end_owed);
        assert_eq!(
            peer_next_flush_delay_ms(
                peer,
                PendingDisplayDamage::CLEAN,
                terminal.current_display_header_signal(),
                &current,
                100.0
            ),
            Some(1)
        );
    }
    assert!(rx.try_recv().is_err());
    peers
        .get_mut(&peer_id)
        .unwrap()
        .adaptive
        .receive_queue_datagrams = 16;
    send_peer_datagram_delta_with_worker(
        &mut terminal,
        &mut compressor,
        &mut worker,
        &mut prepare,
        &mut peers,
        &peer_id,
        101.0,
        &current,
        &mut row_scratch,
        &mut capture,
        false,
        &mut timing,
        None,
    );
    let (channel, ciphertext) = rx.try_recv().expect("owed END was admitted");
    let plain = browser
        .open_datagram(crate::e2e::lane_for_channel(channel).unwrap(), &ciphertext)
        .unwrap();
    let header = merkur_codec::parse_frame_header(&plain).unwrap();
    assert!(header.presentation_coherent && header.presentation_end);
    assert_eq!(
        (
            header.row_count,
            header.presentation_member_index,
            header.presentation_member_count
        ),
        (0, 0, 1)
    );
    let peer = &peers[&peer_id];
    assert!(!peer.presentation_end_owed);
    assert_eq!(peer.display_admission_retry.until_ms, 0.0);
    assert_eq!(
        peer_next_flush_delay_ms(
            peer,
            PendingDisplayDamage::CLEAN,
            terminal.current_display_header_signal(),
            &current,
            101.0
        ),
        None
    );
}

#[tokio::test]
async fn actual_send_refusals_never_manufacture_loss_or_strand_a_sparse_ack_tail() {
    use crate::display::policy::DISPLAY_ACK_MASK_WORDS;
    use crate::display::recv::{DisplayAck, handle_display_ack};
    for first_sequence in [1, u32::MAX - 2] {
        let (mut terminal, baseline, _) = sized_fixture(2, 8);
        terminal.clear_dirty();
        terminal.apply_bytes(b"\rZ");
        let changed_row = usize::from(terminal.current_cursor_row().unwrap());
        let mut current = Vec::new();
        terminal.current_row_hashes_into(&mut current);
        terminal.clear_dirty();
        let (mut peer, mut browser) = benchmark_noise_pair();
        peer.authenticated = true;
        peer.needs_snapshot = false;
        peer.display_cache = baseline;
        peer.next_datagram_seq = first_sequence;
        peer.last_input_at_ms = 100.0;
        let (tx, mut rx) = mpsc::unbounded_channel();
        let live = Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(tx));
        peer.edge_tunnel = Some(Arc::clone(&live));
        let peer_id = Arc::clone(&peer.peer_id);
        let mut peers = PeerMap::from([(Arc::clone(&peer_id), peer)]);
        let mut worker = idle_prepare_worker_for_test();
        let mut compressor = Compressor::new();
        let mut prepare = PrepareScratch::default();
        let mut row_scratch = FlushRowScratch::default();
        let mut capture = HashMap::new();
        let mut timing = PerfTimingTracker::default();
        let mut applied = Vec::new();
        for input in 1..=7 {
            let refused = (2..=4).contains(&input);
            let peer = peers.get_mut(&peer_id).unwrap();
            peer.latest_input_seq = input;
            peer.paths.edge.available = true;
            peer.paths.edge.last_ack_at_ms = 100.0;
            // Capacity is available, then the real physical send refuses.
            // These attempted IDs cannot be reclaimed after carrier entry.
            peer.edge_tunnel = Some(if refused {
                let (closed, receiver) = mpsc::unbounded_channel();
                drop(receiver);
                Arc::new(crate::edge_tunnel::EdgeTunnel::new_capture(closed))
            } else {
                Arc::clone(&live)
            });
            let next_before = peer.next_datagram_seq;
            send_peer_datagram_delta_with_worker(
                &mut terminal,
                &mut compressor,
                &mut worker,
                &mut prepare,
                &mut peers,
                &peer_id,
                100.0,
                &current,
                &mut row_scratch,
                &mut capture,
                false,
                &mut timing,
                None,
            );
            let peer = peers.get_mut(&peer_id).unwrap();
            assert_ne!(
                peer.next_datagram_seq, next_before,
                "one actual attempt per fresh input"
            );
            if refused {
                assert!(rx.try_recv().is_err());
                assert_eq!(peer.last_display_seq_sent, first_sequence);
                continue;
            }
            let (channel, wire) = rx.try_recv().expect("successful physical original");
            let plain = browser
                .open_datagram(crate::e2e::lane_for_channel(channel).unwrap(), &wire)
                .unwrap();
            let header = merkur_codec::parse_frame_header(&plain).unwrap();
            assert_eq!(header.row_count, u16::from(input == 1));
            assert!(rx.try_recv().is_err());
            if input == 1 {
                continue;
            }
            applied.push(peer.last_display_seq_sent);
            let head = *applied.last().unwrap();
            let mut mask = [0u32; DISPLAY_ACK_MASK_WORDS];
            for &seq in &applied {
                let offset = head.wrapping_sub(seq) as usize;
                mask[offset / 32] |= 1 << (offset % 32);
            }
            let ack = DisplayAck::new(peer.generation, head, mask);
            handle_display_ack(peer, ack, 101.0, PeerTransport::Edge, &current, false);
            if applied.len() < 3 {
                assert!(
                    peer.display_cache
                        .sent_datagrams
                        .contains_key(&first_sequence)
                );
                assert_eq!(peer.display_cache.datagram_outcomes.edge.declared_lost, 0);
                let due = peer.display_cache.sent_row_resend_after_ms[changed_row];
                assert!(
                    !peer
                        .display_cache
                        .has_selectable_rows(&current, due - 0.001)
                );
                assert_eq!(
                    peer.display_cache.next_row_resend_due_ms(due - 0.001),
                    Some(due)
                );
                assert!(peer.display_cache.has_selectable_rows(&current, due));
                assert!(peer.display_cache.has_sendable_rows(due));
            } else {
                assert!(
                    !peer
                        .display_cache
                        .sent_datagrams
                        .contains_key(&first_sequence)
                );
                assert_eq!(peer.display_cache.datagram_outcomes.edge.declared_lost, 1);
                assert_eq!(peer.display_cache.sent_row_latest_seq[changed_row], 0);
                handle_display_ack(peer, ack, 102.0, PeerTransport::Edge, &current, false);
                assert_eq!(peer.display_cache.datagram_outcomes.edge.declared_lost, 1);
            }
        }
    }
}

#[test]
fn admission_retry_preserves_fresh_critical_feedback_and_backs_off_only_on_attempts() {
    let (mut peer, _) = converged_peer_for_scheduling(100.0);
    peer.adaptive.presentation_period_ms = 1000.0 / 120.0;
    peer.latest_input_seq = 10;
    note_zero_progress_admission(&mut peer, 100.0, 55);
    assert_eq!(admission_retry_delay_ms(&peer, 100.0, 55, true), 1);
    peer.latest_input_seq += 1;
    assert_eq!(admission_retry_delay_ms(&peer, 100.0, 55, true), 0);
    note_zero_progress_admission(&mut peer, 100.0, 55);
    assert_eq!(admission_retry_delay_ms(&peer, 100.0, 55, true), 2);
    assert_eq!(admission_retry_delay_ms(&peer, 100.0, 56, true), 0);
    for attempt in 0..20 {
        let now = 102.0 + attempt as f64 * 10.0;
        note_zero_progress_admission(&mut peer, now, 56);
        let deadline = peer.display_admission_retry.until_ms;
        assert!(deadline > now && deadline <= now + peer.adaptive.presentation_period_ms);
        for _ in 0..4 {
            admission_retry_delay_ms(&peer, now, 56, false);
        }
        assert_eq!(peer.display_admission_retry.until_ms, deadline);
    }
    peer.carrier_boundary();
    assert_eq!(peer.display_admission_retry.until_ms, 0.0);
}

/// Row 0 changed and went on the wire at `now_ms`: unconfirmed, identical
/// to the terminal, and inside its pacing window — a paced duplicate.
fn send_paced_duplicate(peer: &mut PeerDisplayState, current: &mut [u64], now_ms: f64) {
    use crate::connection::SentRow;
    let sent = SentRow {
        graphics: None,
        row: 0,
        hash: 0xfeed,
        cells: Arc::from(vec![CellRepr::BLANK; 2]),
    };
    peer.display_cache.record_sent_rows(
        1,
        std::slice::from_ref(&sent),
        now_ms,
        DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS,
    );
    peer.last_display_seq_sent = 1;
    current[0] = 0xfeed;
}

/// Row 2 went A → B → A: the terminal and the acknowledged baseline agree
/// on A while a speculative B is still in flight inside its pacing window.
fn put_b_in_flight_over_a(peer: &mut PeerDisplayState, now_ms: f64) {
    peer.display_cache.sent_row_hashes[2] = 0xbbbb;
    peer.display_cache.sent_row_resend_after_ms[2] =
        now_ms + DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS;
}

/// One paced, unconfirmed row must not stretch the delay of a peer that
/// has a reason to emit.
///
/// The re-send deadline of a row already on the wire is a floor for
/// re-sending IDENTICAL bytes, not a sleep for the whole peer. Taking it
/// with `.max()` against every other reason held a clipped repaint's
/// remainder, a header-only advertisement and fresh terminal damage to the
/// paced row's deadline — one flush budget per re-send interval, which is
/// a large screen painting in visible blocks. Seven reasons, each on its
/// own; with none set the row's own deadline is the only wake there is.
#[test]
fn the_resend_arm_yields_to_every_reason_to_emit() {
    let paced_row_deadline_ms = DisplayPolicy::ROW_RESEND_TEST_INTERVAL_MS.ceil() as u64;
    assert!(
        paced_row_deadline_ms > 0,
        "the paced row's deadline must be in the future or nothing below can fail"
    );

    fn paced_peer() -> (PeerDisplayState, Vec<u64>) {
        let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
        send_paced_duplicate(&mut peer, &mut current, SCHED_NOW_MS);
        (peer, current)
    }

    let (peer, current) = paced_peer();
    let peers = PeerMap::from([("browser-1".into(), peer)]);
    assert_eq!(
        compute_next_flush_delay_ms(
            &peers,
            PendingDisplayDamage::CLEAN,
            0,
            &current,
            SCHED_NOW_MS,
        ),
        Some(paced_row_deadline_ms),
        "with nothing to emit, the paced row's own deadline is the only wake"
    );

    let arms: [(&str, EmitReason); 7] = [
        ("terminal damage", |_, _| (true, 0)),
        ("an armed snapshot", |peer, _| {
            peer.needs_snapshot = true;
            (false, 0)
        }),
        ("needs_full_diff", |peer, _| {
            peer.needs_full_diff = true;
            (false, 0)
        }),
        ("a stale input_seq advertisement", |peer, _| {
            peer.latest_input_seq = 1;
            (false, 0)
        }),
        ("a changed critical header", |_, _| (false, 0x51)),
        ("a clipped remainder", |_, current| {
            current[3] = 0xc0ffee;
            (false, 0)
        }),
        ("A -> B -> A with B in flight", |peer, _| {
            put_b_in_flight_over_a(peer, SCHED_NOW_MS);
            (false, 0)
        }),
    ];
    let mut held: Vec<String> = Vec::new();
    for (label, arm) in arms {
        let (mut peer, mut current) = paced_peer();
        let (terminal_dirty, header_signal) = arm(&mut peer, &mut current);
        let peers = PeerMap::from([("browser-1".into(), peer)]);
        let terminal_damage = if terminal_dirty {
            PendingDisplayDamage::COHERENT
        } else {
            PendingDisplayDamage::CLEAN
        };
        let delay = compute_next_flush_delay_ms(
            &peers,
            terminal_damage,
            header_signal,
            &current,
            SCHED_NOW_MS,
        );
        if delay != Some(0) {
            held.push(format!("{label}: {delay:?}"));
        }
    }
    assert!(
        held.is_empty(),
        "a peer with a reason to emit was held to the paced row's {paced_row_deadline_ms} ms \
         deadline instead of flushing in this turn:\n  {}",
        held.join("\n  ")
    );
}

/// Scheduling wakes the owner loop for a peer if and only if a flush would
/// select a row for it.
///
/// Both used to be approximations of each other. Waking on "the
/// acknowledged baseline differs from the terminal" over-reported a paced
/// duplicate (woken, then skipped by selection) and under-reported a row
/// that changed away and back with the middle version still in flight
/// (selected, but never woken for). `has_selectable_rows` is
/// `classify_flush_rows`'s own rule, so the two cannot drift again.
#[test]
fn scheduling_and_selection_agree_row_for_row() {
    let shapes: [(&str, RowShape); 4] = [
        ("converged", |_, _| {}),
        ("a paced duplicate", |peer, current| {
            send_paced_duplicate(peer, current, SCHED_NOW_MS);
        }),
        ("A -> B -> A with B in flight", |peer, _| {
            put_b_in_flight_over_a(peer, SCHED_NOW_MS)
        }),
        ("a clipped remainder", |_, current| current[3] = 0xc0ffee),
    ];
    let mut disagreements: Vec<String> = Vec::new();
    let mut answers = std::collections::BTreeSet::new();
    for (label, shape) in shapes {
        let (mut peer, mut current) = converged_peer_for_scheduling(SCHED_NOW_MS);
        shape(&mut peer, &mut current);
        let (selected, _) = classify_at(&peer.display_cache, &current, SCHED_NOW_MS);
        let selects = !selected.is_empty();
        answers.insert(selects);
        let selectable = peer
            .display_cache
            .has_selectable_rows(&current, SCHED_NOW_MS);
        let runnable = peer_has_runnable_display_work(&peer, false, 0, &current, SCHED_NOW_MS);
        if runnable != selects || selectable != selects {
            disagreements.push(format!(
                "{label}: runnable={runnable} selectable={selectable} but \
                 classify_flush_rows selected {} row(s)",
                selected.len()
            ));
        }
    }
    assert_eq!(answers.len(), 2, "the shapes must cover both answers");
    assert!(
        disagreements.is_empty(),
        "scheduling and selection disagree:\n  {}",
        disagreements.join("\n  ")
    );
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig {
        cases: 512,
        failure_persistence: None,
        ..proptest::prelude::ProptestConfig::default()
    })]

    /// `has_selectable_rows` is exactly "`classify_flush_rows` selects
    /// something", for every combination of the five per-row inputs —
    /// and the set of peers the scheduler keeps a deadline for is exactly
    /// the set holding an unconfirmed row or a row behind the terminal,
    /// so the rewrite added and lost no wake.
    #[test]
    fn has_selectable_rows_is_classify_flush_rows(
        rows in proptest::collection::vec(
            (0u8..4, 0u8..4, proptest::prelude::any::<bool>(), 0u8..4, 0u8..3),
            1..=8,
        ),
    ) {
        use crate::connection::PerPeerDisplayCache;
        const NOW_MS: f64 = 1_000.0;
        const HASHES: [u64; 4] = [0, 0xa, 0xb, 0xc];
        const DEADLINES: [f64; 3] = [0.0, NOW_MS - 1.0, NOW_MS + 1.0];

        let mut cache = PerPeerDisplayCache::new();
        cache.resize(1, rows.len() as u16);
        let mut current = Vec::with_capacity(rows.len());
        for (row, &(cur, acked, exact, sent, due)) in rows.iter().enumerate() {
            current.push(HASHES[usize::from(cur)]);
            cache.acked_row_hashes[row] = HASHES[usize::from(acked)];
            cache.acked_row_exact[row] = exact;
            cache.sent_row_hashes[row] = HASHES[usize::from(sent)];
            cache.sent_row_resend_after_ms[row] = DEADLINES[usize::from(due)];
        }

        let (selected, _) = classify_at(&cache, &current, NOW_MS);
        proptest::prop_assert_eq!(
            cache.has_selectable_rows(&current, NOW_MS),
            !selected.is_empty(),
            "rows {:?}: the scheduler's runnable term disagrees with selection",
            rows
        );

        let scheduled = cache.has_selectable_rows(&current, NOW_MS)
            || cache.next_row_resend_due_ms(NOW_MS).is_some();
        let outstanding = cache.has_unacked_rows()
            || current
                .iter()
                .zip(&cache.acked_row_hashes)
                .any(|(current, acked)| current != acked);
        proptest::prop_assert_eq!(
            scheduled,
            outstanding,
            "rows {:?}: the scheduled set moved",
            rows
        );
    }
}
