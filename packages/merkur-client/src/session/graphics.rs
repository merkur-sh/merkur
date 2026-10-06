//! Graphics content: the transport half of `asset-client.ts`, with
//! `content-stream.ts` and `finite-content-reader.ts`.
//!
//! The viewer names the tiles the presented scene needs. The session asks the
//! daemon for each one it does not hold, on the control lane, and reads the
//! answer from a finite stream: an authenticated header naming the encoded
//! object and the range sent, then that range's chunks in order, each sealed
//! under a key the header's transfer derives. A finished object is verified
//! against its root before the host sees a byte of it.
//!
//! A stream that dies mid-transfer resumes from the prefix already held; the
//! daemon answers the cancel of the dead request with UNAVAILABLE, and the
//! resume asks for exactly the rest of the same object. A refusal holds until
//! the scene or a carrier changes. Every authentication starts over: its keys
//! are new, and nothing asked under the old ones can be answered.

use std::collections::{HashMap, HashSet};

use merkur_e2e::{
    CONTENT_CHUNK_BYTES, CONTENT_CHUNK_OVERHEAD, CONTENT_HEADER_BYTES, ContentDescriptor,
    ContentReceiver, ContentRequests, NoiseTransport,
};
use merkur_graphics::animation::{MAX_FRAMES, Manifest};
use merkur_graphics::budget::Budget;
use merkur_graphics::tile::{TILE_ENCODED_BYTES, TileShape, TileVerifier};
use merkur_wire::protocol::{
    CHANNEL_GRAPHICS_CONTENT, MSG_TYPE_GRAPHICS_CANCEL, MSG_TYPE_GRAPHICS_REQUEST,
    encode_proto_frame,
};

/// The finite class's channel byte for graphics content.
const CONTENT_STREAM: u8 = 0x80 | CHANNEL_GRAPHICS_CONTENT;
/// Jobs in flight, cancels awaiting their answer included: the daemon's and
/// the content domain's bound on concurrent transfers.
const MAX_JOBS: usize = merkur_e2e::CONTENT_MAX_TRANSFERS as usize;
/// A scene larger than this is refused whole, as the asset client refuses it.
pub const MAX_DEMANDS: usize = 8_192;
/// One finite response at most: its header, the largest encoded object and
/// the overhead of each of its chunk records.
const MAX_WIRE_BYTES: usize = CONTENT_HEADER_BYTES
    + TILE_ENCODED_BYTES
    + TILE_ENCODED_BYTES.div_ceil(CONTENT_CHUNK_BYTES) * CONTENT_CHUNK_OVERHEAD;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphicsAsset {
    /// One 256-pixel tile of one pyramid level, as a gutter-bordered PNG.
    Tile,
    /// An animation's frame manifest.
    Animation,
}

/// One asset the presented scene needs: the projection's `TileDemand`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphicsDemand {
    pub asset: GraphicsAsset,
    /// The root the daemon's scene names the image by.
    pub authority: [u8; 32],
    pub frame: u32,
    /// Unique within one scene.
    pub key: String,
    /// The root of the pixels this demand shows.
    pub source: [u8; 32],
    pub level: u8,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl GraphicsDemand {
    fn same_authority(&self, other: &Self) -> bool {
        self.asset == other.asset && self.frame == other.frame && self.authority == other.authority
    }
}

/// One transition of a job, told to a recording host once per transition and
/// never per chunk. A job that hands its asset over ends here at `Published`:
/// the host that takes the asset records `consumed` and retires it. Every
/// other job ends at `Cancelled` and a failed `Retired`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphicsPhase {
    Demanded,
    Requested,
    /// The request's authenticated header arrived.
    FirstByte,
    /// The whole object arrived, before it is verified.
    Fin,
    Published,
    Retired,
    Refused,
    Unavailable,
    Cancelled,
    /// The live request's carrier went, and the job waits for its cancel's answer.
    Interrupted,
    /// That answer came, and the rest of the object is asked for.
    Resumed,
}

