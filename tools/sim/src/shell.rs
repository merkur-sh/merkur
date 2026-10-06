//! The program on the daemon's PTY: a line editor that echoes what it is typed
//! and answers Enter with a fresh prompt, as an interactive shell does with a
//! terminal in canonical mode. It records every byte the terminal wrote to it
//! and every byte it wrote back, for a scenario's invariants.

use std::sync::{Arc, Mutex};

use merkur_dataplane::sim::Shell;

pub const PROMPT: &str = "$ ";

/// What crossed the PTY, in order, across every boot of the daemon host.
#[derive(Clone, Default)]
pub struct Transcript(Arc<Mutex<Transcribed>>);

#[derive(Clone, Default, Debug)]
pub struct Transcribed {
    /// Bytes the terminal wrote to the program, every boot's: the encoded
    /// input.
    pub input: Vec<u8>,
    /// Bytes the current boot's program wrote to its terminal: a rebooted
    /// daemon host starts a new program on a new screen.
    pub output: Vec<u8>,
    /// Programs started.
    pub boots: u32,
}

impl Transcript {
    pub fn read(&self) -> Transcribed {
        self.0.lock().expect("transcript").clone()
    }

    fn boot(&self) {
        let mut transcribed = self.0.lock().expect("transcript");
        transcribed.output.clear();
        transcribed.boots += 1;
    }

    fn input(&self, bytes: &[u8]) {
        self.0
            .lock()
            .expect("transcript")
            .input
            .extend_from_slice(bytes);
    }

    fn output(&self, bytes: &[u8]) {
        self.0
            .lock()
            .expect("transcript")
            .output
            .extend_from_slice(bytes);
    }
}

/// A command line that prints [`FLOOD_LINES`] numbered lines, as `cat` of a
/// large file does: a burst the display is still delivering when a scenario
/// cuts the network.
pub const FLOOD: &str = "flood";
pub const FLOOD_LINES: usize = 400;

/// The last line a flood prints.
pub fn flood_tail() -> String {
    flood_line(FLOOD_LINES - 1)
}

fn flood_line(index: usize) -> String {
    format!("flood {index:04} the quick brown fox jumps over the lazy dog")
}

pub async fn run(mut shell: Shell, transcript: Transcript) {
    transcript.boot();
    if !write(&mut shell, &transcript, PROMPT.as_bytes().to_vec()).await {
        return;
    }
    // The current line, which a backspace may erase.
    let mut line = String::new();
    while let Some(input) = shell.read().await {
        transcript.input(&input);
        let mut output = Vec::new();
        for byte in input {
            match byte {
                b'\r' | b'\n' => {
                    output.extend_from_slice(b"\r\n");
                    if line == FLOOD {
                        for index in 0..FLOOD_LINES {
                            output.extend_from_slice(flood_line(index).as_bytes());
                            output.extend_from_slice(b"\r\n");
                        }
                    }
                    output.extend_from_slice(PROMPT.as_bytes());
                    line.clear();
                }
                0x7f | 0x08 if !line.is_empty() => {
                    output.extend_from_slice(b"\x08 \x08");
                    line.pop();
                }
                0x20..=0x7e => {
                    output.push(byte);
                    line.push(char::from(byte));
                }
                _ => {}
            }
        }
        if !output.is_empty() && !write(&mut shell, &transcript, output).await {
            return;
        }
    }
}

async fn write(shell: &mut Shell, transcript: &Transcript, bytes: Vec<u8>) -> bool {
    transcript.output(&bytes);
    shell.write(bytes).await
}
