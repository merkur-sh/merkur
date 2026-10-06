//! What the daemon's terminal shows, rebuilt from what its program wrote: a
//! terminal of the emulator the dataplane runs, configured as it configures
//! it, fed the PTY transcript. It never sees the display stream, so a client
//! whose presented grid equals it has converged on the daemon's grid through
//! every snapshot, delta, ACK and repair in between.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;

/// The `cols` by `rows` screen after `output`, each row's blank tail trimmed
/// as the client's grid trims it.
pub fn screen(output: &[u8], cols: u16, rows: u16) -> Vec<String> {
    let config = Config {
        kitty_keyboard: true,
        modify_other_keys: true,
        ..Config::default()
    };
    let mut term = Term::new(
        config,
        &TermSize::new(usize::from(cols), usize::from(rows)),
        VoidListener,
    );
    let mut parser: Processor = Processor::new();
    parser.advance(&mut term, output);
    (0..i32::from(rows))
        .map(|row| {
            let line = &term.grid()[Line(row)];
            (0..usize::from(cols))
                .map(|column| line[Column(column)].c)
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect()
}