/// What the graphics side hands the session to send or to deliver.
pub(super) enum Out {
    /// A control frame for the daemon, in the clear; the session seals it.
    Control(Vec<u8>),
    /// A verified asset of the scene of `epoch`, and the job that fetched it
    /// when that job is reported: the host that takes the asset retires it.
    Asset {
        epoch: u32,
        key: String,
        asset: GraphicsAsset,
        job: Option<u64>,
        bytes: Vec<u8>,
    },
    /// `bytes` is the object's size at `Fin` and zero otherwise; `failed`
    /// marks a `Retired` that ended without its asset.
    Phase {
        phase: GraphicsPhase,
        job: u64,
        bytes: u32,
        failed: bool,
    },
}

/// One part of a finite stream as the carrier reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FinitePart<'a> {
    Begin {
        channel: u8,
        total: u32,
    },
    Data(&'a [u8]),
    /// `complete` is a clean FIN; false is a reset or a carrier's end.
    End {
        complete: bool,
    },
}

struct Job {
    id: u64,
    demand: GraphicsDemand,
    request: Option<u64>,
    /// Its request's stream is being read.
    receiving: bool,
    /// The first authenticated descriptor: the object every resume asks for.
    descriptor: Option<ContentDescriptor>,
    object: Vec<u8>,
    /// The contiguous prefix of `object` held.
    held: usize,
    /// A dead request whose UNAVAILABLE lets this job resume.
    cancelling: Option<u64>,
}

struct Stream {
    total: usize,
    received: usize,
    header: Vec<u8>,
    receiver: Option<ContentReceiver>,
    request: u64,
    first: u32,
    count: u32,
    object_bytes: usize,
    ordinal: u32,
    record: Vec<u8>,
    failed: bool,
}

#[derive(Default)]
pub(super) struct Graphics {
    /// What this key epoch may be answered with.
    requests: ContentRequests,
    /// The daemon admits a request id once: they only grow, across every
    /// authentication.
    next_request: u64,
    next_job: u64,
    epoch: u32,
    desired: Vec<GraphicsDemand>,
    resident: HashSet<String>,
    /// Refused keys; `true` when the refusal was the object's own fault.
    refused: HashMap<String, bool>,
    jobs: Vec<Job>,
    /// Cancels the daemon has not answered, holding a transfer slot there.
    cancellations: HashSet<u64>,
    streams: HashMap<(u64, u64), Stream>,
    /// The host records performance evidence: a job demanded now is reported.
    observed: bool,
    /// The jobs in flight whose transitions are reported.
    recorded: HashSet<u64>,
    out: Vec<Out>,
}

impl Graphics {
    pub(super) fn take_out(&mut self) -> Vec<Out> {
        std::mem::take(&mut self.out)
    }

    /// Whether the host records the jobs demanded from now on. A job is
    /// reported whole or not at all: one demanded while the host records
    /// reports to its end, so a record never retires a job it did not open.
    pub(super) fn observe(&mut self, observed: bool) {
        self.observed = observed;
    }

    fn phase(&mut self, phase: GraphicsPhase, job: u64) {
        self.sized_phase(phase, job, 0, false);
    }

    fn sized_phase(&mut self, phase: GraphicsPhase, job: u64, bytes: u32, failed: bool) {
        if phase == GraphicsPhase::Demanded && self.observed {
            self.recorded.insert(job);
        }
        if !self.recorded.contains(&job) {
            return;
        }
        if matches!(phase, GraphicsPhase::Published | GraphicsPhase::Retired) {
            self.recorded.remove(&job);
        }
        self.out.push(Out::Phase {
            phase,
            job,
            bytes,
            failed,
        });
    }

    /// The scene of display lineage `epoch` needs exactly `demands`, largest
    /// first.
    pub(super) fn replace(&mut self, epoch: u32, demands: Vec<GraphicsDemand>, ready: bool) {
        if demands.len() > MAX_DEMANDS {
            return;
        }
        if epoch != self.epoch {
            self.resident.clear();
            self.refused.clear();
        }
        self.epoch = epoch;
        let next: HashMap<&str, &GraphicsDemand> = demands
            .iter()
            .map(|demand| (demand.key.as_str(), demand))
            .collect();
        let stale: Vec<u64> = self
            .jobs
            .iter()
            .filter(|job| {
                next.get(job.demand.key.as_str())
                    .is_none_or(|demand| !job.demand.same_authority(demand))
            })
            .map(|job| job.id)
            .collect();
        for id in stale {
            self.cancel(id, false);
        }
        self.resident.retain(|key| next.contains_key(key.as_str()));
        // A refusal stays while its exact demand does.
        let prior: HashMap<&str, &GraphicsDemand> = self
            .desired
            .iter()
            .map(|demand| (demand.key.as_str(), demand))
            .collect();
        self.refused.retain(|key, _| {
            prior
                .get(key.as_str())
                .zip(next.get(key.as_str()))
                .is_some_and(|(before, after)| before.same_authority(after))
        });
        drop(prior);
        drop(next);
        self.desired = demands;
        self.pump(ready);
    }

