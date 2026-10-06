//! Planner-level profiling harnesses for the display packet planner.
//!
//! They drive the production entry point [`plan_batch_partitions`] with rows
//! captured from a real `TerminalState`, replaying the suffix-replan control
//! flow of `send.rs::pack_captured_rows`: utility domains, the open FEC group
//! carried into every replan, each compression attempt's achieved ratio fed
//! into the flush-local profile, and exact raw records consuming the
//! already-optimal suffix. Compression is real zstd at the production level over
//! each span's real encoded cells. Sender service is a fixed deterministic
//! model instead of a wall-clock sample, so every run replays one call sequence
//! and the printed fingerprint compares two builds' plans exactly.
//!
//! Work counters are derived after each timed call from the workspace the call
//! left behind, so they add nothing to the measured interval. The allocation
//! counter brackets only the planner call.
//!
//! Timing between two builds is dominated by code placement in the default
//! 16-codegen-unit test binary: adding one ignored test to this file moved the
//! untouched reliable-only entropy replans by 12-20%. Compare builds against a
//! null control (the baseline plus an inert edit) and repeat the comparison
//! with `--config 'profile.release.package.merkur-dataplane.codegen-units=1'`;
//! trust only differences that hold in both and whose fingerprints match.
//!
//! Run alone in release (the allocation counter is process-wide):
//!
//! ```sh
//! BENCH_SAMPLES=100 cargo test --release --locked -p merkur-dataplane \
//!   display::planner::profile::planner_replan_sequence_profile \
//!   -- --ignored --exact --nocapture --test-threads=1
//! ```

use std::time::Instant;

use super::*;
use crate::edge_tunnel::test_allocations;
use crate::pty::{RowCaptureScratch, TerminalState};

const HEADER_BYTES: usize =
    merkur_codec::STREAM_HEADER_BYTES + merkur_codec::FRAME_HEADER_BODY_BYTES;
const WIRE_CAP: usize = DisplayPolicy::FEC_PROTECTED_DATAGRAM_PAYLOAD_BYTES;
const RTT_QUOTES_MS: [f64; 3] = [50.0, 120.0, 200.0];
/// The production maximum-preparation cells: plain and styled-entropy grids.
const SHAPES: [(u16, u16, bool); 4] = [
    (120, 40, false),
    (384, 256, false),
    (384, 256, true),
    (512, 192, true),
];
const WARMUP_JOBS: usize = 10;

fn samples() -> usize {
    std::env::var("BENCH_SAMPLES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100)
        .max(10)
}

/// Same byte stream as `send.rs`'s maximum preparation fixture (variant 0).
fn fixture_bytes(cols: u16, rows: u16, entropy: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut random = 0x243f6a88u32;
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
                b'a'
            });
        }
    }
    bytes
}

/// One captured row: what the planner sees, the real encoded cells a
/// compression attempt reads, and its utility domain.
struct CapturedRow {
    planned: PlannedRow,
    encoded: Vec<u8>,
    critical: bool,
}

fn capture(cols: u16, rows: u16, entropy: bool) -> Vec<CapturedRow> {
    let (event_tx, _event_rx) = crossbeam_channel::unbounded();
    let mut terminal = TerminalState::new(cols, rows, event_tx);
    terminal.apply_bytes(&fixture_bytes(cols, rows, entropy));
    let cursor_row = terminal.current_cursor_row();
    let mut scratch = RowCaptureScratch::default();
    (0..rows)
        .map(|row| {
            let captured = terminal.capture_row(row, &mut scratch);
            let mut content = ContentEvidence::default();
            content.observe(&captured.cells);
            let mut encoded = Vec::new();
            encoded.extend_from_slice(&row.to_be_bytes());
            encoded.extend_from_slice(&[0; merkur_codec::ROW_PREFIX_BYTES - 2]);
            merkur_codec::encode_cells(&mut encoded, &captured.cells);
            CapturedRow {
                planned: PlannedRow {
                    bytes: merkur_codec::ROW_PREFIX_BYTES
                        + merkur_codec::encoded_cells_size(&captured.cells),
                    class: content.class(),
                },
                encoded,
                critical: cursor_row == Some(row),
            }
        })
        .collect()
}

/// The benchmark peer's quote: one observed edge quote at `rtt_ms`.
fn planning_context(model: &PeerDisplayPlanningModel) -> PlanningContext {
    let carrier = model.carrier_quote(1, CarrierDeliveryQuote::default());
    PlanningContext {
        earliest_uncompressed_send_us: carrier.preparation_slack_us(),
        carrier,
        alternate_carrier: None,
        datagram_max_payload_bytes: DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES,
        fec_group_size: DisplayPolicy::FEC_GROUP_MAX_SIZE,
        fec_enabled: true,
        initial_fec_group_len: 0,
        initial_fec_group_max_bytes: 0,
        receiver_service_debt_us: model.receiver_service_debt_us(),
        higher_priority_preparation_jobs: 0,
    }
}

fn peer_model(rtt_ms: f64) -> PeerDisplayPlanningModel {
    let mut model = PeerDisplayPlanningModel::default();
    model.observe_carrier_quote(
        1,
        CarrierDeliveryQuote {
            one_way_us: rtt_ms * 500.0,
            ..CarrierDeliveryQuote::default()
        },
    );
    model
}

fn profiles(model: &PeerDisplayPlanningModel) -> [PeerPlanningSnapshot; CONTENT_CLASSES] {
    CONTENT_CLASS_BY_INDEX.map(|class| model.snapshot(class, DictionaryClass::Plain))
}

