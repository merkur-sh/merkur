use super::*;

#[test]
fn continuously_ready_hot_work_cannot_starve_perf_maintenance() {
    let base = Instant::now();
    let sources = [
        PerfTimingHotWork {
            peer_message: true,
            ..PerfTimingHotWork::default()
        },
        PerfTimingHotWork {
            pty_output: true,
            ..PerfTimingHotWork::default()
        },
        PerfTimingHotWork {
            pty_write_completion: true,
            ..PerfTimingHotWork::default()
        },
        PerfTimingHotWork {
            display_prepare_completion: true,
            ..PerfTimingHotWork::default()
        },
        PerfTimingHotWork {
            snapshot_prepare_completion: true,
            ..PerfTimingHotWork::default()
        },
        PerfTimingHotWork {
            display_flush: true,
            ..PerfTimingHotWork::default()
        },
    ];
    for source in sources {
        let mut gate = PerfTimingMaintenanceGate::default();
        assert!(!gate.should_offer(base, source));
        gate.mark_due(base);
        for _ in 0..PERF_TIMING_MAX_MAINTENANCE_HOT_TURNS.saturating_sub(1) {
            assert!(!gate.should_offer(base, source));
        }
        assert!(
            gate.should_offer(base, source),
            "one synchronous batch is forced after the bounded hot-turn budget",
        );
    }

    let all_hot = PerfTimingHotWork {
        peer_message: true,
        pty_output: true,
        pty_write_completion: true,
        display_prepare_completion: true,
        snapshot_prepare_completion: true,
        display_flush: true,
    };
    let mut time_bounded = PerfTimingMaintenanceGate::default();
    time_bounded.mark_due(base);
    assert!(!time_bounded.should_offer(
        base + PERF_TIMING_MAX_MAINTENANCE_DEFERRAL - Duration::from_nanos(1),
        all_hot,
    ));
    assert!(time_bounded.should_offer(base + PERF_TIMING_MAX_MAINTENANCE_DEFERRAL, all_hot,));

    let mut quiet = PerfTimingMaintenanceGate::default();
    quiet.mark_due(base);
    assert!(quiet.should_offer(base, PerfTimingHotWork::default()));
    quiet.clear();
    assert!(!quiet.should_offer(base, PerfTimingHotWork::default()));
}

#[test]
fn bounded_hot_turn_service_keeps_sustained_display_profiling_lossless() {
    use crate::perf_timing::DisplaySendStamps;

    let base = Instant::now();
    let mut tracker = PerfTimingTracker::default();
    tracker.configure(Arc::from("peer-a"), "session-a", true, 1);
    let hot = PerfTimingHotWork {
        peer_message: true,
        pty_output: true,
        pty_write_completion: true,
        display_prepare_completion: true,
        snapshot_prepare_completion: true,
        display_flush: true,
    };
    let mut gate = PerfTimingMaintenanceGate::default();
    let mut records_sent = 0usize;

    // Every turn is a keystroke echo: one input-attributed record and one
    // display record, the 1:1 mix that starved the display queue when a
    // batch reserved a single display slot and an offer sent one batch.
    for turn in 1..=1_024u32 {
        let now = base + Duration::from_millis(u64::from(turn));
        tracker.note_input_received_for("peer-a", "session-a", turn, now);
        tracker.note_pty_write_for("peer-a", "session-a", turn, now);
        tracker.note_pty_read(now);
        tracker.note_grid_applied(now);
        tracker.note_display_sent_for(
            "peer-a",
            "session-a",
            turn,
            DisplaySendStamps {
                flush_started_at: now,
                selection_finished_at: now,
                prepare_queued_at: now,
                prepare_started_at: now,
                prepare_finished_at: now,
                completion_started_at: now,
                sent_at: now,
                compression_time: Duration::ZERO,
                presentation_end_admitted: true,
                flush_owner: perf_timing::owner::OwnerStamp::default(),
                sent_owner: perf_timing::owner::OwnerStamp::default(),
            },
        );
        if tracker
            .next_wire_deadline()
            .is_some_and(|deadline| deadline <= now)
        {
            gate.mark_due(now);
        }
        if gate.should_offer(now, hot) {
            let mut offered = 0usize;
            while let Some(batch) = tracker.take_due_wire_batch(now) {
                assert_eq!(batch.display_dropped_total, 0);
                assert_eq!(batch.dropped_total, 0);
                records_sent += batch.records.len();
                tracker.accept_wire_batch(&batch, now);
                offered += 1;
            }
            assert!(
                offered >= 1,
                "a due maintenance turn offers at least one batch"
            );
            gate.clear();
        }
    }

    let mut now = base + Duration::from_secs(2);
    while tracker.has_wire_update() {
        if let Some(deadline) = tracker.next_wire_deadline()
            && deadline > now
        {
            now = deadline;
        }
        gate.mark_due(now);
        assert!(gate.should_offer(now, PerfTimingHotWork::default()));
        let batch = tracker
            .take_due_wire_batch(now)
            .expect("quiet tail is immediately serviceable at its deadline");
        assert_eq!(batch.display_dropped_total, 0);
        assert_eq!(batch.dropped_total, 0);
        records_sent += batch.records.len();
        tracker.accept_wire_batch(&batch, now);
        gate.clear();
    }
    assert_eq!(records_sent, 2 * 1_024);
}

