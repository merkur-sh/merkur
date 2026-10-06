//! Durable native account custody. One descriptor lock serializes all processes
//! through refresh rotation; a successor is durable before a request can use it.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use merkur_authorization::{
    DelegationCertificate, PUBLIC_KEY_BYTES, decode_exact, encode, root_key_commitment,
};
use merkur_client::auth::Delegation;
use merkur_client_native::account::{
    Account, AccountError, AccountSession, CredentialSource, RefreshCredential, SignedIn,
};
use merkur_identity_seal::{IdentitySealWire, KeyCustody, SealError};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

const STATE: &str = "account.json";
#[cfg(target_os = "macos")]
const SERVICE: &str = "com.merkur.tui.account";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub origin: String,
    pub username: String,
    pub opaque_server_key: String,
    pub root_public_key: String,
    pub certificate: DelegationCertificate,
    pub identity: IdentitySealWire,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    profile: Profile,
    // Only Linux stores this field, always authenticated ciphertext.
    #[cfg(not(target_os = "macos"))]
    tokens: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Tokens {
    access_token: String,
    refresh: String,
    user_id: String,
    delegation_id: String,
    delegation_expires_at: u64,
    server_time_ms: u64,
}
impl Drop for Tokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh.zeroize();
    }
}
impl Tokens {
    fn new(session: &AccountSession, refresh: &RefreshCredential) -> Self {
        Self {
            access_token: session.access_token.clone(),
            refresh: refresh.value().to_owned(),
            user_id: session.user_id.clone(),
            delegation_id: session.delegation_id.clone(),
            delegation_expires_at: session.delegation_expires_at,
            server_time_ms: session.server_time_ms,
        }
    }
    fn session(&self) -> AccountSession {
        AccountSession {
            access_token: self.access_token.clone(),
            user_id: self.user_id.clone(),
            delegation_id: self.delegation_id.clone(),
            delegation_expires_at: self.delegation_expires_at,
            server_time_ms: self.server_time_ms,
            deletion_cancelled: false,
        }
    }
    fn validate(&self, profile: &Profile) -> io::Result<()> {
        if self.user_id != profile.certificate.user_id
            || self.delegation_id != profile.certificate.delegation_id
            || self.delegation_expires_at != profile.certificate.expires_at
            || self.access_token.is_empty()
            || self.refresh.is_empty()
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// A store names one account and one delegation. Replacing or logging out of
/// that account invalidates every older process instead of spending its refresh.
#[derive(Clone)]
pub struct Store {
    directory: PathBuf,
    delegation_id: String,
    origin: String,
}

pub struct Resumed {
    pub profile: Profile,
    pub session: AccountSession,
    pub delegation: Delegation,
    /// The key the delegation certifies, in its custody.
    pub delegate: Arc<dyn KeyCustody>,
    pub store: Arc<Store>,
}

/// A stored account this build can use.
struct Usable {
    record: Record,
    tokens: Tokens,
    delegate: Arc<dyn KeyCustody>,
}

impl Store {
    /// `identity` is the custody whose key `signed_in`'s delegation certifies.
    pub fn create(
        directory: &Path,
        username: &str,
        pin: &[u8; 32],
        signed_in: &SignedIn,
        identity: IdentitySealWire,
    ) -> io::Result<Arc<Self>> {
        let directory = prepare(directory)?;
        let _lock = lock(&directory)?;
        if directory.join(STATE).try_exists()? {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "sign out of the stored account first",
            ));
        }
        let profile = Profile {
            origin: signed_in.delegation.server_origin.clone(),
            username: username.to_owned(),
            opaque_server_key: encode(pin),
            root_public_key: encode(&*signed_in.delegation.root_public_key),
            certificate: signed_in.delegation.certificate.clone(),
            identity,
        };
        validate_profile(&profile)?;
        let store = Arc::new(Self {
            directory,
            delegation_id: profile.certificate.delegation_id.clone(),
            origin: profile.origin.clone(),
        });
        let mut record = Record {
            profile,
            #[cfg(not(target_os = "macos"))]
            tokens: Vec::new(),
        };
        let tokens = Tokens::new(&signed_in.session, &signed_in.refresh);
        tokens.validate(&record.profile)?;
        write_tokens(&store.directory, &mut record, &tokens)?;
        if let Err(error) = publish(&store.directory, &record) {
            // Publication failed: no process may see this account. The
            // directory has no record, so its Keychain item is this orphan.
            delete_tokens(&store.directory)?;
            return Err(error);
        }
        Ok(store)
    }

