//! Authenticated measurement projections. They never authorize display, input,
//! recovery or presentation. The browser host records these decoded facts.
use serde::Serialize;

// Observations already have boxed custody in the bounded host queue. Keeping
// this fixed-size payload inline avoids a second allocation for every sample.
#[expect(
    clippy::large_enum_variant,
    reason = "bounded host queue already boxes observations; inline payload avoids a second allocation"
)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum Observation {
    #[serde(rename = "perf_timing")]
    Timing(Timing),
    #[serde(rename = "perf_egress")]
    Egress(Egress),
    #[serde(rename = "perf_grid_convergence_response")]
    Grid(Grid),
}

impl Observation {
    pub fn decode(kind: u8, body: &[u8], epoch: u32) -> Option<Self> {
        use merkur_wire::protocol::*;
        let value = match kind {
            MSG_TYPE_PERF_TIMING => Self::Timing(Timing::decode(body)?),
            MSG_TYPE_PERF_EGRESS => Self::Egress(Egress::decode(body)?),
            MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE => Self::Grid(Grid::decode(body)?),
            _ => return None,
        };
        let observed_epoch = match &value {
            Self::Timing(value) => value.observation_epoch,
            Self::Egress(value) => value.observation_epoch,
            Self::Grid(value) => value.observation_epoch,
        };
        (epoch != 0 && epoch == observed_epoch).then_some(value)
    }