/// Deterministic sender-service sample for one attempt, in place of a clock
/// reading, so the posterior and therefore every plan is reproducible.
fn modeled_sender_service_us(raw_bytes: usize) -> f64 {
    1.0 + raw_bytes as f64 * 0.0025
}

/// Exact work one call performed, derived from its inputs and the workspace
/// it left behind.
#[derive(Clone, Copy, Default)]
struct Work {
    rows: usize,
    relaxed_spans: usize,
    price_misses: usize,
    frontier_solves: usize,
    frontier_spans: usize,
    transitions: usize,
    admitted: usize,
    states: usize,
    widest_frontier: usize,
}

impl Work {
    fn add(&mut self, other: Self) {
        self.rows += other.rows;
        self.relaxed_spans += other.relaxed_spans;
        self.price_misses += other.price_misses;
        self.frontier_solves += other.frontier_solves;
        self.frontier_spans += other.frontier_spans;
        self.transitions += other.transitions;
        self.admitted += other.admitted;
        self.states += other.states;
        self.widest_frontier = self.widest_frontier.max(other.widest_frontier);
    }
}

#[derive(Clone, Copy)]
struct Call {
    elapsed_ns: u64,
    allocations: usize,
    allocated_bytes: usize,
    work: Work,
}

#[derive(Default)]
struct Job {
    calls: Vec<Call>,
    records: usize,
    fingerprint: u64,
    /// `(raw_bytes, wire_bytes, class)` for each attempted compression,
    /// which the learned population feeds back like the owner completion.
    attempts: Vec<(usize, usize, ContentClass)>,
}

fn fnv(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
}

struct Worker {
    global: GlobalDisplayPlanningModel,
    workspace: PlannerWorkspace,
    plan: BatchPartitionPlan,
    zstd: zstd::bulk::Compressor<'static>,
    span: Vec<u8>,
    batches: Vec<(usize, bool)>,
    planned: Vec<PlannedRow>,
    count_work: bool,
}

impl Worker {
    fn new(count_work: bool) -> Self {
        Self {
            global: GlobalDisplayPlanningModel::default(),
            workspace: PlannerWorkspace::default(),
            plan: BatchPartitionPlan::default(),
            zstd: zstd::bulk::Compressor::new(3).expect("zstd context"),
            span: Vec::new(),
            batches: Vec::new(),
            planned: Vec::new(),
            count_work,
        }
    }

    /// `pending_packed_fec_group`, over the harness's emitted records.
    fn pending_group(&self, critical: bool, group_max: usize) -> (usize, usize) {
        let mut group_len = 0usize;
        let mut group_max_bytes = 0usize;
        for &(wire, batch_critical) in &self.batches {
            if batch_critical != critical || wire > DisplayPolicy::DATAGRAM_MAX_PAYLOAD_BYTES {
                group_len = 0;
                group_max_bytes = 0;
                continue;
            }
            group_len += 1;
            group_max_bytes = group_max_bytes.max(wire);
            if group_len == group_max.max(1) {
                group_len = 0;
                group_max_bytes = 0;
            }
        }
        (group_len, group_max_bytes)
    }

    /// `emit_fitted_batches`: attempt the planned representation, then split
    /// a multirow record that still exceeds the cap.
    fn emit(
        &mut self,
        rows: &[CapturedRow],
        critical: bool,
        representation: Representation,
        profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
        context: PlanningContext,
        job: &mut Job,
    ) -> Option<f64> {
        let mut class_bytes = [0usize; CONTENT_CLASSES];
        for row in rows {
            class_bytes[row.planned.class.index()] += row.planned.bytes;
        }
        let class = content_class_by_bytes(class_bytes);
        let raw_bytes = HEADER_BYTES + rows.iter().map(|row| row.planned.bytes).sum::<usize>();
        let (wire_bytes, achieved) = if representation == Representation::Compressed {
            self.span.clear();
            for row in rows {
                self.span.extend_from_slice(&row.encoded);
            }
            let compressed = self.zstd.compress(&self.span).expect("zstd compress");
            self.global.observe_sender_service(
                ExecutionLane::Bulk,
                raw_bytes,
                class,
                DictionaryClass::Plain,
                modeled_sender_service_us(raw_bytes),
            );
            let compressed_bytes = HEADER_BYTES + 4 + compressed.len();
            if compressed_bytes >= raw_bytes {
                job.attempts.push((raw_bytes, raw_bytes, class));
                (raw_bytes, Some(1.0))
            } else {
                let used = choose_after_compression(
                    profiles[class.index()],
                    raw_bytes,
                    compressed_bytes,
                    DictionaryClass::Plain,
                    context,
                ) == Representation::Compressed;
                let wire = if used { compressed_bytes } else { raw_bytes };
                job.attempts.push((raw_bytes, wire, class));
                (wire, Some(compressed_bytes as f64 / raw_bytes as f64))
            }
        } else {
            (raw_bytes, None)
        };
        if wire_bytes <= WIRE_CAP || rows.len() == 1 {
            self.batches.push((wire_bytes, critical));
            job.records += 1;
            fnv(&mut job.fingerprint, wire_bytes as u64);
            return achieved;
        }
        let keep = (rows.len() * WIRE_CAP / wire_bytes).clamp(1, rows.len() - 1);
        let first = self.emit(
            &rows[..keep],
            critical,
            representation,
            profiles,
            context,
            job,
        );
        let second = self.emit(
            &rows[keep..],
            critical,
            representation,
            profiles,
            context,
            job,
        );
        second.or(first).or(achieved)
    }

