//! The socket protocol between the application server and keyd.
//!
//! A frame is `u32le length || body`. A request body is `u8 op` and its fields;
//! a response body is `u8 status` and its fields. A variable field is
//! `u16le length || bytes`. Requests are answered in order on their connection.
//! `apps/server/src/services/keyd-protocol.ts` is the other side; the real-binary
//! test pins the two together.

/// Resource bound: the largest request (an auth start) is under 3 KiB and the
/// largest response (a capability signature) under 5 KiB.
pub const MAX_FRAME_BYTES: usize = 16 * 1024;

pub const OP_PUBLIC_KEYS: u8 = 1;
pub const OP_AUTH_START: u8 = 2;
pub const OP_REGISTRATION_RESPONSE: u8 = 3;
pub const OP_LOGIN_FINISH: u8 = 4;
pub const OP_SIGN_CAPABILITY: u8 = 5;
pub const OP_VAPID_JWT: u8 = 6;

pub const STATUS_OK: u8 = 0;
/// A field that does not decode, or a message OPAQUE refuses.
pub const STATUS_INVALID: u8 = 1;
/// The account's attempt budget is spent; a `u32le` retry-after in seconds follows.
pub const STATUS_EXHAUSTED: u8 = 2;
/// A capability whose times keyd will not sign.
pub const STATUS_REFUSED: u8 = 3;
/// This deployment holds no key for the operation (web push unconfigured).
pub const STATUS_UNAVAILABLE: u8 = 4;
/// keyd could not do what it should have: randomness or its attempt log failed.
pub const STATUS_INTERNAL: u8 = 5;

/// serenity's bound on either OPAQUE identifier, which keyd keeps.
const MAX_IDENTIFIER_BYTES: usize = 128;

pub enum Request<'a> {
    PublicKeys,
    AuthStart {
        user_id: &'a str,
        server_identity: &'a str,
        record: Option<&'a [u8]>,
        login_request: &'a [u8],
        registration_request: &'a [u8],
    },
    RegistrationResponse {
        user_id: &'a str,
        request: &'a [u8],
    },
    LoginFinish {
        user_id: &'a str,
        server_identity: &'a str,
        state: &'a [u8],
        finish: &'a [u8],
    },
    SignCapability {
        segment: &'a str,
    },
    VapidJwt {
        audience: &'a str,
        subject: &'a str,
    },
}

/// `None` for any body that is not exactly one well-formed request.
pub fn decode(body: &[u8]) -> Option<Request<'_>> {
    let (&op, rest) = body.split_first()?;
    let mut fields = Fields(rest);
    let request = match op {
        OP_PUBLIC_KEYS => Request::PublicKeys,
        OP_AUTH_START => {
            let user_id = fields.identifier()?;
            let server_identity = fields.identifier()?;
            let record = fields.bytes()?;
            Request::AuthStart {
                user_id,
                server_identity,
                record: (!record.is_empty()).then_some(record),
                login_request: fields.bytes()?,
                registration_request: fields.bytes()?,
            }
        }
        OP_REGISTRATION_RESPONSE => Request::RegistrationResponse {
            user_id: fields.identifier()?,
            request: fields.bytes()?,
        },
        OP_LOGIN_FINISH => Request::LoginFinish {
            user_id: fields.identifier()?,
            server_identity: fields.identifier()?,
            state: fields.bytes()?,
            finish: fields.bytes()?,
        },
        OP_SIGN_CAPABILITY => Request::SignCapability {
            segment: fields.text()?,
        },
        OP_VAPID_JWT => Request::VapidJwt {
            audience: fields.text()?,
            subject: fields.text()?,
        },
        _ => return None,
    };
    fields.0.is_empty().then_some(request)
}

struct Fields<'a>(&'a [u8]);

impl<'a> Fields<'a> {
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let (length, rest) = self.0.split_first_chunk::<2>()?;
        let length = usize::from(u16::from_le_bytes(*length));
        let (value, rest) = rest.split_at_checked(length)?;
        self.0 = rest;
        Some(value)
    }

    fn text(&mut self) -> Option<&'a str> {
        std::str::from_utf8(self.bytes()?).ok()
    }

    fn identifier(&mut self) -> Option<&'a str> {
        self.text()
            .filter(|value| !value.is_empty() && value.len() <= MAX_IDENTIFIER_BYTES)
    }
}

/// A response body under construction; `frame` prefixes its length.
pub struct Response(Vec<u8>);

impl Response {
    pub fn status(status: u8) -> Self {
        let mut body = Vec::with_capacity(64);
        body.extend_from_slice(&[0; 4]);
        body.push(status);
        Self(body)
    }

    pub fn bytes(mut self, value: &[u8]) -> Self {
        let length = u16::try_from(value.len()).expect("every response field fits a u16 length");
        self.0.extend_from_slice(&length.to_le_bytes());
        self.0.extend_from_slice(value);
        self
    }

    pub fn u8(mut self, value: u8) -> Self {
        self.0.push(value);
        self
    }

    pub fn u32(mut self, value: u32) -> Self {
        self.0.extend_from_slice(&value.to_le_bytes());
        self
    }

    pub fn u64(mut self, value: u64) -> Self {
        self.0.extend_from_slice(&value.to_le_bytes());
        self
    }

    pub fn frame(mut self) -> Vec<u8> {
        let length = u32::try_from(self.0.len() - 4).expect("a response is under 4 GiB");
        self.0[..4].copy_from_slice(&length.to_le_bytes());
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(value: &[u8]) -> Vec<u8> {
        let mut out = u16::try_from(value.len()).unwrap().to_le_bytes().to_vec();
        out.extend_from_slice(value);
        out
    }

    #[test]
    fn an_auth_start_decodes_with_an_absent_record() {
        let mut body = vec![OP_AUTH_START];
        for value in [
            b"user-1".as_slice(),
            b"https://merkur.example",
            b"",
            &[1; 96],
            &[2; 32],
        ] {
            body.extend(field(value));
        }
        let Some(Request::AuthStart {
            user_id,
            record,
            login_request,
            ..
        }) = decode(&body)
        else {
            panic!("an auth start");
        };
        assert_eq!(user_id, "user-1");
        assert!(record.is_none());
        assert_eq!(login_request, &[1; 96]);
    }

    #[test]
    fn trailing_bytes_truncation_and_unknown_ops_are_refused() {
        let mut body = vec![OP_SIGN_CAPABILITY];
        body.extend(field(b"segment"));
        assert!(decode(&body).is_some());
        body.push(0);
        assert!(decode(&body).is_none());
        assert!(decode(&[OP_SIGN_CAPABILITY, 9, 0, b'a']).is_none());
        assert!(decode(&[0xff]).is_none());
        assert!(decode(&[]).is_none());
    }

    #[test]
    fn an_identifier_must_be_present_and_bounded() {
        let mut empty = vec![OP_REGISTRATION_RESPONSE];
        empty.extend(field(b""));
        empty.extend(field(&[0; 32]));
        assert!(decode(&empty).is_none());
        let mut long = vec![OP_REGISTRATION_RESPONSE];
        long.extend(field(&[b'a'; MAX_IDENTIFIER_BYTES + 1]));
        long.extend(field(&[0; 32]));
        assert!(decode(&long).is_none());
    }

    #[test]
    fn a_response_frame_carries_its_body_length() {
        let frame = Response::status(STATUS_EXHAUSTED).u32(60).frame();
        assert_eq!(frame, [5, 0, 0, 0, STATUS_EXHAUSTED, 60, 0, 0, 0]);
    }
}
