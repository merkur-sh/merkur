//! Where the drawn cursor goes backwards while someone is typing, and what put
//! it there.
//!
//! # The question
//!
//! The renderer draws the cursor at the speculative model's `predicted_cursor`
//! while that model is visible, and at the authoritative cursor otherwise. An
//! outstanding prediction is exactly the state in which those two differ, so
//! **anything that stops the model drawing the cursor is a visible sideways
//! step**, and so is any authoritative frame that carries a cursor behind the
//! one already on screen. Both look identical afterwards: a cursor that jumped
//! left and then caught up. Neither is visible in a row-hash convergence
//! oracle, because both ends agree about the grid the whole time.
//!
//! [`super::sim`] proves a frame left the daemon on time; [`super::viewer`]
//! proves the viewer's grid agrees with the daemon's. Neither says anything
//! about the cursor the viewer *draws*, which is the thing a person watches
//! while typing. This closes that loop:
//!
//! ```text
//!   keystroke -> browser speculative model -> input byte (+ shadow provenance)
//!             -> TerminalState::observe_user_input -> scripted shell echo
//!             -> flush_display -> sealed frames -> term_wasm::Terminal
//!             -> predict_reconcile -> the drawn cursor
//! ```
//!
//! Every arrow above is production code except the shell, which is scripted
//! here, and the browser's control loop, which is [`Browser`] — a transcription
//! of `apps/web/src/terminal-worker.ts`, listed rule by rule on that type.
//!
//! # What it observes
//!
//! `cursor_info_ptr` — the same call the renderer makes — after every event
//! that can move the cursor: the keystroke, the model's answer, each PTY chunk,
//! each flush, each frame applied, each reconciliation. term-wasm's own
//! backwards-step journal supplies the attribution, so a failure names the site
//! that retracted rather than leaving a reader to infer it from a timeline.
//!
//! # What it is not
//!
//! It is not a latency harness and asserts no timing. It is not a frequency
//! measurement either: how often a real fish or zsh session tears its repaint
//! is a property of that shell and that machine, and the answer to it comes
//! from the same journal running in a real browser. What this decides is the
//! question that has to be settled first — **whether a given shape of shell
//! output can step the cursor backwards at all, and through which site.**

use std::fmt::Write as _;

use super::sim::{DisplaySim, SimWake, sim_peer_id};
use super::viewer::SimViewers;

const COLS: u16 = 80;
const ROWS: u16 = 24;
/// Wake cap for one settle. Generous: the cap exists to catch a spinning owner
/// loop, and `run_for_ms` fails outright when it is hit.
const WAKE_CAP: usize = 512;
/// The prediction lifetime the worker passes to `predict_reconcile`, from
/// `DEFAULT_TERMINAL_WORKER_TUNING.predictionTtlMs`.
const PREDICTION_TTL_MS: f64 = 1_000.0;

/// One shell's bytes, in the chunks it writes them.
///
/// Chunking is not a detail. The daemon applies each PTY read and then asks the
/// flush scheduler, which answers *zero* for a drained interactive peer — so a
/// repaint the shell emits as two writes can have a frame flushed between its
/// halves, and that frame describes a screen that never existed as far as the
/// person typing is concerned. A shell that writes its repaint atomically
/// cannot produce that frame. The lab drives both.
trait Shell {
    /// What the shell writes when it draws a new prompt.
    fn prompt(&mut self) -> Vec<Vec<u8>>;
    /// What the shell writes in response to one typed character.
    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>>;
    /// What the shell writes in response to one erase.
    ///
    /// The default is the append-only shell's: step back over the character,
    /// blank it, step back again. A shell that repaints the line overrides it.
    fn erase(&mut self) -> Vec<Vec<u8>> {
        vec![b"\x08 \x08".to_vec()]
    }
    /// What the shell writes when the line is submitted: the newline that
    /// ends it and the next prompt. A shell that keeps a buffer clears it.
    fn submit(&mut self) -> Vec<Vec<u8>> {
        vec![b"\r\n".to_vec(), prompt_bytes()]
    }
}

/// One thing the person at the keyboard did.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Key {
    Print(char),
    /// The one edit the model projects, and the one that moves the predicted
    /// cursor backwards on purpose.
    Backspace,
    /// Submits the line. Deliberately never modelled (`predictionIntent`
    /// returns the flush intent for it), so it reaches the daemon without
    /// shadow provenance and the daemon withdraws the prompt grant on it.
    Enter,
}

/// The `\x1b]133;B\x07` prompt-end marker, unauthenticated.
///
/// The daemon has no token configured in this harness, so the bare form is the
/// grant — the same one an existing iTerm2/kitty/starship integration gives.
const PROMPT_END: &str = "\x1b]133;B\x07";
const PROMPT_TEXT: &str = "$ ";
/// Column the editable region starts at, given `PROMPT_TEXT`.
const PROMPT_COL: u16 = 2;

fn prompt_bytes() -> Vec<u8> {
    format!("\x1b]133;A\x07{PROMPT_TEXT}{PROMPT_END}\x1b[?2004h").into_bytes()
}

/// A shell that echoes the typed character and nothing else.
///
/// The control. Nothing in this shape can contradict a prediction: the echo is
/// exactly what was predicted, it lands in one write, and the cursor advances
/// by one. A backwards step here is a defect in the model or the harness, not
/// in anything a shell did.
struct EchoShell;

impl Shell for EchoShell {
    fn prompt(&mut self) -> Vec<Vec<u8>> {
        vec![prompt_bytes()]
    }

    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>> {
        vec![ch.to_string().into_bytes()]
    }
}

/// A shell that draws an autosuggestion to the right of the cursor.
///
/// fish does this by default and zsh does it with `zsh-autosuggestions`: the
/// echoed character is followed by the rest of a remembered command in a dim
/// colour, and then the cursor is walked back over it. Two consequences the
/// model has to survive — the row tail is no longer blank, which is why
/// prompt-anchored seeding exists at all, and the cursor's final position is
/// reached by moving *left*, so a frame that catches the write half-done
/// carries a cursor several columns right of the truth.
struct SuggestionShell {
    /// What the shell would complete the line to.
    history: String,
    buffer: String,
    /// Whether the cursor walk-back is written separately from the glyphs.
    split_cursor_return: bool,
}

