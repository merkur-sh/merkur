//! The account API, as the browser's `account-api.ts` speaks it.
//!
//! Sign-in runs OPAQUE against `/api/auth/start` and `/api/auth/login/finish`,
//! opens the user-root envelope with the export key, and has the root sign a
//! fresh delegation for this device. The root seed and the password never
//! outlive the call. The server answers with an access token and sets the
//! rotating `merkur_refresh` cookie, which [`RefreshCredential`] carries back
//! on `/api/auth/refresh`.

use std::sync::Arc;

use merkur_authorization::{
    DELEGATION_LIFETIME_MS, DELEGATION_SCOPES, DelegationCertificate, DelegationPayload,
    MlDsa87Signer, PUBLIC_KEY_BYTES, RevocationTarget, RootEnvelope, SigningKey, decode_exact,
    encode, root_key_commitment,
};
use merkur_client::auth::Delegation;
use merkur_client::issuance::{
    ISSUANCE_PATH, Issuance, IssuanceRequest, RENEWAL_PATH, RenewalCapability, RenewalRequest,
};
use merkur_client::{Entropy, uuid_v4};
use reqwest::header::{self, HeaderValue};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::opaque::{self, OpaqueError, SERVER_PUBLIC_KEY_BYTES};

pub mod devices;
pub mod management;

const REFRESH_COOKIE: &str = "merkur_refresh";

#[derive(Debug)]
pub enum AccountError {
    /// The username or the password is wrong; the server does not say which.
    WrongCredentials,
    /// The server refused the request with this status and error code.
    Refused {
        status: u16,
        code: String,
    },
    /// The request never completed.
    Unreachable(String),
    /// An answer this client cannot accept.
    Invalid(&'static str),
    Opaque(OpaqueError),
}

impl AccountError {
    /// Only a final authoritative refusal, after `authorized` attempted renewal,
    /// revokes session authority. HTTP availability failures remain recoverable.
    pub(crate) fn authorization_denied(&self) -> bool {
        matches!(
            self,
            Self::Refused {
                status: 401 | 403,
                ..
            }
        )
    }
}

impl From<reqwest::Error> for AccountError {
    fn from(error: reqwest::Error) -> Self {
        Self::Unreachable(error.to_string())
    }
}

/// What the server answers a sign-in or a refresh with.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountSession {
    pub access_token: String,
    pub user_id: String,
    pub delegation_id: String,
    pub delegation_expires_at: u64,
    pub server_time_ms: u64,
    /// True when this sign-in called off a scheduled erasure of the account.
    pub deletion_cancelled: bool,
}

/// The `merkur_refresh` cookie, exactly as the server set it.
pub struct RefreshCredential(Zeroizing<String>);

impl RefreshCredential {
    pub fn from_value(value: Zeroizing<String>) -> Self {
        Self(value)
    }

    pub fn value(&self) -> &str {
        &self.0
    }
}

pub struct SignedIn {
    pub session: AccountSession,
    pub delegation: Delegation,
    pub refresh: RefreshCredential,
}

/// An account root unlocked for one management action. The key is dropped and
/// wiped when that action ends; no delegation or account session is minted.
pub struct UnlockedRoot {
    pub key: SigningKey,
    pub public_key: Box<[u8; PUBLIC_KEY_BYTES]>,
    pub user_id: String,
    pub root_epoch: u64,
    pub origin: String,
}

