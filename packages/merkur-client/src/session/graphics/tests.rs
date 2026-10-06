//! The asset client's transport half against a daemon that seals its answers
//! as the dataplane does, over a real Noise pair.

use merkur_e2e::{ContentDescriptor, NoiseHandshake, NoiseTransport};
use merkur_graphics::tile::object_root;
use merkur_wire::protocol::{
    MSG_TYPE_GRAPHICS_CANCEL, MSG_TYPE_GRAPHICS_REQUEST, decode_proto_frame,
};

use super::*;

fn noise_pair() -> (NoiseTransport, NoiseTransport) {
    let psk = [7u8; 32];
    let prologue = merkur_e2e::derive_prologue("session", "daemon", &[0x42; 64]);
    let (client_static, _) = merkur_e2e::generate_static_keypair().unwrap();
    let (daemon_static, _) = merkur_e2e::generate_static_keypair().unwrap();
    let mut client = NoiseHandshake::new_initiator(&client_static, &psk, &prologue).unwrap();
    let mut daemon = NoiseHandshake::new_responder(&daemon_static, &psk, &prologue).unwrap();
    daemon
        .read_message(&client.write_message(b"").unwrap())
        .unwrap();
    client
        .read_message(&daemon.write_message(b"").unwrap())
        .unwrap();
    daemon
        .read_message(&client.write_message(b"").unwrap())
        .unwrap();
    (
        client.into_transport().unwrap(),
        daemon.into_transport().unwrap(),
    )
}

/// A PNG envelope `TileVerifier` accepts for a `side`-square tile, with
/// `data` bytes of IDAT: verification is not decoding.
fn tile_png(side: u32, data: usize) -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend_from_slice(&side.to_be_bytes());
    png.extend_from_slice(&side.to_be_bytes());
    png.extend_from_slice(&[8, 6, 0, 0, 0]);
    png.extend_from_slice(&[0; 4]);
    png.extend_from_slice(&(data as u32).to_be_bytes());
    png.extend_from_slice(b"IDAT");
    png.extend((0..data).map(|index| index as u8));
    png.extend_from_slice(&[0; 4]);
    png.extend_from_slice(b"\0\0\0\0IEND\xae\x42\x60\x82");
    png
}

const SIDE: u32 = 258;
const AUTHORITY: [u8; 32] = [0x11; 32];

fn demand(key: &str) -> GraphicsDemand {
    GraphicsDemand {
        asset: GraphicsAsset::Tile,
        authority: AUTHORITY,
        frame: 0,
        key: key.to_string(),
        source: AUTHORITY,
        level: 0,
        x: 0,
        y: 0,
        width: SIDE,
        height: SIDE,
    }
}

/// The control frames in `out`, as `(type, payload)`.
fn controls(out: &[Out]) -> Vec<(u8, Vec<u8>)> {
    out.iter()
        .filter_map(|out| match out {
            Out::Control(frame) => {
                let (kind, payload) = decode_proto_frame(frame).expect("a frame");
                Some((kind, payload.to_vec()))
            }
            Out::Asset { .. } | Out::Phase { .. } => None,
        })
        .collect()
}

fn assets(out: &[Out]) -> Vec<(String, Vec<u8>)> {
    out.iter()
        .filter_map(|out| match out {
            Out::Asset { key, bytes, .. } => Some((key.clone(), bytes.clone())),
            Out::Control(_) | Out::Phase { .. } => None,
        })
        .collect()
}

/// The job transitions in `out`, as `(phase, job, bytes, failed)`.
fn phases(out: &[Out]) -> Vec<(GraphicsPhase, u64, u32, bool)> {
    out.iter()
        .filter_map(|out| match *out {
            Out::Phase {
                phase,
                job,
                bytes,
                failed,
            } => Some((phase, job, bytes, failed)),
            Out::Control(_) | Out::Asset { .. } => None,
        })
        .collect()
}

/// The request id and, for a resume, `(first, count)` of one request frame.
fn request(payload: &[u8]) -> (u64, Option<(u32, u32)>) {
    let id = u64::from_be_bytes(payload[16..24].try_into().unwrap());
    let range = (payload.len() == 100).then(|| {
        (
            u32::from_be_bytes(payload[92..96].try_into().unwrap()),
            u32::from_be_bytes(payload[96..100].try_into().unwrap()),
        )
    });
    (id, range)
}