    fn plan(
        &mut self,
        profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
        context: PlanningContext,
        start: usize,
        job: &mut Job,
    ) {
        self.workspace.states.clear();
        let rows = &self.planned[start..];
        test_allocations::begin();
        let started = Instant::now();
        plan_batch_partitions(
            &self.global,
            profiles,
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            context,
            rows,
            HEADER_BYTES,
            WIRE_CAP,
            &mut self.workspace,
            &mut self.plan,
        );
        let elapsed_ns = started.elapsed().as_nanos() as u64;
        let tally = test_allocations::end();
        let work = if self.count_work {
            derive_work(&self.global, profiles, context, rows, &self.workspace)
        } else {
            Work::default()
        };
        fnv(&mut job.fingerprint, rows.len() as u64);
        fnv(&mut job.fingerprint, self.plan.score_us.to_bits());
        let mut index = 0;
        while let Some((end, representation)) = self.plan.get(index) {
            fnv(&mut job.fingerprint, end as u64);
            fnv(&mut job.fingerprint, representation as u64);
            index += 1;
        }
        job.calls.push(Call {
            elapsed_ns,
            allocations: tally.allocations,
            allocated_bytes: tally.allocated_bytes,
            work,
        });
    }

    /// `pack_captured_rows`' domain and replan loop.
    fn run_job(
        &mut self,
        rows: &[CapturedRow],
        profiles: [PeerPlanningSnapshot; CONTENT_CLASSES],
        context: PlanningContext,
    ) -> Job {
        let mut job = Job::default();
        let mut local = profiles;
        self.batches.clear();
        let mut batch_start = 0;
        while batch_start < rows.len() {
            let critical = rows[batch_start].critical;
            let mut domain_end = batch_start;
            while domain_end < rows.len() && rows[domain_end].critical == critical {
                domain_end += 1;
            }
            let domain = &rows[batch_start..domain_end];
            self.planned.clear();
            self.planned.extend(domain.iter().map(|row| row.planned));
            let mut planned_start = 0;
            let mut origin = 0;
            let mut cursor = 0;
            let mut valid = false;
            while planned_start < domain.len() {
                let mut planning = context;
                let (open_len, open_max) = self.pending_group(critical, planning.fec_group_size);
                planning.initial_fec_group_len = open_len;
                planning.initial_fec_group_max_bytes = open_max;
                if !valid {
                    origin = planned_start;
                    cursor = 0;
                    self.plan(&local, planning, planned_start, &mut job);
                }
                let (offset, representation) = self
                    .plan
                    .get(cursor)
                    .expect("every nonempty row domain has a feasible partition");
                let planned_end = origin + offset;
                let span = &domain[planned_start..planned_end];
                let mut class_bytes = [0usize; CONTENT_CLASSES];
                for row in span {
                    class_bytes[row.planned.class.index()] += row.planned.bytes;
                }
                let class = content_class_by_bytes(class_bytes);
                let emitted_before = self.batches.len();
                let actual = self.emit(span, critical, representation, &local, context, &mut job);
                let predicted_raw_bytes =
                    HEADER_BYTES + span.iter().map(|row| row.planned.bytes).sum::<usize>();
                if let Some(ratio) = actual {
                    local[class.index()].observe_actual_ratio(predicted_raw_bytes, ratio);
                }
                cursor += 1;
                valid = representation == Representation::Raw
                    && actual.is_none()
                    && self.batches.len() == emitted_before + 1
                    && self.batches[emitted_before].0 == predicted_raw_bytes
                    && self.plan.get(cursor).is_some();
                planned_start = planned_end;
            }
            batch_start = domain_end;
        }
        job
    }
}