impl SuggestionShell {
    fn new(history: &str, split_cursor_return: bool) -> Self {
        Self {
            history: history.to_string(),
            buffer: String::new(),
            split_cursor_return,
        }
    }

    /// The dim tail the shell would draw after the cursor, if any.
    fn suggestion(&self) -> &str {
        if self.buffer.is_empty() || !self.history.starts_with(&self.buffer) {
            return "";
        }
        &self.history[self.buffer.len()..]
    }
}

impl Shell for SuggestionShell {
    fn prompt(&mut self) -> Vec<Vec<u8>> {
        vec![prompt_bytes()]
    }

    fn submit(&mut self) -> Vec<Vec<u8>> {
        self.buffer.clear();
        vec![b"\x1b[K\r\n".to_vec(), prompt_bytes()]
    }

    fn erase(&mut self) -> Vec<Vec<u8>> {
        self.buffer.pop();
        let suggestion = self.suggestion().to_string();
        let mut out = String::from("\x08");
        if !suggestion.is_empty() {
            out.push_str("\x1b[90m");
            out.push_str(&suggestion);
            out.push_str("\x1b[0m");
        }
        out.push_str("\x1b[K");
        if !suggestion.is_empty() {
            out.push_str(&format!("\x1b[{}D", suggestion.chars().count()));
        }
        vec![out.into_bytes()]
    }

    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>> {
        self.buffer.push(ch);
        let suggestion = self.suggestion().to_string();
        let mut glyphs = String::new();
        glyphs.push(ch);
        if !suggestion.is_empty() {
            // Dim, then the tail, then back to default — the shape both shells
            // use, and the reason the tail is not blank.
            glyphs.push_str("\x1b[90m");
            glyphs.push_str(&suggestion);
            glyphs.push_str("\x1b[0m");
        }
        // Erase whatever the previous, longer suggestion left behind.
        glyphs.push_str("\x1b[K");
        let walk_back = if suggestion.is_empty() {
            String::new()
        } else {
            format!("\x1b[{}D", suggestion.chars().count())
        };
        if walk_back.is_empty() {
            return vec![glyphs.into_bytes()];
        }
        if self.split_cursor_return {
            vec![glyphs.into_bytes(), walk_back.into_bytes()]
        } else {
            vec![format!("{glyphs}{walk_back}").into_bytes()]
        }
    }
}

/// fish 4.7, byte for byte, as captured from a PTY on 2026-09-07 with
/// `fish --no-config` and a history entry the typed line prefixes.
///
/// Three separate writes per keystroke, each ending with `\r` and an absolute
/// cursor-forward so the cursor lands after the typed text: the echoed
/// character; the autosuggestion drawn after the cursor; and a repaint from the
/// prompt end of the buffer plus suggestion. The row's cells never change while
/// the typed prefix matches history — the suggestion already showed them — so
/// every frame between those writes is a header-only cursor move. Once the
/// prefix diverges the suggestion is erased with `\e[K`.
struct FishShell {
    history: String,
    buffer: String,
}

impl FishShell {
    fn new(history: &str) -> Self {
        Self {
            history: history.to_string(),
            buffer: String::new(),
        }
    }

    fn suggestion(&self) -> &str {
        if self.buffer.is_empty() || !self.history.starts_with(&self.buffer) {
            return "";
        }
        &self.history[self.buffer.len()..]
    }

    fn park(&self) -> String {
        format!("\r\x1b[{}C", PROMPT_COL as usize + self.buffer.chars().count())
    }
}

impl Shell for FishShell {
    fn prompt(&mut self) -> Vec<Vec<u8>> {
        vec![prompt_bytes()]
    }

    fn submit(&mut self) -> Vec<Vec<u8>> {
        self.buffer.clear();
        vec![b"\x1b[K\r\n".to_vec(), prompt_bytes()]
    }

    fn erase(&mut self) -> Vec<Vec<u8>> {
        self.buffer.pop();
        vec![format!("\x08\x1b[K{}", self.park()).into_bytes()]
    }

    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>> {
        self.buffer.push(ch);
        let suggestion = self.suggestion().to_string();
        let park = self.park();
        if suggestion.is_empty() {
            return vec![format!("{ch}\x1b[K{park}").into_bytes()];
        }
        let typed = self.buffer.chars().count();
        vec![
            format!("{ch}{park}").into_bytes(),
            format!("{suggestion}{park}").into_bytes(),
            format!("\x1b[{typed}D{}{suggestion}{park}", self.buffer).into_bytes(),
        ]
    }
}

/// A shell that repaints the whole line on every keystroke.
///
/// This is what a syntax highlighter forces: the colours of characters already
/// on screen can change when a later one is typed, so the editor rewrites the
/// row from the prompt rather than appending. `\r`, erase, prompt, buffer.
/// While that write is half-applied the cursor is at column zero and the line
/// is empty — the single most destructive thing a frame can carry, because it
/// contradicts every cell the model's base describes.
struct RedrawShell {
    buffer: String,
    /// Whether the erase is written separately from the reprint.
    split_erase: bool,
    /// Whether the repaint re-emits the prompt-end marker, as an integration
    /// that lives in `PS1` and is redrawn with the prompt does.
    reemit_anchor: bool,
}

impl RedrawShell {
    fn new(split_erase: bool, reemit_anchor: bool) -> Self {
        Self {
            buffer: String::new(),
            split_erase,
            reemit_anchor,
        }
    }
}

impl Shell for RedrawShell {
    fn prompt(&mut self) -> Vec<Vec<u8>> {
        vec![prompt_bytes()]
    }

    fn submit(&mut self) -> Vec<Vec<u8>> {
        self.buffer.clear();
        vec![b"\r\n".to_vec(), prompt_bytes()]
    }