    pub fn open(directory: &Path) -> io::Result<Option<Arc<Self>>> {
        let directory = prepare(directory)?;
        let _lock = lock(&directory)?;
        let Some(Usable { record, .. }) = usable(&directory)? else {
            return Ok(None);
        };
        Ok(Some(Arc::new(Self {
            directory,
            delegation_id: record.profile.certificate.delegation_id,
            origin: record.profile.origin,
        })))
    }

    /// Server revocation and local removal complete under one process-shared
    /// lock. Cancellation cannot strand a rotation or expose a half-removed login.
    pub async fn sign_out(self: &Arc<Self>) -> io::Result<()> {
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let mut locked = store
                .locked()
                .map_err(|error| io::Error::other(format!("{error:?}")))?;
            let profile = &locked.record.profile;
            let pin = decode_exact::<32>(&profile.opaque_server_key, "OPAQUE server key")
                .map_err(io::Error::other)?;
            let account = Account::new(&profile.origin, pin)
                .map_err(|error| io::Error::other(format!("{error:?}")))?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let sessions = match runtime.block_on(account.sessions(&locked.tokens.access_token)) {
                Err(AccountError::Refused { status: 401, .. }) => {
                    store
                        .rotate(&account, &mut locked)
                        .map_err(|error| io::Error::other(format!("{error:?}")))?;
                    runtime.block_on(account.sessions(&locked.tokens.access_token))
                }
                answer => answer,
            }
            .map_err(|error| io::Error::other(format!("{error:?}")))?;
            let profile = &locked.record.profile;
            let delegate = delegate(profile)?;
            let delegation = Delegation {
                certificate: profile.certificate.clone(),
                root_public_key: Box::new(
                    decode_exact::<PUBLIC_KEY_BYTES>(&profile.root_public_key, "root public key")
                        .map_err(io::Error::other)?,
                ),
                server_origin: profile.origin.clone(),
            };
            let refresh =
                RefreshCredential::from_value(Zeroizing::new(locked.tokens.refresh.clone()));
            runtime
                .block_on(account.logout(
                    &delegation,
                    &*delegate,
                    &refresh,
                    sessions.server_time_ms,
                    &mut merkur_client_native::driver::OsEntropy,
                ))
                .map_err(|error| io::Error::other(format!("{error:?}")))?;
            fs::remove_file(store.directory.join(STATE))?;
            File::open(&store.directory)?.sync_all()?;
            delete_tokens(&store.directory)
        })
        .await
        .map_err(io::Error::other)?
    }

    pub fn resume(directory: &Path) -> io::Result<Option<Resumed>> {
        let directory = prepare(directory)?;
        let _lock = lock(&directory)?;
        let Some(Usable {
            record,
            tokens,
            delegate,
        }) = usable(&directory)?
        else {
            return Ok(None);
        };
        let root_public_key = Box::new(
            decode_exact::<PUBLIC_KEY_BYTES>(&record.profile.root_public_key, "root public key")
                .map_err(io::Error::other)?,
        );
        let delegation = Delegation {
            certificate: record.profile.certificate.clone(),
            root_public_key,
            server_origin: record.profile.origin.clone(),
        };
        let store = Arc::new(Self {
            directory,
            delegation_id: record.profile.certificate.delegation_id.clone(),
            origin: record.profile.origin.clone(),
        });
        Ok(Some(Resumed {
            profile: record.profile,
            session: tokens.session(),
            delegation,
            delegate,
            store,
        }))
    }

    /// Removes only this delegation, after its server revocation succeeded.
    pub async fn remove(self: &Arc<Self>) -> io::Result<()> {
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let _lock = lock(&store.directory)?;
            store.record()?;
            // Removing the public record first prevents any waiter from loading
            // a credential whose Keychain entry has already disappeared.
            fs::remove_file(store.directory.join(STATE))?;
            File::open(&store.directory)?.sync_all()?;
            delete_tokens(&store.directory)
        })
        .await
        .map_err(io::Error::other)?
    }

    fn record(&self) -> io::Result<Record> {
        let record = read(&self.directory)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "account signed out"))?;
        if record.profile.certificate.delegation_id != self.delegation_id
            || record.profile.origin != self.origin
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "stored account changed",
            ));
        }
        validate_profile(&record.profile)?;
        Ok(record)
    }

    fn rotate(&self, account: &Account, locked: &mut Locked) -> Result<(), AccountError> {
        if account.origin() != self.origin {
            return Err(AccountError::Invalid("stored account origin"));
        }
        let refresh = RefreshCredential::from_value(Zeroizing::new(locked.tokens.refresh.clone()));
        let (session, refresh) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(storage_error)?
            .block_on(account.refresh(&refresh))?;
        let tokens = Tokens::new(&session, &refresh);
        tokens
            .validate(&locked.record.profile)
            .map_err(storage_error)?;
        write_tokens(&self.directory, &mut locked.record, &tokens).map_err(storage_error)?;
        #[cfg(not(target_os = "macos"))]
        publish(&self.directory, &locked.record).map_err(storage_error)?;
        locked.tokens = tokens;
        Ok(())
    }

    fn locked(&self) -> Result<Locked, AccountError> {
        let file = lock(&self.directory).map_err(storage_error)?;
        let record = self.record().map_err(storage_error)?;
        let tokens = read_tokens(&self.directory, &record).map_err(storage_error)?;
        tokens.validate(&record.profile).map_err(storage_error)?;
        Ok(Locked {
            _file: file,
            record,
            tokens,
        })
    }
}

