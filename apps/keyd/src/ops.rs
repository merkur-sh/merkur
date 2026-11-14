//! What keyd does with its keys. Each operation answers one request; none
//! returns key material.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use merkur_authorization::{SESSION_CAPABILITY_CONTEXT, parse_session_capability};
use opaque_ke::errors::ProtocolError;
use opaque_ke::{
    CredentialFinalization, CredentialRequest, Identifiers, RegistrationRequest, ServerLogin,
    ServerLoginParameters, ServerRegistration,
};
use p256::ecdsa::Signature;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use rand_core::OsRng;
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};

use crate::budget::{Admission, Budget};
use crate::keys::{Keys, Suite};
use crate::wire::{
    Request, Response, STATUS_EXHAUSTED, STATUS_INTERNAL, STATUS_INVALID, STATUS_OK,
    STATUS_REFUSED, STATUS_UNAVAILABLE,
};

/// How far a capability's issue time may sit from keyd's clock, either way:
/// the daemon's own skew allowance, so keyd signs only what is live now.
const CAPABILITY_CLOCK_SKEW_MS: u64 = merkur_authorization::CLOCK_SKEW_MS;
/// The daemon's bound on a whole token; the payload segment is under it.
const MAX_CAPABILITY_SEGMENT_BYTES: usize = 8 * 1024;
/// RFC 8292 caps a VAPID JWT at 24 hours; the server reuses one for most of this.
pub const VAPID_LIFETIME_SECS: u64 = 12 * 60 * 60;
const MAX_VAPID_SUBJECT_BYTES: usize = 512;

pub struct Service {
    keys: Keys,
    budget: Mutex<Budget>,
    rng: SystemRandom,
}

impl Service {
    pub fn new(keys: Keys, budget: Budget) -> Self {
        Self {
            keys,
            budget: Mutex::new(budget),
            rng: SystemRandom::new(),
        }
    }

    /// One framed response for one request body.
    pub fn handle(&self, body: &[u8]) -> Vec<u8> {
        let now_ms = now_ms();
        let response = match crate::wire::decode(body) {
            None => Response::status(STATUS_INVALID),
            Some(request) => self.answer(request, now_ms),
        };
        response.frame()
    }

    fn answer(&self, request: Request<'_>, now_ms: u64) -> Response {
        match request {
            Request::PublicKeys => Response::status(STATUS_OK)
                .bytes(&self.keys.opaque_public_key)
                .bytes(self.keys.capability.public_key())
                .bytes(
                    self.keys
                        .vapid
                        .as_ref()
                        .map_or(&[][..], |vapid| &vapid.public_key[..]),
                ),
            Request::AuthStart {
                user_id,
                server_identity,
                record,
                login_request,
                registration_request,
            } => self.auth_start(
                user_id,
                server_identity,
                record,
                login_request,
                registration_request,
                now_ms,
            ),
            Request::RegistrationResponse { user_id, request } => {
                self.registration_response(user_id, request, now_ms)
            }
            Request::LoginFinish {
                user_id,
                server_identity,
                state,
                finish,
            } => self.login_finish(user_id, server_identity, state, finish, now_ms),
            Request::SignCapability { segment } => self.sign_capability(segment, now_ms),
            Request::VapidJwt { audience, subject } => self.vapid_jwt(audience, subject, now_ms),
        }
    }

    /// Spends the account's attempt, or answers why not. Inputs are decoded
    /// before this, so a malformed request costs nothing and yields nothing.
    fn spend(&self, user_id: &str, now_ms: u64) -> Option<Response> {
        let mut budget = self
            .budget
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match budget.spend(user_id, now_ms) {
            Ok(Admission::Admitted) => None,
            Ok(Admission::Exhausted { retry_after_ms }) => Some(
                Response::status(STATUS_EXHAUSTED)
                    .u32(u32::try_from(retry_after_ms.div_ceil(1_000)).unwrap_or(u32::MAX)),
            ),
            Err(error) => {
                tracing::error!(%error, "keyd: attempt log write failed");
                Some(Response::status(STATUS_INTERNAL))
            }
        }
    }