    fn erase(&mut self) -> Vec<Vec<u8>> {
        self.buffer.pop();
        vec![format!("\r\x1b[K{PROMPT_TEXT}{}", self.buffer).into_bytes()]
    }

    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>> {
        self.buffer.push(ch);
        let erase = "\r\x1b[K".to_string();
        let mut reprint = String::new();
        reprint.push_str(PROMPT_TEXT);
        if self.reemit_anchor {
            reprint.push_str(PROMPT_END);
        }
        reprint.push_str(&self.buffer);
        if self.split_erase {
            vec![erase.into_bytes(), reprint.into_bytes()]
        } else {
            vec![format!("{erase}{reprint}").into_bytes()]
        }
    }
}

/// A shell that wraps what it echoes in ordinary control sequences.
///
/// Nothing here is exotic: `CSI 1 m` is bold, which any syntax highlighter or
/// coloured prompt emits, and `CSI 1 C` / `CSI 1 D` is a one-column cursor move,
/// which is how a line editor repositions when `cuf1`/`cub1` are parameterised.
/// The screen this shell paints is identical to [`EchoShell`]'s apart from an
/// attribute, so any difference in what the cursor does is the control
/// sequences and nothing else.
struct MarkupShell {
    before: &'static str,
    after: &'static str,
}

impl Shell for MarkupShell {
    fn prompt(&mut self) -> Vec<Vec<u8>> {
        vec![prompt_bytes()]
    }

    fn keystroke(&mut self, ch: char) -> Vec<Vec<u8>> {
        vec![format!("{}{ch}{}", self.before, self.after).into_bytes()]
    }
}

/// The browser's speculative-echo control loop.
///
/// Every rule here is transcribed from `apps/web/src/terminal-worker.ts` and
/// the modules it composes, and is named with its source so the two can be
/// compared:
///
/// - `handlePredictionCommand` — a covered action is skipped rather than
///   modelled, an open causal barrier rejects, and a rejection re-opens the
///   barrier through its own sequence.
/// - `prediction-input-barrier.ts` — the barrier closes only when authoritative
///   display covers every rejected input.
/// - `commitDisplayReconciliation` — one reconciliation per applied batch, then
///   the barrier is offered that batch's input watermark.
/// - `predictPrintable` — the visibility decision is read once, at the
///   keystroke, and carried to the model on the command.
///
/// The one deliberate simplification is the visibility gate, which is pinned
/// open. Admission is not what this lab is asking about: a line that is never
/// admitted draws its cursor from authority for its whole life and steps
/// nowhere. Pinning it open is the *hostile* setting for the question that is
/// being asked — it maximises the number of moments at which the predicted and
/// authoritative cursors differ, which is exactly when a retraction is visible.
struct Browser {
    /// What the visibility gate answers when a line is seeded. Pinned for a
    /// whole session: a line latches this once and keeps it.
    visible: bool,
    input_seq: u32,
    /// `predictionInputBarrier`'s high water; zero is closed.
    barrier: u32,
    /// Reconciliation outcomes, for the report.
    confirmed: u32,
    mismatched: u32,
    expired_covered: u32,
    expired_stalled: u32,
    deferred: u32,
    /// Keystrokes the model refused, which are the ones that reach the daemon
    /// without shadow provenance.
    unmodelled: u32,
    /// Line submissions. Unmodelled by design, so counted apart from refusals.
    submitted: u32,
    /// Each refusal and the model's own name for it.
    refusals: Vec<(u32, String)>,
}

impl Browser {
    fn new(visible: bool) -> Self {
        Self {
            visible,
            input_seq: 0,
            barrier: 0,
            confirmed: 0,
            mismatched: 0,
            expired_covered: 0,
            expired_stalled: 0,
            deferred: 0,
            unmodelled: 0,
            submitted: 0,
            refusals: Vec::new(),
        }
    }
}

/// One observation of the cursor the renderer would draw.
#[derive(Clone)]
struct Step {
    at_ms: f64,
    label: String,
    row: u16,
    col: u16,
    /// The daemon's own cursor at the same instant, for context: a browser
    /// cursor that steps back to where the daemon says it is, is a retraction;
    /// one that follows the daemon backwards is a torn frame.
    daemon: Option<(usize, usize)>,
}

/// A backwards step of the drawn cursor, with what term-wasm says caused it.
#[derive(Clone)]
struct Regression {
    at_ms: f64,
    label: String,
    from: (u16, u16),
    to: (u16, u16),
    cause: String,
    was_modelled: bool,
    is_modelled: bool,
    line_present: bool,
    line_admitted: bool,
    mode_unsafe: bool,
    ops: u32,
}

struct Lab {
    sim: DisplaySim,
    viewers: SimViewers,
    peer: String,
    browser: Browser,
    shell: Box<dyn Shell>,
    /// Whether a flush is allowed to land between the chunks of one repaint.
    ///
    /// True is the production scheduler's own answer for a drained interactive
    /// peer — zero delay — reached when the next chunk of the shell's write has
    /// not been read yet. False models the same write arriving as one read.
    flush_between_chunks: bool,
    /// How long the shell takes to answer a keystroke. Zero is an ideal shell;
    /// fish under a syntax highlighter and a prompt hook was measured at up to
    /// 100–150 ms per key on 2026-09-07 (`pty_to_read_us`), which is longer
    /// than the round trip it was reported on.
    echo_delay_ms: f64,
    timeline: Vec<Step>,
    regressions: Vec<Regression>,
}

impl Lab {
    fn new(shell: Box<dyn Shell>, flush_between_chunks: bool, gate_open: bool) -> Self {
        let mut sim = DisplaySim::new(COLS, ROWS);
        let viewers = SimViewers::attach(&mut sim, COLS, ROWS);
        let peer = sim_peer_id(0);
        Self {
            sim,
            viewers,
            peer,
            browser: Browser::new(gate_open),
            shell,
            flush_between_chunks,
            echo_delay_ms: 0.0,
            timeline: Vec::new(),
            regressions: Vec::new(),
        }
    }

