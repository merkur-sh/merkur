use merkur_graphics::boundary::Boundary;
use merkur_graphics::command::Error;
use merkur_graphics::ingest::Step;

#[test]
fn a_full_consumer_keeps_the_same_staging_buffer_and_final_barrier() {
    let mut boundary = Boundary::new(8192);
    boundary.start();
    boundary.push(b"Gf=24,s=2,v=1,i=17,m=1;AAAA");
    boundary.end(true);
    let Some(Step::Data {
        id,
        encoded,
        first: true,
        last: false,
        ..
    }) = boundary.pending()
    else {
        panic!()
    };
    let pointer = encoded.as_ptr();
    for _ in 0..100 {
        assert!(boundary.paused());
        let Some(Step::Data { encoded, .. }) = boundary.pending() else {
            panic!()
        };
        assert_eq!(encoded, b"AAAA");
        assert_eq!(encoded.as_ptr(), pointer);
    }
    assert!(boundary.acknowledge());
    assert!(!boundary.paused());
    boundary.start();
    boundary.push(b"Gm=0;BBBB");
    boundary.end(true);
    let Some(Step::Data {
        id: final_id,
        encoded,
        first: false,
        last: true,
        ..
    }) = boundary.pending()
    else {
        panic!()
    };
    assert_eq!(final_id, id);
    assert_eq!(encoded, b"BBBB");
    assert!(!boundary.finish_validation(id));
    assert!(boundary.acknowledge());
    assert!(boundary.paused());
    assert!(boundary.finish_validation(id));
    assert!(!boundary.paused());
    assert!(!boundary.finish_validation(id));
}

#[test]
fn unknown_apcs_never_hold_the_owner_and_reset_never_reuses_identity() {
    let mut boundary = Boundary::new(8192);
    boundary.start();
    boundary.push(b"other application");
    boundary.end(true);
    assert!(!boundary.paused());
    boundary.start();
    boundary.push(b"Ga=q,f=24,s=1,v=1,i=17;AAAA");
    boundary.end(true);
    let Some(Step::Data { id, .. }) = boundary.pending() else {
        panic!()
    };
    boundary.reset();
    assert!(!boundary.paused());
    assert!(!boundary.finish_validation(id));
    boundary.start();
    boundary.push(b"Ga=q,f=24,s=1,v=1,i=17;AAAA");
    boundary.end(true);
    let Some(Step::Data { id: successor, .. }) = boundary.pending() else {
        panic!()
    };
    assert!(successor.get() > id.get());
    boundary.acknowledge();
    assert!(!boundary.finish_validation(id));
    assert!(boundary.finish_validation(successor));
}

#[test]
fn cancellation_and_rejection_are_applied_before_the_next_command() {
    let mut boundary = Boundary::new(8192);
    for (input, complete, expected) in [
        (
            b"Ga=q,t=f,i=17;/private".as_slice(),
            true,
            Error::UnsupportedMedium,
        ),
        (b"Ga=q,f=24,s=1,v=1,i=17;AAAA", false, Error::Cancelled),
    ] {
        boundary.start();
        boundary.push(input);
        boundary.end(complete);
        assert!(boundary.paused());
        assert!(
            matches!(boundary.pending(), Some(Step::Rejected { error, .. }) if error == expected)
        );
        assert!(boundary.acknowledge());
        assert!(!boundary.paused());
    }
}
