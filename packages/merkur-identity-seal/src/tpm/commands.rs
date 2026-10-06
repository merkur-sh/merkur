//! Merkur's fixed TPM command sequences. All numeric fields follow TCG TPM
//! 2.0 Part 2/3, big endian. The pinned codec validates command/response frames;
//! object templates and policy remain owned here, independent of transport.
use super::{super::SealError, transport::TpmTransport};
use std::time::{Duration, Instant};
use tpm2_protocol::{
    data::TpmCc,
    frame::{TpmCommand, TpmResponse},
};
use zeroize::{Zeroize, Zeroizing};

const CREATE_PRIMARY: u32 = 0x131;
const CREATE: u32 = 0x153;
const LOAD: u32 = 0x157;
const SIGN: u32 = 0x15d;
const UNSEAL: u32 = 0x15e;
const FLUSH: u32 = 0x165;
const OWNER: u32 = 0x40000001;
const NULL: u16 = 0x10;
const SHA256: u16 = 0x0b;
const ECC: u16 = 0x23;
const ECDSA: u16 = 0x18;
const P256: u16 = 3;
const PRIMARY_ATTRIBUTES: u32 = 0x0003_0072;
const SIGNING_ATTRIBUTES: u32 = 0x0004_0472;
const SEALED_ATTRIBUTES: u32 = 0x0000_0452;

pub(super) struct Device {
    transport: Box<dyn TpmTransport>,
    handles: Vec<u32>,
    response: Zeroizing<[u8; 4096]>,
}

impl Device {
    pub fn new(transport: Box<dyn TpmTransport>) -> Self {
        Self {
            transport,
            handles: Vec::with_capacity(3),
            response: Zeroizing::new([0; 4096]),
        }
    }

    fn command(
        &mut self,
        code: u32,
        handle: u32,
        params: &[u8],
        sessions: bool,
        response_handles: usize,
    ) -> Result<(u32, Zeroizing<Vec<u8>>), SealError> {
        let mut command = Zeroizing::new(Vec::with_capacity(64 + params.len()));
        u16be(&mut command, if sessions { 0x8002 } else { 0x8001 });
        u32be(&mut command, 0);
        u32be(&mut command, code);
        u32be(&mut command, handle);
        if sessions {
            u32be(&mut command, 9);
            u32be(&mut command, 0x40000009); // TPM_RS_PW
            u16be(&mut command, 0); // nonce
            command.push(0); // session attributes
            u16be(&mut command, 0); // empty password
        }
        command.extend_from_slice(params);
        let length = u32::try_from(command.len()).map_err(|_| SealError::InvalidMaterial)?;
        command[2..6].copy_from_slice(&length.to_be_bytes());
        let frame = TpmCommand::cast(&command).map_err(|_| SealError::Hardware)?;
        frame.validate().map_err(|_| SealError::Hardware)?;
        let cc = TpmCc::try_from(code).map_err(|_| SealError::Hardware)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let length = loop {
            self.response.zeroize();
            let length = self.transport.submit(&command, &mut self.response)?;
            if length > self.response.len() {
                return Err(SealError::Hardware);
            }
            let frame =
                TpmResponse::cast(&self.response[..length]).map_err(|_| SealError::Hardware)?;
            frame.validate(cc).map_err(|_| SealError::Hardware)?;
            let rc = frame.rc().map_err(|_| SealError::Hardware)?.value();
            // RETRY, TESTING, YIELDED explicitly mean the command can be retried.
            if matches!(rc, 0x922 | 0x90a | 0x908) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            if rc != 0 {
                return Err(SealError::Hardware);
            }
            break length;
        };
        let mut cursor = Cursor::new(&self.response[..length]);
        let tag = cursor.u16()?;
        cursor.take(8)?;
        if tag != if sessions { 0x8002 } else { 0x8001 } {
            return Err(SealError::Hardware);
        }
        let handle = if response_handles == 1 {
            let handle = cursor.u32()?;
            if handle >> 24 != 0x80 {
                return Err(SealError::Hardware);
            }
            self.handles.push(handle);
            handle
        } else {
            0
        };
        let params = if sessions {
            let n = cursor.u32()? as usize;
            let params = Zeroizing::new(cursor.take(n)?.to_vec());
            // TPM_RS_PW response sets continueSession and has empty nonce/HMAC.
            if !cursor.blob()?.is_empty() || cursor.take(1)? != [1] || !cursor.blob()?.is_empty() {
                return Err(SealError::Hardware);
            }
            cursor.finish()?;
            params
        } else {
            Zeroizing::new(cursor.remaining().to_vec())
        };
        self.response.zeroize();
        Ok((handle, params))
    }

    pub fn primary(&mut self) -> Result<u32, SealError> {
        let params = creation_params(&[], &ecc_template(true));
        let (handle, params) = self.command(CREATE_PRIMARY, OWNER, &params, true, 1)?;
        let mut cursor = Cursor::new(&params);
        validate_ecc(cursor.blob()?, true)?;
        creation_evidence(&mut cursor)?;
        cursor.blob()?; // Name
        cursor.finish()?;
        Ok(handle)
    }