struct ErrorAfterBytes {
    cursor: std::io::Cursor<Vec<u8>>,
}

impl io::Read for ErrorAfterBytes {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cursor.position() < self.cursor.get_ref().len() as u64 {
            io::Read::read(&mut self.cursor, buf)
        } else {
            Err(io::Error::other("forced read error"))
        }
    }
}

#[tokio::test]
async fn ipc_reader_backpressures_and_preserves_command_then_error_order() {
    let mut bytes = Vec::new();
    ipc::write_frame(&mut bytes, 1, b"first").unwrap();
    ipc::write_frame(&mut bytes, 2, b"second").unwrap();
    let mut reader = ErrorAfterBytes {
        cursor: std::io::Cursor::new(bytes),
    };
    let (tx, mut rx) = mpsc::channel(1);
    let observed_tx = tx.clone();
    let reader_thread = std::thread::spawn(move || {
        read_ipc_commands(&mut reader, &tx);
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        while observed_tx.capacity() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first command should fill the bounded IPC queue");
    assert!(
        !reader_thread.is_finished(),
        "reader must stop draining input while the queue is full"
    );

    assert!(matches!(
        rx.recv().await.unwrap(),
        IpcInput::Frame(1, payload) if payload == b"first"
    ));
    assert!(matches!(
        rx.recv().await.unwrap(),
        IpcInput::Frame(2, payload) if payload == b"second"
    ));
    let IpcInput::ReadError(error) = rx.recv().await.unwrap() else {
        panic!("expected typed IPC read failure");
    };
    assert_eq!(error.to_string(), "forced read error");
    reader_thread.join().unwrap();
}

#[tokio::test]
async fn pty_completion_drain_is_bounded_per_owner_loop_turn() {
    let (mut pty_writer, _writer_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (completion_tx, mut completion_rx) = mpsc::unbounded_channel();
    let queued = PTY_WRITE_COMPLETIONS_PER_TURN + 3;
    for _ in 0..queued - 1 {
        completion_tx
            .send(PtyWriteCompletion::Delivered {
                source: PtyWriteSource::TerminalReply,
                byte_len: 0,
                trace: None,
            })
            .unwrap();
    }
    let first = PtyWriteCompletion::Delivered {
        source: PtyWriteSource::TerminalReply,
        byte_len: 0,
        trace: None,
    };
    let mut peers = HashMap::new();
    let mut parked_peers = ParkedPeers::new();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

    let turn = handle_pty_write_completions(
        first,
        &mut completion_rx,
        &mut pty_writer,
        &mut terminal,
        &mut peers,
        &mut parked_peers,
        &mut input::InputRefill::default(),
        &mut PerfTimingTracker::default(),
    )
    .unwrap();

    assert_eq!(
        turn,
        PtyCompletionTurn {
            handled: PTY_WRITE_COMPLETIONS_PER_TURN,
            input_ack_queued: false,
        },
        "terminal replies confirm no input, so the turn owes no ack"
    );
    assert_eq!(
        completion_rx.len(),
        3,
        "remaining completions must stay queued so select! can service another ready branch"
    );
}

fn user_input_completion(peer_id: &str, seq: u32) -> PtyWriteCompletion {
    PtyWriteCompletion::Delivered {
        source: PtyWriteSource::UserInput {
            peer_id: Arc::from(peer_id),
            seq,
            via_transport: PeerTransport::Edge,
        },
        byte_len: 1,
        trace: None,
    }
}

/// The per-turn budget `break` sits before the next `try_recv`, so a turn
/// that confirms exactly the budget leaves the loop without ever reading
/// an empty chain. The ack it queued must be reported all the same, or the
/// 64th keystroke of a burst waits for an unrelated later turn.
#[tokio::test]
async fn a_turn_that_consumes_exactly_its_budget_still_reports_its_ack() {
    let peer_id = "browser-1";
    let (mut pty_writer, _writer_completion_rx) =
        PtyWriter::new(Box::new(Vec::<u8>::new())).unwrap();
    let (completion_tx, mut completion_rx) = mpsc::unbounded_channel();
    let budget = u32::try_from(PTY_WRITE_COMPLETIONS_PER_TURN).unwrap();
    // One more than the budget is queued so the drain stops on the budget,
    // not on an empty chain.
    for seq in 2..=budget + 1 {
        completion_tx
            .send(user_input_completion(peer_id, seq))
            .unwrap();
    }
    let mut peer = PeerDisplayState::new(peer_id.into(), PeerTransport::Edge);
    // Every seq through the budget is already in the PTY FIFO.
    peer.keystroke_next_queued_seq = budget + 2;
    let mut peers = PeerMap::from([(peer_id.into(), peer)]);
    let mut parked_peers = ParkedPeers::new();
    let (terminal_event_tx, _terminal_event_rx) = unbounded();
    let mut terminal = TerminalState::new(80, 24, terminal_event_tx);

    let turn = handle_pty_write_completions(
        user_input_completion(peer_id, 1),
        &mut completion_rx,
        &mut pty_writer,
        &mut terminal,
        &mut peers,
        &mut parked_peers,
        &mut input::InputRefill::default(),
        &mut PerfTimingTracker::default(),
    )
    .unwrap();

    assert_eq!(
        turn,
        PtyCompletionTurn {
            handled: PTY_WRITE_COMPLETIONS_PER_TURN,
            input_ack_queued: true,
        },
        "the ack is reported even though the loop left on the budget break"
    );
    assert_eq!(
        peers[peer_id].pending_input_ack,
        Some(PendingInputAck {
            ack_seq: budget,
            via_transport: PeerTransport::Edge,
        }),
        "the slot holds the newest confirmed seq of the turn, not one per completion"
    );
    assert_eq!(peers[peer_id].latest_input_seq, budget);
    assert_eq!(
        completion_rx.len(),
        1,
        "the completion past the budget waits for the next turn"
    );
}

/// Grep-level pin: the PTY-output arm confirms queued write completions
/// before it applies the read, so the frame a read produces advertises the
/// keystroke whose echo it carries rather than that keystroke's predecessor.
#[test]
fn queued_write_completions_are_confirmed_before_a_pty_read_is_applied() {
    // This pin lives outside lib.rs, so its own string literals cannot
    // match the arm it looks for.
    let main: &str = include_str!("../lib.rs");
    let arm = main
        .find("event = async {")
        .expect("the PTY output arm exists");
    let drain = main[arm..]
        .find("pty_write_completion_rx.try_recv()")
        .expect("the arm drains queued write completions")
        + arm;
    let apply = main[arm..]
        .find("if let Some(event) = event {")
        .expect("the arm dispatches a waking event or resumes the retained read")
        + arm;
    assert!(
        drain < apply,
        "queued completions must be confirmed before the read is applied"
    );
    assert!(
        main[drain..apply].contains("handle_pty_write_completions("),
        "the drain goes through the one completion handler"
    );
}

/// Grep-level pin: the input ack path is a level flag and a per-peer slot.
/// No timer, no deadline, no clock read may return to it.
#[test]
fn the_input_ack_path_reads_no_clock() {
    const MAIN: &str = include_str!("../lib.rs");
    const CONNECTION: &str = include_str!("../connection.rs");
    let start = MAIN
        .find("fn handle_pty_write_completions(")
        .expect("the completion drain exists");
    let end = MAIN[start..]
        .find("fn refill_waiting_input(")
        .expect("input admission follows the ack path")
        + start;
    // The native PTY trace stamps its own owner-handled instant when a
    // trace is armed; that is an observation of the path, not a wait on
    // it, and it is the one clock read the pin tolerates.
    let mut ack_path = String::new();
    let mut inside_trace_record = false;
    for line in MAIN[start..end].lines() {
        if line.contains("trace.record(") {
            inside_trace_record = !line.contains(");");
            continue;
        }
        if inside_trace_record {
            inside_trace_record = !line.contains(");");
            continue;
        }
        ack_path.push_str(line);
        ack_path.push('\n');
    }
    let ack_path = ack_path.as_str();
    assert!(
        ack_path.contains("fn flush_input_acks(") && ack_path.contains("fn send_input_ack("),
        "the pinned region must still hold the flush and the send"
    );
    for symbol in [
        "tokio::time",
        "Instant",
        "Duration",
        "sleep",
        "due_at",
        "deadline",
    ] {
        assert!(
            !ack_path.contains(symbol),
            "the input ack path must not mention `{symbol}`"
        );
    }
    let queue = CONNECTION
        .find("pub fn queue_input_ack(")
        .expect("the per-peer queue exists");
    let queue_end = CONNECTION[queue..]
        .find("\n    }\n")
        .expect("the queue method closes")
        + queue;
    assert!(
        !CONNECTION[queue..queue_end].contains("Instant"),
        "queueing an ack must not read a clock"
    );
    // The retired timer's names are assembled here so this test's own
    // source cannot satisfy the search.
    for retired in [
        concat!("input_ack_", "sleep"),
        concat!("input_ack_", "armed"),
        concat!("INPUT_ACK_", "TRAILING_DELAY_MS"),
        concat!("INPUT_ACK_", "BURST_MIN_INTERVAL_MS"),
        concat!("INPUT_ACK_", "IDLE_RESET_MS"),
        concat!("next_input_", "ack_delay"),
        concat!("last_input_", "ack_flush_at"),
        concat!("pending_", "input_acks"),
    ] {
        assert!(
            !MAIN.contains(retired) && !CONNECTION.contains(retired),
            "`{retired}` was deleted with the ack timer and must not return"
        );
    }
}

#[test]
fn cleanup_observes_a_failure_that_arrives_after_the_run_loop() {
    let (failure_tx, mut failure_rx) = mpsc::channel(1);
    failure_tx.try_send(EventSinkFailure::QueueFull).unwrap();
    let mut fatal = None;

    capture_pending_event_failure(&mut fatal, &mut failure_rx);

    assert_eq!(fatal, Some(EventSinkFailure::QueueFull));
}