/// A request the server refused with 401 is repeated once with a renewed
/// token, as the browser's `shouldRefreshSessionRequest` allows: any other
/// failure may have reached the server, and repeating it could act twice.
/// Renewals are serialized, and a request refused with a token another
/// request already replaced takes the replacement instead of spending the
/// rotating credential again.
/// Durable token custody supplied by a native host. Each renewal holds the
/// store's process-shared lock through rotation and durable publication.
pub trait CredentialSource: Send + Sync {
    fn current(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + '_>>;
    fn renewed<'a>(
        &'a self,
        account: &'a Account,
        refused: Arc<str>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + 'a>>;
}

/// Account tokens, either explicitly ephemeral for headless runs or supplied
/// by the native host's durable store. A refusal is refreshed once, never replayed
/// after any other failure. Stored credentials always use their store.
pub struct Credentials {
    user_id: String,
    delegation_id: String,
    tokens: CredentialTokens,
}

enum CredentialTokens {
    Ephemeral(tokio::sync::Mutex<Tokens>),
    Stored(Arc<dyn CredentialSource>),
}

struct Tokens {
    access_token: Arc<str>,
    refresh: RefreshCredential,
    /// Counts renewals: a refused token is still the current one while this
    /// has not moved since it was read.
    serial: u64,
}

impl Credentials {
    pub fn new(session: &AccountSession, refresh: RefreshCredential) -> Self {
        Self {
            user_id: session.user_id.clone(),
            delegation_id: session.delegation_id.clone(),
            tokens: CredentialTokens::Ephemeral(tokio::sync::Mutex::new(Tokens {
                access_token: Arc::from(session.access_token.as_str()),
                refresh,
                serial: 0,
            })),
        }
    }

    pub fn stored(session: &AccountSession, source: Arc<dyn CredentialSource>) -> Self {
        Self {
            user_id: session.user_id.clone(),
            delegation_id: session.delegation_id.clone(),
            tokens: CredentialTokens::Stored(source),
        }
    }

    async fn current(&self) -> Result<(Arc<str>, u64), AccountError> {
        let tokens = match &self.tokens {
            CredentialTokens::Stored(source) => {
                return source.current().await.map(|token| (token, 0));
            }
            CredentialTokens::Ephemeral(tokens) => tokens,
        };
        let tokens = tokens.lock().await;
        Ok((Arc::clone(&tokens.access_token), tokens.serial))
    }

