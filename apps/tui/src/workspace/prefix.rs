//! A physical key's press decides where its repeats and release go. A tab
//! switch cannot transfer that ownership to another remote application.

use crate::host_input::HostEvent;
use merkur_wire::input_record::{InputRecord, KeyEvent, KeyRecord, KeyText, decode, mods};
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Route {
    Forward(Option<u64>),
    Command(Option<char>),
    Discard,
}

#[derive(Default)]
pub(super) struct Prefix {
    pub active: bool,
    held: HashMap<u32, Option<u64>>,
}
impl Prefix {
    // Dialog input belongs to the local UI, but releases still retire the
    // remote press that owns them. Repeats must not type into that application
    // while a password or management dialog has focus.
    pub fn dialog_route(&mut self, event: &HostEvent) -> Route {
        self.active = false;
        if let HostEvent::Record(record) = event
            && let Some(InputRecord::Key(key)) = decode(record)
        {
            match key.event {
                KeyEvent::Release => {
                    return match self.held.remove(&key.key) {
                        Some(Some(target)) => Route::Forward(Some(target)),
                        Some(None) => Route::Discard,
                        None => Route::Forward(None),
                    };
                }
                KeyEvent::Press => {
                    self.held.insert(key.key, None);
                }
                KeyEvent::Repeat => {}
            }
        }
        Route::Forward(None)
    }

    pub fn route(&mut self, event: &HostEvent, selected: Option<u64>) -> Route {
        let HostEvent::Record(record) = event else {
            return Route::Forward(selected);
        };
        let character = match decode(record) {
            Some(InputRecord::Key(key)) => {
                if key.event == KeyEvent::Release {
                    return match self.held.remove(&key.key) {
                        Some(None) => Route::Discard,
                        Some(target) => Route::Forward(target),
                        None => Route::Forward(selected),
                    };
                }
                if key.event == KeyEvent::Repeat {
                    return match self.held.get(&key.key) {
                        Some(None) => Route::Discard,
                        Some(target) => Route::Forward(*target),
                        None => Route::Forward(selected),
                    };
                }
                let control_prefix = key.base.unwrap_or(key.key) == u32::from('\\')
                    && key.mods & !mods::LOCKS == mods::CTRL;
                if control_prefix {
                    self.active = !self.active;
                    self.held
                        .insert(key.key, if self.active { None } else { selected });
                    return if self.active {
                        Route::Discard
                    } else {
                        Route::Forward(selected)
                    };
                }
                self.held
                    .insert(key.key, if self.active { None } else { selected });
                key_character(key)
            }
            Some(InputRecord::Text(text)) if text.chars().count() == 1 => text.chars().next(),
            _ => return Route::Forward(selected),
        };
        if self.active {
            self.active = false;
            Route::Command(character)
        } else {
            Route::Forward(selected)
        }
    }
}

