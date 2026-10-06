//! All permanent identity signing runs on one bounded blocking thread.
use merkur_e2e::{DAEMON_IDENTITY_SIGNATURE_BYTES, daemon_p256_digest};
use merkur_identity_seal::{KeyCustody, SealError};
use ring::rand::{SecureRandom, SystemRandom};
#[cfg(not(merkur_sim))]
use std::sync::mpsc;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

#[cfg(not(merkur_sim))]
const SIGN_QUEUE_CAPACITY: usize = 32;
pub const MAX_TRANSCRIPT_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagementPurpose {
    Http,
    Control,
}
impl ManagementPurpose {
    pub fn context(self) -> &'static [u8] {
        match self {
            Self::Http => b"merkur-daemon-http",
            Self::Control => b"merkur-daemon-control",
        }
    }
}

pub struct SignaturePair {
    pub mldsa: [u8; DAEMON_IDENTITY_SIGNATURE_BYTES],
    pub p256: [u8; 64],
}

struct SignJob {
    context: &'static [u8],
    transcript: Vec<u8>,
    result: oneshot::Sender<Result<SignaturePair, SealError>>,
}

pub struct IdentitySigner {
    #[cfg(not(merkur_sim))]
    jobs: mpsc::SyncSender<SignJob>,
    /// The network simulator signs in place, so a signature's arrival is
    /// ordered by simulated time and not by a thread's (`crate::sim`).
    #[cfg(merkur_sim)]
    custody: Box<dyn KeyCustody>,
    stopped: Arc<AtomicBool>,
    pub public_key: [u8; merkur_e2e::DAEMON_IDENTITY_PUBLIC_KEY_BYTES],
    pub p256_public_key: [u8; 65],
}

impl IdentitySigner {
    /// The worker owns the custody. A chip signs either half for up to tens of
    /// milliseconds (an enclave ML-DSA-87 signature measured p99 32.6 ms), so
    /// nothing on the owner loop ever waits on it.
    pub fn new(custody: Box<dyn KeyCustody>) -> Result<Self, SealError> {
        let public_key = *custody.public_key();
        let p256_public_key = custody.p256_public_key();
        let stopped = Arc::new(AtomicBool::new(false));
        #[cfg(not(merkur_sim))]
        let jobs = {
            let (jobs, receiver) = mpsc::sync_channel::<SignJob>(SIGN_QUEUE_CAPACITY);
            let worker_stopped = Arc::clone(&stopped);
            std::thread::Builder::new()
                .name("merkur-identity-signer".into())
                .spawn(move || {
                    let rng = SystemRandom::new();
                    while let Ok(job) = receiver.recv() {
                        if worker_stopped.load(Ordering::Acquire) {
                            break;
                        }
                        sign_job(custody.as_ref(), &rng, job, &worker_stopped);
                    }
                })?;
            jobs
        };
        Ok(Self {
            #[cfg(not(merkur_sim))]
            jobs,
            #[cfg(merkur_sim)]
            custody,
            stopped,
            public_key,
            p256_public_key,
        })
    }

    /// Admission is nonblocking. Dropping the receiver cancels queued work;
    /// an in-progress hardware call can finish but cannot publish authority.
    pub fn sign(
        &self,
        context: &'static [u8],
        transcript: Vec<u8>,
    ) -> Result<oneshot::Receiver<Result<SignaturePair, SealError>>, SealError> {
        if transcript.is_empty() || transcript.len() > MAX_TRANSCRIPT_BYTES {
            return Err(SealError::InvalidMaterial);
        }
        let (result, receiver) = oneshot::channel();
        let job = SignJob {
            context,
            transcript,
            result,
        };
        #[cfg(not(merkur_sim))]
        self.jobs.try_send(job).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => SealError::Busy,
            mpsc::TrySendError::Disconnected(_) => SealError::Closed,
        })?;
        #[cfg(merkur_sim)]
        sign_job(
            self.custody.as_ref(),
            &SystemRandom::new(),
            job,
            &self.stopped,
        );
        Ok(receiver)
    }
}