    fn auth_start(
        &self,
        user_id: &str,
        server_identity: &str,
        record: Option<&[u8]>,
        login_request: &[u8],
        registration_request: &[u8],
        now_ms: u64,
    ) -> Response {
        let record = match record
            .map(ServerRegistration::<Suite>::deserialize)
            .transpose()
        {
            Ok(record) => record,
            Err(_) => return Response::status(STATUS_INVALID),
        };
        let (Ok(login_request), Ok(registration_request)) = (
            CredentialRequest::<Suite>::deserialize(login_request),
            RegistrationRequest::<Suite>::deserialize(registration_request),
        ) else {
            return Response::status(STATUS_INVALID);
        };
        if let Some(refusal) = self.spend(user_id, now_ms) {
            return refusal;
        }
        let login = ServerLogin::start(
            &mut OsRng,
            &self.keys.opaque,
            record,
            login_request,
            user_id.as_bytes(),
            parameters(user_id, server_identity),
        );
        let registration = ServerRegistration::<Suite>::start(
            &self.keys.opaque,
            registration_request,
            user_id.as_bytes(),
        );
        let (Ok(login), Ok(registration)) = (login, registration) else {
            return Response::status(STATUS_INVALID);
        };
        Response::status(STATUS_OK)
            .bytes(&login.state.serialize())
            .bytes(&login.message.serialize())
            .bytes(&registration.message.serialize())
    }

    fn registration_response(&self, user_id: &str, request: &[u8], now_ms: u64) -> Response {
        let Ok(request) = RegistrationRequest::<Suite>::deserialize(request) else {
            return Response::status(STATUS_INVALID);
        };
        if let Some(refusal) = self.spend(user_id, now_ms) {
            return refusal;
        }
        match ServerRegistration::<Suite>::start(&self.keys.opaque, request, user_id.as_bytes()) {
            Ok(started) => Response::status(STATUS_OK).bytes(&started.message.serialize()),
            Err(_) => Response::status(STATUS_INVALID),
        }
    }

    /// Answers whether the password was right; a right one hands the
    /// account's attempt back. Earning that takes knowing the password.
    fn login_finish(
        &self,
        user_id: &str,
        server_identity: &str,
        state: &[u8],
        finish: &[u8],
        now_ms: u64,
    ) -> Response {
        let (Ok(state), Ok(finish)) = (
            ServerLogin::<Suite>::deserialize(state),
            CredentialFinalization::<Suite>::deserialize(finish),
        ) else {
            return Response::status(STATUS_INVALID);
        };
        match state.finish(finish, parameters(user_id, server_identity)) {
            Ok(_) => {
                let mut budget = self
                    .budget
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if let Err(error) = budget.refund(user_id, now_ms) {
                    tracing::error!(%error, "keyd: attempt log write failed");
                    return Response::status(STATUS_INTERNAL);
                }
                Response::status(STATUS_OK).u8(1)
            }
            Err(ProtocolError::InvalidLoginError) => Response::status(STATUS_OK).u8(0),
            Err(_) => Response::status(STATUS_INVALID),
        }
    }

    /// Signs a capability that is live now. A taken-over server can still ask
    /// for one, but cannot bank them: each expires within five minutes of the
    /// moment keyd signed it.
    fn sign_capability(&self, segment: &str, now_ms: u64) -> Response {
        if segment.len() > MAX_CAPABILITY_SEGMENT_BYTES {
            return Response::status(STATUS_INVALID);
        }
        let Ok(capability) = parse_session_capability(segment) else {
            return Response::status(STATUS_INVALID);
        };
        let payload = &capability.payload;
        if payload.iat > now_ms.saturating_add(CAPABILITY_CLOCK_SKEW_MS)
            || payload.iat.saturating_add(CAPABILITY_CLOCK_SKEW_MS) < now_ms
            || payload.e <= now_ms
        {
            return Response::status(STATUS_REFUSED);
        }
        let mut randomness = [0u8; 32];
        if self.rng.fill(&mut randomness).is_err() {
            return Response::status(STATUS_INTERNAL);
        }
        match self.keys.capability.sign_with_context(
            SESSION_CAPABILITY_CONTEXT,
            segment.as_bytes(),
            randomness,
        ) {
            Ok(signature) => Response::status(STATUS_OK).bytes(&signature),
            Err(_) => Response::status(STATUS_INTERNAL),
        }
    }

