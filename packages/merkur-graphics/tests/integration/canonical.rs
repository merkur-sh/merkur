use merkur_graphics::command::{Error, Key, Receiver};
use merkur_graphics::ingest::{CommandId, Ingest, Step};
use vte::ansi::{Handler, Processor};

struct Owner {
    receiver: Receiver,
    ingest: Ingest,
    job: Option<CommandId>,
    payload: Vec<u8>,
    replies: Vec<&'static str>,
    printed: String,
}

impl Default for Owner {
    fn default() -> Self {
        Self {
            receiver: Receiver::default(),
            ingest: Ingest::new(8192),
            job: None,
            payload: Vec::new(),
            replies: Vec::new(),
            printed: String::new(),
        }
    }
}

impl Handler for Owner {
    fn apc_start(&mut self) {
        self.receiver.start();
    }

    fn apc_put(&mut self, bytes: &[u8]) {
        self.receiver.push(bytes);
    }

    fn apc_end(&mut self, complete: bool) {
        match self.ingest.accept(self.receiver.finish(complete)) {
            Step::Data {
                id, last, encoded, ..
            } => {
                self.payload.extend_from_slice(encoded);
                if last {
                    self.job = Some(id);
                }
            }
            Step::Rejected { error, control }
                if error != Error::Cancelled && control.and_then(|c| c.quiet().ok()) != Some(2) =>
            {
                self.replies.push(error.response());
            }
            _ => {}
        }
    }

    fn semantic_pending(&self) -> bool {
        self.ingest.validation_pending()
    }

    fn identify_terminal(&mut self, _: Option<char>) {
        self.replies.push("DA");
    }

    fn input(&mut self, c: char) {
        self.printed.push(c);
    }
}

#[test]
fn canonical_query_waits_for_validation_in_and_out_of_synchronized_output() {
    for synchronized in [false, true] {
        let prefix = if synchronized {
            b"\x1b[?2026h".as_slice()
        } else {
            b""
        };
        let suffix = if synchronized {
            b"\x1b[?2026l".as_slice()
        } else {
            b""
        };
        let input = [
            prefix,
            b"before\x1b_Ga=q,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[cafter",
            suffix,
        ]
        .concat();
        for split in 0..=input.len() {
            let mut parser = Processor::<vte::ansi::StdSyncHandler>::new();
            let mut owner = Owner::default();
            let mut accepted = parser.advance(&mut owner, &input[..split]);
            accepted += parser.advance(&mut owner, &input[accepted..]);
            assert!(owner.ingest.validation_pending());
            assert!(owner.replies.is_empty());
            assert_eq!(owner.printed, "before");
            assert_eq!(owner.payload, b"AAAA");
            let id = owner.job.take().unwrap();
            // A failed decoder result releases the same semantic barrier but
            // must answer failure before subsequent terminal queries.
            owner.replies.push("EINVAL:invalid image");
            assert!(owner.ingest.finish_validation(id));
            assert_eq!(
                parser.advance(&mut owner, &input[accepted..]),
                input.len() - accepted
            );
            assert_eq!(owner.replies, ["EINVAL:invalid image", "DA"]);
            assert_eq!(owner.printed, "beforeafter");
        }
    }
}

#[test]
fn refused_medium_preserves_reply_identity_and_quiet_policy() {
    for quiet in *b"012" {
        let input = [
            b"\x1b_Ga=q,t=f,i=31,q=".as_slice(),
            &[quiet],
            b";L2V0Yy9wYXNzd2Q=\x1b\\\x1b[c",
        ]
        .concat();
        let mut parser = Processor::<vte::ansi::StdSyncHandler>::new();
        let mut owner = Owner::default();
        assert_eq!(parser.advance(&mut owner, &input), input.len());
        assert!(!owner.ingest.validation_pending());
        assert!(owner.payload.is_empty());
        if quiet == b'2' {
            assert_eq!(owner.replies, ["DA"]);
        } else {
            assert_eq!(owner.replies, [Error::UnsupportedMedium.response(), "DA"]);
        }
    }
    let mut receiver = Receiver::default();
    let mut ingest = Ingest::new(4);
    receiver.start();
    receiver.push(b"Gf=100,i=31,m=1,q=1;AAAA");
    ingest.accept(receiver.finish(true));
    receiver.start();
    receiver.push(b"Gm=0;BBBB");
    let Step::Rejected {
        error,
        control: Some(control),
    } = ingest.accept(receiver.finish(true))
    else {
        panic!()
    };
    assert_eq!(error, Error::UploadTooLarge);
    assert_eq!(control.get(Key::ImageId), Some(31));
    assert_eq!(control.quiet(), Ok(1));
}