    /// Ask for what is wanted and neither held, refused nor asked for.
    pub(super) fn pump(&mut self, ready: bool) {
        if !ready {
            return;
        }
        let mut index = 0;
        while index < self.desired.len() {
            if self.jobs.len() + self.cancellations.len() >= MAX_JOBS {
                break;
            }
            let demand = &self.desired[index];
            index += 1;
            if self.resident.contains(&demand.key)
                || self.refused.contains_key(&demand.key)
                || self.jobs.iter().any(|job| job.demand.key == demand.key)
            {
                continue;
            }
            self.next_job += 1;
            let id = self.next_job;
            self.jobs.push(Job {
                id,
                demand: demand.clone(),
                request: None,
                receiving: false,
                descriptor: None,
                object: Vec::new(),
                held: 0,
                cancelling: None,
            });
            self.phase(GraphicsPhase::Demanded, id);
            self.request(id);
        }
    }

    fn job(&mut self, id: u64) -> Option<&mut Job> {
        self.jobs.iter_mut().find(|job| job.id == id)
    }

    /// Only a request that is sent spends its id.
    fn request(&mut self, id: u64) {
        let Some(job) = self.jobs.iter().find(|job| job.id == id) else {
            return;
        };
        let request = self.next_request + 1;
        let (admitted, range) = match job.descriptor {
            Some(descriptor) => {
                let bytes = descriptor.object_bytes();
                // Re-read the last record when only the FIN was lost.
                let first = (job.held.min(bytes as usize - 1) / CONTENT_CHUNK_BYTES) as u32;
                let count = (bytes as usize).div_ceil(CONTENT_CHUNK_BYTES) as u32 - first;
                let resumed = ContentDescriptor::new(
                    request,
                    *descriptor.source(),
                    *descriptor.object(),
                    bytes,
                    first,
                    count,
                );
                match resumed {
                    Ok(resumed) => (
                        self.requests.range(resumed).is_ok(),
                        Some((*descriptor.object(), bytes, first, count)),
                    ),
                    Err(_) => (false, None),
                }
            }
            None => (
                self.requests
                    .whole(request, job.demand.source, TILE_ENCODED_BYTES as u32)
                    .is_ok(),
                None,
            ),
        };
        if !admitted {
            let key = job.demand.key.clone();
            self.refused.insert(key, true);
            self.phase(GraphicsPhase::Refused, id);
            self.cancel(id, false);
            return;
        }
        self.next_request = request;
        let frame = request_frame(&job.demand, request, range);
        if let Some(job) = self.job(id) {
            job.request = Some(request);
        }
        self.phase(GraphicsPhase::Requested, id);
        self.out.push(Out::Control(frame));
    }

    /// Stop a job: ask the daemon to drop its live request, and forget it.
    fn cancel(&mut self, id: u64, native_retired: bool) {
        let Some(index) = self.jobs.iter().position(|job| job.id == id) else {
            return;
        };
        let job = self.jobs.swap_remove(index);
        self.phase(GraphicsPhase::Cancelled, id);
        if let Some(request) = job.request {
            self.requests.cancel(request);
        }
        if !native_retired && let Some(request) = job.request.or(job.cancelling) {
            self.cancellations.insert(request);
            self.out.push(Out::Control(cancel_frame(request)));
        }
        self.sized_phase(GraphicsPhase::Retired, id, 0, true);
    }