    /// The token to repeat a request with, after the server refused the one
    /// read at `refused`.
    async fn renewed(
        &self,
        account: &Account,
        refused: u64,
        refused_token: Arc<str>,
    ) -> Result<Arc<str>, AccountError> {
        let tokens = match &self.tokens {
            CredentialTokens::Stored(source) => {
                return source.renewed(account, refused_token).await;
            }
            CredentialTokens::Ephemeral(tokens) => tokens,
        };
        let mut tokens = tokens.lock().await;
        if tokens.serial == refused {
            let (session, refresh) = account.refresh(&tokens.refresh).await?;
            // The browser's `resumeBrowserAccount`: the renewal answers for
            // this device's delegation, or for nothing it may use.
            if session.user_id != self.user_id || session.delegation_id != self.delegation_id {
                return Err(AccountError::Invalid("account session"));
            }
            tokens.access_token = Arc::from(session.access_token.as_str());
            tokens.refresh = refresh;
            tokens.serial += 1;
        }
        Ok(Arc::clone(&tokens.access_token))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthenticationStart {
    login: LoginStart,
    registration: RegistrationStart,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginStart {
    flow_id: String,
    user_id: String,
    login_response: String,
    root_public_key: String,
    root_envelope: RootEnvelope,
    root_epoch: u64,
    delegation_issued_at: u64,
    delegation_expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistrationStart {
    flow_id: String,
    user_id: String,
    registration_response: String,
    delegation_issued_at: u64,
    delegation_expires_at: u64,
}

impl AuthenticationStart {
    /// The browser's `parseAuthenticationStart`: one flow, one account, one
    /// delegation window, on both halves.
    fn is_valid(&self) -> bool {
        let (login, registration) = (&self.login, &self.registration);
        !login.flow_id.is_empty()
            && !login.user_id.is_empty()
            && !login.login_response.is_empty()
            && !registration.registration_response.is_empty()
            && login.root_epoch >= 1
            && login
                .delegation_expires_at
                .checked_sub(login.delegation_issued_at)
                == Some(DELEGATION_LIFETIME_MS)
            && login.flow_id == registration.flow_id
            && login.user_id == registration.user_id
            && login.delegation_issued_at == registration.delegation_issued_at
            && login.delegation_expires_at == registration.delegation_expires_at
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartBody<'a> {
    username: &'a str,
    start_login_request: &'a str,
    registration_request: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishBody<'a> {
    flow_id: &'a str,
    finish_login_request: &'a str,
    delegation_certificate: &'a DelegationCertificate,
    /// A browser reports whether it runs as an installed app; a terminal
    /// client never does.
    installed: bool,
}

#[derive(Clone)]
pub struct Account {
    http: reqwest::Client,
    origin: String,
    opaque_server_key: [u8; SERVER_PUBLIC_KEY_BYTES],
}

impl Account {
    /// `origin` is the account's canonical origin: OPAQUE, the root envelope
    /// and every delegation are bound to it.
    pub fn new(
        origin: &str,
        opaque_server_key: [u8; SERVER_PUBLIC_KEY_BYTES],
    ) -> Result<Self, AccountError> {
        // Another component may have installed ring first; either way ring is
        // the process provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
        merkur_authorization::require_origin(origin)
            .map_err(|_| AccountError::Invalid("account origin"))?;
        let mut client_headers = reqwest::header::HeaderMap::new();
        client_headers.insert(
            "merkur-client",
            reqwest::header::HeaderValue::from_static("tui"),
        );
        client_headers.insert(
            "merkur-client-platform",
            reqwest::header::HeaderValue::from_static(if cfg!(target_os = "macos") {
                "macOS"
            } else {
                "Linux"
            }),
        );
        let http = reqwest::Client::builder()
            .default_headers(client_headers)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("merkur-tui/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            http,
            origin: origin.to_string(),
            opaque_server_key,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Unlock the stored account's exact root using OPAQUE. Management cannot
    /// change the pinned user, epoch or root while asking for its password.
    pub async fn unlock_root(
        &self,
        username: &str,
        password: Zeroizing<String>,
        expected: &Delegation,
    ) -> Result<UnlockedRoot, AccountError> {
        if expected.server_origin != self.origin {
            return Err(AccountError::Invalid("root origin"));
        }
        let (login, _finished, root) = self.authenticate_root(username, password).await?;
        if login.user_id != expected.certificate.user_id
            || login.root_epoch != expected.certificate.root_epoch
            || *root.public_key != *expected.root_public_key
        {
            return Err(AccountError::Invalid("stored account root changed"));
        }
        Ok(root)
    }

    async fn authenticate_root(
        &self,
        username: &str,
        password: Zeroizing<String>,
    ) -> Result<(LoginStart, opaque::LoginFinish, UnlockedRoot), AccountError> {
        let started = opaque::start(password.as_bytes()).map_err(AccountError::Opaque)?;
        let (start, _): (AuthenticationStart, _) = self
            .post(
                "/api/auth/start",
                Some(json(&StartBody {
                    username,
                    start_login_request: &started.login_request,
                    registration_request: &started.registration_request,
                })?),
                None,
                None,
            )
            .await?;
        if !start.is_valid() {
            return Err(AccountError::Invalid("authentication start"));
        }
        let login = start.login;
        let Some(finished) = started
            .finish(
                password.as_bytes(),
                &login.login_response,
                &login.user_id,
                &self.origin,
                &self.opaque_server_key,
            )
            .map_err(AccountError::Opaque)?
        else {
            return Err(AccountError::WrongCredentials);
        };
        drop(password);

        let root_public_key: Box<[u8; PUBLIC_KEY_BYTES]> = Box::new(
            decode_exact(&login.root_public_key, "user-root public key")
                .map_err(|_| AccountError::Invalid("user-root public key"))?,
        );
        let root_seed = login
            .root_envelope
            .open(
                &finished.export_key,
                &login.user_id,
                &root_public_key,
                &self.origin,
            )
            .map_err(|_| AccountError::Invalid("user-root envelope"))?;
        let key = SigningKey::from_seed(&mut *Zeroizing::new(*root_seed))
            .map_err(|_| AccountError::Invalid("user-root seed"))?;
        drop(root_seed);

        let root = UnlockedRoot {
            key,
            public_key: root_public_key,
            user_id: login.user_id.clone(),
            root_epoch: login.root_epoch,
            origin: self.origin.clone(),
        };
        Ok((login, finished, root))
    }

    /// Signs in with `password` and mints this device's delegation to
    /// `delegate`, the public half of a key the caller's custody already holds.
    pub async fn sign_in(
        &self,
        username: &str,
        password: Zeroizing<String>,
        delegate: &[u8; PUBLIC_KEY_BYTES],
        entropy: &mut impl Entropy,
    ) -> Result<SignedIn, AccountError> {
        let (login, finished, root) = self.authenticate_root(username, password).await?;
        let opaque::LoginFinish {
            finish_request,
            export_key,
        } = finished;
        drop(export_key);
        let UnlockedRoot {
            key: root_key,
            public_key: root_public_key,
            ..
        } = root;

        let certificate = DelegationCertificate::create(
            DelegationPayload {
                user_id: login.user_id.clone(),
                root_key_commitment: root_key_commitment(&*root_public_key)
                    .map_err(|_| AccountError::Invalid("user-root public key"))?,
                delegation_id: uuid_v4(entropy),
                delegate_public_key: encode(delegate),
                scopes: DELEGATION_SCOPES
                    .iter()
                    .map(|scope| scope.to_string())
                    .collect(),
                server_origin: self.origin.clone(),
                root_epoch: login.root_epoch,
                issued_at: login.delegation_issued_at,
                expires_at: login.delegation_expires_at,
            },
            &root_key,
            entropy.array(),
        )
        .map_err(|_| AccountError::Invalid("delegation certificate"))?;
        drop(root_key);

        let (session, refresh): (AccountSession, _) = self
            .post(
                "/api/auth/login/finish",
                Some(json(&FinishBody {
                    flow_id: &login.flow_id,
                    finish_login_request: &finish_request,
                    delegation_certificate: &certificate,
                    installed: false,
                })?),
                None,
                None,
            )
            .await?;
        // The browser's `assertSessionMatchesCertificate`.
        if session.user_id != certificate.user_id
            || session.delegation_id != certificate.delegation_id
            || session.delegation_expires_at != certificate.expires_at
        {
            return Err(AccountError::Invalid("account session"));
        }
        let refresh = refresh.ok_or(AccountError::Invalid("refresh cookie"))?;
        Ok(SignedIn {
            session,
            delegation: Delegation {
                certificate,
                root_public_key,
                server_origin: self.origin.clone(),
            },
            refresh,
        })
    }

    /// Trades the refresh credential for a new access token and its rotated
    /// successor. The old credential is spent either way.
    pub async fn refresh(
        &self,
        credential: &RefreshCredential,
    ) -> Result<(AccountSession, RefreshCredential), AccountError> {
        let (session, refresh): (AccountSession, _) = self
            .post("/api/auth/refresh", None, None, Some(credential))
            .await?;
        Ok((
            session,
            refresh.ok_or(AccountError::Invalid("refresh cookie"))?,
        ))
    }

    /// `call` with the current access token, and once more with a renewed one
    /// when the server refused it with 401.
    pub async fn authorized<T, Call>(
        &self,
        credentials: &Credentials,
        call: impl Fn(Arc<str>) -> Call,
    ) -> Result<T, AccountError>
    where
        Call: Future<Output = Result<T, AccountError>>,
    {
        let (token, serial) = credentials.current().await?;
        match call(Arc::clone(&token)).await {
            Err(AccountError::Refused { status: 401, .. }) => {
                let token = credentials.renewed(self, serial, token).await?;
                call(token).await
            }
            result => result,
        }
    }

    /// Revoke this native client's delegation and its refresh-token family.
    /// The statement is signed by `delegate`, so it runs where a hardware
    /// key's signing time blocks nothing else; the account root is not needed.
    pub async fn logout(
        &self,
        delegation: &Delegation,
        delegate: &dyn MlDsa87Signer,
        refresh: &RefreshCredential,
        issued_at: u64,
        entropy: &mut impl Entropy,
    ) -> Result<(), AccountError> {
        let certificate = &delegation.certificate;
        if delegation.server_origin != self.origin {
            return Err(AccountError::Invalid("logout origin"));
        }
        let authorization = management::Revocation::create(
            delegation,
            delegate,
            vec![RevocationTarget {
                delegation_id: certificate.delegation_id.clone(),
                expires_at: certificate.expires_at,
            }],
            issued_at,
            entropy,
        )?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct OkResponse {
            ok: bool,
        }
        let (answer, _): (OkResponse, _) = self
            .post(
                "/api/auth/logout",
                Some(json(&authorization)?),
                None,
                Some(refresh),
            )
            .await?;
        if answer.ok {
            Ok(())
        } else {
            Err(AccountError::Invalid("logout response"))
        }
    }

    /// Asks the server for a session to the daemon `request` names.
    pub async fn request_issuance(
        &self,
        access_token: &str,
        request: &IssuanceRequest,
    ) -> Result<Box<Issuance>, AccountError> {
        let response = self
            .send(
                ISSUANCE_PATH,
                Some(json(request)?),
                Some(access_token),
                None,
            )
            .await?;
        let body = response.bytes().await?;
        Issuance::parse(&body)
            .map(Box::new)
            .ok_or(AccountError::Invalid("session issuance"))
    }

    /// Asks the server for a renewal capability bound to `request`'s intent.
    pub async fn request_renewal(
        &self,
        access_token: &str,
        request: &RenewalRequest,
    ) -> Result<RenewalCapability, AccountError> {
        let response = self
            .send(RENEWAL_PATH, Some(json(request)?), Some(access_token), None)
            .await?;
        let body = response.bytes().await?;
        RenewalCapability::parse(&body).ok_or(AccountError::Invalid("renewal capability"))
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &'static str,
        body: Option<Vec<u8>>,
        access_token: Option<&str>,
        refresh: Option<&RefreshCredential>,
    ) -> Result<(T, Option<RefreshCredential>), AccountError> {
        let response = self.send(path, body, access_token, refresh).await?;
        let rotated = refresh_cookie(response.headers());
        let body = response.bytes().await?;
        let value = serde_json::from_slice(&body).map_err(|_| AccountError::Invalid(path))?;
        Ok((value, rotated))
    }

    async fn send(
        &self,
        path: &str,
        body: Option<Vec<u8>>,
        access_token: Option<&str>,
        refresh: Option<&RefreshCredential>,
    ) -> Result<reqwest::Response, AccountError> {
        self.request(reqwest::Method::POST, path, body, access_token, refresh)
            .await
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
        access_token: Option<&str>,
        refresh: Option<&RefreshCredential>,
    ) -> Result<reqwest::Response, AccountError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.origin))
            .header(header::ACCEPT, "application/json")
            // A browser always names its origin; the cookie routes accept it.
            .header(header::ORIGIN, &self.origin);
        if let Some(body) = body {
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(body);
        }
        if let Some(token) = access_token {
            request = request.bearer_auth(token);
        }
        if let Some(credential) = refresh {
            let mut cookie =
                HeaderValue::from_str(&format!("{REFRESH_COOKIE}={}", credential.value()))
                    .map_err(|_| AccountError::Invalid("refresh cookie"))?;
            cookie.set_sensitive(true);
            request = request.header(header::COOKIE, cookie);
        }
        self.checked(request).await
    }

    async fn checked(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, AccountError> {
        let response = request.send().await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        #[derive(Deserialize)]
        struct Refusal {
            error: String,
        }
        let code = response
            .json::<Refusal>()
            .await
            .map(|refusal| refusal.error)
            .unwrap_or_else(|_| "request_failed".to_string());
        Err(AccountError::Refused {
            status: status.as_u16(),
            code,
        })
    }
}

fn json(body: &impl Serialize) -> Result<Vec<u8>, AccountError> {
    serde_json::to_vec(body).map_err(|_| AccountError::Invalid("request body"))
}

/// The `merkur_refresh` value from the response's `Set-Cookie` headers.
fn refresh_cookie(headers: &reqwest::header::HeaderMap) -> Option<RefreshCredential> {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|cookie| {
            let pair = cookie.split(';').next()?.trim();
            let value = pair.strip_prefix(REFRESH_COOKIE)?.strip_prefix('=')?;
            (!value.is_empty()).then(|| RefreshCredential(Zeroizing::new(value.to_string())))
        })
}

#[cfg(test)]
mod tests;
