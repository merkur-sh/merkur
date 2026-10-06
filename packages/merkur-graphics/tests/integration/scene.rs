use merkur_graphics::budget::{Budget, Usage};
use merkur_graphics::command::{Chunk, Control, Received};
use merkur_graphics::ingest::{CommandId, Ingest, Step};
use merkur_graphics::publication::TerminalIncarnation;
use merkur_graphics::scene::{
    IMAGE_METADATA_BYTES, Image, Published, Scene, SceneContent, SceneError,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

struct TestImage {
    pixels: [u8; 4],
    retired: AtomicBool,
}

impl From<[u8; 4]> for TestImage {
    fn from(pixels: [u8; 4]) -> Self {
        Self {
            pixels,
            retired: AtomicBool::new(false),
        }
    }
}

impl SceneContent for TestImage {
    fn descriptor(&self) -> merkur_graphics::projection::Content {
        merkur_graphics::projection::Content {
            kind: merkur_graphics::projection::ContentKind::Image,
            root: *blake3::hash(&self.pixels).as_bytes(),
            width: 1,
            height: 1,
        }
    }
    fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }
}

fn command(ingest: &mut Ingest, header: &[u8]) -> (CommandId, Control) {
    let control = Control::parse(header).unwrap();
    let Step::Data { id, .. } = ingest.accept(Received::Chunk(Chunk {
        control,
        payload: b"AAAAAA==",
    })) else {
        panic!("data command")
    };
    assert!(ingest.finish_validation(id));
    (id, control)
}

fn publish(
    scene: &mut Scene<TestImage>,
    ingest: &mut Ingest,
    header: &[u8],
    pixels: [u8; 4],
) -> Arc<Image<TestImage>> {
    let (id, control) = command(ingest, header);
    let fence = scene.begin(id, &control).unwrap();
    let Published::Image { image, .. } = scene.publish(fence, pixels.into()).unwrap() else {
        panic!("image")
    };
    image
}

fn scene(objects: usize) -> (Scene<TestImage>, Ingest, Budget) {
    let budget = Budget::new(Usage {
        bytes: objects * (IMAGE_METADATA_BYTES + std::mem::size_of::<Image<TestImage>>()),
        objects,
    });
    (
        Scene::new(TerminalIncarnation([1; 16]), budget.clone()),
        Ingest::new(4096),
        budget,
    )
}

#[test]
fn replacement_is_atomic_and_captures_retain_the_old_immutable_revision() {
    let (mut scene, mut ingest, _) = scene(3);
    let old = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [1; 4]);
    let (id, control) = command(&mut ingest, b"i=7,s=1,v=1");
    let fence = scene.begin(id, &control).unwrap();
    assert_eq!(scene.resolve(&control), Ok(old.incarnation));
    assert_eq!(fence.predecessor, Some(old.revision));
    let Published::Image {
        image,
        replaced,
        retired,
    } = scene.publish(fence, [2; 4].into()).unwrap()
    else {
        panic!("image")
    };
    assert_eq!(replaced, Some(old.incarnation));
    // The caller learns which content the publication retired.
    assert!(Arc::ptr_eq(&retired.unwrap(), &old));
    assert_ne!(old.incarnation, image.incarnation);
    assert_ne!(old.revision, image.revision);
    assert_eq!(old.content.pixels, [1; 4]);
    assert_eq!(image.content.pixels, [2; 4]);
    assert_eq!(scene.resolve(&control), Ok(image.incarnation));
    assert!(matches!(
        scene.publish(fence, [3; 4].into()),
        Err(SceneError::Stale)
    ));
}