    /// The live request's carrier is gone: cancel it, and resume from what is
    /// held once the daemon answers the cancel.
    fn recover(&mut self, id: u64) {
        let Some(job) = self.job(id) else {
            return;
        };
        let Some(request) = job.request.take() else {
            return;
        };
        job.cancelling = Some(request);
        job.receiving = false;
        if job.descriptor.is_none() {
            job.held = 0;
        }
        self.requests.cancel(request);
        self.phase(GraphicsPhase::Interrupted, id);
        self.out.push(Out::Control(cancel_frame(request)));
    }

    /// The daemon's answer to a request it could not serve, or to a cancel.
    pub(super) fn unavailable(&mut self, request: u64, ready: bool) {
        if self.cancellations.remove(&request) {
            return self.pump(ready);
        }
        if let Some(job) = self
            .jobs
            .iter_mut()
            .find(|job| job.cancelling == Some(request))
        {
            job.cancelling = None;
            let id = job.id;
            self.phase(GraphicsPhase::Resumed, id);
            return self.request(id);
        }
        let Some(job) = self.jobs.iter().find(|job| job.request == Some(request)) else {
            return;
        };
        let (id, key) = (job.id, job.demand.key.clone());
        self.refused.insert(key, false);
        self.phase(GraphicsPhase::Unavailable, id);
        self.cancel(id, true);
        self.pump(ready);
    }

    /// A carrier that may have held requests, cancels or answers retired:
    /// everything still awaiting the daemon is asked again.
    pub(super) fn interrupt(&mut self, ready: bool) {
        let cancels: Vec<u64> = self.cancellations.iter().copied().collect();
        for request in cancels {
            self.out.push(Out::Control(cancel_frame(request)));
        }
        let asking: Vec<(u64, Option<u64>, bool)> = self
            .jobs
            .iter()
            .map(|job| {
                (
                    job.id,
                    job.cancelling,
                    job.request.is_some() && !job.receiving,
                )
            })
            .collect();
        for (id, cancelling, unanswered) in asking {
            if let Some(request) = cancelling {
                self.out.push(Out::Control(cancel_frame(request)));
            } else if unanswered {
                self.recover(id);
            }
        }
        self.readmit(ready);
    }

    /// A carrier became available: refusals it may have caused are retried.
    pub(super) fn readmit(&mut self, ready: bool) {
        self.refused.retain(|_, invalid| *invalid);
        self.pump(ready);
    }

    /// A new authenticated key epoch: nothing asked under the last can be
    /// answered, and the viewer states its scene again.
    pub(super) fn restart(&mut self) {
        let ids: Vec<u64> = self.jobs.iter().map(|job| job.id).collect();
        for id in ids {
            self.cancel(id, false);
        }
        self.cancellations.clear();
        self.resident.clear();
        self.refused.clear();
        self.desired.clear();
        self.streams.clear();
        self.requests = ContentRequests::default();
    }

    /// One part of the finite stream `stream` on attachment `conn`.
    pub(super) fn on_finite(
        &mut self,
        transport: &mut NoiseTransport,
        conn: u64,
        stream: u64,
        part: FinitePart<'_>,
        ready: bool,
    ) {
        let key = (conn, stream);
        match part {
            FinitePart::Begin { channel, total } => {
                let total = total as usize;
                let admitted = channel == CONTENT_STREAM
                    && total > CONTENT_HEADER_BYTES + CONTENT_CHUNK_OVERHEAD
                    && total <= MAX_WIRE_BYTES
                    && self.streams.len() < MAX_JOBS;
                // A stream that is not admitted is not kept: its data and its
                // end find no entry, so the table holds at most `MAX_JOBS`.
                if !admitted {
                    self.streams.remove(&key);
                    return;
                }
                self.streams.insert(
                    key,
                    Stream {
                        total,
                        received: 0,
                        header: Vec::with_capacity(CONTENT_HEADER_BYTES),
                        receiver: None,
                        request: 0,
                        first: 0,
                        count: 0,
                        object_bytes: 0,
                        ordinal: 0,
                        record: Vec::new(),
                        failed: false,
                    },
                );
            }
            FinitePart::Data(bytes) => {
                let Some(mut state) = self.streams.remove(&key) else {
                    return;
                };
                if !state.failed && self.push(transport, &mut state, bytes).is_err() {
                    state.failed = true;
                    state.receiver = None;
                    self.abort(state.request, false, ready);
                }
                self.streams.insert(key, state);
            }
            FinitePart::End { complete } => {
                let Some(state) = self.streams.remove(&key) else {
                    return;
                };
                if state.failed {
                    return;
                }
                if !complete {
                    return self.abort(state.request, true, ready);
                }
                if state.received != state.total
                    || state.request == 0
                    || state.ordinal != state.count
                {
                    return self.abort(state.request, false, ready);
                }
                self.finish(state.request, ready);
            }
        }
    }

