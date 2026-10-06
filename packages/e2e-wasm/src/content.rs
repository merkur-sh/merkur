//! Fixed-capacity content transfer buffers. No chunk allocates or grows memory.

use merkur_e2e::{
    CONTENT_CHUNK_BYTES, CONTENT_CHUNK_OVERHEAD, CONTENT_HEADER_BYTES, ContentDescriptor,
    ContentReceiver, ContentRequests, ContentSender,
};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

use crate::E2eTransport;

const BUFFER_BYTES: usize = CONTENT_CHUNK_BYTES + CONTENT_CHUNK_OVERHEAD;

#[wasm_bindgen]
impl E2eTransport {
    pub fn content_sender(&mut self, descriptor: &[u8]) -> Result<E2eContentSender, JsError> {
        let descriptor = ContentDescriptor::decode(descriptor)
            .map_err(|error| JsError::new(&error.to_string()))?;
        // Core admission precedes these buffers; at most 32 owners per direction
        // retain them. Dropping the parent epoch disables every retained owner.
        let sender = self
            .transport
            .content_sender(descriptor)
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(E2eContentSender {
            sender,
            input: vec![0; BUFFER_BYTES],
            output: vec![0; BUFFER_BYTES],
        })
    }

    pub fn content_expect_whole(
        &mut self,
        request: u64,
        source: &[u8],
        max_bytes: u32,
    ) -> Result<(), JsError> {
        let source = source
            .try_into()
            .map_err(|_| JsError::new("invalid source root"))?;
        self.requests
            .get_or_insert_with(|| Box::new(ContentRequests::default()))
            .whole(request, source, max_bytes)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    pub fn content_expect_range(&mut self, descriptor: &[u8]) -> Result<(), JsError> {
        let descriptor = ContentDescriptor::decode(descriptor)
            .map_err(|error| JsError::new(&error.to_string()))?;
        self.requests
            .get_or_insert_with(|| Box::new(ContentRequests::default()))
            .range(descriptor)
            .map_err(|error| JsError::new(&error.to_string()))
    }

    /// Cancels a pending header. After admission, free the returned receiver.
    pub fn content_cancel_request(&mut self, request: u64) -> bool {
        self.requests
            .as_mut()
            .is_some_and(|requests| requests.cancel(request))
    }

    /// Requests are registered locally before control transmission. The network header was copied into
    /// the existing transport input buffer; wasm-bindgen never copies an
    /// attacker-sized header argument before this exact-size check.
    pub fn content_receiver(&mut self, header_len: usize) -> Result<E2eContentReceiver, JsError> {
        if header_len != CONTENT_HEADER_BYTES || header_len > self.input.len() {
            return Err(JsError::new("invalid content header length"));
        }
        let requests = self
            .requests
            .as_mut()
            .ok_or_else(|| JsError::new("no pending content requests"))?;
        let receiver = self
            .transport
            .content_receiver(requests, &self.input[..header_len])
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(E2eContentReceiver {
            receiver,
            input: vec![0; BUFFER_BYTES],
            output: vec![0; BUFFER_BYTES],
        })
    }
}

#[wasm_bindgen]
pub struct E2eContentSender {
    sender: ContentSender,
    input: Vec<u8>,
    output: Vec<u8>,
}

#[wasm_bindgen]
impl E2eContentSender {
    /// Refresh JS views after any WASM memory growth, including other sessions.
    #[wasm_bindgen(getter)]
    pub fn input_ptr(&self) -> *const u8 {
        self.input.as_ptr()
    }
    #[wasm_bindgen(getter)]
    pub fn output_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }
    #[wasm_bindgen(getter)]
    pub fn capacity(&self) -> usize {
        self.input.len()
    }
    pub fn header(&self) -> Vec<u8> {
        self.sender.header().to_vec()
    }

    /// Positive record length or -1. Each admitted ordinal can be sealed once;
    /// retain its ciphertext for retries rather than calling this method twice.
    pub fn seal_next(&mut self, len: usize) -> i32 {
        if len > CONTENT_CHUNK_BYTES {
            return -1;
        }
        self.sender
            .seal_next(&self.input[..len], &mut self.output)
            .map_or(-1, |n| n as i32)
    }
}

impl Drop for E2eContentSender {
    fn drop(&mut self) {
        self.input.zeroize();
        self.output.zeroize();
    }
}

#[wasm_bindgen]
pub struct E2eContentReceiver {
    receiver: ContentReceiver,
    input: Vec<u8>,
    output: Vec<u8>,
}

#[wasm_bindgen]
impl E2eContentReceiver {
    /// Authenticated metadata, returned once at admission rather than per chunk.
    pub fn descriptor(&self) -> Vec<u8> {
        self.receiver.descriptor().encode().to_vec()
    }
    #[wasm_bindgen(getter)]
    pub fn input_ptr(&self) -> *const u8 {
        self.input.as_ptr()
    }
    #[wasm_bindgen(getter)]
    pub fn output_ptr(&self) -> *const u8 {
        self.output.as_ptr()
    }
    #[wasm_bindgen(getter)]
    pub fn capacity(&self) -> usize {
        self.input.len()
    }

    /// Positive plaintext length, -2 for an authenticated duplicate, -1 for a
    /// refusal. Failed authentication never commits transfer replay state.
    pub fn open_chunk(&mut self, len: usize) -> i32 {
        if len > self.input.len() {
            return -1;
        }
        match self
            .receiver
            .open_chunk(&self.input[..len], &mut self.output)
        {
            Ok(chunk) if chunk.duplicate => -2,
            Ok(chunk) => chunk.len as i32,
            Err(_) => -1,
        }
    }
}

impl Drop for E2eContentReceiver {
    fn drop(&mut self) {
        self.input.zeroize();
        self.output.zeroize();
    }
}