#[test]
fn frame_edits_keep_image_identity_and_number_order_but_revoke_old_asset_authority() {
    let (mut scene, mut ingest, budget) = scene(4);
    let older = publish(&mut scene, &mut ingest, b"I=7,s=1,v=1", [1; 4]);
    let newer = publish(&mut scene, &mut ingest, b"I=7,s=1,v=1", [2; 4]);
    let selector = Control::parse(b"I=7").unwrap();
    let (command, _) = command(&mut ingest, b"i=1,s=1,v=1");
    let fence = scene.begin_edit(command, older.incarnation).unwrap();
    assert_eq!(fence.predecessor, Some(older.revision));
    assert!(!older.content.retired.load(Ordering::Acquire));
    let Published::Image {
        image,
        replaced,
        retired,
    } = scene.publish(fence, [3; 4].into()).unwrap()
    else {
        panic!("image")
    };
    // An edit retires the revision it supersedes in place.
    assert!(Arc::ptr_eq(&retired.unwrap(), &older));
    assert_eq!(image.incarnation, older.incarnation);
    assert_eq!(image.client_id, older.client_id);
    assert_eq!(image.number, older.number);
    assert_ne!(image.revision, older.revision);
    assert_eq!(replaced, None);
    assert_eq!(scene.oldest(), Some(older.incarnation));
    assert_eq!(scene.resolve(&selector), Ok(newer.incarnation));
    assert!(older.content.retired.load(Ordering::Acquire));
    assert!(scene.source(&older.content.descriptor().root).is_none());
    assert_eq!(
        scene
            .source(&image.content.descriptor().root)
            .unwrap()
            .revision,
        image.revision
    );
    assert!(matches!(
        scene.publish(fence, [4; 4].into()),
        Err(SceneError::Stale)
    ));
    assert_eq!(budget.used().unwrap().objects, 3);
    drop(older);
    assert_eq!(budget.used().unwrap().objects, 2);
    scene.remove(newer.incarnation);
    assert_eq!(scene.resolve(&selector), Ok(image.incarnation));
}

#[test]
fn delayed_frame_edits_cannot_restore_deleted_reset_or_replaced_content() {
    for reset in [false, true] {
        let (mut scene, mut ingest, _) = scene(4);
        let image = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [1; 4]);
        let (id, _) = command(&mut ingest, b"i=7,s=1,v=1");
        let fence = scene.begin_edit(id, image.incarnation).unwrap();
        if reset {
            scene.clear();
        } else {
            scene.remove(image.incarnation);
        }
        let new = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [2; 4]);
        assert!(matches!(
            scene.publish(fence, [3; 4].into()),
            Err(SceneError::Stale)
        ));
        assert_eq!(scene.resolve_id(7), Some(new.incarnation));
        assert!(!new.content.retired.load(Ordering::Acquire));
    }
}

#[test]
fn numbers_select_newest_live_upload_and_anonymous_images_do_not_replace_each_other() {
    let (mut scene, mut ingest, _) = scene(6);
    let first = publish(&mut scene, &mut ingest, b"I=7,s=1,v=1", [1; 4]);
    let second = publish(&mut scene, &mut ingest, b"I=7,s=1,v=1", [2; 4]);
    let selector = Control::parse(b"I=7").unwrap();
    assert_ne!(first.client_id, second.client_id);
    assert_eq!(scene.resolve(&selector), Ok(second.incarnation));
    scene.remove(second.incarnation);
    assert_eq!(scene.resolve(&selector), Ok(first.incarnation));
    let anonymous = publish(&mut scene, &mut ingest, b"s=1,v=1", [3; 4]);
    let another = publish(&mut scene, &mut ingest, b"i=0,s=1,v=1", [4; 4]);
    assert_ne!(anonymous.incarnation, another.incarnation);
    assert_eq!(scene.len(), 3);
}

#[test]
fn query_neither_replaces_a_live_id_nor_consumes_image_quota() {
    let (mut scene, mut ingest, budget) = scene(1);
    let old = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [1; 4]);
    let before = budget.used();
    let (id, control) = command(&mut ingest, b"a=q,i=7,s=1,v=1");
    let fence = scene.begin(id, &control).unwrap();
    assert!(matches!(
        scene.publish(fence, [2; 4].into()),
        Ok(Published::Query)
    ));
    assert_eq!(budget.used(), before);
    assert_eq!(scene.resolve(&control), Ok(old.incarnation));
}

#[test]
fn cancellation_deletion_reset_and_retirement_fence_delayed_results() {
    let (mut scene, mut ingest, _) = scene(3);
    let old = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [1; 4]);
    let (id, control) = command(&mut ingest, b"i=7,s=1,v=1");
    let stale = scene.begin(id, &control).unwrap();
    scene.remove(old.incarnation);
    assert!(matches!(
        scene.publish(stale, [2; 4].into()),
        Err(SceneError::Stale)
    ));
    let (id, control) = command(&mut ingest, b"i=7,s=1,v=1");
    let pending = scene.begin(id, &control).unwrap();
    assert!(matches!(
        scene.publish(stale, [2; 4].into()),
        Err(SceneError::Stale)
    ));
    scene.clear();
    assert!(matches!(
        scene.publish(pending, [2; 4].into()),
        Err(SceneError::Stale)
    ));
    let new = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [3; 4]);
    assert!(new.incarnation > pending.image);
    scene.retire();
    let (id, control) = command(&mut ingest, b"i=7,s=1,v=1");
    assert!(scene.begin(id, &control).is_err());
}