/// Local commands use the character the host reports, including Shift-? on
/// enhanced keyboards. Control/Alt combinations still belong to the machine.
pub(super) fn key_character(key: KeyRecord<'_>) -> Option<char> {
    if key.mods & !(mods::LOCKS | mods::SHIFT) != 0 {
        return None;
    }
    match key.text {
        KeyText::Implied(c) => Some(c),
        KeyText::Explicit(text) => {
            let mut chars = text.chars();
            let c = chars.next()?;
            chars.next().is_none().then_some(c)
        }
        KeyText::None => char::from_u32(if key.mods & mods::SHIFT != 0 {
            key.shifted.unwrap_or(key.key)
        } else {
            key.key
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use merkur_wire::input_record::build;
    fn key(code: char, event: u8, modifiers: u8) -> HostEvent {
        HostEvent::Record(build::functional(u32::from(code), event, modifiers))
    }
    #[test]
    fn shifted_help_uses_reported_text_and_keeps_its_release_local() {
        let mut prefix = Prefix::default();
        let mut parser = crate::host_input::HostInput::default();
        let mut events = Vec::new();
        parser.feed(b"\x1b[47:63;2u\x1b[47:63;2:3u", &mut events);
        prefix.route(&key('\\', 0, mods::CTRL), Some(7));
        assert_eq!(prefix.route(&events[0], Some(7)), Route::Command(Some('?')));
        assert_eq!(prefix.route(&events[1], Some(7)), Route::Discard);
    }
    #[test]
    fn double_prefix_forwards_its_own_repeats_and_release() {
        let mut prefix = Prefix::default();
        assert_eq!(
            prefix.route(&key('\\', 0, mods::CTRL), Some(1)),
            Route::Discard
        );
        assert_eq!(
            prefix.route(&key('\\', 1, mods::CTRL), Some(1)),
            Route::Discard
        );
        assert!(prefix.active);
        assert_eq!(
            prefix.route(&key('\\', 2, mods::CTRL), Some(1)),
            Route::Discard
        );
        assert_eq!(
            prefix.route(&key('\\', 0, mods::CTRL), Some(1)),
            Route::Forward(Some(1))
        );
        assert!(!prefix.active);
        assert_eq!(
            prefix.route(&key('\\', 1, mods::CTRL), Some(2)),
            Route::Forward(Some(1))
        );
        assert_eq!(
            prefix.route(&key('\\', 2, mods::CTRL), Some(2)),
            Route::Forward(Some(1))
        );
    }
    #[test]
    fn prefix_commands_consume_their_release_and_preserve_other_keys_ownership() {
        let mut prefix = Prefix::default();
        assert_eq!(
            prefix.route(&key('a', 0, 0), Some(1)),
            Route::Forward(Some(1))
        );
        prefix.route(&key('\\', 0, mods::CTRL), Some(1));
        assert_eq!(
            prefix.route(&key('n', 0, 0), Some(1)),
            Route::Command(Some('n'))
        );
        assert_eq!(prefix.route(&key('n', 2, 0), Some(2)), Route::Discard);
        assert_eq!(
            prefix.route(&key('a', 2, 0), Some(2)),
            Route::Forward(Some(1))
        );
        assert_eq!(
            prefix.route(&key('\\', 2, mods::CTRL), Some(2)),
            Route::Discard
        );
    }
    #[test]
    fn dialog_releases_remote_press_once_and_preserves_its_tab() {
        let mut prefix = Prefix::default();
        assert_eq!(
            prefix.route(&key('a', 0, 0), Some(1)),
            Route::Forward(Some(1))
        );
        assert_eq!(prefix.dialog_route(&key('a', 1, 0)), Route::Forward(None));
        assert_eq!(
            prefix.dialog_route(&key('a', 2, 0)),
            Route::Forward(Some(1))
        );
        // It cannot emit a second release, even if another tab is now selected.
        assert_eq!(prefix.dialog_route(&key('a', 2, 0)), Route::Forward(None));
        assert_eq!(
            prefix.route(&key('b', 0, 0), Some(2)),
            Route::Forward(Some(2))
        );
    }

    #[test]
    fn dialog_presses_and_their_later_releases_never_reach_remote_tabs() {
        let mut prefix = Prefix::default();
        prefix.route(&key('a', 0, 0), Some(1));
        assert_eq!(prefix.dialog_route(&key('p', 0, 0)), Route::Forward(None));
        assert_eq!(prefix.dialog_route(&key('p', 1, 0)), Route::Forward(None));
        // Closing the dialog or switching tabs cannot give its held key away.
        assert_eq!(prefix.route(&key('p', 2, 0), Some(2)), Route::Discard);
        assert_eq!(
            prefix.dialog_route(&key('a', 2, 0)),
            Route::Forward(Some(1))
        );
        assert_eq!(
            prefix.dialog_route(&key('\\', 0, mods::CTRL)),
            Route::Forward(None)
        );
        assert!(!prefix.active);
    }
}