    fn push(
        &mut self,
        transport: &mut NoiseTransport,
        state: &mut Stream,
        bytes: &[u8],
    ) -> Result<(), ()> {
        if state.received + bytes.len() > state.total {
            return Err(());
        }
        state.received += bytes.len();
        let mut rest = bytes;
        if state.header.len() < CONTENT_HEADER_BYTES {
            let take = (CONTENT_HEADER_BYTES - state.header.len()).min(rest.len());
            state.header.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if state.header.len() < CONTENT_HEADER_BYTES {
                return Ok(());
            }
            let receiver = transport
                .content_receiver(&mut self.requests, &state.header)
                .map_err(|_| ())?;
            let descriptor = receiver.descriptor();
            let object_bytes = descriptor.object_bytes() as usize;
            let (first, count) = (descriptor.first(), descriptor.count());
            let end = ((first + count) as usize * CONTENT_CHUNK_BYTES).min(object_bytes);
            // The authenticated header has spent its request by now, so the
            // stream names that request before anything below can refuse it:
            // the refusal then ends the job that waits on the request.
            state.request = descriptor.request();
            if object_bytes > TILE_ENCODED_BYTES
                || state.total
                    != CONTENT_HEADER_BYTES + end + count as usize * CONTENT_CHUNK_OVERHEAD
                        - first as usize * CONTENT_CHUNK_BYTES
            {
                return Err(());
            }
            self.admit(descriptor)?;
            state.receiver = Some(receiver);
            state.first = first;
            state.count = count;
            state.object_bytes = object_bytes;
        }
        let Some(receiver) = state.receiver.as_mut() else {
            return Err(());
        };
        let mut plaintext = vec![0; CONTENT_CHUNK_BYTES + 16];
        while !rest.is_empty() {
            if state.ordinal >= state.count {
                return Err(());
            }
            let offset = (state.first + state.ordinal) as usize * CONTENT_CHUNK_BYTES;
            let length = CONTENT_CHUNK_BYTES.min(state.object_bytes - offset);
            let record = length + CONTENT_CHUNK_OVERHEAD;
            let take = (record - state.record.len()).min(rest.len());
            state.record.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if state.record.len() < record {
                continue;
            }
            // Ordered: a repeat or a hole cannot stand in for the range asked.
            let ordinal = u32::from_be_bytes(state.record[..4].try_into().expect("four bytes"));
            let opened = receiver.open_chunk(&state.record, &mut plaintext);
            if ordinal != state.ordinal || opened.map(|chunk| chunk.len) != Ok(length) {
                return Err(());
            }
            let request = state.request;
            let job = self
                .jobs
                .iter_mut()
                .find(|job| job.request == Some(request) && job.receiving)
                .ok_or(())?;
            job.object[offset..offset + length].copy_from_slice(&plaintext[..length]);
            if offset <= job.held {
                job.held = job.held.max(offset + length);
            }
            state.ordinal += 1;
            state.record.clear();
        }
        Ok(())
    }

    /// The authenticated descriptor names a request a job is waiting on.
    fn admit(&mut self, descriptor: ContentDescriptor) -> Result<(), ()> {
        let request = descriptor.request();
        let job = self
            .jobs
            .iter_mut()
            .find(|job| job.request == Some(request) && !job.receiving)
            .ok_or(())?;
        job.receiving = true;
        match job.descriptor {
            None => {
                job.descriptor = Some(descriptor);
                job.object = vec![0; descriptor.object_bytes() as usize];
            }
            // A resume is exactly the rest of the object asked for.
            Some(known) if known.object() != descriptor.object() => return Err(()),
            Some(_) => {}
        }
        let id = job.id;
        self.phase(GraphicsPhase::FirstByte, id);
        Ok(())
    }

