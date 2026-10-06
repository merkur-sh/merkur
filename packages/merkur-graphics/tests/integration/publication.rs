use core::num::NonZeroU64;

use merkur_graphics::command::{Chunk, Control, Received};
use merkur_graphics::ingest::{CommandId, Ingest, Step};
use merkur_graphics::publication::{
    ImageIncarnation, PublicationGate, Revision, TerminalIncarnation,
};

fn next(ingest: &mut Ingest) -> CommandId {
    let chunk = Chunk {
        control: Control::parse(b"f=100,i=1").unwrap(),
        payload: b"AAAA",
    };
    let Step::Data { id, .. } = ingest.accept(Received::Chunk(chunk)) else {
        panic!()
    };
    id
}

#[test]
fn every_fence_coordinate_is_required_and_success_consumes_right_once() {
    let terminal = TerminalIncarnation([7; 16]);
    let image = ImageIncarnation(NonZeroU64::new(11).unwrap());
    let revision = Some(Revision(NonZeroU64::new(3).unwrap()));
    let mut ingest = Ingest::new(4096);
    let mut gate = PublicationGate::new(terminal);
    let command = next(&mut ingest);
    let fence = gate.begin(command, image, revision).unwrap();
    let mut wrong = fence;
    wrong.terminal = TerminalIncarnation([8; 16]);
    assert!(!gate.accept(wrong, image, revision));
    wrong = fence;
    wrong.image = ImageIncarnation(NonZeroU64::new(12).unwrap());
    assert!(!gate.accept(wrong, image, revision));
    wrong = fence;
    wrong.predecessor = None;
    assert!(!gate.accept(wrong, image, revision));
    assert!(!gate.accept(fence, image, None));
    assert!(!gate.accept(
        fence,
        ImageIncarnation(NonZeroU64::new(12).unwrap()),
        revision
    ));
    assert!(gate.accept(fence, image, revision));
    assert!(!gate.accept(fence, image, revision));
    assert!(gate.begin(command, image, revision).is_err());
}

#[test]
fn late_completion_cannot_consume_successor_right_or_cross_retirement() {
    let image = ImageIncarnation(NonZeroU64::new(1).unwrap());
    let mut ingest = Ingest::new(4096);
    let mut gate = PublicationGate::new(TerminalIncarnation([1; 16]));
    let first = next(&mut ingest);
    let old = gate.begin(first, image, None).unwrap();
    gate.cancel();
    ingest.cancel();
    let second = next(&mut ingest);
    let new = gate.begin(second, image, None).unwrap();
    assert!(!gate.accept(old, image, None));
    let mut wrong = new;
    wrong.command = old.command;
    assert!(!gate.accept(wrong, image, None));
    assert!(gate.accept(new, image, None));
    ingest.cancel();
    let third = next(&mut ingest);
    let pending = gate.begin(third, image, None).unwrap();
    gate.retire();
    assert!(!gate.accept(pending, image, None));
    assert!(gate.begin(third, image, None).is_err());
}