/// Count the spans, candidate prices, transitions and frontier states the
/// last single-carrier call evaluated, replaying its loops over the retained
/// workspace without re-running the transition or dominance work.
fn derive_work(
    global: &GlobalDisplayPlanningModel,
    profiles: &[PeerPlanningSnapshot; CONTENT_CLASSES],
    context: PlanningContext,
    rows: &[PlannedRow],
    workspace: &PlannerWorkspace,
) -> Work {
    assert!(
        context.alternate_carrier.is_none(),
        "work replay is single-carrier"
    );
    let count = rows.len().min(MAX_PLANNED_ROWS);
    let mut work = Work {
        rows: count,
        ..Work::default()
    };
    let multirow_limit = profiles
        .iter()
        .map(|profile| multirow_raw_limit(*profile, WIRE_CAP))
        .max()
        .unwrap_or(WIRE_CAP);
    let sender_upper_by_size: [[f64; SIZE_CLASSES]; CONTENT_CLASSES] =
        std::array::from_fn(|content| {
            std::array::from_fn(|class| {
                global.sender_service_upper_us(
                    ExecutionLane::Bulk,
                    [512, 768, 1_536, 3_072, 6_144, 12_288][class],
                    CONTENT_CLASS_BY_INDEX[content],
                    DictionaryClass::Plain,
                )
            })
        });
    let raw = |start: usize, end: usize| {
        HEADER_BYTES + workspace.prefix[end].saturating_sub(workspace.prefix[start])
    };
    let mut slots: Vec<Option<([usize; CONTENT_CLASSES], usize)>> = vec![None; count + 1];
    let mut misses = 0usize;
    let mut price = |start: usize, end: usize| {
        let key = (
            span_class_bytes(&workspace.class_prefix, start, end),
            raw(start, end),
        );
        if slots[end - start] != Some(key) {
            misses += 1;
            slots[end - start] = Some(key);
        }
        batch_candidates(
            profiles,
            &sender_upper_by_size,
            key.0,
            key.1,
            end == start + 1,
            WIRE_CAP,
            context.datagram_max_payload_bytes,
        )
    };
    for start in (0..count).rev() {
        for end in start + 1..=count {
            if end > start + 1 && raw(start, end) > multirow_limit {
                break;
            }
            work.relaxed_spans += 1;
            price(start, end);
        }
    }
    if workspace.states.is_empty() {
        // The relaxed optimum was itself exact: no FEC frontier was built.
        work.price_misses = misses;
        return work;
    }
    work.frontier_solves = 1;
    let mut feasible = PlannerState {
        score_us: 0.0,
        open_group_len: context
            .initial_fec_group_len
            .min(planned_fec_group_size(context).saturating_sub(1)) as u8,
        open_group_max: context.initial_fec_group_max_bytes.min(u16::MAX as usize) as u16,
        ..PlannerState::INVALID
    };
    let mut start = 0;
    while start < count {
        let end = usize::from(workspace.suffix_ends[start]);
        let choice = price(start, end)
            .into_iter()
            .flatten()
            .find(|choice| choice.representation == workspace.suffix_representations[start])
            .expect("relaxed partition is feasible");
        feasible = transition_state(
            feasible,
            0,
            end,
            choice,
            candidate_base_cost_us(choice, context.carrier, context),
            context,
            &workspace.group_close_cost_us,
        );
        start = end;
    }
    let upper_bound_us = feasible.score_us
        + cached_group_close_cost_us(
            &workspace.group_close_cost_us,
            usize::from(feasible.open_group_len),
            usize::from(feasible.open_group_max),
        );
    let prune_above_us = upper_bound_us + (1.0 + upper_bound_us.abs()) * 1e-10;
    for end in 1..=count {
        for start in (0..end).rev() {
            if end > start + 1 && raw(start, end) > multirow_limit {
                break;
            }
            work.frontier_spans += 1;
            for choice in price(start, end).into_iter().flatten() {
                let base_cost_us = candidate_base_cost_us(choice, context.carrier, context);
                visit_distinct_predecessors(
                    &workspace.states,
                    &workspace.frontier_groups[start],
                    choice,
                    context,
                    |index, predecessor| {
                        work.transitions += 1;
                        let candidate = transition_state(
                            predecessor,
                            index,
                            end,
                            choice,
                            base_cost_us,
                            context,
                            &workspace.group_close_cost_us,
                        );
                        if candidate.score_us + workspace.suffix_lower_bound_us[end]
                            <= prune_above_us
                        {
                            work.admitted += 1;
                        }
                    },
                );
            }
        }
        work.widest_frontier = work
            .widest_frontier
            .max((workspace.frontier_ends[end] - workspace.frontier_starts[end]) as usize);
    }
    work.states = workspace.states.len();
    work.price_misses = misses;
    work
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    let rank = (percentile * sorted.len() as f64).ceil().max(1.0) as usize - 1;
    sorted[rank.min(sorted.len() - 1)]
}

fn summarize(mut values: Vec<f64>) -> (f64, f64) {
    values.sort_by(f64::total_cmp);
    (percentile(&values, 0.50), percentile(&values, 0.95))
}

/// The complete replan sequence of each production preparation cell: calls,
/// partition CPU (sum, first and largest call), allocations, derived work, and
/// a plan fingerprint that must match between two builds of an exact change.
#[test]
#[ignore = "production planner workload; the counting allocator is process-wide"]
fn planner_replan_sequence_profile() {
    let samples = samples();
    let mut overall = 0xcbf2_9ce4_8422_2325u64;
    for (cols, rows, entropy) in SHAPES {
        let captured = capture(cols, rows, entropy);
        let row_bytes: Vec<usize> = captured.iter().map(|row| row.planned.bytes).collect();
        eprintln!(
            "PLANNER_FIXTURE cols={cols} rows={rows} entropy={entropy} row_bytes_min={} row_bytes_max={} row_bytes_sum={} critical_rows={}",
            row_bytes.iter().min().copied().unwrap_or(0),
            row_bytes.iter().max().copied().unwrap_or(0),
            row_bytes.iter().sum::<usize>(),
            captured.iter().filter(|row| row.critical).count(),
        );
        for rtt_ms in RTT_QUOTES_MS {
            for learned in [false, true] {
                let mut peer = peer_model(rtt_ms);
                let context = planning_context(&peer);
                let mut worker = Worker::new(false);
                let observe = |peer: &mut PeerDisplayPlanningModel, job: &Job| {
                    if learned {
                        for &(raw, wire, class) in &job.attempts {
                            peer.observe_ratio(
                                raw,
                                class,
                                DictionaryClass::Plain,
                                (wire as f64 / raw as f64).clamp(0.01, 1.0),
                            );
                        }
                    }
                };
                for _ in 0..WARMUP_JOBS {
                    let job = worker.run_job(&captured, profiles(&peer), context);
                    observe(&mut peer, &job);
                }
                let mut totals = Vec::with_capacity(samples);
                let mut firsts = Vec::with_capacity(samples);
                let mut largest = Vec::with_capacity(samples);
                let mut call_counts = Vec::with_capacity(samples);
                let mut allocations = 0usize;
                let mut allocated_bytes = 0usize;
                let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
                let mut records = 0usize;
                for sample in 0..samples {
                    // Count work on the first measured job only; the replay
                    // is outside the timed call but still host CPU.
                    worker.count_work = sample == 0;
                    let job = worker.run_job(&captured, profiles(&peer), context);
                    observe(&mut peer, &job);
                    if sample == 0 {
                        let mut work = Work::default();
                        for call in &job.calls {
                            work.add(call.work);
                        }
                        let first = job.calls[0].work;
                        eprintln!(
                            "PLANNER_WORK rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned={learned} calls={} planned_rows={} relaxed_spans={} price_misses={} frontier_solves={} frontier_spans={} transitions={} admitted={} states={} widest_frontier={} first_rows={} first_relaxed_spans={} first_transitions={} first_states={}",
                            job.calls.len(),
                            work.rows,
                            work.relaxed_spans,
                            work.price_misses,
                            work.frontier_solves,
                            work.frontier_spans,
                            work.transitions,
                            work.admitted,
                            work.states,
                            work.widest_frontier,
                            first.rows,
                            first.relaxed_spans,
                            first.transitions,
                            first.states,
                        );
                    }
                    let ns: Vec<u64> = job.calls.iter().map(|call| call.elapsed_ns).collect();
                    totals.push(ns.iter().sum::<u64>() as f64 / 1_000.0);
                    firsts.push(ns[0] as f64 / 1_000.0);
                    largest.push(ns.iter().copied().max().unwrap_or(0) as f64 / 1_000.0);
                    call_counts.push(job.calls.len() as f64);
                    allocations += job.calls.iter().map(|call| call.allocations).sum::<usize>();
                    allocated_bytes += job
                        .calls
                        .iter()
                        .map(|call| call.allocated_bytes)
                        .sum::<usize>();
                    records += job.records;
                    fnv(&mut fingerprint, job.fingerprint);
                }
                fnv(&mut overall, fingerprint);
                let (total_p50, total_p95) = summarize(totals);
                let (first_p50, first_p95) = summarize(firsts);
                let (largest_p50, largest_p95) = summarize(largest);
                let (calls_p50, calls_p95) = summarize(call_counts);
                eprintln!(
                    "PLANNER_SEQUENCE rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned={learned} samples={samples} calls_p50={calls_p50} calls_p95={calls_p95} partition_p50_us={total_p50:.3} partition_p95_us={total_p95:.3} first_p50_us={first_p50:.3} first_p95_us={first_p95:.3} largest_p50_us={largest_p50:.3} largest_p95_us={largest_p95:.3} allocations={allocations} allocated_bytes={allocated_bytes} records_per_job={:.1} fingerprint={fingerprint:016x}",
                    records as f64 / samples as f64,
                );
                assert_eq!(allocations, 0, "a warmed planner must not allocate");
            }
        }
    }
    eprintln!("PLANNER_SEQUENCE_FINGERPRINT {overall:016x}");
}