    fn abort(&mut self, request: u64, recoverable: bool, ready: bool) {
        let Some(job) = self
            .jobs
            .iter()
            .find(|job| request != 0 && job.request == Some(request))
        else {
            return;
        };
        let (id, key, receiving) = (job.id, job.demand.key.clone(), job.receiving);
        if recoverable && receiving {
            return self.recover(id);
        }
        self.refused.insert(key, true);
        self.phase(GraphicsPhase::Refused, id);
        self.cancel(id, false);
        self.pump(ready);
    }

    /// The whole object arrived: verify it, then hand it over.
    fn finish(&mut self, request: u64, ready: bool) {
        let Some(index) = self
            .jobs
            .iter()
            .position(|job| job.request == Some(request) && job.receiving)
        else {
            return;
        };
        let (id, bytes) = (self.jobs[index].id, self.jobs[index].object.len() as u32);
        self.sized_phase(GraphicsPhase::Fin, id, bytes, false);
        let job = &self.jobs[index];
        let verified = job
            .descriptor
            .is_some_and(|descriptor| verify(&job.demand, descriptor, &job.object));
        if !verified || job.held != job.object.len() {
            let key = job.demand.key.clone();
            self.refused.insert(key, true);
            self.phase(GraphicsPhase::Refused, id);
            self.cancel(id, false);
            return self.pump(ready);
        }
        let job = self.jobs.swap_remove(index);
        self.resident.insert(job.demand.key.clone());
        self.out.push(Out::Asset {
            epoch: self.epoch,
            key: job.demand.key,
            asset: job.demand.asset,
            job: self.recorded.contains(&id).then_some(id),
            bytes: job.object,
        });
        self.phase(GraphicsPhase::Published, id);
        self.pump(ready);
    }
}

/// An encoded object is the one its descriptor names, in the shape its
/// demand expects: a tile's PNG envelope, or an animation's manifest.
fn verify(demand: &GraphicsDemand, descriptor: ContentDescriptor, object: &[u8]) -> bool {
    match demand.asset {
        GraphicsAsset::Tile => {
            let Some(shape) = TileShape::new(demand.width, demand.height) else {
                return false;
            };
            let mut verifier = TileVerifier::default();
            verifier.begin(object.len(), shape, *descriptor.object())
                && object
                    .chunks(merkur_graphics::tile::VERIFY_CHUNK_BYTES)
                    .all(|chunk| verifier.update(chunk))
                && verifier.finish()
        }
        GraphicsAsset::Animation => {
            let Some(charge) = Manifest::charge(MAX_FRAMES) else {
                return false;
            };
            Manifest::decode(object, &Budget::new(charge)).is_some_and(|manifest| {
                manifest.root() == *descriptor.object()
                    && manifest.width() == demand.width
                    && manifest.height() == demand.height
            })
        }
    }
}

/// `[asset][level][0 0][frame][x][y][request][source]`, and for a resume
/// `[object][bytes][first][count]`: `encodeGraphicsControl`.
fn request_frame(
    demand: &GraphicsDemand,
    request: u64,
    range: Option<([u8; 32], u32, u32, u32)>,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(100);
    payload.push(u8::from(demand.asset == GraphicsAsset::Animation));
    payload.push(demand.level);
    payload.extend_from_slice(&[0, 0]);
    payload.extend_from_slice(&demand.frame.to_be_bytes());
    payload.extend_from_slice(&demand.x.to_be_bytes());
    payload.extend_from_slice(&demand.y.to_be_bytes());
    payload.extend_from_slice(&request.to_be_bytes());
    payload.extend_from_slice(&demand.authority);
    if let Some((object, bytes, first, count)) = range {
        payload.extend_from_slice(&object);
        payload.extend_from_slice(&bytes.to_be_bytes());
        payload.extend_from_slice(&first.to_be_bytes());
        payload.extend_from_slice(&count.to_be_bytes());
    }
    encode_proto_frame(MSG_TYPE_GRAPHICS_REQUEST, &payload)
}

fn cancel_frame(request: u64) -> Vec<u8> {
    encode_proto_frame(MSG_TYPE_GRAPHICS_CANCEL, &request.to_be_bytes())
}

#[cfg(test)]
mod tests;
