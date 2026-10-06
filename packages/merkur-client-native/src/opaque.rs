//! OPAQUE sign-in, byte for byte what `@serenity-kit/opaque` 1.1.0 does in the
//! browser: opaque-ke 4 over Ristretto255 with a triple Diffie-Hellman over
//! SHA-512, and Argon2id with Merkur's fixed policy (t = 6,
//! m = 64 MiB, p = 4, sixteen zero bytes of salt) as the key-stretching
//! function. An account registered in the browser signs in here with the same
//! password and yields the same export key.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use generic_array::{ArrayLength, GenericArray};
use opaque_ke::errors::{InternalError, ProtocolError};
use opaque_ke::ksf::Ksf;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration, CredentialResponse,
    Identifiers,
};
use rand_core::OsRng;
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

pub const EXPORT_KEY_BYTES: usize = 64;
pub const SERVER_PUBLIC_KEY_BYTES: usize = 32;
/// The server identifier is the origin, the client identifier the user id;
/// serenity refuses either past this length.
const MAX_IDENTIFIER_BYTES: usize = 128;

struct Suite;

impl CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = MemoryConstrained;
}

struct MemoryConstrained(Argon2<'static>);

impl Default for MemoryConstrained {
    fn default() -> Self {
        let params = Params::new(1 << 16, 6, 4, None).expect("fixed Argon2id parameters");
        Self(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

impl Ksf for MemoryConstrained {
    fn hash<L: ArrayLength<u8>>(
        &self,
        mut input: GenericArray<u8, L>,
    ) -> Result<GenericArray<u8, L>, InternalError> {
        let mut output = GenericArray::default();
        let mut memory = Zeroizing::new(vec![
            argon2::Block::default();
            self.0.params().block_count()
        ]);
        let result = self.0.hash_password_into_with_memory(
            &input,
            &[0; argon2::RECOMMENDED_SALT_LEN],
            &mut output,
            memory.as_mut_slice(),
        );
        input.zeroize();
        result.map_err(|_| InternalError::KsfError)?;
        Ok(output)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpaqueError {
    /// A message from the server that does not decode.
    Malformed,
    /// The server's static key is not the one this build pins.
    UnpinnedServer,
    Identifier,
}

/// The client half of one sign-in exchange.
pub struct LoginStart {
    state: ClientLogin<Suite>,
    pub login_request: String,
    /// The server answers a sign-in and a sign-up in one exchange, so nobody
    /// watching can tell whether an account exists. This client only signs in:
    /// its registration request is sent and never finished.
    pub registration_request: String,
}

pub struct LoginFinish {
    pub finish_request: String,
    pub export_key: Zeroizing<[u8; EXPORT_KEY_BYTES]>,
}

pub fn start(password: &[u8]) -> Result<LoginStart, OpaqueError> {
    let login =
        ClientLogin::<Suite>::start(&mut OsRng, password).map_err(|_| OpaqueError::Malformed)?;
    let registration = ClientRegistration::<Suite>::start(&mut OsRng, password)
        .map_err(|_| OpaqueError::Malformed)?;
    Ok(LoginStart {
        state: login.state,
        login_request: URL_SAFE_NO_PAD.encode(login.message.serialize()),
        registration_request: URL_SAFE_NO_PAD.encode(registration.message.serialize()),
    })
}

impl LoginStart {
    /// `None` when the password is wrong or no such account exists; the server
    /// answers both the same way.
    pub fn finish(
        self,
        password: &[u8],
        login_response: &str,
        user_id: &str,
        origin: &str,
        pinned_server_key: &[u8; SERVER_PUBLIC_KEY_BYTES],
    ) -> Result<Option<LoginFinish>, OpaqueError> {
        for identifier in [user_id, origin] {
            if identifier.is_empty() || identifier.len() > MAX_IDENTIFIER_BYTES {
                return Err(OpaqueError::Identifier);
            }
        }
        let response = URL_SAFE_NO_PAD
            .decode(login_response)
            .ok()
            .and_then(|bytes| CredentialResponse::<Suite>::deserialize(&bytes).ok())
            .ok_or(OpaqueError::Malformed)?;
        let ksf = MemoryConstrained::default();
        let parameters = ClientLoginFinishParameters::new(
            None,
            Identifiers {
                client: Some(user_id.as_bytes()),
                server: Some(origin.as_bytes()),
            },
            Some(&ksf),
        );
        let finished = match self
            .state
            .finish(&mut OsRng, password, response, parameters)
        {
            Ok(finished) => finished,
            Err(ProtocolError::InvalidLoginError) => return Ok(None),
            Err(_) => return Err(OpaqueError::Malformed),
        };
        if !bool::from(
            finished
                .server_s_pk
                .serialize()
                .as_slice()
                .ct_eq(pinned_server_key),
        ) {
            return Err(OpaqueError::UnpinnedServer);
        }
        let mut export_key = Zeroizing::new([0u8; EXPORT_KEY_BYTES]);
        export_key.copy_from_slice(&finished.export_key);
        Ok(Some(LoginFinish {
            finish_request: URL_SAFE_NO_PAD.encode(finished.message.serialize()),
            export_key,
        }))
    }
}

#[cfg(test)]
mod tests {
    use opaque_ke::{
        ClientRegistrationFinishParameters, CredentialRequest, RegistrationRequest, ServerLogin,
        ServerLoginParameters, ServerRegistration, ServerSetup,
    };

    use super::*;

    const USER_ID: &str = "user-1";
    const ORIGIN: &str = "https://merkur.example";

    /// An account registered the way the browser registers one, and the
    /// server's half of a sign-in to it.
    struct Server {
        setup: ServerSetup<Suite>,
        record: ServerRegistration<Suite>,
        export_key: Vec<u8>,
    }

    impl Server {
        fn register(password: &[u8]) -> Self {
            let setup = ServerSetup::<Suite>::new(&mut OsRng);
            let client = ClientRegistration::<Suite>::start(&mut OsRng, password).unwrap();
            let request = RegistrationRequest::deserialize(&client.message.serialize()).unwrap();
            let response = ServerRegistration::start(&setup, request, USER_ID.as_bytes()).unwrap();
            let ksf = MemoryConstrained::default();
            let finished = client
                .state
                .finish(
                    &mut OsRng,
                    password,
                    response.message,
                    ClientRegistrationFinishParameters::new(identifiers(), Some(&ksf)),
                )
                .unwrap();
            Self {
                setup,
                record: ServerRegistration::finish(finished.message),
                export_key: finished.export_key.to_vec(),
            }
        }

        fn public_key(&self) -> [u8; SERVER_PUBLIC_KEY_BYTES] {
            self.setup
                .keypair()
                .public()
                .serialize()
                .as_slice()
                .try_into()
                .unwrap()
        }

        fn answer(&self, login_request: &str) -> String {
            let request =
                CredentialRequest::deserialize(&URL_SAFE_NO_PAD.decode(login_request).unwrap())
                    .unwrap();
            let started = ServerLogin::start(
                &mut OsRng,
                &self.setup,
                Some(self.record.clone()),
                request,
                USER_ID.as_bytes(),
                ServerLoginParameters {
                    context: None,
                    identifiers: identifiers(),
                },
            )
            .unwrap();
            URL_SAFE_NO_PAD.encode(started.message.serialize())
        }
    }

    fn identifiers() -> Identifiers<'static> {
        Identifiers {
            client: Some(USER_ID.as_bytes()),
            server: Some(ORIGIN.as_bytes()),
        }
    }

    #[test]
    fn sign_in_recovers_the_export_key_registration_produced() {
        let server = Server::register(b"correct horse");
        let started = start(b"correct horse").unwrap();
        let answer = server.answer(&started.login_request);
        let finished = started
            .finish(
                b"correct horse",
                &answer,
                USER_ID,
                ORIGIN,
                &server.public_key(),
            )
            .unwrap()
            .expect("the right password signs in");
        assert_eq!(finished.export_key.as_slice(), server.export_key.as_slice());
        assert!(!finished.finish_request.is_empty());
    }

    #[test]
    fn native_sign_in_opens_a_browser_worker_registration() {
        // A declaring runner supplies the oracle as one executable; a source run has Bun
        // run the same script from the workspace root.
        let mut oracle = match std::env::var_os("MERKUR_BROWSER_REGISTRATION_ORACLE") {
            Some(executable) => std::process::Command::new(executable),
            None => {
                let mut bun = std::process::Command::new("bun");
                bun.current_dir(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap(),
                )
                .arg("packages/merkur-client-native/scripts/browser-registration-oracle.ts");
                bun
            }
        };
        let output = oracle
            .output()
            .expect("run the real browser registration worker in Bun");
        assert!(
            output.status.success(),
            "browser fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let fixture: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let decode = |field: &str| {
            URL_SAFE_NO_PAD
                .decode(fixture[field].as_str().unwrap())
                .unwrap()
        };
        let server = Server {
            setup: ServerSetup::deserialize(&decode("setup")).unwrap(),
            record: ServerRegistration::deserialize(&decode("record")).unwrap(),
            export_key: decode("exportKey"),
        };
        let started = start(b"correct horse").unwrap();
        let answer = server.answer(&started.login_request);
        let finished = started
            .finish(
                b"correct horse",
                &answer,
                USER_ID,
                ORIGIN,
                &server.public_key(),
            )
            .unwrap()
            .expect("native and browser use the same password stretching");
        assert_eq!(finished.export_key.as_slice(), server.export_key.as_slice());
    }

    #[test]
    fn a_wrong_password_is_no_account_not_an_error() {
        let server = Server::register(b"correct horse");
        let started = start(b"battery staple").unwrap();
        let answer = server.answer(&started.login_request);
        assert!(matches!(
            started.finish(
                b"battery staple",
                &answer,
                USER_ID,
                ORIGIN,
                &server.public_key()
            ),
            Ok(None)
        ));
    }

    #[test]
    fn a_server_key_other_than_the_pinned_one_is_refused() {
        let server = Server::register(b"correct horse");
        let started = start(b"correct horse").unwrap();
        let answer = server.answer(&started.login_request);
        assert!(matches!(
            started.finish(b"correct horse", &answer, USER_ID, ORIGIN, &[7; 32]),
            Err(OpaqueError::UnpinnedServer)
        ));
    }
}