    /// Draw the prompt, let the session converge, and arm the journal.
    ///
    /// The journal is armed only after the prompt has settled: the first
    /// snapshot moves the cursor from a blank grid's origin to the prompt end,
    /// which is forwards, and every subsequent step is the thing being
    /// measured.
    async fn boot(&mut self) {
        for chunk in self.shell.prompt() {
            self.sim.write_pty(&chunk);
        }
        self.sim.sample_prediction_safety(true);
        self.settle(200.0, "boot").await;
        assert!(
            self.sim.prediction_safe(),
            "the daemon withheld the prompt grant, so nothing here would predict at all"
        );
        assert_eq!(
            self.sim.editor_anchor(),
            Some((0, PROMPT_COL)),
            "the daemon did not capture the prompt anchor at the prompt end"
        );
        assert!(
            self.viewers.viewer(&self.peer).editor_anchors_seen > 0,
            "the prompt anchor never reached the viewer"
        );
        let terminal = self.viewers.viewer(&self.peer).terminal_mut();
        terminal.set_cursor_motion_journal(true);
        terminal.clear_cursor_motion();
        self.observe("armed");
    }

    /// Drive one key through the whole loop.
    async fn press(&mut self, key: Key, inter_key_ms: f64) {
        let now_ms = self.sim.now_ms();
        let seq = self.browser.input_seq + 1;
        self.browser.input_seq = seq;
        let authoritative = self.viewers.viewer(&self.peer).authoritative_input_seq;
        let mut refusal: Option<String> = None;

        // `handlePredictionCommand`: an action authority has already covered
        // can no longer produce a paint, and is dropped without touching the
        // model. It still reached the daemon as ordinary input.
        let covered = authoritative > 0 && seq <= authoritative;
        let modelled = if covered {
            false
        } else if key == Key::Enter {
            // `predictionIntent` answers the flush intent for Enter, and
            // `handlePredictionCommand` opens the barrier through it and seals
            // the model: nothing typed behind a submission is modelled, and
            // nothing already painted is taken back for it.
            self.browser.barrier = self.browser.barrier.max(seq);
            self.viewers
                .viewer(&self.peer)
                .terminal_mut()
                .predict_seal(seq);
            false
        } else if self.browser.barrier != 0 {
            // `classifyPredictionModelAdmission` -> reject_causal, and
            // `rejectIfOpen` extends the barrier over the whole unmodelled run.
            self.browser.barrier = self.browser.barrier.max(seq);
            false
        } else {
            let visible = self.browser.visible;
            let terminal = self.viewers.viewer(&self.peer).terminal_mut();
            // Snapshot the model before the key: a refusal flushes the line,
            // so afterwards there is nothing left to describe.
            let before = terminal.shadow_debug();
            let accepted = match key {
                Key::Print(ch) => terminal.predict_printable(u32::from(ch), now_ms, seq, visible),
                Key::Backspace => terminal.predict_backspace(now_ms, seq),
                Key::Enter => unreachable!("Enter never reaches the model"),
            } != 0;
            if !accepted {
                // A model rejection is itself an unmodelled-input edge, and the
                // reason it refused is the first half of every cascade below:
                // the daemon reads an unmodelled keystroke as grounds to
                // withdraw the prompt grant.
                refusal = Some(format!(
                    "{} :: {before}",
                    term_wasm::cursor_cause_name(terminal.last_flush_cause()),
                ));
                self.browser.barrier = self.browser.barrier.max(seq);
            }
            accepted
        };
        if key == Key::Enter {
            self.browser.submitted += 1;
        } else if !modelled {
            self.browser.unmodelled += 1;
            if let Some(refusal) = refusal.as_deref() {
                self.browser.refusals.push((seq, refusal.to_string()));
            }
        }
        let label = match key {
            Key::Print(ch) => format!("'{ch}'"),
            Key::Backspace => "backspace".to_string(),
            Key::Enter => "enter".to_string(),
        };
        self.observe(&format!(
            "key {label} seq={seq} {}",
            match (modelled, refusal.as_deref()) {
                (true, _) => "modelled".to_string(),
                (false, Some(cause)) => format!("REFUSED {cause}"),
                (false, None) if covered => "SKIPPED covered".to_string(),
                (false, None) if key == Key::Enter => "SEALED".to_string(),
                (false, None) => "REFUSED barrier".to_string(),
            }
        ));

        let mut scratch = [0u8; 4];
        let bytes = match key {
            Key::Print(ch) => ch.encode_utf8(&mut scratch).as_bytes().to_vec(),
            // DEL, which is what a terminal sends for Backspace.
            Key::Backspace => vec![0x7f],
            Key::Enter => vec![b'\r'],
        };
        self.sim.write_input(&self.peer, seq, &bytes, modelled);
        self.observe("input written");
        if self.echo_delay_ms > 0.0 {
            // The daemon has the keystroke and the shell has not answered yet.
            // Frames flushed in here carry the input watermark past the key
            // without any echo, which is the ordering a slow shell produces.
            self.settle(self.echo_delay_ms, "shell latency").await;
        }

        let chunks = match key {
            Key::Print(ch) => self.shell.keystroke(ch),
            Key::Backspace => self.shell.erase(),
            Key::Enter => self.shell.submit(),
        };
        let last = chunks.len().saturating_sub(1);
        for (index, chunk) in chunks.into_iter().enumerate() {
            self.sim.write_pty(&chunk);
            // `main.rs` re-samples the grant on the coalesced arm after every
            // PTY read.
            self.sim.sample_prediction_safety(true);
            if index < last && self.flush_between_chunks {
                // The scheduler's zero-delay answer for a drained interactive
                // peer, reached before the rest of the repaint has been read.
                self.settle(0.0, "torn flush").await;
            }
        }
        self.settle(inter_key_ms, "settle").await;
    }

    async fn type_text(&mut self, text: &str, inter_key_ms: f64) {
        for ch in text.chars() {
            self.press(Key::Print(ch), inter_key_ms).await;
        }
    }

