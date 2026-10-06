//! Current title plus a bounded queue of effects for attached, authenticated clients.

use merkur_wire::terminal_ui::{CLIPBOARD_BYTES_MAX, TerminalUi};
use std::collections::VecDeque;

const EVENTS_MAX: usize = 16;

pub struct Effects {
    pub title: TerminalUi,
    pub title_revision: u64,
    pub newest: u64,
    events: VecDeque<(u64, TerminalUi)>,
    bytes: usize,
}

impl Default for Effects {
    fn default() -> Self {
        Self {
            title: TerminalUi::Title(String::new()),
            title_revision: 1,
            newest: 0,
            events: VecDeque::new(),
            bytes: 0,
        }
    }
}

impl Effects {
    pub fn title(&mut self, title: String) {
        let value = TerminalUi::Title(title);
        if !value.valid() || self.title == value {
            return;
        }
        let Some(revision) = self.title_revision.checked_add(1) else {
            return;
        };
        self.title = value;
        self.title_revision = revision;
    }

    pub fn push(&mut self, effect: TerminalUi) {
        if !effect.valid() {
            return;
        }
        let Some(next) = self.newest.checked_add(1) else {
            return;
        };
        let bytes = effect.text_bytes();
        // A child cannot retain arbitrarily many clipboard writes while a
        // carrier refuses admission. Keep the newest within both hard budgets.
        while self.events.len() >= EVENTS_MAX || self.bytes + bytes > CLIPBOARD_BYTES_MAX {
            self.pop();
        }
        self.newest = next;
        self.bytes += bytes;
        self.events.push_back((next, effect));
    }

    pub fn after(&self, sequence: u64) -> impl Iterator<Item = &(u64, TerminalUi)> {
        let start = self.events.partition_point(|(seq, _)| *seq <= sequence);
        self.events.range(start..)
    }

    pub fn retire(&mut self, through: u64) {
        while self.events.front().is_some_and(|(seq, _)| *seq <= through) {
            self.pop();
        }
    }

    fn pop(&mut self) {
        if let Some((_, event)) = self.events.pop_front() {
            self.bytes -= event.text_bytes();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    #[test]
    fn latest_title_survives_event_retirement_and_invalid_changes() {
        let mut ui = Effects::default();
        ui.title("nvim".into());
        ui.title("nvim".into());
        ui.title("injected\x1b]52".into());
        assert_eq!(ui.title_revision, 2);
        ui.push(TerminalUi::Bell);
        ui.retire(ui.newest);
        assert_eq!(ui.title, TerminalUi::Title("nvim".into()));
        assert_eq!(ui.after(0).count(), 0);
        ui.title(String::new());
        assert_eq!(ui.title_revision, 3);
    }

    #[test]
    fn effects_have_a_byte_budget_and_retire_only_the_sent_frontier() {
        let mut ui = Effects::default();
        let clipboard = || TerminalUi::Clipboard {
            selection: b'c',
            text: Zeroizing::new("x".repeat(CLIPBOARD_BYTES_MAX)),
        };
        ui.push(clipboard());
        ui.push(clipboard());
        assert_eq!(ui.after(0).map(|(seq, _)| *seq).collect::<Vec<_>>(), [2]);
        for _ in 0..EVENTS_MAX {
            ui.push(TerminalUi::Bell);
        }
        assert_eq!(ui.bytes, 0);
        assert_eq!(ui.events.len(), EVENTS_MAX);
        ui.retire(5);
        assert_eq!(ui.after(0).next().map(|(seq, _)| *seq), Some(6));
    }
}