/// The daemon's finite answer to `request` for chunks `first..first+count` of
/// `object`, as `[u32 total][header][records]` less the length prefix.
fn answer(
    daemon: &mut NoiseTransport,
    request: u64,
    object: &[u8],
    first: u32,
    count: u32,
) -> Vec<u8> {
    let descriptor = ContentDescriptor::new(
        request,
        AUTHORITY,
        object_root(object),
        object.len() as u32,
        first,
        count,
    )
    .unwrap();
    let mut sender = daemon.content_sender(descriptor).unwrap();
    let mut wire = sender.header().to_vec();
    let mut record = vec![0; CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD];
    for chunk in object[descriptor.range()].chunks(CONTENT_CHUNK_BYTES) {
        let n = sender.seal_next(chunk, &mut record).unwrap();
        wire.extend_from_slice(&record[..n]);
    }
    wire
}

/// Deliver `wire` as one stream, in `pieces` reads, ending cleanly or not.
fn deliver(
    graphics: &mut Graphics,
    client: &mut NoiseTransport,
    stream: u64,
    wire: &[u8],
    upto: usize,
    complete: bool,
) {
    graphics.on_finite(
        client,
        1,
        stream,
        FinitePart::Begin {
            channel: CONTENT_STREAM,
            total: wire.len() as u32,
        },
        true,
    );
    for piece in wire[..upto].chunks(5_000) {
        graphics.on_finite(client, 1, stream, FinitePart::Data(piece), true);
    }
    graphics.on_finite(client, 1, stream, FinitePart::End { complete }, true);
}

#[test]
fn a_demanded_tile_is_asked_for_once_and_handed_over_verified() {
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], true);
    let out = graphics.take_out();
    let [(MSG_TYPE_GRAPHICS_REQUEST, payload)] = &controls(&out)[..] else {
        panic!("one request");
    };
    assert_eq!(request(payload), (1, None));
    // Asked again while in flight: nothing new.
    graphics.replace(1, vec![demand("t")], true);
    assert!(graphics.take_out().is_empty());

    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    deliver(&mut graphics, &mut client, 7, &wire, wire.len(), true);
    assert_eq!(assets(&graphics.take_out()), [("t".to_string(), png)]);
    // Held: the same scene asks for nothing.
    graphics.replace(1, vec![demand("t")], true);
    assert!(graphics.take_out().is_empty());
}

#[test]
fn a_stream_cut_mid_transfer_resumes_from_what_is_held() {
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    // Two whole chunks arrive, then the carrier dies.
    let two = CONTENT_HEADER_BYTES + 2 * (CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD);
    deliver(&mut graphics, &mut client, 7, &wire, two, false);
    assert_eq!(
        controls(&graphics.take_out()),
        [(MSG_TYPE_GRAPHICS_CANCEL, 1u64.to_be_bytes().to_vec())]
    );
    // The daemon's answer to that cancel resumes exactly the rest.
    graphics.unavailable(1, true);
    let out = graphics.take_out();
    let [(MSG_TYPE_GRAPHICS_REQUEST, payload)] = &controls(&out)[..] else {
        panic!("the resume");
    };
    assert_eq!(request(payload), (2, Some((2, 1))));
    let rest = answer(&mut daemon, 2, &png, 2, 1);
    deliver(&mut graphics, &mut client, 8, &rest, rest.len(), true);
    assert_eq!(assets(&graphics.take_out()), [("t".to_string(), png)]);
}

#[test]
fn an_object_that_does_not_verify_is_refused_until_the_scene_changes() {
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    // A tile of another shape than the demand's.
    let wrong = tile_png(130, 1_000);
    let wire = answer(&mut daemon, 1, &wrong, 0, 1);
    deliver(&mut graphics, &mut client, 7, &wire, wire.len(), true);
    let out = graphics.take_out();
    assert!(assets(&out).is_empty());
    assert_eq!(
        controls(&out),
        [(MSG_TYPE_GRAPHICS_CANCEL, 1u64.to_be_bytes().to_vec())]
    );
    // A carrier event does not retry the object's own fault; a new scene does.
    graphics.readmit(true);
    assert!(controls(&graphics.take_out()).is_empty());
    graphics.replace(2, vec![demand("t")], true);
    assert_eq!(controls(&graphics.take_out()).len(), 1);
}

#[test]
fn an_unavailable_request_is_retried_when_a_carrier_changes() {
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    graphics.unavailable(1, true);
    assert!(graphics.take_out().is_empty(), "refused, not asked again");
    graphics.readmit(true);
    let out = graphics.take_out();
    let [(MSG_TYPE_GRAPHICS_REQUEST, payload)] = &controls(&out)[..] else {
        panic!("asked again");
    };
    assert_eq!(request(payload), (2, None));
}