    async fn erase(&mut self, count: usize, inter_key_ms: f64) {
        for _ in 0..count {
            self.press(Key::Backspace, inter_key_ms).await;
        }
    }

    /// Run the owner loop for `budget_ms`, pumping the viewer at every wake.
    ///
    /// A budget of zero still runs any event already due, which is what makes
    /// the torn-flush step above a flush rather than a no-op.
    async fn settle(&mut self, budget_ms: f64, label: &str) {
        let Lab {
            sim,
            viewers,
            peer,
            browser,
            timeline,
            regressions,
            ..
        } = self;
        let mut pending: Vec<(f64, String)> = Vec::new();
        sim.run_for_ms(budget_ms.max(0.0), WAKE_CAP, |sim, wake| {
            let before = viewers.viewer(peer).applied_frames;
            viewers.pump(sim);
            viewers.acknowledge(sim);
            let viewer = viewers.viewer(peer);
            let applied = viewer.applied_frames - before;
            let authoritative = viewer.authoritative_input_seq;
            let echo_horizon = viewer.authoritative_echo_horizon;
            let now_ms = sim.now_ms();
            if applied > 0 {
                // This cursor-semantic lab presents every pumped batch (it is
                // not the browser's coherence scheduler). Explicitly promote
                // the received base before retiring matching speculation.
                let terminal = viewer.terminal_mut();
                terminal.commit_presentation_state();
                if terminal.has_predictions() {
                    terminal.predict_reconcile(
                        now_ms,
                        PREDICTION_TTL_MS,
                        authoritative,
                        echo_horizon,
                    );
                    let stats = reconcile_stats(terminal);
                    browser.confirmed += stats[0];
                    browser.mismatched += stats[1];
                    browser.expired_covered += stats[2];
                    browser.deferred += stats[5];
                    browser.expired_stalled += stats[6];
                }
                if browser.barrier != 0 && authoritative >= browser.barrier {
                    browser.barrier = 0;
                }
            }
            let wake = match wake {
                SimWake::Timer => "flush",
                SimWake::Ack => "ack",
                SimWake::Delivery => "delivery",
                SimWake::BrowserKey => "browser-key",
                SimWake::Input => "input",
                SimWake::Pty => "pty",
            };
            pending.push((now_ms, format!("{label}/{wake} applied={applied}")));
        })
        .await;
        for (at_ms, note) in pending {
            let _ = at_ms;
            Self::record(sim, viewers, peer, timeline, regressions, &note);
        }
        Self::record(sim, viewers, peer, timeline, regressions, label);
    }

    fn observe(&mut self, label: &str) {
        let Lab {
            sim,
            viewers,
            peer,
            timeline,
            regressions,
            ..
        } = self;
        Self::record(sim, viewers, peer, timeline, regressions, label);
    }

    /// Read the cursor the renderer would draw, and drain the journal.
    fn record(
        sim: &DisplaySim,
        viewers: &mut SimViewers,
        peer: &str,
        timeline: &mut Vec<Step>,
        regressions: &mut Vec<Regression>,
        label: &str,
    ) {
        let at_ms = sim.now_ms();
        let daemon = sim.cursor_position();
        let terminal = viewers.viewer(peer).terminal_mut();
        let (col, row) = cursor_info(terminal);
        let drained = cursor_motion(terminal);
        terminal.clear_cursor_motion();
        for record in drained.chunks_exact(term_wasm::CURSOR_MOTION_RECORD_WORDS) {
            let flags = record[4];
            regressions.push(Regression {
                at_ms,
                label: label.to_string(),
                from: ((record[2] >> 16) as u16, record[2] as u16),
                to: ((record[3] >> 16) as u16, record[3] as u16),
                cause: term_wasm::cursor_cause_name(record[1]),
                was_modelled: flags & term_wasm::CURSOR_MOTION_FLAG_WAS_MODELLED != 0,
                is_modelled: flags & term_wasm::CURSOR_MOTION_FLAG_IS_MODELLED != 0,
                line_present: flags & term_wasm::CURSOR_MOTION_FLAG_LINE_PRESENT != 0,
                line_admitted: flags & term_wasm::CURSOR_MOTION_FLAG_LINE_ADMITTED != 0,
                mode_unsafe: flags & term_wasm::CURSOR_MOTION_FLAG_MODE_UNSAFE != 0,
                ops: record[5],
            });
        }
        timeline.push(Step {
            at_ms,
            label: label.to_string(),
            row,
            col,
            daemon,
        });
    }

    /// The whole session, for a failure message.
    fn report(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(
            out,
            "confirmed={} mismatched={} expired(covered/stalled)={}/{} deferred={} \
             unmodelled-keystrokes={} submitted={}",
            self.browser.confirmed,
            self.browser.mismatched,
            self.browser.expired_covered,
            self.browser.expired_stalled,
            self.browser.deferred,
            self.browser.unmodelled,
            self.browser.submitted,
        );
        if !self.browser.refusals.is_empty() {
            let _ = writeln!(out, "-- refused keystrokes --");
            for (seq, cause) in &self.browser.refusals {
                let _ = writeln!(out, "  seq={seq} {cause}");
            }
        }
        let _ = writeln!(out, "-- drawn cursor --");
        let mut previous: Option<(u16, u16)> = None;
        for step in &self.timeline {
            let marker = match previous {
                Some(from) if (step.row, step.col) < from => " <== BACKWARDS",
                _ => "",
            };
            previous = Some((step.row, step.col));
            let daemon = step
                .daemon
                .map_or_else(|| "-".to_string(), |(row, col)| format!("{row},{col}"));
            let _ = writeln!(
                out,
                "  {:>8.2}ms  drawn={},{:<3} daemon={:<6} {}{marker}",
                step.at_ms, step.row, step.col, daemon, step.label
            );
        }
        let _ = writeln!(out, "-- backwards steps, attributed --");
        for regression in &self.regressions {
            let _ = writeln!(
                out,
                "  {:>8.2}ms  {},{} -> {},{}  cause={} modelled={}->{} line={} admitted={} \
                 unsafe={} ops={}  at: {}",
                regression.at_ms,
                regression.from.0,
                regression.from.1,
                regression.to.0,
                regression.to.1,
                regression.cause,
                regression.was_modelled,
                regression.is_modelled,
                regression.line_present,
                regression.line_admitted,
                regression.mode_unsafe,
                regression.ops,
                regression.label,
            );
        }
        out
    }