/// One fixed call repeated: the first (largest) solve of each cell, and the
/// same rows against two crossing carriers, which pays both searches.
#[test]
#[ignore = "production planner workload; the counting allocator is process-wide"]
fn planner_first_call_profile() {
    let samples = samples().max(100);
    for (cols, rows, entropy) in SHAPES {
        let captured = capture(cols, rows, entropy);
        for rtt_ms in [120.0] {
            for learned in [false, true] {
                let mut peer = peer_model(rtt_ms);
                let base = planning_context(&peer);
                let mut worker = Worker::new(false);
                for _ in 0..WARMUP_JOBS {
                    let job = worker.run_job(&captured, profiles(&peer), base);
                    if learned {
                        for &(raw, wire, class) in &job.attempts {
                            peer.observe_ratio(
                                raw,
                                class,
                                DictionaryClass::Plain,
                                (wire as f64 / raw as f64).clamp(0.01, 1.0),
                            );
                        }
                    }
                }
                let crossing = PlanningContext {
                    alternate_carrier: Some(CarrierDeliveryQuote {
                        one_way_us: base.carrier.one_way_us / 6.0,
                        pacing_rate_bps: 500_000,
                        ..base.carrier
                    }),
                    ..base
                };
                let first_domain = captured
                    .iter()
                    .take_while(|row| row.critical == captured[0].critical)
                    .count();
                let planned: Vec<PlannedRow> = captured[..first_domain]
                    .iter()
                    .map(|row| row.planned)
                    .collect();
                let snapshot = profiles(&peer);
                for (scenario, context) in [("single", base), ("crossing", crossing)] {
                    let mut elapsed = Vec::with_capacity(samples);
                    let mut allocations = 0;
                    let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
                    for round in 0..samples + 20 {
                        test_allocations::begin();
                        let started = Instant::now();
                        plan_batch_partitions(
                            &worker.global,
                            &snapshot,
                            ExecutionLane::Bulk,
                            DictionaryClass::Plain,
                            context,
                            &planned,
                            HEADER_BYTES,
                            WIRE_CAP,
                            &mut worker.workspace,
                            &mut worker.plan,
                        );
                        let ns = started.elapsed().as_nanos() as f64;
                        allocations += test_allocations::end().allocations;
                        if round >= 20 {
                            elapsed.push(ns / 1_000.0);
                        }
                        if round == 0 {
                            fnv(&mut fingerprint, worker.plan.score_us.to_bits());
                            let mut index = 0;
                            while let Some((end, representation)) = worker.plan.get(index) {
                                fnv(&mut fingerprint, end as u64);
                                fnv(&mut fingerprint, representation as u64);
                                index += 1;
                            }
                        }
                    }
                    let batches = (0..).take_while(|index| worker.plan.get(*index).is_some());
                    let batches = batches.count();
                    let (p50, p95) = summarize(elapsed);
                    eprintln!(
                        "PLANNER_FIRST_CALL scenario={scenario} rtt_ms={rtt_ms} cols={cols} rows={rows} entropy={entropy} learned={learned} planned_rows={} samples={samples} p50_us={p50:.3} p95_us={p95:.3} batches={batches} allocations={allocations} fingerprint={fingerprint:016x}",
                        planned.len(),
                    );
                    assert_eq!(allocations, 0);
                }
            }
        }
    }
}

