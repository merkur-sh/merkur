//! OSC 8 definitions received on the authenticated reliable control lane.
use merkur_wire::protocol::{DISPLAY_LINK_TABLE_FLAG_RESET, PROTO_MAX_BODY_BYTES};
use std::{collections::BTreeMap, rc::Rc};

#[derive(Default)]
pub struct Links {
    definitions: BTreeMap<u32, Rc<str>>,
    revision: u64,
}
impl Links {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn entries(&self) -> impl ExactSizeIterator<Item = (u32, &str)> {
        self.definitions.iter().map(|(&id, uri)| (id, uri.as_ref()))
    }
    pub fn uri(&self, id: u32) -> Option<&str> {
        self.definitions.get(&id).map(|uri| uri.as_ref())
    }
    pub fn clear(&mut self) {
        self.definitions.clear();
        self.revision = self
            .revision
            .checked_add(1)
            .expect("link revision namespace");
    }
    /// A malformed frame changes nothing. A definition set can span many
    /// frames; only the frame body is bounded by the wire length.
    pub fn receive(&mut self, body: &[u8]) -> bool {
        if body.len() > PROTO_MAX_BODY_BYTES {
            return false;
        }
        let Some((&flags, mut remaining)) = body.split_first() else {
            return false;
        };
        if flags & !DISPLAY_LINK_TABLE_FLAG_RESET != 0 {
            return false;
        }
        let reset = flags & DISPLAY_LINK_TABLE_FLAG_RESET != 0;
        let mut additions = BTreeMap::new();
        while !remaining.is_empty() {
            let Some(header) = remaining.get(..8) else {
                return false;
            };
            let id = u32::from_be_bytes(header[..4].try_into().expect("four bytes"));
            let length = u32::from_be_bytes(header[4..].try_into().expect("four bytes")) as usize;
            let Some(encoded) = remaining.get(8..).and_then(|tail| tail.get(..length)) else {
                return false;
            };
            let Ok(uri) = std::str::from_utf8(encoded) else {
                return false;
            };
            if id == 0 {
                return false;
            }
            // Identity never names a different URI inside a retained lineage.
            if (!reset && self.uri(id).is_some_and(|old| old != uri))
                || additions.insert(id, uri).is_some_and(|old| old != uri)
            {
                return false;
            }
            remaining = &remaining[8 + length..];
        }
        if reset {
            self.clear();
        }
        for (id, uri) in additions {
            if self.uri(id) != Some(uri) {
                self.definitions.insert(id, Rc::from(uri));
                self.revision = self
                    .revision
                    .checked_add(1)
                    .expect("link revision namespace");
            }
        }
        true
    }
}

/// Only web URIs with no parser controls may be written into host OSC 8.
/// The daemon also vets them before assigning an identity.
pub fn host_uri(uri: &str) -> Option<&str> {
    merkur_wire::protocol::openable_url(uri.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn table(reset: bool, entries: &[(u32, &str)]) -> Vec<u8> {
        let mut body = vec![u8::from(reset)];
        for &(id, uri) in entries {
            body.extend_from_slice(&id.to_be_bytes());
            body.extend_from_slice(&(uri.len() as u32).to_be_bytes());
            body.extend_from_slice(uri.as_bytes());
        }
        body
    }
    #[test]
    fn tables_replace_extend_and_reject_partial_or_redefined_identities_atomically() {
        let mut links = Links::default();
        assert!(links.receive(&table(true, &[(17, "https://a.example")])));
        let revision = links.revision();
        assert!(links.receive(&table(false, &[(17, "https://a.example")])));
        assert_eq!(links.revision(), revision);
        assert!(!links.receive(&table(
            false,
            &[(23, "https://b.example"), (17, "https://changed.example")]
        )));
        assert_eq!(links.uri(17), Some("https://a.example"));
        assert_eq!(links.uri(23), None);
        let full = table(false, &[(23, "https://b.example")]);
        for length in 2..full.len() {
            assert!(!links.receive(&full[..length]));
        }
        assert_eq!(links.uri(23), None);
        assert!(links.receive(&full));
        assert!(links.receive(&table(true, &[(31, "https://c.example")])));
        assert_eq!(links.uri(17), None);
        assert_eq!(links.uri(31), Some("https://c.example"));
    }

    #[test]
    fn invalid_headers_utf8_and_duplicate_identities_leave_the_table_intact() {
        let mut links = Links::default();
        assert!(links.receive(&table(true, &[(1, "https://a.example")])));
        let revision = links.revision();
        for body in [
            vec![],
            vec![2],
            table(true, &[(0, "https://b.example")]),
            table(true, &[(2, "https://b.example"), (2, "https://c.example")]),
            vec![1, 0, 0, 0, 2, 0, 0, 0, 1, 0xff],
        ] {
            assert!(!links.receive(&body));
            assert_eq!(links.uri(1), Some("https://a.example"));
            assert_eq!(links.revision(), revision);
        }
    }

    #[test]
    fn definition_sets_continue_across_more_than_one_frame_body() {
        let mut links = Links::default();
        let uri = format!("https://a.example/{}", "x".repeat(1024 * 1024));
        for id in 1..=17 {
            assert!(links.receive(&table(id == 1, &[(id, &uri)])));
        }
        assert_eq!(links.definitions.len(), 17);
        assert!(links.receive(&table(true, &[(23, "https://b.example")])));
        assert_eq!(links.definitions.len(), 1);
    }

    #[test]
    fn host_links_cannot_inject_commands_or_open_non_web_schemes() {
        for uri in [
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://a\u{1b}[2J",
            "https://a\u{9c}x",
            "https://a\n",
            "https://",
            "https://a b",
            "https://é.example",
        ] {
            assert_eq!(host_uri(uri), None);
        }
        assert_eq!(
            host_uri("HTTPS://a.example/%1b?q=%C3%A9t%C3%A9"),
            Some("HTTPS://a.example/%1b?q=%C3%A9t%C3%A9")
        );
    }
}