    pub fn resident_bytes(&self) -> usize {
        size_of::<Self>()
            + match self {
                Self::Timing(value) => value.records.capacity() * size_of::<TimingRecord>(),
                Self::Egress(_) => 0,
                Self::Grid(value) => value.row_hashes.capacity() * size_of::<u32>(),
            }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub batch_seq: u32,
    pub input_attributed_total: u32,
    pub input_dropped_total: u32,
    pub input_skipped_total: u32,
    pub pending_inputs: u32,
    pub display_attributed_total: u32,
    pub display_dropped_total: u32,
    pub observation_epoch: u32,
    pub records: Vec<TimingRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingRecord {
    pub input_seq: u32,
    pub recv_to_pty_us: u32,
    pub pty_to_read_us: u32,
    pub grid_apply_us: u32,
    pub display_coalesce_us: u32,
    pub select_capture_us: u32,
    pub prepare_queue_us: u32,
    pub encode_us: u32,
    pub compression_us: u32,
    pub completion_queue_us: u32,
    pub transport_submit_us: u32,
    pub write_completion_us: Option<u32>,
    pub ack_transmit_us: Option<u32>,
    pub owner_cpu_us: u32,
    pub owner_off_cpu_us: u32,
    pub owner_quinn_wait_us: u32,
    pub owner_registry_wait_us: u32,
    pub flush_lock_wait_us: u32,
}

impl Timing {
    fn decode(body: &[u8]) -> Option<Self> {
        let count = usize::from(*body.get(32)?);
        if count > 3 || body.len() != 33 + count * 72 {
            return None;
        }
        let mut header = Words(body);
        let batch_seq = header.word();
        let input_attributed_total = header.word();
        let input_dropped_total = header.word();
        let input_skipped_total = header.word();
        let pending_inputs = header.word();
        let display_attributed_total = header.word();
        let display_dropped_total = header.word();
        let observation_epoch = header.word();
        let mut records = Vec::with_capacity(count);
        for record in body[33..].chunks_exact(72) {
            let mut at = Words(record);
            records.push(TimingRecord {
                input_seq: at.word(),
                recv_to_pty_us: at.word(),
                pty_to_read_us: at.word(),
                grid_apply_us: at.word(),
                display_coalesce_us: at.word(),
                select_capture_us: at.word(),
                prepare_queue_us: at.word(),
                encode_us: at.word(),
                compression_us: at.word(),
                completion_queue_us: at.word(),
                transport_submit_us: at.word(),
                write_completion_us: observed(at.word()),
                ack_transmit_us: observed(at.word()),
                owner_cpu_us: at.word(),
                owner_off_cpu_us: at.word(),
                owner_quinn_wait_us: at.word(),
                owner_registry_wait_us: at.word(),
                flush_lock_wait_us: at.word(),
            });
        }
        Some(Self {
            batch_seq,
            input_attributed_total,
            input_dropped_total,
            input_skipped_total,
            pending_inputs,
            display_attributed_total,
            display_dropped_total,
            observation_epoch,
            records,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusals {
    pub blocked: u32,
    pub paced: u32,
    pub waited_us: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub epoch: u32,
    pub bw: u64,
    pub rtprop_us: u64,
    pub pacing_rate: u64,
    pub bulk_cap: u64,
    pub quantum: u64,
    pub phase: u32,
    pub probes_gated: u32,
    pub probes_aborted: u32,
    pub interactive_in_probe: u32,
    pub queue_growth_cuts: u32,
    pub loss_rounds: u32,
    pub ce_rounds: u32,
    pub probe_rtts: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Egress {
    pub observation_epoch: u32,
    pub daemon_group: u32,
    pub edge_attachment: u32,
    pub daemon_interactive: Refusals,
    pub daemon_bulk: Refusals,
    pub edge_interactive: Refusals,
    pub edge_bulk: Refusals,
    pub edge_forward_residence: [u32; 12],
    pub daemon_model: Model,
    pub edge_model: Model,
}

impl Egress {
    fn decode(body: &[u8]) -> Option<Self> {
        if body.len() != 260 {
            return None;
        }
        let mut at = Words(body);
        let observation_epoch = at.word();
        let daemon_group = at.word();
        let edge_attachment = at.word();
        let mut refusals = || Refusals {
            blocked: at.word(),
            paced: at.word(),
            waited_us: at.word(),
        };
        let daemon_interactive = refusals();
        let daemon_bulk = refusals();
        let edge_interactive = refusals();
        let edge_bulk = refusals();
        let edge_forward_residence = std::array::from_fn(|_| at.word());
        let daemon_model = at.model()?;
        let edge_model = at.model()?;
        Some(Self {
            observation_epoch,
            daemon_group,
            edge_attachment,
            daemon_interactive,
            daemon_bulk,
            edge_interactive,
            edge_bulk,
            edge_forward_residence,
            daemon_model,
            edge_model,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub observation_epoch: u32,
    pub probe_id: u32,
    pub generation: u32,
    pub last_admitted_display_seq: u32,
    pub cols: u16,
    pub rows: u16,
    /// Renderer/WASM ABI order: low word, high word for each u64 row hash.
    pub row_hashes: Vec<u32>,
}

impl Grid {
    fn decode(body: &[u8]) -> Option<Self> {
        let header = body.get(..20)?;
        let cols = u16::from_be_bytes(header[16..18].try_into().ok()?);
        let rows = u16::from_be_bytes(header[18..20].try_into().ok()?);
        if cols == 0
            || rows == 0
            || cols > 512
            || rows > 256
            || usize::from(cols) * usize::from(rows) > 96 * 1024
            || body.len() != 20 + usize::from(rows) * 8
        {
            return None;
        }
        let mut at = Words(header);
        let observation_epoch = at.word();
        let probe_id = at.word();
        let generation = at.word();
        let last_admitted_display_seq = at.word();
        if probe_id == 0 || generation == 0 {
            return None;
        }
        let mut row_hashes = Vec::with_capacity(usize::from(rows) * 2);
        for row in body[20..].chunks_exact(8) {
            let mut at = Words(row);
            let high = at.word();
            let low = at.word();
            row_hashes.extend_from_slice(&[low, high]);
        }
        Some(Self {
            observation_epoch,
            probe_id,
            generation,
            last_admitted_display_seq,
            cols,
            rows,
            row_hashes,
        })
    }
}

// Callers validate the complete fixed extent before this infallible reader.
struct Words<'a>(&'a [u8]);
impl Words<'_> {
    fn word(&mut self) -> u32 {
        let (bytes, rest) = self.0.split_at(4);
        self.0 = rest;
        u32::from_be_bytes(bytes.try_into().expect("validated word extent"))
    }
    fn gauge(&mut self) -> Option<u64> {
        let value = u64::from(self.word()) << 32 | u64::from(self.word());
        (value < (1u64 << 53)).then_some(value)
    }
    fn model(&mut self) -> Option<Model> {
        let epoch = self.word();
        let bw = self.gauge()?;
        let rtprop_us = self.gauge()?;
        let pacing_rate = self.gauge()?;
        let bulk_cap = self.gauge()?;
        let quantum = self.gauge()?;
        let phase = self.word();
        if phase > 6 {
            return None;
        }
        Some(Model {
            epoch,
            bw,
            rtprop_us,
            pacing_rate,
            bulk_cap,
            quantum,
            phase,
            probes_gated: self.word(),
            probes_aborted: self.word(),
            interactive_in_probe: self.word(),
            queue_growth_cuts: self.word(),
            loss_rounds: self.word(),
            ce_rounds: self.word(),
            probe_rtts: self.word(),
        })
    }
}
fn observed(value: u32) -> Option<u32> {
    (value != u32::MAX).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_wire::protocol::*;
    #[test]
    fn timing_is_exact_epoch_fenced_and_retains_unobserved_terms() {
        let mut body = vec![0; 33 + 72];
        body[28..32].copy_from_slice(&7u32.to_be_bytes());
        body[32] = 1;
        body[33 + 44..33 + 48].fill(0xff);
        let Some(Observation::Timing(timing)) = Observation::decode(MSG_TYPE_PERF_TIMING, &body, 7)
        else {
            panic!()
        };
        assert_eq!(timing.records[0].write_completion_us, None);
        assert_eq!(timing.records[0].ack_transmit_us, Some(0));
        assert!(Observation::decode(MSG_TYPE_PERF_TIMING, &body, 8).is_none());
        body.pop();
        assert!(Observation::decode(MSG_TYPE_PERF_TIMING, &body, 7).is_none());
    }
    #[test]
    fn egress_preserves_u64_gauges_and_rejects_inexact_browser_numbers() {
        let mut body = vec![0; 260];
        body[..4].copy_from_slice(&1u32.to_be_bytes());
        let gauge = (u64::from(u32::MAX) + 77).to_be_bytes();
        body[112..120].copy_from_slice(&gauge);
        let Some(Observation::Egress(egress)) = Observation::decode(MSG_TYPE_PERF_EGRESS, &body, 1)
        else {
            panic!()
        };
        assert_eq!(egress.daemon_model.bw, u64::from(u32::MAX) + 77);
        body[112..120].copy_from_slice(&(1u64 << 53).to_be_bytes());
        assert!(Observation::decode(MSG_TYPE_PERF_EGRESS, &body, 1).is_none());
        body[112..120].fill(0);
        body[152..156].copy_from_slice(&7u32.to_be_bytes());
        assert!(Observation::decode(MSG_TYPE_PERF_EGRESS, &body, 1).is_none());
    }
    #[test]
    fn grid_projection_uses_renderer_word_order_and_validates_the_extent() {
        let frame =
            encode_perf_grid_convergence_response(1, 2, 3, 4, 5, 1, &[0x1234_5678_8765_4321])
                .unwrap();
        let (_, body) = decode_proto_frame(&frame).unwrap();
        let Some(Observation::Grid(grid)) =
            Observation::decode(MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE, body, 1)
        else {
            panic!()
        };
        assert_eq!(grid.row_hashes, [0x8765_4321, 0x1234_5678]);
        assert!(
            Observation::decode(
                MSG_TYPE_PERF_GRID_CONVERGENCE_RESPONSE,
                &body[..body.len() - 1],
                1
            )
            .is_none()
        );
    }
}