    /// Fail with the whole session if the cursor ever went backwards.
    fn assert_no_backwards_step(&self, context: &str) {
        assert!(
            self.regressions.is_empty(),
            "{context}: the drawn cursor stepped backwards {} time(s)\n{}",
            self.regressions.len(),
            self.report()
        );
    }

    /// Fail if the speculative model ever took the cursor back.
    ///
    /// The sharper of the two assertions, and the one that survives a shell
    /// whose own output moves the cursor backwards. A retraction has one exact
    /// shape — the model was drawing the cursor and stopped — which is not the
    /// same as the model moving its own projection back, because a Backspace
    /// does that on purpose and the person asked for it.
    fn assert_the_model_never_retracted(&self, context: &str) {
        let retractions: Vec<&Regression> = self
            .regressions
            .iter()
            .filter(|regression| regression.was_modelled && !regression.is_modelled)
            .collect();
        assert!(
            retractions.is_empty(),
            "{context}: the speculative model took the cursor back {} time(s)\n{}",
            retractions.len(),
            self.report()
        );
        assert_eq!(
            self.browser.unmodelled,
            0,
            "{context}: {} keystroke(s) reached the daemon without shadow provenance, which \
             withdraws the prompt grant and ends prediction for the rest of the line\n{}",
            self.browser.unmodelled,
            self.report()
        );
    }
}

/// `[col, row]` from the same export the renderer reads.
fn cursor_info(terminal: &mut term_wasm::Terminal) -> (u16, u16) {
    let len = terminal.cursor_info_len();
    let ptr = terminal.cursor_info_ptr();
    // SAFETY: `cursor_info_ptr` returns the address of the terminal's own fixed
    // `cursor_info_buf`, and `cursor_info_len` is its length. Nothing mutates
    // the terminal while the slice is alive. This is the read the browser's
    // WASM glue performs over the same memory.
    let info = unsafe { std::slice::from_raw_parts(ptr, len) };
    (info[0], info[1])
}

fn reconcile_stats(terminal: &term_wasm::Terminal) -> [u32; 7] {
    let len = terminal.reconcile_stats_len();
    let ptr = terminal.reconcile_stats_ptr();
    // SAFETY: as `cursor_info` above — the terminal's own fixed array, read
    // through the exported pointer and length.
    let stats = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut out = [0u32; 7];
    out.copy_from_slice(&stats[..7]);
    out
}

fn cursor_motion(terminal: &term_wasm::Terminal) -> Vec<u32> {
    assert_eq!(
        terminal.cursor_motion_dropped(),
        0,
        "the cursor-motion journal overflowed; the harness is not draining it"
    );
    let len = terminal.cursor_motion_len();
    let ptr = terminal.cursor_motion_ptr();
    // SAFETY: as above. Copied out before anything can push another record.
    unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec()
}