    /// A P-256 signing child, or with `sealed` a KEYEDHASH object holding it.
    pub fn create(
        &mut self,
        primary: u32,
        sealed: Option<&[u8]>,
    ) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let template = if sealed.is_some() {
            sealed_template()
        } else {
            ecc_template(false)
        };
        let params = creation_params(sealed.unwrap_or(&[]), &template);
        let (_, params) = self.command(CREATE, primary, &params, true, 0)?;
        let mut cursor = Cursor::new(&params);
        let private = cursor.blob()?;
        let public = cursor.blob()?;
        if sealed.is_some() {
            validate_sealed(public)?;
        } else {
            validate_ecc(public, false)?;
        }
        creation_evidence(&mut cursor)?;
        cursor.finish()?;
        let mut material = Zeroizing::new(Vec::new());
        blob(&mut material, public);
        blob(&mut material, private);
        Ok(material)
    }

    pub fn load(&mut self, primary: u32, public: &[u8], private: &[u8]) -> Result<u32, SealError> {
        let mut params = Zeroizing::new(Vec::new());
        blob(&mut params, private);
        blob(&mut params, public);
        let (handle, params) = self.command(LOAD, primary, &params, true, 1)?;
        let mut cursor = Cursor::new(&params);
        cursor.blob()?;
        cursor.finish()?;
        Ok(handle)
    }

    pub fn unseal(&mut self, handle: u32) -> Result<Zeroizing<Vec<u8>>, SealError> {
        let (_, params) = self.command(UNSEAL, handle, &[], true, 0)?;
        let mut cursor = Cursor::new(&params);
        let data = Zeroizing::new(cursor.blob()?.to_vec());
        cursor.finish()?;
        Ok(data)
    }

    pub fn sign(&mut self, handle: u32, digest: &[u8; 32]) -> Result<[u8; 64], SealError> {
        let mut params = Vec::new();
        blob(&mut params, digest);
        u16be(&mut params, ECDSA);
        u16be(&mut params, SHA256);
        u16be(&mut params, 0x8024); // TPM_ST_HASHCHECK
        u32be(&mut params, 0x40000007); // TPM_RH_NULL
        blob(&mut params, &[]);
        let (_, params) = self.command(SIGN, handle, &params, true, 0)?;
        let mut cursor = Cursor::new(&params);
        if cursor.u16()? != ECDSA || cursor.u16()? != SHA256 {
            return Err(SealError::Hardware);
        }
        let mut signature = [0; 64];
        for half in signature.chunks_exact_mut(32) {
            let scalar = cursor.blob()?;
            if scalar.is_empty() || scalar.len() > 32 {
                return Err(SealError::Hardware);
            }
            half[32 - scalar.len()..].copy_from_slice(scalar);
        }
        cursor.finish()?;
        Ok(merkur_e2e::normalize_daemon_p256_signature(&signature)?)
    }

    pub fn flush(&mut self, handle: u32) -> Result<(), SealError> {
        let (_, params) = self.command(FLUSH, handle, &[], false, 0)?;
        if !params.is_empty() {
            return Err(SealError::Hardware);
        }
        self.handles.retain(|h| *h != handle);
        Ok(())
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        // rm-device close also reclaims contexts; explicit cleanup is necessary
        // for TBS/simulator transports and for dropping only the sealed object.
        while let Some(handle) = self.handles.pop() {
            let _ = self.flush(handle);
        }
    }
}

