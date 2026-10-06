//! The account's device-event stream. Snapshot and sequence rules match the
//! browser's device-events reducer; a gap is an error, never a guessed list.

use reqwest::header;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use super::{Account, AccountError, Credentials};

const MAX_SEQUENCE: u64 = merkur_authorization::MAX_SAFE_INTEGER;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Online,
    Degraded,
    Offline,
}

pub use merkur_authorization::DaemonIdentitySealBackend as IdentityBackend;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub platform: String,
    #[serde(deserialize_with = "nullable")]
    pub last_seen: Option<f64>,
    pub status: Status,
    #[serde(deserialize_with = "nullable")]
    pub version: Option<String>,
    pub identity_seal_backend: IdentityBackend,
}
pub(super) fn nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
impl Device {
    fn valid(&self) -> bool {
        !self.id.is_empty()
            && !self.user_id.is_empty()
            && !self.name.is_empty()
            && !self.platform.is_empty()
            && self.last_seen.is_none_or(f64::is_finite)
            && self.version.as_ref().is_none_or(|value| !value.is_empty())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub epoch: String,
    pub seq: u64,
}
impl Cursor {
    fn valid(&self) -> bool {
        (1..=64).contains(&self.epoch.len())
            && self
                .epoch
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && self.seq <= MAX_SEQUENCE
    }
    fn header(&self) -> String {
        format!("{}:{}", self.epoch, self.seq)
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub epoch: String,
    pub seq: u64,
    pub devices: Vec<Device>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Delta {
    #[serde(rename_all = "camelCase")]
    Presence {
        seq: u64,
        daemon_id: String,
        status: Status,
    },
    #[serde(rename_all = "camelCase")]
    Rename {
        seq: u64,
        device_id: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    Remove {
        seq: u64,
        device_id: String,
    },
    Added {
        seq: u64,
        device: Device,
    },
}
impl Delta {
    fn seq(&self) -> u64 {
        match self {
            Self::Presence { seq, .. }
            | Self::Rename { seq, .. }
            | Self::Remove { seq, .. }
            | Self::Added { seq, .. } => *seq,
        }
    }
    fn valid(&self) -> bool {
        self.seq() <= MAX_SEQUENCE
            && match self {
                Self::Presence { daemon_id, .. } => !daemon_id.is_empty(),
                Self::Rename {
                    device_id, name, ..
                } => !device_id.is_empty() && !name.is_empty(),
                Self::Remove { device_id, .. } => !device_id.is_empty(),
                Self::Added { device, .. } => device.valid(),
            }
    }
}
#[derive(Debug)]
pub enum Event {
    Snapshot(Snapshot),
    Delta(Delta),
    Resume(Cursor),
    Presence(Vec<String>),
    SessionsChanged,
    SessionEnded,
}

#[derive(Default)]
pub struct List {
    pub devices: Vec<Device>,
    pub cursor: Option<Cursor>,
}
impl List {
    /// True only when a list fact changed. Presence signals belong to sessions.
    pub fn apply(&mut self, event: Event) -> Result<bool, AccountError> {
        match event {
            Event::Snapshot(snapshot) => {
                let cursor = Cursor {
                    epoch: snapshot.epoch,
                    seq: snapshot.seq,
                };
                if !cursor.valid() || snapshot.devices.iter().any(|device| !device.valid()) {
                    return Err(invalid());
                }
                self.devices = snapshot.devices;
                self.cursor = Some(cursor);
                Ok(true)
            }
            Event::Resume(cursor) => {
                if !cursor.valid() || self.cursor.as_ref() != Some(&cursor) {
                    return Err(invalid());
                }
                Ok(false)
            }
            Event::Delta(delta) => {
                if !delta.valid() {
                    return Err(invalid());
                }
                let cursor = self.cursor.as_mut().ok_or_else(invalid)?;
                let seq = delta.seq();
                if seq <= cursor.seq {
                    return Ok(false);
                }
                if cursor.seq.checked_add(1) != Some(seq) {
                    return Err(invalid());
                }
                cursor.seq = seq;
                match delta {
                    Delta::Presence {
                        daemon_id, status, ..
                    } => {
                        if let Some(device) = self
                            .devices
                            .iter_mut()
                            .find(|device| device.id == daemon_id)
                        {
                            if device.status == status {
                                return Ok(false);
                            }
                            device.status = status;
                            return Ok(true);
                        }
                    }
                    Delta::Rename {
                        device_id, name, ..
                    } => {
                        if let Some(device) = self
                            .devices
                            .iter_mut()
                            .find(|device| device.id == device_id)
                        {
                            if device.name == name {
                                return Ok(false);
                            }
                            device.name = name;
                            return Ok(true);
                        }
                    }
                    Delta::Remove { device_id, .. } => {
                        if let Some(at) = self
                            .devices
                            .iter()
                            .position(|device| device.id == device_id)
                        {
                            self.devices.remove(at);
                            return Ok(true);
                        }
                    }
                    Delta::Added { device, .. } => {
                        if let Some(existing) = self
                            .devices
                            .iter_mut()
                            .find(|existing| existing.id == device.id)
                        {
                            *existing = device;
                        } else {
                            self.devices.push(device);
                        }
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }
}

/// Incremental SSE decoding. Lines, UTF-8 scalars and CRLF may span reads.
#[derive(Default)]
struct Parser {
    line: Vec<u8>,
    event: String,
    data: Vec<u8>,
    had_data: bool,
    after_cr: bool,
    started: bool,
    ready: VecDeque<Event>,
}
impl Parser {
    fn feed(&mut self, bytes: &[u8]) -> Result<(), AccountError> {
        for byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if *byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.line()?;
                    self.after_cr = true;
                }
                b'\n' => self.line()?,
                byte => self.line.push(*byte),
            }
        }
        Ok(())
    }
    fn line(&mut self) -> Result<(), AccountError> {
        let mut line = std::mem::take(&mut self.line);
        if !self.started {
            self.started = true;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        let text = std::str::from_utf8(&line).map_err(|_| invalid())?;
        if text.is_empty() {
            if self.had_data {
                // SSE's final data newline is not part of the dispatched value.
                self.data.pop();
                if let Some(event) = parse_event(&self.event, &self.data)? {
                    self.ready.push_back(event);
                }
            }
            self.event.clear();
            self.data.clear();
            self.had_data = false;
        } else if !text.starts_with(':') {
            let (field, value) = text.split_once(':').unwrap_or((text, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => {
                    self.event.clear();
                    self.event.push_str(value);
                }
                "data" => {
                    self.data.extend_from_slice(value.as_bytes());
                    self.data.push(b'\n');
                    self.had_data = true;
                }
                _ => {}
            }
        }
        line.clear();
        self.line = line;
        Ok(())
    }
}
fn parse_event(name: &str, data: &[u8]) -> Result<Option<Event>, AccountError> {
    fn json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, AccountError> {
        serde_json::from_slice(bytes).map_err(|_| invalid())
    }
    Ok(Some(match name {
        "snapshot" => Event::Snapshot(json(data)?),
        "delta" => Event::Delta(json(data)?),
        "resume" => Event::Resume(json(data)?),
        "browser-session-ended" | "browser-sessions-changed" => {
            if !json::<serde_json::Value>(data)?.is_null() {
                return Err(invalid());
            }
            if name == "browser-session-ended" {
                Event::SessionEnded
            } else {
                Event::SessionsChanged
            }
        }
        "browser-presence" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Presence {
                active_delegation_ids: Vec<String>,
            }
            let presence: Presence = json(data)?;
            let ids = presence.active_delegation_ids;
            if ids.len() > 256
                || ids.iter().any(|id| id.is_empty() || id.len() > 128)
                || ids
                    .iter()
                    .enumerate()
                    .any(|(at, id)| ids[..at].contains(id))
            {
                return Err(invalid());
            }
            Event::Presence(ids)
        }
        _ => return Ok(None),
    }))
}

pub struct Stream {
    response: reqwest::Response,
    parser: Parser,
    byte_deadline: tokio::time::Instant,
}
impl Stream {
    /// Cancellation leaves all decoded events queued and partial lines intact.
    pub async fn next(&mut self) -> Result<Option<Event>, AccountError> {
        loop {
            if let Some(event) = self.parser.ready.pop_front() {
                return Ok(Some(event));
            }
            // Same 35 s wire keepalive contract as the browser. Comments count
            // as progress too; cancelling next never extends a stalled stream.
            let Some(chunk) = tokio::time::timeout_at(self.byte_deadline, self.response.chunk())
                .await
                .map_err(|_| {
                    AccountError::Unreachable("device stream stopped sending bytes".into())
                })??
            else {
                return Ok(None);
            };
            if !chunk.is_empty() {
                self.byte_deadline =
                    tokio::time::Instant::now() + std::time::Duration::from_secs(35);
            }
            self.parser.feed(&chunk)?;
        }
    }
}
impl Account {
    pub async fn devices(
        &self,
        credentials: &Credentials,
        cursor: Option<&Cursor>,
    ) -> Result<Stream, AccountError> {
        self.authorized(credentials, |token| async move {
            let mut request = self
                .http
                .get(format!("{}/api/devices/events", self.origin))
                .bearer_auth(&*token)
                .header(header::ORIGIN, &self.origin)
                .header(header::ACCEPT, "text/event-stream");
            if let Some(cursor) = cursor {
                if !cursor.valid() {
                    return Err(invalid());
                }
                request = request.header("x-merkur-device-events-since", cursor.header());
            }
            let response = self.checked(request).await?;
            if response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(str::trim)
                != Some("text/event-stream")
            {
                return Err(invalid());
            }
            Ok(Stream {
                response,
                parser: Parser::default(),
                byte_deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(35),
            })
        })
        .await
    }
}
fn invalid() -> AccountError {
    AccountError::Invalid("device events")
}

#[cfg(test)]
mod tests;