struct Locked {
    _file: File,
    record: Record,
    tokens: Tokens,
}

impl CredentialSource for Store {
    fn current(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + '_>> {
        let store = self.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let locked = store.locked()?;
                Ok(Arc::from(locked.tokens.access_token.as_str()))
            })
            .await
            .map_err(|_| AccountError::Invalid("credential worker"))?
        })
    }

    fn renewed<'a>(
        &'a self,
        account: &'a Account,
        refused: Arc<str>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<Arc<str>, AccountError>> + Send + 'a>> {
        let store = self.clone();
        let account = account.clone();
        Box::pin(async move {
            // Blocking tasks finish even if their caller is cancelled; runtime
            // shutdown waits for them. The rotation and its durable write are
            // one transaction on their own reactor, never the terminal's.
            tokio::task::spawn_blocking(move || {
                let mut locked = store.locked()?;
                if locked.tokens.access_token.as_str() == &*refused {
                    store.rotate(&account, &mut locked)?;
                }
                Ok(Arc::from(locked.tokens.access_token.as_str()))
            })
            .await
            .map_err(|_| AccountError::Invalid("credential worker"))?
        })
    }
}

/// The stored account, when this build can use it. A record it cannot parse
/// or verify, or whose credentials or custody material are missing or invalid,
/// is no account: it is removed with its credentials and reads as signed out,
/// so the next sign-in replaces it. Nothing local can use its delegation again.
fn usable(directory: &Path) -> io::Result<Option<Usable>> {
    let usable = (|| -> io::Result<Option<Usable>> {
        let Some(record) = read(directory)? else {
            return Ok(None);
        };
        validate_profile(&record.profile)?;
        // Linux credentials open through the custody, so its material is
        // judged first.
        let delegate = delegate(&record.profile)?;
        let tokens = read_tokens(directory, &record)?;
        tokens.validate(&record.profile)?;
        Ok(Some(Usable {
            record,
            tokens,
            delegate,
        }))
    })();
    match usable {
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            match fs::remove_file(directory.join(STATE)) {
                Ok(()) => File::open(directory)?.sync_all()?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            delete_tokens(directory)?;
            Ok(None)
        }
        usable => usable,
    }
}

fn validate_profile(profile: &Profile) -> io::Result<()> {
    let root = decode_exact::<PUBLIC_KEY_BYTES>(&profile.root_public_key, "root public key")
        .map_err(|_| invalid())?;
    decode_exact::<32>(&profile.opaque_server_key, "OPAQUE server key").map_err(|_| invalid())?;
    let certificate = &profile.certificate;
    if certificate.server_origin != profile.origin
        || certificate.root_key_commitment != root_key_commitment(&root).map_err(|_| invalid())?
    {
        return Err(invalid());
    }
    certificate.verify_signature(&root).map_err(|_| invalid())
}

/// Opens the profile's custody and proves it holds the key the certificate
/// delegates to.
fn delegate(profile: &Profile) -> io::Result<Arc<dyn KeyCustody>> {
    let custody = merkur_identity_seal::open(&profile.identity).map_err(|error| match error {
        SealError::InvalidMaterial => invalid(),
        error => io::Error::other(error),
    })?;
    if encode(custody.public_key()) != profile.certificate.delegate_public_key {
        return Err(invalid());
    }
    Ok(Arc::from(custody))
}

/// The directory's canonical path: the Keychain names its credentials by it,
/// so removing an account never depends on parsing its record.
fn prepare(directory: &Path) -> io::Result<PathBuf> {
    match fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir()
        // SAFETY: getuid has no arguments or memory effects.
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "account directory must be private and owned by the current user",
        ));
    }
    fs::canonicalize(directory)
}

fn open(path: &Path, create: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        // SAFETY: getuid has no arguments or memory effects.
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "account file must be private and owned by the current user",
        ));
    }
    Ok(file)
}

