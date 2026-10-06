use merkur_graphics::command::{Control, Error};
use merkur_graphics::reply::{Reply, ReplyError};

#[test]
fn identities_are_numeric_and_image_numbers_report_the_assigned_id() {
    let control = Control::parse(b"a=p,I=13,p=7").unwrap();
    assert_eq!(
        Reply::new(&control, Some(99), Ok(())).unwrap().as_bytes(),
        b"\x1b_Gi=99,I=13,p=7;OK\x1b\\"
    );
    let failure = Reply::new(&control, None, Err(ReplyError::MissingImage)).unwrap();
    assert_eq!(
        failure.as_bytes(),
        b"\x1b_GI=13,p=7;ENOENT:image or frame does not exist\x1b\\"
    );
}

#[test]
fn quiet_and_anonymous_commands_cannot_generate_unsolicited_replies() {
    for quiet in 0..=2 {
        let control = Control::parse(format!("i=1,q={quiet}").as_bytes()).unwrap();
        assert_eq!(Reply::new(&control, None, Ok(())).is_some(), quiet == 0);
        assert_eq!(
            Reply::new(&control, None, Err(ReplyError::Decode)).is_some(),
            quiet < 2
        );
    }
    let anonymous = Control::parse(b"p=123").unwrap();
    assert!(Reply::new(&anonymous, None, Ok(())).is_none());
    assert!(Reply::new(&anonymous, None, Err(ReplyError::Decode)).is_none());
    for command in [b"a=d,i=1".as_slice(), b"a=a,i=1"] {
        assert!(Reply::new(&Control::parse(command).unwrap(), None, Ok(())).is_none());
    }
    // Kitty acknowledges a completed frame composition like a transmission.
    assert_eq!(
        Reply::new(&Control::parse(b"a=c,i=1,r=2,c=1").unwrap(), None, Ok(()))
            .unwrap()
            .as_bytes(),
        b"\x1b_Gi=1;OK\x1b\\"
    );
}

#[test]
fn size_limits_answer_the_codes_kitty_answers() {
    // Kitty 0.48.2 answers data past its load buffer with EFBIG. It bounds no
    // header, and a value past its ten digits makes a malformed control.
    let control = Control::parse(b"i=7").unwrap();
    for (error, reply) in [
        (
            Error::ChunkTooLarge,
            b"\x1b_Gi=7;EFBIG:graphics data too large\x1b\\".as_slice(),
        ),
        (
            Error::UploadTooLarge,
            b"\x1b_Gi=7;EFBIG:graphics data too large\x1b\\",
        ),
        (
            Error::HeaderTooLarge,
            b"\x1b_Gi=7;EINVAL:invalid graphics command\x1b\\",
        ),
    ] {
        let answer = Reply::new(&control, None, Err(ReplyError::Protocol(error))).unwrap();
        assert_eq!(answer.as_bytes(), reply, "{error:?}");
    }
}

#[test]
fn maximal_control_fields_and_fixed_errors_fit_without_truncation() {
    let control =
        Control::parse(b"a=f,i=4294967295,I=4294967295,p=4294967295,r=4294967295").unwrap();
    for error in [
        ReplyError::MissingImage,
        ReplyError::MissingParent,
        ReplyError::Cycle,
        ReplyError::TooDeep,
        ReplyError::Quota,
        ReplyError::Decode,
        ReplyError::Truncated,
        ReplyError::Png,
        ReplyError::Worker,
        ReplyError::Protocol(Error::ValidationPending),
        ReplyError::Protocol(Error::IdentityExhausted),
        ReplyError::Protocol(Error::Cancelled),
        ReplyError::Protocol(Error::UnsupportedMedium),
        ReplyError::Protocol(Error::UploadTooLarge),
    ] {
        let reply = Reply::new(&control, None, Err(error)).unwrap();
        assert!(reply.as_bytes().len() <= 128);
        assert!(
            reply
                .as_bytes()
                .starts_with(b"\x1b_Gi=4294967295,I=4294967295,p=4294967295,r=4294967295;")
        );
        assert!(reply.as_bytes().ends_with(b"\x1b\\"));
        assert!(
            reply.as_bytes()[3..reply.as_bytes().len() - 2]
                .iter()
                .all(|byte| (32..=126).contains(byte))
        );
    }
}
