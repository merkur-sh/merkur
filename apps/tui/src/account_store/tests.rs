use super::*;
use merkur_authorization::{
    DELEGATION_LIFETIME_MS, DELEGATION_SCOPES, DelegationPayload, SigningKey,
};
use merkur_identity_seal::Backend;
use std::os::unix::fs::{PermissionsExt, symlink};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let mut random = [0; 16];
        SystemRandom::new().fill(&mut random).unwrap();
        Self(
            prepare(&std::env::temp_dir().join(format!("merkur-account-test-{}", encode(&random))))
                .unwrap(),
        )
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn profile() -> Profile {
    let root = SigningKey::from_seed(&mut [7; 32]).unwrap();
    let (identity, delegate) = merkur_identity_seal::create(Backend::Software).unwrap();
    Profile {
        origin: "http://localhost:3000".into(),
        username: "alice".into(),
        opaque_server_key: encode(&[9; 32]),
        root_public_key: encode(root.public_key()),
        certificate: DelegationCertificate::create(
            DelegationPayload {
                user_id: "11111111-1111-4111-8111-111111111111".into(),
                root_key_commitment: root_key_commitment(root.public_key()).unwrap(),
                delegation_id: "22222222-2222-4222-8222-222222222222".into(),
                delegate_public_key: encode(delegate.public_key()),
                scopes: DELEGATION_SCOPES
                    .iter()
                    .map(|scope| (*scope).into())
                    .collect(),
                server_origin: "http://localhost:3000".into(),
                root_epoch: 1,
                issued_at: 1,
                expires_at: DELEGATION_LIFETIME_MS + 1,
            },
            &root,
            [10; 32],
        )
        .unwrap(),
        identity,
    }
}
fn tokens(profile: &Profile) -> Tokens {
    Tokens {
        access_token: "secret-access-token".into(),
        refresh: "secret-refresh-credential".into(),
        user_id: profile.certificate.user_id.clone(),
        delegation_id: profile.certificate.delegation_id.clone(),
        delegation_expires_at: profile.certificate.expires_at,
        server_time_ms: 1,
    }
}
fn record(profile: Profile) -> Record {
    Record {
        #[cfg(not(target_os = "macos"))]
        tokens: encrypt_tokens(&profile, &tokens(&profile)).unwrap(),
        profile,
    }
}

#[test]
fn sealed_tokens_bind_every_profile_field_and_reject_tampering() {
    let mut profile = profile();
    let tokens = tokens(&profile);
    let mut encrypted = encrypt_tokens(&profile, &tokens).unwrap();
    assert!(
        !encrypted
            .windows(tokens.refresh.len())
            .any(|window| window == tokens.refresh.as_bytes())
    );
    assert_eq!(
        decrypt_tokens(&profile, &encrypted).unwrap().refresh,
        tokens.refresh
    );
    profile.username = "changed".into();
    assert!(decrypt_tokens(&profile, &encrypted).is_err());
    profile.username = "alice".into();
    let last = encrypted.len() - 1;
    encrypted[last] ^= 1;
    assert!(decrypt_tokens(&profile, &encrypted).is_err());
    for length in [0, 11, 12, 27] {
        assert!(decrypt_tokens(&profile, &encrypted[..length]).is_err());
    }
}

#[test]
fn public_record_is_atomic_private_and_rejects_links_or_corruption() {
    let directory = Directory::new();
    let record = record(profile());
    publish(&directory.0, &record).unwrap();
    let path = directory.0.join(STATE);
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    validate_profile(&read(&directory.0).unwrap().unwrap().profile).unwrap();
    let other = directory.0.join("other");
    fs::hard_link(&path, &other).unwrap();
    assert!(read(&directory.0).is_err());
    fs::remove_file(&other).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read(&directory.0).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, b"{}").unwrap();
    assert!(read(&directory.0).is_err());
    fs::remove_file(&path).unwrap();
    symlink(&other, &path).unwrap();
    assert!(read(&directory.0).is_err());
}

#[test]
fn older_process_cannot_read_a_replaced_delegation() {
    let directory = Directory::new();
    let mut record = record(profile());
    let store = Store {
        directory: directory.0.clone(),
        origin: record.profile.origin.clone(),
        delegation_id: record.profile.certificate.delegation_id.clone(),
    };
    publish(&directory.0, &record).unwrap();
    store.record().unwrap();
    record.profile.certificate.delegation_id = "33333333-3333-4333-8333-333333333333".into();
    publish(&directory.0, &record).unwrap();
    assert_eq!(
        store.record().err().unwrap().kind(),
        io::ErrorKind::PermissionDenied
    );
    fs::remove_file(directory.0.join(STATE)).unwrap();
    assert_eq!(
        store.record().err().unwrap().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn descriptor_lock_excludes_an_independent_open_and_releases_on_drop() {
    use std::os::fd::AsRawFd;
    let directory = Directory::new();
    let first = lock(&directory.0).unwrap();
    let second = open(&directory.0.join("lock"), true).unwrap();
    // SAFETY: owned live descriptor; nonblocking lock changes only its lock state.
    let contended = unsafe { libc::flock(second.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(contended, -1);
    assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
    drop(first);
    // SAFETY: `second` still owns its descriptor; `flock` takes no pointer.
    let acquired = unsafe { libc::flock(second.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    assert_eq!(acquired, 0);
}

#[test]
fn an_unusable_record_is_removed_and_reads_as_signed_out() {
    let directory = Directory::new();
    let path = directory.0.join(STATE);
    let mut record = record(profile());
    record.profile.certificate.server_origin = "http://localhost:3001".into();
    publish(&directory.0, &record).unwrap();
    assert!(Store::resume(&directory.0).unwrap().is_none());
    assert!(!path.try_exists().unwrap());

    // Another build's shape, written through the private file it replaces.
    publish(&directory.0, &record).unwrap();
    fs::write(&path, br#"{"profile":{"identity":{"backend":"other"}}}"#).unwrap();
    assert!(Store::open(&directory.0).unwrap().is_none());
    assert!(!path.try_exists().unwrap());
}

#[test]
fn an_unsafe_record_is_refused_and_kept() {
    let directory = Directory::new();
    let path = directory.0.join(STATE);
    publish(&directory.0, &record(profile())).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        Store::resume(&directory.0).err().unwrap().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(path.try_exists().unwrap());
}

#[test]
fn tokens_cannot_move_between_delegations() {
    let profile = profile();
    let mut tokens = tokens(&profile);
    tokens.validate(&profile).unwrap();
    tokens.delegation_id = "33333333-3333-4333-8333-333333333333".into();
    assert!(tokens.validate(&profile).is_err());
}