/// Signs one admitted job with both halves and publishes the pair, unless its
/// requester or the signer went away first.
fn sign_job(custody: &dyn KeyCustody, rng: &SystemRandom, job: SignJob, stopped: &AtomicBool) {
    if job.result.is_closed() {
        return;
    }
    let result = (|| {
        let mut randomness = Zeroizing::new([0; 32]);
        rng.fill(&mut *randomness).map_err(|_| SealError::Crypto)?;
        // The custody verifies a chip's output of either half
        // before returning it, so a fault publishes nothing.
        let mldsa = custody.sign_with_context(job.context, &job.transcript, *randomness)?;
        if job.result.is_closed() || stopped.load(Ordering::Acquire) {
            return Err(SealError::Closed);
        }
        let p256 = custody.sign_p256(&daemon_p256_digest(job.context, &job.transcript))?;
        if job.result.is_closed() || stopped.load(Ordering::Acquire) {
            return Err(SealError::Closed);
        }
        Ok(SignaturePair { mldsa, p256 })
    })();
    let _ = job.result.send(result);
}

impl Drop for IdentitySigner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_e2e::{MlDsa87Signer, SessionCryptoError};
    use merkur_identity_seal::Backend;
    use std::sync::Mutex;

    #[tokio::test]
    async fn worker_produces_verified_pairs_and_rejects_oversize() {
        let (_, custody) = merkur_identity_seal::create(Backend::Software).unwrap();
        let signer = IdentitySigner::new(custody).unwrap();
        let context = b"merkur-daemon-http";
        let first = signer.sign(context, b"first".to_vec()).unwrap();
        let cancelled = signer.sign(context, b"cancelled".to_vec()).unwrap();
        drop(cancelled);
        let second = signer.sign(context, b"second".to_vec()).unwrap();
        for (transcript, receiver) in [(b"first".as_slice(), first), (b"second".as_slice(), second)]
        {
            let pair = receiver.await.unwrap().unwrap();
            merkur_e2e::verify_daemon_p256_signature(
                &signer.p256_public_key,
                &daemon_p256_digest(context, transcript),
                &pair.p256,
            )
            .unwrap();
            merkur_e2e::verify_ml_dsa87(&signer.public_key, context, transcript, &pair.mldsa)
                .unwrap();
        }
        assert!(
            signer
                .sign(context, vec![0; MAX_TRANSCRIPT_BYTES + 1])
                .is_err()
        );
    }

    /// A custody whose chip blocks its first P-256 signature until released.
    struct GatedCustody {
        inner: Box<dyn KeyCustody>,
        entered: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl MlDsa87Signer for GatedCustody {
        fn public_key(&self) -> &[u8; merkur_e2e::DAEMON_IDENTITY_PUBLIC_KEY_BYTES] {
            self.inner.public_key()
        }
        fn sign_with_context(
            &self,
            context: &[u8],
            message: &[u8],
            randomness: [u8; 32],
        ) -> Result<[u8; DAEMON_IDENTITY_SIGNATURE_BYTES], SessionCryptoError> {
            self.inner.sign_with_context(context, message, randomness)
        }
    }
    impl KeyCustody for GatedCustody {
        fn p256_public_key(&self) -> [u8; 65] {
            self.inner.p256_public_key()
        }
        fn sign_p256(&self, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(entered) = self.entered.lock().unwrap().take() {
                let _ = entered.send(());
                self.release
                    .lock()
                    .unwrap()
                    .recv()
                    .map_err(|_| SealError::Closed)?;
            }
            self.inner.sign_p256(digest)
        }
        fn derive_storage_key(
            &self,
            salt: &[u8],
            info: &[&[u8]],
        ) -> Result<Zeroizing<[u8; 32]>, SealError> {
            self.inner.derive_storage_key(salt, info)
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocked_hardware_never_blocks_owner_and_cancelled_queue_never_reaches_chip() {
        let (entered, waiting) = oneshot::channel();
        let (release, gate) = mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (_, inner) = merkur_identity_seal::create(Backend::Software).unwrap();
        let signer = IdentitySigner::new(Box::new(GatedCustody {
            inner,
            entered: Mutex::new(Some(entered)),
            release: Mutex::new(gate),
            calls: Arc::clone(&calls),
        }))
        .unwrap();
        let first = signer
            .sign(b"merkur-daemon-control", b"first".to_vec())
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap();
        let mut queued = Vec::new();
        for _ in 0..SIGN_QUEUE_CAPACITY {
            queued.push(
                signer
                    .sign(b"merkur-daemon-control", b"queued".to_vec())
                    .unwrap(),
            );
        }
        assert!(matches!(
            signer.sign(b"merkur-daemon-control", b"overflow".to_vec()),
            Err(SealError::Busy)
        ));
        drop(queued);
        // Dropping the owner while the chip is still blocked must return now,
        // cancel all queued jobs, and suppress the in-flight result as well.
        drop(signer);
        release.send(()).unwrap();
        assert!(matches!(first.await.unwrap(), Err(SealError::Closed)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
