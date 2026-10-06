//! Fixed host sequences for typed remote effects. No raw remote ANSI reaches the host.

use base64::Engine;
use merkur_wire::terminal_ui::{CLIPBOARD_BYTES_MAX, TerminalUi, safe_text};
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Effects {
    pending: VecDeque<(u64, TerminalUi)>,
    bytes: usize,
    title: String,
}

impl Effects {
    pub fn accept(&mut self, tab: u64, effect: TerminalUi) -> bool {
        if !effect.valid() {
            return false;
        }
        let bytes = effect.text_bytes();
        while self.pending.len() >= 16 || self.bytes + bytes > CLIPBOARD_BYTES_MAX {
            if let Some((_, old)) = self.pending.pop_front() {
                self.bytes -= old.text_bytes();
            }
        }
        self.bytes += bytes;
        self.pending.push_back((tab, effect));
        true
    }

    pub fn frame(&mut self, title: &str, clipboard_tab: Option<u64>, out: &mut Vec<u8>) {
        if self.title != title && safe_text(title) {
            out.extend_from_slice(b"\x1b]2;");
            out.extend_from_slice(title.as_bytes());
            out.extend_from_slice(b"\x1b\\");
            self.title.clear();
            self.title.push_str(title);
        }
        for (tab, effect) in self.pending.drain(..) {
            match effect {
                TerminalUi::Bell => out.push(7),
                TerminalUi::Notification { title, body } => {
                    out.extend_from_slice(b"\x1b]777;notify;");
                    out.extend_from_slice(title.as_bytes());
                    out.push(b';');
                    out.extend_from_slice(body.as_bytes());
                    out.extend_from_slice(b"\x1b\\");
                }
                TerminalUi::Clipboard { selection, text } if clipboard_tab == Some(tab) => {
                    out.extend_from_slice(b"\x1b]52;");
                    out.push(selection);
                    out.push(b';');
                    let encoded = zeroize::Zeroizing::new(
                        base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
                    );
                    out.extend_from_slice(encoded.as_bytes());
                    out.extend_from_slice(b"\x1b\\");
                }
                _ => {}
            }
        }
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_is_fixed_base64_and_only_the_still_focused_tab_can_write() {
        let mut effects = Effects::default();
        let copy = || TerminalUi::Clipboard {
            selection: b'c',
            text: zeroize::Zeroizing::new("\x1b]2;injected\x07".into()),
        };
        effects.accept(1, copy());
        let mut out = Vec::new();
        effects.frame("merkur", Some(2), &mut out);
        assert_eq!(out, b"\x1b]2;merkur\x1b\\");
        effects.accept(1, copy());
        out.clear();
        effects.frame("merkur", Some(1), &mut out);
        assert_eq!(out, b"\x1b]52;c;G10yO2luamVjdGVkBw==\x1b\\");
        out.clear();
        effects.frame("merkur", Some(1), &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn notifications_preserve_body_semicolons_and_never_emit_conemu() {
        let mut effects = Effects::default();
        assert!(effects.accept(
            2,
            TerminalUi::Notification {
                title: "done".into(),
                body: "7;rm;a;b".into()
            }
        ));
        assert!(effects.accept(2, TerminalUi::Bell));
        assert!(!effects.accept(
            2,
            TerminalUi::Notification {
                title: "bad\x1b".into(),
                body: "x".into()
            }
        ));
        let mut out = Vec::new();
        effects.frame("merkur", None, &mut out);
        assert!(out.ends_with(b"\x1b]777;notify;done;7;rm;a;b\x1b\\\x07"));
    }
}