#[test]
fn a_changed_demand_cancels_its_job_and_nothing_is_asked_before_ready() {
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], false);
    assert!(graphics.take_out().is_empty());
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    graphics.replace(
        1,
        vec![GraphicsDemand {
            frame: 1,
            ..demand("t")
        }],
        true,
    );
    let out = controls(&graphics.take_out());
    assert_eq!(
        out[0],
        (MSG_TYPE_GRAPHICS_CANCEL, 1u64.to_be_bytes().to_vec())
    );
    assert_eq!(out[1].0, MSG_TYPE_GRAPHICS_REQUEST);
    assert_eq!(request(&out[1].1), (2, None));
}

#[test]
fn a_stream_for_no_request_is_refused_whole() {
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    // The daemon answers a request this client never made.
    let png = tile_png(SIDE, 1_000);
    let wire = answer(&mut daemon, 9, &png, 0, 1);
    deliver(&mut graphics, &mut client, 7, &wire, wire.len(), true);
    assert!(graphics.take_out().is_empty());
}

#[test]
fn a_recording_host_is_told_each_transition_of_a_delivered_job_once() {
    use GraphicsPhase::*;
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.observe(true);
    graphics.replace(1, vec![demand("t")], true);
    assert_eq!(
        phases(&graphics.take_out()),
        [(Demanded, 1, 0, false), (Requested, 1, 0, false)]
    );
    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    deliver(&mut graphics, &mut client, 7, &wire, wire.len(), true);
    let out = graphics.take_out();
    // The job leaves the session at `Published`; its host retires it.
    assert_eq!(
        phases(&out),
        [
            (FirstByte, 1, 0, false),
            (Fin, 1, png.len() as u32, false),
            (Published, 1, 0, false)
        ]
    );
    assert!(matches!(
        out.iter().find(|out| matches!(out, Out::Asset { .. })),
        Some(Out::Asset { job: Some(1), .. })
    ));
}

#[test]
fn a_job_is_reported_whole_or_not_at_all() {
    use GraphicsPhase::*;
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    // Demanded before the host records: told to nobody, to its end.
    graphics.replace(1, vec![demand("t")], true);
    graphics.observe(true);
    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    deliver(&mut graphics, &mut client, 7, &wire, wire.len(), true);
    let out = graphics.take_out();
    assert!(phases(&out).is_empty());
    assert!(matches!(
        out.iter().find(|out| matches!(out, Out::Asset { .. })),
        Some(Out::Asset { job: None, .. })
    ));

    // Demanded while it records: told to its end, though the host stops.
    graphics.replace(2, vec![demand("u")], true);
    graphics.observe(false);
    graphics.replace(3, vec![demand("v")], true);
    assert_eq!(
        phases(&graphics.take_out()),
        [
            (Demanded, 2, 0, false),
            (Requested, 2, 0, false),
            (Cancelled, 2, 0, false),
            (Retired, 2, 0, true)
        ]
    );
}

#[test]
fn a_recording_host_is_told_how_a_job_was_interrupted_resumed_or_refused() {
    use GraphicsPhase::*;
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.observe(true);
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    let two = CONTENT_HEADER_BYTES + 2 * (CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD);
    deliver(&mut graphics, &mut client, 7, &wire, two, false);
    assert_eq!(
        phases(&graphics.take_out()),
        [(FirstByte, 1, 0, false), (Interrupted, 1, 0, false)]
    );
    graphics.unavailable(1, true);
    assert_eq!(
        phases(&graphics.take_out()),
        [(Resumed, 1, 0, false), (Requested, 1, 0, false)]
    );
    let rest = answer(&mut daemon, 2, &png, 2, 1);
    deliver(&mut graphics, &mut client, 8, &rest, rest.len(), true);
    assert_eq!(
        phases(&graphics.take_out()),
        [
            (FirstByte, 1, 0, false),
            (Fin, 1, png.len() as u32, false),
            (Published, 1, 0, false)
        ]
    );

    // An object of another shape than its demand's ends its job without a tile.
    graphics.replace(2, vec![demand("u")], true);
    graphics.take_out();
    let wrong = tile_png(130, 1_000);
    let wire = answer(&mut daemon, 3, &wrong, 0, 1);
    deliver(&mut graphics, &mut client, 9, &wire, wire.len(), true);
    assert_eq!(
        phases(&graphics.take_out()),
        [
            (FirstByte, 2, 0, false),
            (Fin, 2, wrong.len() as u32, false),
            (Refused, 2, 0, false),
            (Cancelled, 2, 0, false),
            (Retired, 2, 0, true)
        ]
    );

    // So does a request the daemon cannot serve.
    graphics.replace(3, vec![demand("v")], true);
    graphics.take_out();
    graphics.unavailable(4, true);
    assert_eq!(
        phases(&graphics.take_out()),
        [
            (Unavailable, 3, 0, false),
            (Cancelled, 3, 0, false),
            (Retired, 3, 0, true)
        ]
    );
}