    /// An RFC 8292 VAPID JWT for one push service, signed with ES256.
    fn vapid_jwt(&self, audience: &str, subject: &str, now_ms: u64) -> Response {
        let Some(vapid) = &self.keys.vapid else {
            return Response::status(STATUS_UNAVAILABLE);
        };
        if !audience.starts_with("https://")
            || merkur_authorization::require_origin(audience).is_err()
            || !valid_subject(subject)
        {
            return Response::status(STATUS_INVALID);
        }
        let expires_at = now_ms / 1_000 + VAPID_LIFETIME_SECS;
        let claims = serde_json::json!({ "aud": audience, "exp": expires_at, "sub": subject });
        let signing_input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let digest = digest::digest(&digest::SHA256, signing_input.as_bytes());
        let signature: Signature = match vapid.key.sign_prehash(digest.as_ref()) {
            Ok(signature) => signature,
            Err(_) => return Response::status(STATUS_INTERNAL),
        };
        let jwt = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        Response::status(STATUS_OK)
            .bytes(jwt.as_bytes())
            .u64(expires_at)
    }
}

fn parameters<'i>(
    user_id: &'i str,
    server_identity: &'i str,
) -> ServerLoginParameters<'static, 'i> {
    ServerLoginParameters {
        context: None,
        identifiers: Identifiers {
            client: Some(user_id.as_bytes()),
            server: Some(server_identity.as_bytes()),
        },
    }
}

