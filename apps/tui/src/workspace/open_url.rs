//! Authenticated program requests remain inert until the user reviews one.
use merkur_wire::protocol::OpenUrlId;
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    process::Stdio,
    sync::Arc,
};

// The daemon retains the same number of pending program requests. This bounds
// retained URL bytes independently of how long the user leaves a tab open.
const PENDING_MAX: usize = 16;

#[derive(Clone)]
pub(super) struct Request {
    pub id: OpenUrlId,
    pub url: Arc<str>,
    pub host: Arc<str>,
}

struct Pending {
    request: Request,
    opening: bool,
}

#[derive(Default)]
pub(super) struct Requests {
    pending: VecDeque<Pending>,
    // Adjacent accepted sequences collapse to one interval. Receipts survive
    // Noise reauthentication, including already handled or evicted requests.
    seen: BTreeMap<u32, BTreeMap<u32, u32>>,
}
impl Requests {
    pub fn accept(&mut self, id: OpenUrlId, url: String) -> Option<bool> {
        if id.seq == 0 {
            return None;
        }
        merkur_wire::protocol::openable_url(url.as_bytes())?;
        let parsed = url::Url::parse(&url).ok()?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return None;
        }
        let host = parsed.host_str()?;
        let seen = self.seen.entry(id.epoch).or_default();
        let before = seen
            .range(..=id.seq)
            .next_back()
            .map(|(&start, &end)| (start, end));
        if before.is_some_and(|(_, end)| end >= id.seq) {
            return Some(false);
        }
        let mut start = id.seq;
        let mut end = id.seq;
        if let Some((old_start, old_end)) = before
            && old_end.checked_add(1) == Some(id.seq)
        {
            start = old_start;
            seen.remove(&old_start);
        }
        if let Some(next) = id.seq.checked_add(1)
            && let Some(old_end) = seen.remove(&next)
        {
            end = old_end;
        }
        seen.insert(start, end);
        let host = Arc::from(host);
        if self.pending.len() == PENDING_MAX {
            self.pending.pop_front();
        }
        self.pending.push_back(Pending {
            request: Request {
                id,
                url: Arc::from(url),
                host,
            },
            opening: false,
        });
        Some(true)
    }
    pub fn first(&self) -> Option<Request> {
        self.pending
            .iter()
            .find(|pending| !pending.opening)
            .map(|pending| pending.request.clone())
    }
    pub fn start(&mut self, id: OpenUrlId) -> bool {
        let Some(pending) = self
            .pending
            .iter_mut()
            .find(|pending| pending.request.id == id)
        else {
            return false;
        };
        if pending.opening {
            return false;
        }
        pending.opening = true;
        true
    }
    pub fn finish(&mut self, id: OpenUrlId, success: bool) {
        if success {
            self.remove(id);
        } else if let Some(pending) = self
            .pending
            .iter_mut()
            .find(|pending| pending.request.id == id)
        {
            pending.opening = false;
        }
    }
    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn remove(&mut self, id: OpenUrlId) {
        self.pending.retain(|pending| pending.request.id != id);
    }
}

/// The child is owned by a cancellable UI task. Waiting never blocks the UI;
/// dropping that task terminates its opener child without waiting for a browser.
pub(super) async fn open(request: &Request) -> io::Result<()> {
    use tokio::process::Command;
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "macos")]
    command.arg("--");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("/usr/bin/xdg-open");
    let status = command
        .arg(request.url.as_ref())
        .env_remove("BROWSER")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("URL opener exited with {status}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(epoch: u32, seq: u32) -> OpenUrlId {
        OpenUrlId { epoch, seq }
    }
    #[test]
    fn receipts_deduplicate_reordered_requests_and_compress_contiguous_runs() {
        let mut requests = Requests::default();
        for seq in [3, 1, 2, 5, 4] {
            assert_eq!(
                requests.accept(id(7, seq), format!("https://example.com/{seq}")),
                Some(true)
            );
        }
        assert_eq!(requests.seen[&7], BTreeMap::from([(1, 5)]));
        requests.remove(id(7, 3));
        assert_eq!(
            requests.accept(id(7, 3), "https://example.com/3".into()),
            Some(false)
        );
        assert_eq!(
            requests.accept(id(8, 3), "https://example.com/new-process".into()),
            Some(true)
        );
        assert_eq!(requests.len(), 5);
    }
    #[test]
    fn pending_bytes_are_bounded_and_evicted_requests_cannot_reappear() {
        let mut requests = Requests::default();
        for seq in 1..=100 {
            assert_eq!(
                requests.accept(id(1, seq), "https://example.com/".into()),
                Some(true)
            );
        }
        assert_eq!(requests.len(), PENDING_MAX);
        assert_eq!(requests.first().unwrap().id.seq, 85);
        assert_eq!(requests.seen[&1], BTreeMap::from([(1, 100)]));
        assert_eq!(
            requests.accept(id(1, 1), "https://example.com/".into()),
            Some(false)
        );
    }
    #[test]
    fn schemes_and_authority_are_parsed_before_any_opener_can_run() {
        let mut requests = Requests::default();
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://",
            "https://[bad]/",
        ] {
            assert_eq!(requests.accept(id(1, 1), url.into()), None);
        }
        assert_eq!(
            requests.accept(id(1, 1), "https://trusted.example@real.example/path".into()),
            Some(true)
        );
        assert_eq!(requests.first().unwrap().host.as_ref(), "real.example");
    }
    #[test]
    fn an_opening_request_cannot_be_launched_twice_and_failed_launches_can_be_retried() {
        let mut requests = Requests::default();
        let first = id(1, 1);
        let next = id(1, 2);
        requests.accept(first, "https://example.com/1".into());
        assert!(requests.start(first));
        assert!(!requests.start(first));
        assert!(requests.first().is_none());
        assert_eq!(
            requests.accept(first, "https://example.com/1".into()),
            Some(false)
        );
        assert!(requests.first().is_none());
        requests.accept(next, "https://example.com/2".into());
        assert_eq!(requests.first().unwrap().id, next);
        requests.finish(first, false);
        assert_eq!(requests.first().unwrap().id, first);
        assert!(requests.start(first));
        requests.finish(first, true);
        assert_eq!(requests.first().unwrap().id, next);
        assert_eq!(requests.len(), 1);
    }
}