/// The stream's authenticated header has already spent the request when its
/// length is checked, so a stream of another length than the header implies
/// must end the job it answered. Left alone, the job would wait on a request
/// nothing can answer and hold one of the job slots until the scene changed.
#[test]
fn a_stream_of_the_wrong_length_ends_the_job_it_answered() {
    use GraphicsPhase::*;
    let (mut client, mut daemon) = noise_pair();
    let mut graphics = Graphics::default();
    graphics.observe(true);
    graphics.replace(1, vec![demand("t")], true);
    graphics.take_out();
    let png = tile_png(SIDE, 40_000);
    let wire = answer(&mut daemon, 1, &png, 0, 3);
    // One byte more than the header's object and range come to.
    graphics.on_finite(
        &mut client,
        1,
        7,
        FinitePart::Begin {
            channel: CONTENT_STREAM,
            total: wire.len() as u32 + 1,
        },
        true,
    );
    for piece in wire.chunks(5_000) {
        graphics.on_finite(&mut client, 1, 7, FinitePart::Data(piece), true);
    }
    graphics.on_finite(&mut client, 1, 7, FinitePart::End { complete: true }, true);

    let out = graphics.take_out();
    assert!(assets(&out).is_empty());
    assert_eq!(
        controls(&out),
        [(MSG_TYPE_GRAPHICS_CANCEL, 1u64.to_be_bytes().to_vec())]
    );
    assert_eq!(
        phases(&out),
        [
            (Refused, 1, 0, false),
            (Cancelled, 1, 0, false),
            (Retired, 1, 0, true)
        ]
    );
    assert!(graphics.jobs.is_empty(), "the job gave its slot back");
    assert!(graphics.streams.is_empty());
    // The stream's own fault, like an object that does not verify: a carrier
    // event does not retry it, a new scene does.
    graphics.readmit(true);
    assert!(controls(&graphics.take_out()).is_empty());
    graphics.replace(2, vec![demand("t")], true);
    assert_eq!(controls(&graphics.take_out()).len(), 1);
}

/// A stream is kept only when it is admitted. One refused at its `Begin`,
/// past the cap among them, takes no entry, so streams that never end cannot
/// grow the table past the job slots.
#[test]
fn streams_past_the_cap_or_refused_at_begin_are_not_kept() {
    let (mut client, _daemon) = noise_pair();
    let mut graphics = Graphics::default();
    let begin = |graphics: &mut Graphics, client: &mut NoiseTransport, stream: u64, total| {
        graphics.on_finite(
            client,
            1,
            stream,
            FinitePart::Begin {
                channel: CONTENT_STREAM,
                total,
            },
            true,
        );
    };
    let admissible = (CONTENT_HEADER_BYTES + CONTENT_CHUNK_OVERHEAD + 1) as u32;
    // Never admissible: nothing after the header, and past the wire bound.
    begin(&mut graphics, &mut client, 1, admissible - 1);
    begin(&mut graphics, &mut client, 2, MAX_WIRE_BYTES as u32 + 1);
    assert!(graphics.streams.is_empty());

    for stream in 0..MAX_JOBS as u64 * 3 {
        begin(&mut graphics, &mut client, 100 + stream, admissible);
        assert!(graphics.streams.len() <= MAX_JOBS);
    }
    assert_eq!(graphics.streams.len(), MAX_JOBS);
    // Data and an end for a stream that was not kept change nothing.
    let refused = 100 + MAX_JOBS as u64;
    graphics.on_finite(&mut client, 1, refused, FinitePart::Data(&[0; 16]), true);
    graphics.on_finite(
        &mut client,
        1,
        refused,
        FinitePart::End { complete: true },
        true,
    );
    assert_eq!(graphics.streams.len(), MAX_JOBS);
    // An ended stream gives its place to the next.
    graphics.on_finite(
        &mut client,
        1,
        100,
        FinitePart::End { complete: false },
        true,
    );
    begin(&mut graphics, &mut client, refused, admissible);
    assert_eq!(graphics.streams.len(), MAX_JOBS);
    assert!(graphics.take_out().is_empty());
}