/// Type a line and return the lab, for a test to assert over.
async fn typing_session(
    shell: Box<dyn Shell>,
    flush_between_chunks: bool,
    text: &str,
    inter_key_ms: f64,
) -> Lab {
    let mut lab = Lab::new(shell, flush_between_chunks, true);
    lab.boot().await;
    lab.type_text(text, inter_key_ms).await;
    lab
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The line typed by every scenario. Long enough to leave a shell's
    /// autosuggestion something to complete, short enough to stay on one row.
    const LINE: &str = "git status --short";
    /// A comfortable typing cadence: 8 characters a second.
    const INTER_KEY_MS: f64 = 125.0;

    /// The control. A shell that echoes exactly what was typed can never
    /// contradict a prediction, so the cursor can only ever move forwards.
    ///
    /// This is what makes every other scenario in this module readable: a
    /// failure there is a statement about that shell's output shape, because
    /// this one holds the model, the transport and the harness fixed.
    #[tokio::test(flavor = "current_thread")]
    async fn a_plain_echo_never_steps_the_cursor_backwards() {
        let lab = typing_session(Box::new(EchoShell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("plain echo");
        assert!(
            lab.browser.confirmed > 0,
            "nothing was ever confirmed, so this proved only that prediction is off\n{}",
            lab.report()
        );
        assert_eq!(
            lab.browser.unmodelled,
            0,
            "a plain echo refused a keystroke\n{}",
            lab.report()
        );
    }

    /// An autosuggestion, written atomically.
    ///
    /// The row tail is no longer blank, so every line after the first has to be
    /// seeded from the prompt anchor rather than from a blank tail.
    #[tokio::test(flavor = "current_thread")]
    async fn an_atomic_autosuggestion_repaint_never_steps_the_cursor_backwards() {
        let shell = SuggestionShell::new("git status --short --branch", false);
        let lab = typing_session(Box::new(shell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("autosuggestion, one write");
    }

    /// The same autosuggestion, with the cursor walk-back written separately
    /// and a flush allowed in between — so the daemon publishes a frame whose
    /// cursor sits at the far end of the suggestion, where nobody is typing.
    ///
    /// The model absorbs every one of those: while it is drawing the cursor,
    /// what authority says the cursor is doing does not reach the screen. The
    /// one it cannot absorb is the first keystroke of the line, where its own
    /// epoch is still unconfirmed and authority draws — see
    /// [`the_tentative_window_is_the_one_a_torn_repaint_reaches`].
    #[tokio::test(flavor = "current_thread")]
    async fn a_torn_autosuggestion_repaint_is_absorbed_by_the_model() {
        let shell = SuggestionShell::new("git status --short --branch", true);
        let lab = typing_session(Box::new(shell), true, LINE, INTER_KEY_MS).await;
        lab.assert_the_model_never_retracted("autosuggestion, torn");
    }

    /// A syntax highlighter's full-line repaint, written atomically.
    #[tokio::test(flavor = "current_thread")]
    async fn an_atomic_line_redraw_never_steps_the_cursor_backwards() {
        let shell = RedrawShell::new(false, false);
        let lab = typing_session(Box::new(shell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("line redraw, one write");
    }

    /// The same repaint, with the erase and the reprint in separate writes and
    /// a flush allowed in between — the frame that carries an empty line and a
    /// cursor at column zero, which contradicts every cell the model's base
    /// describes.
    #[tokio::test(flavor = "current_thread")]
    async fn a_torn_line_redraw_is_absorbed_by_the_model() {
        let shell = RedrawShell::new(true, false);
        let lab = typing_session(Box::new(shell), true, LINE, INTER_KEY_MS).await;
        lab.assert_the_model_never_retracted("line redraw, torn");
    }

    /// Backspace moves the drawn cursor back, and that is not a retraction.
    ///
    /// It is the one key the model projects that moves the cursor left, so it
    /// is also the one place a naive "the cursor never goes back" rule would
    /// fire on correct behaviour. Every step here must be the model's own,
    /// caused by the op the person pressed — a step where the model *stopped*
    /// drawing is a different event with the same pixel, and the whole point of
    /// the journal is that they are told apart.
    #[tokio::test(flavor = "current_thread")]
    async fn a_backspace_moves_the_cursor_back_without_the_model_letting_go() {
        let shell = SuggestionShell::new("git status --short --branch", false);
        let mut lab = Lab::new(Box::new(shell), false, true);
        lab.boot().await;
        lab.type_text(LINE, INTER_KEY_MS).await;
        lab.erase(5, INTER_KEY_MS).await;
        lab.assert_the_model_never_retracted("backspace");
        assert!(
            !lab.regressions.is_empty(),
            "no backwards step at all, so five backspaces predicted nothing\n{}",
            lab.report()
        );
        for regression in &lab.regressions {
            // The model takes the cursor over on the way back: with nothing
            // outstanding the drawn cursor is authority's, and the erase is
            // the model's first op, so the step is `false -> true`. What
            // matters is that the model is the one drawing afterwards.
            assert!(
                regression.is_modelled,
                "a backspace step was drawn from authority rather than the model\n{}",
                lab.report()
            );
            assert_eq!(
                regression.cause,
                "PredictOp",
                "a backwards step during editing was not the edit\n{}",
                lab.report()
            );
            assert_eq!(
                (regression.from.1 - regression.to.1, regression.from.0),
                (1, regression.to.0),
                "a backspace moved the cursor by more than one column\n{}",
                lab.report()
            );
        }
    }

    /// A line the gate never admitted draws its cursor from authority for its
    /// whole life, and therefore steps nowhere.
    ///
    /// The admission latch is the half of the previous fix that is not about
    /// retraction, and this is what it buys: on a link too slow to be worth
    /// predicting on, the model still runs — it still refuses nothing, still
    /// confirms, still keeps the causal barrier closed — and the person sees
    /// exactly the authoritative cursor, moving forwards one column per echo.
    #[tokio::test(flavor = "current_thread")]
    async fn a_line_the_gate_never_admitted_steps_nowhere() {
        let shell = SuggestionShell::new("git status --short --branch", false);
        let mut lab = Lab::new(Box::new(shell), false, false);
        lab.boot().await;
        lab.type_text(LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("gate closed");
        assert_eq!(
            lab.browser.unmodelled,
            0,
            "a withheld line must still be modelled; only its display is withheld\n{}",
            lab.report()
        );
        assert!(
            lab.browser.confirmed > 0,
            "a withheld line must still confirm, or the gate can never reopen\n{}",
            lab.report()
        );
    }

    /// The residual, stated rather than left to be rediscovered.
    ///
    /// A prediction is not drawn until its epoch is confirmed, so the first
    /// keystroke after any flush — including the first of a line — draws its
    /// cursor from authority for one round trip. A shell that writes its
    /// repaint in two syscalls can have a frame published between them, and in
    /// that window the drawn cursor is authority's: it goes wherever the
    /// half-written repaint left it, and comes back when the rest arrives.
    ///
    /// This is the daemon publishing a screen that existed only between two
    /// writes, not the model retracting. Whether it is worth spending latency
    /// on — the zero-delay flush for a drained interactive peer is what admits
    /// it — is a pacing question for `docs/performance.md`, and this test's job
    /// is to keep the answer honest: it fails if the count changes in either
    /// direction.
    #[tokio::test(flavor = "current_thread")]
    async fn the_tentative_window_is_the_one_a_torn_repaint_reaches() {
        let shell = SuggestionShell::new("git status --short --branch", true);
        let lab = typing_session(Box::new(shell), true, LINE, INTER_KEY_MS).await;
        assert_eq!(
            lab.regressions.len(),
            1,
            "a torn repaint reached the screen {} time(s), not once\n{}",
            lab.regressions.len(),
            lab.report()
        );
        let regression = &lab.regressions[0];
        assert_eq!(
            regression.cause,
            "AuthorityHeader",
            "the one step was not authority's\n{}",
            lab.report()
        );
        assert!(
            !regression.was_modelled && !regression.is_modelled,
            "the model was drawing the cursor across the step it is not supposed to cover\n{}",
            lab.report()
        );
        assert!(
            regression.line_present,
            "the model had already dropped the line, so this is a retraction after all\n{}",
            lab.report()
        );
    }

    /// A fast typist over a real round trip, at a shell with an autosuggestion.
    ///
    /// Reproduces the 2026-09-07 report in the harness: at 35 ms per key with a
    /// 50 ms round trip, two keystrokes are in flight while their echoes travel,
    /// and `tests/e2e/terminal-cursor-motion.e2e.ts` journalled
    /// `FlushBaseMismatch` in fish (drawn cursor 14 -> 13) followed by the gate
    /// staying dark for the rest of the line. Every scenario above types at
    /// 125 ms, slower than the round trip, so nothing was ever in flight twice.
    #[tokio::test(flavor = "current_thread")]
    async fn a_fast_typist_over_a_round_trip_never_steps_the_cursor_backwards() {
        for (label, cadence_ms, torn) in [
            ("idealized suggestion, 35 ms", 35.0, false),
            ("fish, 60 ms, torn", 60.0, true),
            ("fish, 35 ms, torn", 35.0, true),
        ] {
            let shell: Box<dyn Shell> = if torn {
                Box::new(FishShell::new("echo cursor-motion-fish-seed"))
            } else {
                Box::new(SuggestionShell::new("echo cursor-motion-fish-seed", false))
            };
            let mut lab = Lab::new(shell, torn, true);
            lab.sim.set_downlink_delay_ms(50.0);
            lab.boot().await;
            lab.type_text("echo cursor-motion-fish-ok", cadence_ms).await;
            lab.settle(300.0, "drain").await;
            eprintln!("=== {label}\n{}", lab.report());
            lab.assert_no_backwards_step(label);
            assert_eq!(
                lab.browser.unmodelled,
                0,
                "{label}: a keystroke was refused while its predecessors' echoes were in flight\n{}",
                lab.report()
            );
            assert!(lab.browser.confirmed > 0, "{label}: nothing confirmed\n{}", lab.report());
        }
    }

    /// A line submitted inside its own round trip.
    ///
    /// The 2026-09-07 report, in the reporter's words: "for a split second the
    /// cursor jumps backwards and I see past content". Enter is never modelled
    /// — predicting it would mark the keystroke shadow-modelled and suppress the
    /// daemon's pre-emptive revocation — and it used to *flush* the speculative
    /// line. Every glyph whose echo was still in flight came off the screen, the
    /// row reverted to what authority had drawn, and the cursor followed it back
    /// for one round trip; the daemon's grant withdrawal on the same key then
    /// arrived at the browser as a header and did the same to whatever the
    /// shell had still not echoed. Both happen on every line submitted faster
    /// than the path, and the second on every line the shell answers slower
    /// than the path. A submission now seals the line instead: nothing typed
    /// behind it is modelled, and what is already painted waits for its echo.
    #[tokio::test(flavor = "current_thread")]
    async fn a_line_submitted_inside_its_round_trip_never_steps_the_cursor_backwards() {
        for (label, torn, cadence_ms, echo_delay_ms) in [
            ("plain echo, 35 ms", false, 35.0, 0.0),
            ("fish, 35 ms, torn", true, 35.0, 0.0),
            ("fish, 60 ms, torn, 80 ms shell", true, 60.0, 80.0),
        ] {
            let shell: Box<dyn Shell> = if torn {
                Box::new(FishShell::new("echo cursor-motion-enter-seed"))
            } else {
                Box::new(EchoShell)
            };
            let mut lab = Lab::new(shell, torn, true);
            lab.sim.set_downlink_delay_ms(50.0);
            lab.echo_delay_ms = echo_delay_ms;
            lab.boot().await;
            lab.type_text("echo cursor-motion-enter", cadence_ms).await;
            // No pause: the last echoes are still on the wire when the line goes.
            lab.press(Key::Enter, 0.0).await;
            lab.settle(600.0, "drain").await;
            eprintln!("=== {label}\n{}", lab.report());
            lab.assert_no_backwards_step(label);
            assert!(
                lab.browser.refusals.is_empty(),
                "{label}: a keystroke was refused\n{}",
                lab.report()
            );
            assert!(lab.browser.confirmed > 0, "{label}: nothing confirmed\n{}", lab.report());
            assert_eq!(
                lab.browser.mismatched,
                0,
                "{label}: the submission was read as a contradiction, which resets trust\n{}",
                lab.report()
            );
        }
    }

    /// Bold text does not end speculative echo.
    ///
    /// It did. `CSI 1 m` completes with the payload `1`, and the scanner asked
    /// of that finished sequence the question it should only ask of a fragment
    /// — "could this still have become `133;C` or `?2004l`?" — for which `1` is
    /// a prefix of `133;` and the answer was yes. The prompt boundary closed,
    /// the daemon withdrew the grant on its next frame, and the model flushed
    /// on the next keystroke with the cursor snapping back to the last echoed
    /// column. Every remaining keystroke of the line then reached the daemon
    /// unmodelled, which is itself a reason to withdraw the grant, so the line
    /// never recovered.
    #[tokio::test(flavor = "current_thread")]
    async fn bold_output_does_not_end_speculative_echo() {
        let shell = MarkupShell {
            before: "\x1b[1m",
            after: "\x1b[0m",
        };
        let lab = typing_session(Box::new(shell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("bold echo");
        assert!(
            lab.browser.confirmed > 0,
            "nothing was confirmed, so prediction was never running\n{}",
            lab.report()
        );
    }

    /// A one-column cursor move does not end speculative echo.
    ///
    /// The same defect through `CSI 1 C` and `CSI 1 D`. Kept separate from the
    /// bold case because they are different bytes on different paths through a
    /// shell, and a narrowing that fixed only one would pass the other.
    #[tokio::test(flavor = "current_thread")]
    async fn a_one_column_cursor_move_does_not_end_speculative_echo() {
        let shell = MarkupShell {
            before: "",
            after: "\x1b[1C\x1b[1D",
        };
        let lab = typing_session(Box::new(shell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("one-column cursor move");
        assert!(
            lab.browser.confirmed > 0,
            "nothing was confirmed, so prediction was never running\n{}",
            lab.report()
        );
    }

    /// A repaint that carries the prompt-end marker with it, so the daemon
    /// re-captures the anchor at whatever column the redraw had reached.
    #[tokio::test(flavor = "current_thread")]
    async fn a_repainted_prompt_marker_never_steps_the_cursor_backwards() {
        let shell = RedrawShell::new(false, true);
        let lab = typing_session(Box::new(shell), false, LINE, INTER_KEY_MS).await;
        lab.assert_no_backwards_step("line redraw with a repainted anchor");
    }
}