fn lock(directory: &Path) -> io::Result<File> {
    use std::os::fd::AsRawFd;
    let file = open(&directory.join("lock"), true)?;
    loop {
        // SAFETY: a live descriptor, operation takes no pointer. Close releases it.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(file);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn read(directory: &Path) -> io::Result<Option<Record>> {
    let mut file = match open(&directory.join(STATE), false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    file.read_to_end(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| invalid())
}

fn publish(directory: &Path, record: &Record) -> io::Result<()> {
    let mut random = [0; 16];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| invalid())?;
    let temp = directory.join(format!(".account-{}", encode(&random)));
    let bytes = Zeroizing::new(serde_json::to_vec(record).map_err(|_| invalid())?);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, directory.join(STATE))?;
        File::open(directory)?.sync_all()
    })();
    if result.is_err() {
        match fs::remove_file(&temp) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    result
}

#[cfg(target_os = "macos")]
fn keychain_account(directory: &Path) -> io::Result<&str> {
    directory.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "account directory path must be UTF-8",
        )
    })
}
#[cfg(target_os = "macos")]
fn write_tokens(directory: &Path, _record: &mut Record, tokens: &Tokens) -> io::Result<()> {
    let bytes = Zeroizing::new(serde_json::to_vec(tokens).map_err(|_| invalid())?);
    merkur_identity_seal::keychain::put(SERVICE, keychain_account(directory)?, &bytes)
        .map_err(io::Error::other)
}
#[cfg(target_os = "macos")]
fn read_tokens(directory: &Path, _record: &Record) -> io::Result<Tokens> {
    let bytes = merkur_identity_seal::keychain::get(SERVICE, keychain_account(directory)?)
        .map_err(io::Error::other)?
        .ok_or_else(invalid)?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
#[cfg(target_os = "macos")]
fn delete_tokens(directory: &Path) -> io::Result<()> {
    merkur_identity_seal::keychain::delete(SERVICE, keychain_account(directory)?)
        .map_err(io::Error::other)
}

#[cfg(any(not(target_os = "macos"), test))]
fn token_key(profile: &Profile) -> io::Result<ring::aead::LessSafeKey> {
    use ring::aead;
    let key = merkur_identity_seal::open(&profile.identity)
        .and_then(|custody| {
            custody.derive_storage_key(
                b"merkur-tui-credential-key\0",
                &[
                    profile.origin.as_bytes(),
                    profile.certificate.delegation_id.as_bytes(),
                ],
            )
        })
        .map_err(io::Error::other)?;
    Ok(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &*key).map_err(|_| invalid())?,
    ))
}
#[cfg(any(not(target_os = "macos"), test))]
fn encrypt_tokens(profile: &Profile, tokens: &Tokens) -> io::Result<Vec<u8>> {
    use ring::aead::{Aad, Nonce};
    let mut bytes = Zeroizing::new(serde_json::to_vec(tokens).map_err(|_| invalid())?);
    let mut nonce = [0; 12];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| invalid())?;
    let aad = serde_json::to_vec(profile).map_err(|_| invalid())?;
    token_key(profile)?
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(&aad),
            &mut *bytes,
        )
        .map_err(|_| invalid())?;
    let mut encrypted = nonce.to_vec();
    encrypted.extend_from_slice(&bytes);
    Ok(encrypted)
}
#[cfg(any(not(target_os = "macos"), test))]
fn decrypt_tokens(profile: &Profile, ciphertext: &[u8]) -> io::Result<Tokens> {
    use ring::aead::{Aad, Nonce};
    let nonce: [u8; 12] = ciphertext
        .get(..12)
        .ok_or_else(invalid)?
        .try_into()
        .map_err(|_| invalid())?;
    let mut bytes = Zeroizing::new(ciphertext[12..].to_vec());
    let aad = serde_json::to_vec(profile).map_err(|_| invalid())?;
    let opened = token_key(profile)?
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(&aad),
            &mut bytes,
        )
        .map_err(|_| invalid())?;
    serde_json::from_slice(opened).map_err(|_| invalid())
}
#[cfg(not(target_os = "macos"))]
fn write_tokens(_directory: &Path, record: &mut Record, tokens: &Tokens) -> io::Result<()> {
    record.tokens = encrypt_tokens(&record.profile, tokens)?;
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn read_tokens(_directory: &Path, record: &Record) -> io::Result<Tokens> {
    decrypt_tokens(&record.profile, &record.tokens)
}
#[cfg(not(target_os = "macos"))]
#[expect(
    clippy::unnecessary_wraps,
    reason = "the macOS form removes a Keychain item and can fail; callers are shared"
)]
fn delete_tokens(_directory: &Path) -> io::Result<()> {
    Ok(())
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid stored account")
}
fn storage_error(_error: io::Error) -> AccountError {
    AccountError::Invalid("credential storage")
}

#[cfg(test)]
mod tests;
