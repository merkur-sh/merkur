//! Terminal UI effects are typed reliable CTRL records, never host escape bytes.

use zeroize::Zeroizing;

use crate::protocol::{MSG_TYPE_TERMINAL_UI, encode_proto_frame};

pub const TEXT_BYTES_MAX: usize = 2_048;
pub const CLIPBOARD_BYTES_MAX: usize = 2 * 1_024 * 1_024;

#[derive(Clone, PartialEq, Eq)]
pub enum TerminalUi {
    /// Empty restores the client's own title.
    Title(String),
    Bell,
    Notification {
        title: String,
        body: String,
    },
    /// Write only. No terminal operation may read the host clipboard.
    Clipboard {
        selection: u8,
        text: Zeroizing<String>,
    },
}

impl std::fmt::Debug for TerminalUi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Title(title) => f.debug_tuple("Title").field(title).finish(),
            Self::Bell => f.write_str("Bell"),
            Self::Notification { title, body } => f
                .debug_struct("Notification")
                .field("title", title)
                .field("body", body)
                .finish(),
            Self::Clipboard { selection, text } => f
                .debug_struct("Clipboard")
                .field("selection", selection)
                .field("bytes", &text.len())
                .finish(),
        }
    }
}

pub fn safe_text(text: &str) -> bool {
    text.len() <= TEXT_BYTES_MAX && !text.chars().any(char::is_control)
}

impl TerminalUi {
    pub fn valid(&self) -> bool {
        match self {
            Self::Title(title) => safe_text(title),
            Self::Bell => true,
            Self::Notification { title, body } => {
                safe_text(title)
                    && safe_text(body)
                    && !title.contains(';')
                    && title.len() + body.len() <= TEXT_BYTES_MAX
            }
            Self::Clipboard { selection, text } => {
                matches!(selection, b'c' | b'p') && text.len() <= CLIPBOARD_BYTES_MAX
            }
        }
    }

    pub fn text_bytes(&self) -> usize {
        match self {
            Self::Title(text) => text.len(),
            Self::Clipboard { text, .. } => text.len(),
            Self::Notification { title, body } => title.len() + body.len(),
            Self::Bell => 0,
        }
    }

    pub fn encode(&self) -> Option<Zeroizing<Vec<u8>>> {
        if !self.valid() {
            return None;
        }
        let mut body = Zeroizing::new(Vec::with_capacity(4 + self.text_bytes()));
        match self {
            Self::Title(title) => {
                body.push(0);
                body.extend_from_slice(title.as_bytes());
            }
            Self::Bell => body.push(1),
            Self::Notification { title, body: text } => {
                body.push(2);
                body.extend_from_slice(&(title.len() as u16).to_be_bytes());
                body.extend_from_slice(title.as_bytes());
                body.extend_from_slice(text.as_bytes());
            }
            Self::Clipboard { selection, text } => {
                body.extend_from_slice(&[3, *selection]);
                body.extend_from_slice(text.as_bytes());
            }
        }
        Some(Zeroizing::new(encode_proto_frame(
            MSG_TYPE_TERMINAL_UI,
            &body,
        )))
    }

    pub fn decode(body: &[u8]) -> Option<Self> {
        let (&kind, bytes) = body.split_first()?;
        let value = match kind {
            0 if bytes.len() <= TEXT_BYTES_MAX => {
                Self::Title(std::str::from_utf8(bytes).ok()?.into())
            }
            1 if bytes.is_empty() => Self::Bell,
            2 if bytes.len() <= TEXT_BYTES_MAX + 2 => {
                let (length, rest) = bytes.split_first_chunk::<2>()?;
                let (title, text) =
                    rest.split_at_checked(usize::from(u16::from_be_bytes(*length)))?;
                let title = std::str::from_utf8(title).ok()?;
                let text = std::str::from_utf8(text).ok()?;
                Self::Notification {
                    title: title.into(),
                    body: text.into(),
                }
            }
            3 if bytes.len() <= CLIPBOARD_BYTES_MAX + 1 => {
                let (&selection, text) = bytes.split_first()?;
                if !matches!(selection, b'c' | b'p') {
                    return None;
                }
                Self::Clipboard {
                    selection,
                    text: Zeroizing::new(std::str::from_utf8(text).ok()?.into()),
                }
            }
            _ => return None,
        };
        value.valid().then_some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::decode_proto_frame;

    #[test]
    fn rust_and_typescript_share_the_same_effect_vectors() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/test-vectors/terminal-ui.json"))
                .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let hex = fixture["bodyHex"].as_str().unwrap();
            let body = (0..hex.len())
                .step_by(2)
                .map(|i| {
                    let digits = hex.get(i..i + 2).expect("an even number of hex digits");
                    u8::from_str_radix(digits, 16).unwrap()
                })
                .collect::<Vec<_>>();
            let decoded = TerminalUi::decode(&body);
            let expected = &fixture["expected"];
            let value = match decoded {
                None => serde_json::Value::Null,
                Some(TerminalUi::Title(title)) => {
                    serde_json::json!({ "kind": "title", "title": title })
                }
                Some(TerminalUi::Bell) => serde_json::json!({ "kind": "bell" }),
                Some(TerminalUi::Notification { title, body }) => {
                    serde_json::json!({ "kind": "notification", "title": title, "body": body })
                }
                Some(TerminalUi::Clipboard { selection, text }) => {
                    serde_json::json!({ "kind": "clipboard", "selection": (selection as char).to_string(), "text": *text })
                }
            };
            assert_eq!(&value, expected, "{}", fixture["name"]);
        }
    }

    #[test]
    fn canonical_effects_round_trip_and_clipboard_debug_redacts_content() {
        for value in [
            TerminalUi::Title("neovim · λ".into()),
            TerminalUi::Title(String::new()),
            TerminalUi::Bell,
            TerminalUi::Notification {
                title: "done".into(),
                body: "a;b;c".into(),
            },
            TerminalUi::Clipboard {
                selection: b'c',
                text: Zeroizing::new("secret\n\x1b[31m".into()),
            },
        ] {
            let frame = value.encode().unwrap();
            let (kind, body) = decode_proto_frame(&frame).unwrap();
            assert_eq!(kind, MSG_TYPE_TERMINAL_UI);
            assert_eq!(TerminalUi::decode(body), Some(value.clone()));
            if matches!(value, TerminalUi::Clipboard { .. }) {
                assert!(!format!("{value:?}").contains("secret"));
            }
        }
    }

    #[test]
    fn effects_reject_host_controls_unknown_selectors_and_bad_extents() {
        for bytes in [
            &b"\x00x\x1b]52"[..],
            b"\x00\xc2\x9c",
            b"\x01x",
            b"\x02\x00\x08x",
            b"\x03sdata",
            b"\x03?data",
            b"\x04",
            b"\x00\xff",
            b"\x02\x00\x01;body",
        ] {
            assert_eq!(TerminalUi::decode(bytes), None);
        }
        assert_eq!(
            TerminalUi::decode(&vec![b'x'; CLIPBOARD_BYTES_MAX + 3]),
            None
        );
        assert_eq!(
            TerminalUi::Title("x".repeat(TEXT_BYTES_MAX + 1)).encode(),
            None
        );
    }
}
