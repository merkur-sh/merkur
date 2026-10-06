//! Kitty Unicode placeholders, interpreted before terminal color resolution.

use crate::diacritics::DIACRITICS;

pub const PLACEHOLDER: char = '\u{10eeee}';

/// Preserve the original SGR encoding, including explicit zero versus default.
/// Applying a palette or reverse-video transformation would corrupt identity.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb([u8; 3]),
}

impl Color {
    fn id(self) -> u32 {
        match self {
            Self::Default => 0,
            Self::Indexed(index) => u32::from(index),
            Self::Rgb([red, green, blue]) => u32::from_be_bytes([0, red, green, blue]),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placeholder {
    pub image_id: u32,
    pub placement_id: u32,
    pub row: u32,
    pub column: u32,
}

#[derive(Clone, Copy)]
struct Previous {
    cell: Placeholder,
    foreground: Color,
    underline: Color,
}

/// One left-to-right traversal of a row. Never carry this state across rows.
#[derive(Default)]
pub struct RowDecoder {
    previous: Option<Previous>,
}

pub fn diacritic_index(character: char) -> Option<u16> {
    DIACRITICS
        .binary_search(&(character as u32))
        .ok()
        .map(|index| index as u16)
}

impl RowDecoder {
    /// Inspect at most three combining marks. Extra marks are not protocol
    /// fields. An invalid protocol mark breaks inheritance; no heuristic repair.
    pub fn cell(
        &mut self,
        character: char,
        marks: &[char],
        foreground: Color,
        underline: Color,
    ) -> Option<Placeholder> {
        let previous = self.previous.take();
        if character != PLACEHOLDER {
            return None;
        }
        let mut fields = [0_u32; 3];
        for (field, mark) in fields.iter_mut().zip(marks) {
            *field = u32::from(diacritic_index(*mark)?);
        }
        if fields[2] > u32::from(u8::MAX) {
            return None;
        }
        if let Some(previous) = previous
            .filter(|previous| previous.foreground == foreground && previous.underline == underline)
        {
            let prior = previous.cell;
            let next_column = prior.column.checked_add(1)?;
            let inherit = match marks.len() {
                0 => {
                    fields[0] = prior.row;
                    fields[1] = next_column;
                    true
                }
                1 if fields[0] == prior.row => {
                    fields[1] = next_column;
                    true
                }
                2 if fields[0] == prior.row && fields[1] == next_column => true,
                _ => false,
            };
            if inherit {
                fields[2] = prior.image_id >> 24;
            }
        }
        let cell = Placeholder {
            image_id: foreground.id() | (fields[2] << 24),
            placement_id: underline.id(),
            row: fields[0],
            column: fields[1],
        };
        self.previous = Some(Previous {
            cell,
            foreground,
            underline,
        });
        (cell.image_id != 0).then_some(cell)
    }
}