fn u16be(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}
fn u32be(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}
fn blob(out: &mut Vec<u8>, value: &[u8]) {
    u16be(out, u16::try_from(value.len()).expect("bounded TPM value"));
    out.extend_from_slice(value);
}
fn ecc_template(primary: bool) -> Vec<u8> {
    let mut out = Vec::new();
    u16be(&mut out, ECC);
    u16be(&mut out, SHA256);
    u32be(
        &mut out,
        if primary {
            PRIMARY_ATTRIBUTES
        } else {
            SIGNING_ATTRIBUTES
        },
    );
    blob(&mut out, &[]);
    if primary {
        u16be(&mut out, 6);
        u16be(&mut out, 128);
        u16be(&mut out, 0x43); // AES-128-CFB
        u16be(&mut out, NULL);
    } else {
        u16be(&mut out, NULL);
        u16be(&mut out, ECDSA);
        u16be(&mut out, SHA256);
    }
    u16be(&mut out, P256);
    u16be(&mut out, NULL);
    blob(&mut out, &[]);
    blob(&mut out, &[]);
    out
}
fn sealed_template() -> Vec<u8> {
    let mut out = Vec::new();
    u16be(&mut out, 8);
    u16be(&mut out, SHA256);
    u32be(&mut out, SEALED_ATTRIBUTES);
    blob(&mut out, &[]);
    u16be(&mut out, NULL);
    blob(&mut out, &[]);
    out
}
fn creation_params(seed: &[u8], template: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut sensitive = Zeroizing::new(Vec::new());
    blob(&mut sensitive, &[]);
    blob(&mut sensitive, seed);
    let mut params = Zeroizing::new(Vec::new());
    blob(&mut params, &sensitive);
    blob(&mut params, template);
    blob(&mut params, &[]);
    u32be(&mut params, 0); // outsideInfo, creationPCR
    params
}
fn creation_evidence(cursor: &mut Cursor<'_>) -> Result<(), SealError> {
    cursor.blob()?;
    cursor.blob()?;
    if cursor.u16()? != 0x8021 {
        return Err(SealError::Hardware);
    }
    cursor.u32()?;
    cursor.blob()?;
    Ok(())
}
pub(super) fn validate_ecc(public: &[u8], primary: bool) -> Result<[u8; 65], SealError> {
    let template = ecc_template(primary);
    let prefix = &template[..template.len() - 4];
    if !public.starts_with(prefix) {
        return Err(SealError::InvalidMaterial);
    }
    let mut cursor = Cursor::new(&public[prefix.len()..]);
    let mut pk = [0; 65];
    pk[0] = 4;
    for half in pk[1..].chunks_exact_mut(32) {
        let coordinate = cursor.blob()?;
        if coordinate.is_empty() || coordinate.len() > 32 {
            return Err(SealError::InvalidMaterial);
        }
        half[32 - coordinate.len()..].copy_from_slice(coordinate);
    }
    cursor.finish()?;
    merkur_e2e::validate_daemon_p256_public_key(&pk)?;
    Ok(pk)
}
pub(super) fn validate_sealed(public: &[u8]) -> Result<(), SealError> {
    let template = sealed_template();
    let prefix = &template[..template.len() - 2];
    if !public.starts_with(prefix) {
        return Err(SealError::InvalidMaterial);
    }
    let mut cursor = Cursor::new(&public[prefix.len()..]);
    if cursor.blob()?.len() != 32 {
        return Err(SealError::InvalidMaterial);
    }
    cursor.finish()
}

pub(super) struct Cursor<'a> {
    bytes: &'a [u8],
}
impl<'a> Cursor<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], SealError> {
        let (value, rest) = self
            .bytes
            .split_at_checked(n)
            .ok_or(SealError::InvalidMaterial)?;
        self.bytes = rest;
        Ok(value)
    }
    fn u16(&mut self) -> Result<u16, SealError> {
        Ok(u16::from_be_bytes(
            self.take(2)?.try_into().expect("fixed field"),
        ))
    }
    fn u32(&mut self) -> Result<u32, SealError> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().expect("fixed field"),
        ))
    }
    pub fn blob(&mut self) -> Result<&'a [u8], SealError> {
        let n = self.u16()? as usize;
        self.take(n)
    }
    fn remaining(&self) -> &'a [u8] {
        self.bytes
    }
    pub fn finish(&self) -> Result<(), SealError> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(SealError::InvalidMaterial)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        io,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct ScriptedTransport {
        replies: VecDeque<io::Result<Vec<u8>>>,
        calls: Arc<AtomicUsize>,
    }
    impl TpmTransport for ScriptedTransport {
        #[expect(
            clippy::panic_in_result_fn,
            reason = "a scripted test transport asserts the command it is handed; `TpmTransport` \
                      fixes the signature"
        )]
        fn submit(&mut self, command: &[u8], response: &mut [u8; 4096]) -> io::Result<usize> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(&command[6..10], &FLUSH.to_be_bytes());
            let bytes = self
                .replies
                .pop_front()
                .expect("unexpected command retry")?;
            response[..bytes.len()].copy_from_slice(&bytes);
            Ok(bytes.len())
        }
    }
    fn reply(rc: u32) -> Vec<u8> {
        let mut bytes = vec![0x80, 0x01, 0, 0, 0, 10];
        bytes.extend_from_slice(&rc.to_be_bytes());
        bytes
    }
    fn scripted(replies: Vec<io::Result<Vec<u8>>>) -> (Device, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Device::new(Box::new(ScriptedTransport {
                replies: replies.into(),
                calls: Arc::clone(&calls),
            })),
            calls,
        )
    }
    #[test]
    fn tpm_retry_requires_an_explicit_retry_response() {
        for retry in [0x922, 0x90a, 0x908] {
            let (mut device, calls) = scripted(vec![Ok(reply(retry)), Ok(reply(0))]);
            device.flush(0x80000001).unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }
        let (mut device, calls) = scripted(vec![Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "ambiguous write",
        ))]);
        assert!(device.flush(0x80000001).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn truncated_malformed_and_failed_responses_never_retry_or_succeed() {
        let success = reply(0);
        let mut cases: Vec<Vec<u8>> = (0..success.len()).map(|n| success[..n].to_vec()).collect();
        let mut wrong_size = success.clone();
        wrong_size[5] = 11;
        cases.push(wrong_size);
        let mut wrong_tag = success;
        wrong_tag[1] = 2;
        cases.push(wrong_tag);
        cases.push(reply(0x101));
        for response in cases {
            let (mut device, calls) = scripted(vec![Ok(response)]);
            assert!(device.flush(0x80000001).is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
}