#[test]
fn retained_capture_prevents_quota_reuse_after_namespace_deletion() {
    let (mut scene, mut ingest, budget) = scene(1);
    let capture = publish(&mut scene, &mut ingest, b"i=7,s=1,v=1", [1; 4]);
    let cleared = scene.clear();
    assert!(Arc::ptr_eq(&cleared[&capture.incarnation], &capture));
    drop(cleared);
    let (id, control) = command(&mut ingest, b"i=8,s=1,v=1");
    assert_eq!(scene.begin(id, &control), Err(SceneError::Quota));
    drop(capture);
    assert_eq!(
        budget.used(),
        Some(Usage {
            bytes: 0,
            objects: 0
        })
    );
    assert!(scene.begin(id, &control).is_ok());
}

#[test]
fn source_membership_is_terminal_local_and_retires_independently_of_captures() {
    let (mut owner, mut ingest, budget) = scene(6);
    let (other, _, _) = scene(1);
    let first = publish(&mut owner, &mut ingest, b"i=1,s=1,v=1", [1; 4]);
    let root = first.content.descriptor().root;
    assert!(other.source(&root).is_none());
    assert!(owner.source(&[0; 32]).is_none());
    assert!(Arc::ptr_eq(owner.source(&root).unwrap(), &first));
    let same = publish(&mut owner, &mut ingest, b"i=2,s=1,v=1", [1; 4]);
    assert!(Arc::ptr_eq(owner.source(&root).unwrap(), &same));
    owner.remove(same.incarnation);
    assert!(same.content.retired.load(Ordering::Acquire));
    assert!(!first.content.retired.load(Ordering::Acquire));
    assert!(Arc::ptr_eq(owner.source(&root).unwrap(), &first));
    let replacement = publish(&mut owner, &mut ingest, b"i=1,s=1,v=1", [2; 4]);
    assert!(first.content.retired.load(Ordering::Acquire));
    assert!(owner.source(&root).is_none());
    let replacement_root = replacement.content.descriptor().root;
    assert!(owner.source(&replacement_root).is_some());
    owner.clear();
    assert!(replacement.content.retired.load(Ordering::Acquire));
    assert!(owner.source(&replacement_root).is_none());
    // Readers retain storage, never namespace access, after reset.
    assert_eq!(budget.used().unwrap().objects, 3);
    assert_eq!(first.content.pixels, [1; 4]);
    let after_reset = publish(&mut owner, &mut ingest, b"i=1,s=1,v=1", [1; 4]);
    assert!(!after_reset.content.retired.load(Ordering::Acquire));
    assert!(first.content.retired.load(Ordering::Acquire));
    drop(owner);
    assert!(after_reset.content.retired.load(Ordering::Acquire));
    drop((first, same, replacement, after_reset));
    assert_eq!(budget.used().unwrap().objects, 0);
}

#[test]
fn queries_and_failed_publications_never_authorize_their_source() {
    let (mut owner, mut ingest, _) = scene(3);
    let root = TestImage::from([9; 4]).descriptor().root;
    let (id, control) = command(&mut ingest, b"a=q,i=9,s=1,v=1");
    let fence = owner.begin(id, &control).unwrap();
    assert!(matches!(
        owner.publish(fence, [9; 4].into()),
        Ok(Published::Query)
    ));
    assert!(owner.source(&root).is_none());
    assert!(owner.publish(fence, [9; 4].into()).is_err());
    assert!(owner.source(&root).is_none());
}

#[test]
fn image_metadata_is_refunded_before_its_content_is_released() {
    struct Probe(Budget);
    impl SceneContent for Probe {
        fn descriptor(&self) -> merkur_graphics::projection::Content {
            TestImage::from([5; 4]).descriptor()
        }
        fn retire(&self) {}
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            // A content release completion is the projector's signal that the
            // whole source, image metadata included, is back in the budget.
            assert_eq!(
                self.0.used(),
                Some(Usage {
                    bytes: 0,
                    objects: 0
                })
            );
        }
    }
    let budget = Budget::new(Usage {
        bytes: IMAGE_METADATA_BYTES + std::mem::size_of::<Image<Probe>>(),
        objects: 1,
    });
    let mut scene = Scene::new(TerminalIncarnation([1; 16]), budget.clone());
    let mut ingest = Ingest::new(4096);
    let (id, control) = command(&mut ingest, b"i=5,s=1,v=1");
    let fence = scene.begin(id, &control).unwrap();
    let Published::Image { image, .. } = scene.publish(fence, Probe(budget)).unwrap() else {
        panic!("image")
    };
    assert!(scene.remove(image.incarnation).is_some());
    drop(image);
}