/// A `mailto:` or `https:` contact, as the server's configuration admits it.
fn valid_subject(subject: &str) -> bool {
    (subject.starts_with("mailto:") || subject.starts_with("https://"))
        && subject.len() <= MAX_VAPID_SUBJECT_BYTES
        && !subject.chars().any(char::is_control)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{OP_SIGN_CAPABILITY, OP_VAPID_JWT};

    fn service(name: &str) -> (Service, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("merkur-keyd-ops-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::keys::testing::generate(&dir.join("keys")).unwrap();
        let keys = crate::keys::load(&dir.join("keys")).unwrap();
        let budget = Budget::open(&dir.join("budget.log"), now_ms()).unwrap();
        (Service::new(keys, budget), dir)
    }

    fn request(op: u8, fields: &[&[u8]]) -> Vec<u8> {
        let mut body = vec![op];
        for field in fields {
            body.extend_from_slice(&u16::try_from(field.len()).unwrap().to_le_bytes());
            body.extend_from_slice(field);
        }
        body
    }

    fn segment(iat: u64, e: u64) -> String {
        let hash = URL_SAFE_NO_PAD.encode([7u8; 64]);
        URL_SAFE_NO_PAD.encode(format!(
            r#"{{"u":"user-1","g":"del-1","b":"node-1","d":"daemon-1","s":"session-1","k":"{hash}","q":"{hash}","iat":{iat},"e":{e}}}"#
        ))
    }

    #[test]
    fn a_live_capability_is_signed_and_verifies_under_the_session_context() {
        let (service, dir) = service("capability");
        let now = now_ms();
        let segment = segment(now, now + 60_000);
        let frame = service.handle(&request(OP_SIGN_CAPABILITY, &[segment.as_bytes()]));
        assert_eq!(frame[4], STATUS_OK);
        let signature = &frame[7..];
        assert_eq!(signature.len(), merkur_authorization::SIGNATURE_BYTES);
        merkur_e2e::verify_ml_dsa87(
            service.keys.capability.public_key(),
            SESSION_CAPABILITY_CONTEXT,
            segment.as_bytes(),
            signature,
        )
        .unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Reads the variable fields of an OK response.
    fn fields(frame: &[u8]) -> Vec<Vec<u8>> {
        assert_eq!(frame[4], STATUS_OK, "status {}", frame[4]);
        let mut rest = &frame[5..];
        let mut out = Vec::new();
        while rest.len() >= 2 {
            let length = usize::from(u16::from_le_bytes([rest[0], rest[1]]));
            out.push(rest[2..2 + length].to_vec());
            rest = &rest[2 + length..];
        }
        out
    }

    #[test]
    fn a_registered_password_signs_in_and_hands_its_attempt_back() {
        use crate::wire::{OP_AUTH_START, OP_LOGIN_FINISH, OP_REGISTRATION_RESPONSE};
        use opaque_ke::{
            ClientLogin, ClientLoginFinishParameters, ClientRegistration,
            ClientRegistrationFinishParameters, CredentialResponse, RegistrationResponse,
        };
        let (service, dir) = service("opaque");
        let (user, origin) = ("user-1", "https://merkur.example");
        let identifiers = Identifiers {
            client: Some(user.as_bytes()),
            server: Some(origin.as_bytes()),
        };
        let client = ClientRegistration::<Suite>::start(&mut OsRng, b"correct horse").unwrap();
        let response = fields(&service.handle(&request(
            OP_REGISTRATION_RESPONSE,
            &[user.as_bytes(), &client.message.serialize()],
        )));
        let finished = client
            .state
            .finish(
                &mut OsRng,
                b"correct horse",
                RegistrationResponse::deserialize(&response[0]).unwrap(),
                ClientRegistrationFinishParameters::new(identifiers, None),
            )
            .unwrap();
        let record = finished.message.serialize();

        let sign_in = |password: &[u8]| {
            let login = ClientLogin::<Suite>::start(&mut OsRng, password).unwrap();
            let registration = ClientRegistration::<Suite>::start(&mut OsRng, password).unwrap();
            let started = fields(&service.handle(&request(
                OP_AUTH_START,
                &[
                    user.as_bytes(),
                    origin.as_bytes(),
                    &record,
                    &login.message.serialize(),
                    &registration.message.serialize(),
                ],
            )));
            let finish = login.state.finish(
                &mut OsRng,
                password,
                CredentialResponse::deserialize(&started[1]).unwrap(),
                ClientLoginFinishParameters::new(None, identifiers, None),
            );
            let Ok(finish) = finish else { return false };
            let answer = service.handle(&request(
                OP_LOGIN_FINISH,
                &[
                    user.as_bytes(),
                    origin.as_bytes(),
                    &started[0],
                    &finish.message.serialize(),
                ],
            ));
            assert_eq!(answer[4], STATUS_OK);
            answer[5] == 1
        };
        assert!(sign_in(b"correct horse"));
        assert!(!sign_in(b"battery staple"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_capability_issued_far_from_now_is_refused() {
        let (service, dir) = service("stale");
        let now = now_ms();
        for (iat, e) in [
            (now - 120_000, now - 60_000),
            (now + 120_000, now + 180_000),
            (now - 40_000, now + 200_000),
        ] {
            let frame = service.handle(&request(OP_SIGN_CAPABILITY, &[segment(iat, e).as_bytes()]));
            assert_eq!(frame[4], STATUS_REFUSED, "iat {iat} e {e}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_vapid_jwt_verifies_with_the_public_key() {
        use p256::ecdsa::VerifyingKey;
        use p256::ecdsa::signature::hazmat::PrehashVerifier;
        let (service, dir) = service("vapid");
        let frame = service.handle(&request(
            OP_VAPID_JWT,
            &[b"https://push.example", b"mailto:ops@merkur.example"],
        ));
        assert_eq!(frame[4], STATUS_OK);
        let length = usize::from(u16::from_le_bytes([frame[5], frame[6]]));
        let jwt = std::str::from_utf8(&frame[7..7 + length]).unwrap();
        let (signing_input, signature) = jwt.rsplit_once('.').unwrap();
        let claims: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(signing_input.split('.').nth(1).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(claims["aud"], "https://push.example");
        let public =
            VerifyingKey::from_sec1_bytes(&service.keys.vapid.as_ref().unwrap().public_key)
                .unwrap();
        let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
        public
            .verify_prehash(
                digest::digest(&digest::SHA256, signing_input.as_bytes()).as_ref(),
                &signature,
            )
            .unwrap();
        let refused = service.handle(&request(
            OP_VAPID_JWT,
            &[b"http://push.example", b"mailto:a@b"],
        ));
        assert_eq!(refused[4], STATUS_INVALID);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