/// A steady loop over the largest measured solve (unlearned 384x256 plain
/// grid, 120 ms quote) for a sampling profiler to attach to, e.g.
/// `sample <pid> 8 -file planner.sample` while it runs.
#[test]
#[ignore = "sampling-profiler target; runs for BENCH_SECONDS"]
fn planner_hot_loop_profile() {
    let seconds = std::env::var("BENCH_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10);
    let captured = capture(384, 256, false);
    let peer = peer_model(120.0);
    let context = planning_context(&peer);
    let mut worker = Worker::new(false);
    for _ in 0..WARMUP_JOBS {
        worker.run_job(&captured, profiles(&peer), context);
    }
    let planned: Vec<PlannedRow> = captured
        .iter()
        .take_while(|row| !row.critical)
        .map(|row| row.planned)
        .collect();
    let snapshot = profiles(&peer);
    let deadline = Instant::now() + std::time::Duration::from_secs(seconds);
    let mut solves = 0u64;
    let started = Instant::now();
    while Instant::now() < deadline {
        plan_batch_partitions(
            &worker.global,
            &snapshot,
            ExecutionLane::Bulk,
            DictionaryClass::Plain,
            context,
            &planned,
            HEADER_BYTES,
            WIRE_CAP,
            &mut worker.workspace,
            &mut worker.plan,
        );
        solves += 1;
    }
    eprintln!(
        "PLANNER_HOT_LOOP solves={solves} mean_us={:.3}",
        started.elapsed().as_secs_f64() * 1e6 / solves as f64
    );
}

fn nanos_per_op(iterations: usize, mut op: impl FnMut()) -> f64 {
    let started = Instant::now();
    for _ in 0..iterations {
        op();
    }
    started.elapsed().as_nanos() as f64 / iterations as f64
}

/// Warm a posterior window with a spread of samples so every read walks
/// the full bounded window, as a long-lived peer's would.
fn warm_peer_model(rtt_ms: f64) -> PeerDisplayPlanningModel {
    let mut model = peer_model(rtt_ms);
    for sample in 0..POSTERIOR_SAMPLES * 2 {
        let jitter = (sample % 7) as f64;
        for carrier in 0..2 {
            model.observe_carrier_quote(
                carrier,
                CarrierDeliveryQuote {
                    one_way_us: rtt_ms * 500.0 + jitter * 50.0,
                    loss_upper: 0.001 * jitter,
                    ..CarrierDeliveryQuote::default()
                },
            );
        }
        for class in CONTENT_CLASS_BY_INDEX {
            for bytes in [512, 768, 1_536, 3_072, 6_144, 12_288] {
                model.observe_ratio(bytes, class, DictionaryClass::Plain, 0.2 + 0.01 * jitter);
            }
        }
    }
    model
}

/// Per-flush owner-loop planner work: the three class snapshots and carrier
/// quotes a flush's compression policy reads, and the complete one-, two- and
/// eight-row plans an inline keystroke echo or interactive job solves, with
/// the group-close table fill that every protected solve performs isolated.
#[test]
#[ignore = "production planner workload; the counting allocator is process-wide"]
fn planner_small_plan_profile() {
    let iterations = samples().max(100) * 200;
    let rows = capture(120, 40, false);
    let mut prompt = TerminalState::new(120, 40, crossbeam_channel::unbounded().0);
    prompt.apply_bytes(b"user@host:~/src/merkur$ git status --short && cargo test -p merkur");
    let mut scratch = RowCaptureScratch::default();
    let captured = prompt.capture_row(0, &mut scratch);
    let mut content = ContentEvidence::default();
    content.observe(&captured.cells);
    let prompt_row = PlannedRow {
        bytes: merkur_codec::ROW_PREFIX_BYTES + merkur_codec::encoded_cells_size(&captured.cells),
        class: content.class(),
    };
    for warm in [false, true] {
        let peer = if warm {
            warm_peer_model(50.0)
        } else {
            peer_model(50.0)
        };
        let mut global = GlobalDisplayPlanningModel::default();
        if warm {
            for sample in 0..POSTERIOR_SAMPLES {
                for lane in [
                    ExecutionLane::Inline,
                    ExecutionLane::Interactive,
                    ExecutionLane::Bulk,
                ] {
                    for class in CONTENT_CLASS_BY_INDEX {
                        for bytes in [512, 768, 1_536, 3_072, 6_144, 12_288] {
                            global.observe_sender_service(
                                lane,
                                bytes,
                                class,
                                DictionaryClass::Plain,
                                modeled_sender_service_us(bytes) + (sample % 5) as f64,
                            );
                        }
                    }
                }
            }
        }
        let single = planning_context(&peer);
        let crossing = PlanningContext {
            alternate_carrier: Some(CarrierDeliveryQuote {
                one_way_us: single.carrier.one_way_us / 6.0,
                pacing_rate_bps: 500_000,
                ..single.carrier
            }),
            ..single
        };
        let snapshot_ns = nanos_per_op(iterations, || {
            std::hint::black_box(profiles(std::hint::black_box(&peer)));
        });
        let quote_ns = nanos_per_op(iterations, || {
            std::hint::black_box(
                std::hint::black_box(&peer).carrier_quote(1, CarrierDeliveryQuote::default()),
            );
        });
        let sender_upper_ns = nanos_per_op(iterations, || {
            let table: [[f64; SIZE_CLASSES]; CONTENT_CLASSES] = std::array::from_fn(|content| {
                std::array::from_fn(|class| {
                    std::hint::black_box(&global).sender_service_upper_us(
                        ExecutionLane::Bulk,
                        [512, 768, 1_536, 3_072, 6_144, 12_288][class],
                        CONTENT_CLASS_BY_INDEX[content],
                        DictionaryClass::Plain,
                    )
                })
            });
            std::hint::black_box(table);
        });
        let mut cache = [[0.0; SHARD_SIZES]; GROUP_LENGTHS];
        // Every width, as the widest solves fill it; the small plans below
        // fill only the widths they can read. Warm the fill first: it runs
        // after three short loops, and an unwarmed first batch measured twice
        // the second on the same inputs.
        let fill = |cache: &mut [[f64; SHARD_SIZES]; GROUP_LENGTHS]| {
            fill_group_close_cost_cache(
                cache,
                std::hint::black_box(single.carrier),
                single,
                SHARD_SIZES - 1,
            );
        };
        for _ in 0..iterations / 100 {
            fill(&mut cache);
        }
        let close_table_ns = nanos_per_op(iterations / 10, || {
            fill(&mut cache);
            std::hint::black_box(&cache);
        });
        eprintln!(
            "PLANNER_OWNER_READS warm={warm} snapshots3_ns={snapshot_ns:.1} carrier_quote_ns={quote_ns:.1} sender_upper18_ns={sender_upper_ns:.1} close_table_fill_ns={close_table_ns:.1} close_table_entries={}",
            GROUP_LENGTHS * SHARD_SIZES,
        );
        let snapshot = profiles(&peer);
        let mut workspace = PlannerWorkspace::default();
        let mut plan = BatchPartitionPlan::default();
        for (label, planned) in [
            ("prompt-1", vec![prompt_row]),
            ("prompt-2", vec![prompt_row; 2]),
            ("plain-8", rows[..8].iter().map(|row| row.planned).collect()),
        ] {
            for lane in [ExecutionLane::Inline, ExecutionLane::Interactive] {
                for (scenario, context) in [("single", single), ("crossing", crossing)] {
                    let solve = |workspace: &mut PlannerWorkspace,
                                 plan: &mut BatchPartitionPlan| {
                        plan_batch_partitions(
                            &global,
                            &snapshot,
                            lane,
                            DictionaryClass::Plain,
                            context,
                            &planned,
                            HEADER_BYTES,
                            WIRE_CAP,
                            workspace,
                            plan,
                        );
                    };
                    for _ in 0..1_000 {
                        solve(&mut workspace, &mut plan);
                    }
                    test_allocations::begin();
                    let ns = nanos_per_op(iterations / 10, || solve(&mut workspace, &mut plan));
                    let tally = test_allocations::end();
                    workspace.states.clear();
                    solve(&mut workspace, &mut plan);
                    let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
                    fnv(&mut fingerprint, plan.score_us.to_bits());
                    let mut index = 0;
                    while let Some((end, representation)) = plan.get(index) {
                        fnv(&mut fingerprint, end as u64);
                        fnv(&mut fingerprint, representation as u64);
                        index += 1;
                    }
                    eprintln!(
                        "PLANNER_SMALL_PLAN warm={warm} rows={label} row_bytes={} lane={lane:?} scenario={scenario} ns_per_plan={ns:.1} frontier_built={} allocations={} fingerprint={fingerprint:016x}",
                        planned[0].bytes,
                        !workspace.states.is_empty(),
                        tally.allocations,
                    );
                    assert_eq!(tally.allocations, 0);
                }
            }
        }
    }
}

/// The reliable-only suffix solves that make up 255 of an entropy redraw's
/// 256 calls: one solve per row count over the learned 384x256 entropy grid,
/// timed alone so the fixed per-call cost (intercept) and the relaxed pass's
/// per-row cost (slope) separate. Each redraw pays the intercept once per row.
#[test]
#[ignore = "production planner workload; the counting allocator is process-wide"]
fn planner_reliable_only_scaling_profile() {
    let samples = samples();
    let captured = capture(384, 256, true);
    let mut peer = peer_model(120.0);
    let context = planning_context(&peer);
    let mut worker = Worker::new(false);
    for _ in 0..WARMUP_JOBS {
        let job = worker.run_job(&captured, profiles(&peer), context);
        for &(raw, wire, class) in &job.attempts {
            peer.observe_ratio(
                raw,
                class,
                DictionaryClass::Plain,
                (wire as f64 / raw as f64).clamp(0.01, 1.0),
            );
        }
    }
    let snapshot = profiles(&peer);
    let planned: Vec<PlannedRow> = captured
        .iter()
        .take_while(|row| row.critical == captured[0].critical)
        .map(|row| row.planned)
        .collect();
    for rows in [1, 2, 4, 16, 64, 128, planned.len()] {
        let suffix = &planned[planned.len() - rows..];
        let solve = |worker: &mut Worker| {
            plan_batch_partitions(
                &worker.global,
                &snapshot,
                ExecutionLane::Bulk,
                DictionaryClass::Plain,
                context,
                suffix,
                HEADER_BYTES,
                WIRE_CAP,
                &mut worker.workspace,
                &mut worker.plan,
            );
        };
        for _ in 0..200 {
            solve(&mut worker);
        }
        let iterations = (samples * 4_000 / rows).max(200);
        let mut per_plan = Vec::with_capacity(9);
        test_allocations::begin();
        for _ in 0..9 {
            per_plan.push(nanos_per_op(iterations, || solve(&mut worker)));
        }
        let tally = test_allocations::end();
        worker.workspace.states.clear();
        solve(&mut worker);
        let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
        fnv(&mut fingerprint, worker.plan.score_us.to_bits());
        let mut index = 0;
        while let Some((end, representation)) = worker.plan.get(index) {
            fnv(&mut fingerprint, end as u64);
            fnv(&mut fingerprint, representation as u64);
            index += 1;
        }
        let (ns, _) = summarize(per_plan);
        eprintln!(
            "PLANNER_RELIABLE_ONLY rows={rows} row_bytes={} ns_per_plan={ns:.1} ns_per_row={:.2} frontier_built={} allocations={} fingerprint={fingerprint:016x}",
            suffix[0].bytes,
            ns / rows as f64,
            !worker.workspace.states.is_empty(),
            tally.allocations,
        );
        assert_eq!(tally.allocations, 0);
    }
}

/// Posterior writes and reads as one flush performs them once every window
/// is warm: each live carrier observes one quote, `carrier_quote` then runs
/// about ten times (transport choice twice, the planning context, admission
/// and the prepared-burst delivery price, for both carriers), and the
/// compression policy takes three class snapshots. A prepare worker's sender
/// windows are written once per compression attempt and read eighteen at a
/// time by every solve. Each figure is the median of nine timed batches.
#[test]
#[ignore = "posterior read/write microbenchmark"]
fn planner_posterior_read_profile() {
    let iterations = samples().max(100) * 200;
    let median_ns = |mut op: Box<dyn FnMut() + '_>| {
        for _ in 0..iterations / 10 {
            op();
        }
        let mut runs: Vec<f64> = (0..9).map(|_| nanos_per_op(iterations, &mut op)).collect();
        runs.sort_by(f64::total_cmp);
        runs[4]
    };
    let mut peer = warm_peer_model(50.0);
    let mut global = GlobalDisplayPlanningModel::default();
    for sample in 0..POSTERIOR_SAMPLES * 2 {
        for lane in [
            ExecutionLane::Inline,
            ExecutionLane::Interactive,
            ExecutionLane::Bulk,
        ] {
            for class in CONTENT_CLASS_BY_INDEX {
                for bytes in [512, 768, 1_536, 3_072, 6_144, 12_288] {
                    global.observe_sender_service(
                        lane,
                        bytes,
                        class,
                        DictionaryClass::Plain,
                        modeled_sender_service_us(bytes) + (sample % 5) as f64,
                    );
                }
            }
        }
    }
    let quote = |jitter: f64| CarrierDeliveryQuote {
        one_way_us: 25_000.0 + jitter * 50.0,
        loss_upper: 0.001 * jitter,
        ..CarrierDeliveryQuote::default()
    };
    let mut step = 0u64;
    let observe_quote_ns = median_ns(Box::new(|| {
        step += 1;
        std::hint::black_box(&mut peer).observe_carrier_quote(1, quote((step % 7) as f64));
    }));
    let carrier_quote_ns = median_ns(Box::new(|| {
        std::hint::black_box(
            std::hint::black_box(&peer).carrier_quote(1, CarrierDeliveryQuote::default()),
        );
    }));
    let flush_ns = median_ns(Box::new(|| {
        step += 1;
        let peer = std::hint::black_box(&mut peer);
        for carrier in 0..2 {
            peer.observe_carrier_quote(carrier, quote((step % 7) as f64));
        }
        for read in 0..10 {
            std::hint::black_box(peer.carrier_quote(read % 2, CarrierDeliveryQuote::default()));
        }
        std::hint::black_box(profiles(peer));
    }));
    let observe_sender_ns = median_ns(Box::new(|| {
        step += 1;
        std::hint::black_box(&mut global).observe_sender_service(
            ExecutionLane::Bulk,
            1_536,
            ContentClass::Color,
            DictionaryClass::Plain,
            modeled_sender_service_us(1_536) + (step % 5) as f64,
        );
    }));
    let sender_upper18_ns = median_ns(Box::new(|| {
        let global = std::hint::black_box(&global);
        let table: [[f64; SIZE_CLASSES]; CONTENT_CLASSES] = std::array::from_fn(|content| {
            std::array::from_fn(|class| {
                global.sender_service_upper_us(
                    ExecutionLane::Bulk,
                    [512, 768, 1_536, 3_072, 6_144, 12_288][class],
                    CONTENT_CLASS_BY_INDEX[content],
                    DictionaryClass::Plain,
                )
            })
        });
        std::hint::black_box(table);
    }));
    let mut fingerprint = 0xcbf2_9ce4_8422_2325u64;
    for carrier in 0..2 {
        let quote = peer.carrier_quote(carrier, CarrierDeliveryQuote::default());
        fnv(&mut fingerprint, quote.one_way_us.to_bits());
        fnv(&mut fingerprint, quote.loss_upper.to_bits());
    }
    for content in CONTENT_CLASS_BY_INDEX {
        for bytes in [300, 512, 768, 1_536, 3_072, 6_144, 12_288, 20_000] {
            fnv(
                &mut fingerprint,
                global
                    .sender_service_upper_us(
                        ExecutionLane::Bulk,
                        bytes,
                        content,
                        DictionaryClass::Plain,
                    )
                    .to_bits(),
            );
        }
    }
    eprintln!(
        "PLANNER_POSTERIOR observe_quote_ns={observe_quote_ns:.1} carrier_quote_ns={carrier_quote_ns:.1} flush_ns={flush_ns:.1} observe_sender_ns={observe_sender_ns:.1} sender_upper18_ns={sender_upper18_ns:.1} fingerprint={fingerprint:016x}"
    );
}
