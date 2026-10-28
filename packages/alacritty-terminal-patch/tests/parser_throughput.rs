use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell as Counter;
use std::hint::black_box;
use std::io::Write;
use std::time::Instant;

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi;

thread_local! {
    static TRACK: Counter<bool> = const { Counter::new(false) };
    static ALLOCATIONS: Counter<u64> = const { Counter::new(0) };
    static ALLOCATED_BYTES: Counter<u64> = const { Counter::new(0) };
}

struct CountingAllocator;

fn count_allocation(size: usize) {
    if TRACK.get() {
        ALLOCATIONS.set(ALLOCATIONS.get() + 1);
        ALLOCATED_BYTES.set(ALLOCATED_BYTES.get() + size as u64);
    }
}

// Test-only instrumentation delegates every allocation unchanged to System.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count_allocation(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[cfg(target_os = "macos")]
fn instructions() -> Option<u64> {
    let mut info = unsafe { std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed().assume_init() };
    let result = unsafe {
        libc::proc_pid_rusage(
            libc::getpid(),
            libc::RUSAGE_INFO_V4,
            &mut info as *mut _ as *mut _,
        )
    };
    assert_eq!(result, 0, "proc_pid_rusage failed");
    Some(info.ri_instructions)
}

#[cfg(not(target_os = "macos"))]
fn instructions() -> Option<u64> {
    None
}

const CORPUS_BYTES: usize = 1024 * 1024;

// Read ends are cumulative offsets, including the final byte of the corpus.
enum Plan {
    Chunks(usize),
    Reads(Vec<usize>),
}

struct Corpus {
    name: String,
    bytes: Vec<u8>,
    plan: Plan,
    cols: usize,
    rows: usize,
}

fn corpus(name: &str, bytes: Vec<u8>, chunk: usize) -> Corpus {
    Corpus {
        name: name.into(),
        bytes,
        plan: Plan::Chunks(chunk),
        cols: 120,
        rows: 40,
    }
}

fn lcg(seed: &mut u64) -> u32 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    (*seed >> 32) as u32
}

fn range(seed: &mut u64, low: usize, high: usize) -> usize {
    low + lcg(seed) as usize % (high - low + 1)
}

fn ascii_text(bytes: &mut Vec<u8>, seed: &mut u64, len: usize) {
    for _ in 0..len {
        bytes.push(range(seed, 0x20, 0x7e) as u8);
    }
}

fn word(bytes: &mut Vec<u8>, seed: &mut u64) {
    const WORDS: [&[u8]; 12] = [
        b"parser",
        b"terminal",
        b"hello",
        b"world",
        b"status",
        b"ready",
        b"project",
        b"render",
        b"branch",
        b"main",
        b"test",
        b"ok",
    ];
    bytes.extend_from_slice(WORDS[range(seed, 0, WORDS.len() - 1)]);
}

fn character(bytes: &mut Vec<u8>, codepoint: u32) {
    let mut utf8 = [0; 4];
    bytes.extend_from_slice(
        char::from_u32(codepoint)
            .expect("corpus scalar")
            .encode_utf8(&mut utf8)
            .as_bytes(),
    );
}

fn ascii(chunk: usize) -> Corpus {
    let mut seed = 1;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        ascii_text(&mut bytes, &mut seed, 1);
    }
    corpus("ascii", bytes, chunk)
}

fn ascii_lines(chunk: usize) -> Corpus {
    let mut seed = 2;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        let len = range(&mut seed, 0, 100);
        let mut line = Vec::new();
        while line.len() < len {
            word(&mut line, &mut seed);
            line.push(b' ');
        }
        bytes.extend_from_slice(&line[..len]);
        bytes.extend_from_slice(b"\r\n");
    }
    corpus("ascii_lines", bytes, chunk)
}

fn cjk(chunk: usize) -> Corpus {
    let mut seed = 3;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        for _ in 0..range(&mut seed, 20, 60) {
            character(&mut bytes, range(&mut seed, 0x4e00, 0x9fff) as u32);
        }
        bytes.extend_from_slice(b"\r\n");
    }
    corpus("cjk", bytes, chunk)
}

fn unicode_mixed(chunk: usize) -> Corpus {
    let mut seed = 4;
    let mut bytes = Vec::new();
    const WORDS: [&str; 8] = [
        "terminal",
        "éüñç",
        "Ελληνικά",
        "Кириллица",
        "漢字中文",
        "한글",
        "e\u{301}",
        "",
    ];
    while bytes.len() <= CORPUS_BYTES {
        for _ in 0..range(&mut seed, 8, 20) {
            let index = range(&mut seed, 0, WORDS.len() - 1);
            if index == WORDS.len() - 1 {
                for _ in 0..range(&mut seed, 1, 6) {
                    character(&mut bytes, range(&mut seed, 0x2500, 0x257f) as u32);
                }
            } else {
                bytes.extend_from_slice(WORDS[index].as_bytes());
            }
            bytes.push(b' ');
        }
        bytes.extend_from_slice(b"\r\n");
    }
    corpus("unicode_mixed", bytes, chunk)
}

fn emoji(chunk: usize) -> Corpus {
    let mut seed = 5;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        for _ in 0..range(&mut seed, 8, 24) {
            match range(&mut seed, 0, 4) {
                0 => character(&mut bytes, range(&mut seed, 0x1f600, 0x1f64f) as u32),
                1 => bytes.extend_from_slice("\u{2764}\u{fe0f}".as_bytes()),
                2 => bytes.extend_from_slice("\u{1f44d}\u{1f3fd}".as_bytes()),
                3 => bytes
                    .extend_from_slice("\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}".as_bytes()),
                _ => {
                    character(&mut bytes, range(&mut seed, 0x1f1e6, 0x1f1ff) as u32);
                    character(&mut bytes, range(&mut seed, 0x1f1e6, 0x1f1ff) as u32);
                }
            }
            bytes.push(b' ');
        }
        bytes.extend_from_slice(b"\r\n");
    }
    corpus("emoji", bytes, chunk)
}

fn controls(chunk: usize) -> Corpus {
    let mut seed = 6;
    let mut bytes = Vec::new();
    const CONTROLS: [&[u8]; 10] = [
        b"\t",
        b"\x08",
        b"\r",
        b"\n",
        b"\x07",
        b"\xc2\x85",
        b"\xc2\x9b",
        b"\x7f",
        b"\xff",
        b"\xe2\x82A",
    ];
    while bytes.len() <= CORPUS_BYTES {
        word(&mut bytes, &mut seed);
        bytes.extend_from_slice(CONTROLS[range(&mut seed, 0, CONTROLS.len() - 1)]);
    }
    corpus("controls", bytes, chunk)
}

fn tui_redraw(chunk: usize) -> Corpus {
    let mut seed = 7;
    let mut bytes = Vec::new();
    let mut frame = 0;
    while bytes.len() <= CORPUS_BYTES {
        frame += 1;
        bytes.extend_from_slice(b"\x1b[?2026h\x1b[?25l");
        let short = frame % 8 == 0;
        let rows = if short { 3 } else { 40 };
        for row in 1..=rows {
            if short {
                bytes.extend_from_slice(b"\x1b[2K\x1b[1A\x1b[G");
            } else {
                write!(bytes, "\x1b[{row};1H").expect("write corpus");
            }
            for segment in 0..range(&mut seed, 2, 6) {
                match (frame + row + segment) % 9 {
                    0 => bytes.extend_from_slice(b"\x1b[0m"),
                    1 => bytes.extend_from_slice(b"\x1b[1m"),
                    2 => bytes.extend_from_slice(b"\x1b[2m"),
                    3 => bytes.extend_from_slice(b"\x1b[7m"),
                    4 => write!(bytes, "\x1b[38;5;{}m", range(&mut seed, 0, 255))
                        .expect("write corpus"),
                    5 => write!(bytes, "\x1b[48;5;{}m", range(&mut seed, 0, 255))
                        .expect("write corpus"),
                    6 => write!(
                        bytes,
                        "\x1b[38;2;{};{};{}m",
                        range(&mut seed, 0, 255),
                        range(&mut seed, 0, 255),
                        range(&mut seed, 0, 255)
                    )
                    .expect("write corpus"),
                    7 => bytes.extend_from_slice(b"\x1b[39;49m"),
                    _ => bytes.extend_from_slice(b"\x1b[22;23;24m"),
                }
                let len = range(&mut seed, 3, 30);
                ascii_text(&mut bytes, &mut seed, len);
            }
            bytes.extend_from_slice(b"\x1b[K");
        }
        write!(
            bytes,
            "\x1b[{};{}H\x1b[?25h\x1b[?2026l",
            range(&mut seed, 1, 40),
            range(&mut seed, 1, 120)
        )
        .expect("write corpus");
    }
    corpus("tui_redraw", bytes, chunk)
}

fn sgr_random(chunk: usize) -> Corpus {
    let mut seed = 8;
    let mut bytes = Vec::new();
    let mut count = 0;
    while bytes.len() <= CORPUS_BYTES {
        write!(
            bytes,
            "\x1b[38;2;{};{};{}m",
            range(&mut seed, 0, 255),
            range(&mut seed, 0, 255),
            range(&mut seed, 0, 255)
        )
        .expect("write corpus");
        ascii_text(&mut bytes, &mut seed, 1);
        count += 1;
        if count % 64 == 0 {
            write!(
                bytes,
                "\x1b[{};{}H",
                range(&mut seed, 1, 40),
                range(&mut seed, 1, 120)
            )
            .expect("write corpus");
        }
    }
    corpus("sgr_random", bytes, chunk)
}

fn csi_mix(chunk: usize) -> Corpus {
    let mut seed = 9;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        match range(&mut seed, 0, 11) {
            0 => write!(
                bytes,
                "\x1b[{};{}H",
                range(&mut seed, 1, 40),
                range(&mut seed, 1, 120)
            )
            .expect("write corpus"),
            1 => write!(bytes, "\x1b[{}K", range(&mut seed, 0, 2)).expect("write corpus"),
            2 => bytes.extend_from_slice(b"\x1b[0J"),
            3 => {
                bytes.extend_from_slice(b"\x1b[");
                for param in 0..range(&mut seed, 1, 5) {
                    if param > 0 {
                        bytes.push(b';');
                    }
                    write!(bytes, "{}", range(&mut seed, 0, 107)).expect("write corpus");
                }
                bytes.push(b'm');
            }
            4 => {
                let mode = if range(&mut seed, 0, 1) == 0 {
                    25
                } else {
                    2004
                };
                let action = if range(&mut seed, 0, 1) == 0 {
                    'h'
                } else {
                    'l'
                };
                write!(bytes, "\x1b[?{mode}{action}").expect("write corpus");
            }
            choice => {
                let action = b"ABCDX@P"[choice - 5] as char;
                write!(bytes, "\x1b[{}{action}", range(&mut seed, 1, 40)).expect("write corpus");
            }
        }
        let len = range(&mut seed, 0, 12);
        ascii_text(&mut bytes, &mut seed, len);
    }
    corpus("csi_mix", bytes, chunk)
}

fn osc_prompt(chunk: usize) -> Corpus {
    let mut seed = 10;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        bytes.extend_from_slice(b"\x1b]133;A\x07\x1b]7;file://host.local/Users/dev/project/src\x1b\\\x1b]0;dev@host: ~/project\x07dev@host project % \x1b]133;B\x07");
        word(&mut bytes, &mut seed);
        bytes.extend_from_slice(b"\r\n\x1b]133;C\x07");
        for line in 0..range(&mut seed, 1, 6) {
            word(&mut bytes, &mut seed);
            if line % 2 == 0 {
                let n = lcg(&mut seed);
                write!(
                    bytes,
                    " \x1b]8;id={n};https://example.com/src/{n}\x1b\\source\x1b]8;;\x1b\\"
                )
                .expect("write corpus");
            }
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"\x1b]133;D;0\x07");
    }
    corpus("osc_prompt", bytes, chunk)
}

fn osc_title(chunk: usize) -> Corpus {
    let mut seed = 11;
    let mut bytes = Vec::new();
    let mut count = 0;
    while bytes.len() <= CORPUS_BYTES {
        write!(bytes, "\x1b]2;title {}", lcg(&mut seed)).expect("write corpus");
        bytes.extend_from_slice(if count % 2 == 0 { b"\x07" } else { b"\x1b\\" });
        bytes.push(b'x');
        count += 1;
    }
    corpus("osc_title", bytes, chunk)
}

fn random_base64(seed: &mut u64, len: usize) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let raw: Vec<u8> = (0..len).map(|_| (lcg(seed) >> 24) as u8).collect();
    let mut encoded = Vec::with_capacity(len.div_ceil(3) * 4);
    for triple in raw.chunks(3) {
        let a = triple[0] as usize;
        let b = triple.get(1).copied().unwrap_or(0) as usize;
        let c = triple.get(2).copied().unwrap_or(0) as usize;
        encoded.push(ALPHABET[a >> 2]);
        encoded.push(ALPHABET[((a & 3) << 4) | (b >> 4)]);
        encoded.push(if triple.len() > 1 {
            ALPHABET[((b & 15) << 2) | (c >> 6)]
        } else {
            b'='
        });
        encoded.push(if triple.len() > 2 {
            ALPHABET[c & 63]
        } else {
            b'='
        });
    }
    encoded
}

fn osc52_large(chunk: usize) -> Corpus {
    let mut seed = 12;
    let mut bytes = Vec::new();
    while bytes.len() <= CORPUS_BYTES {
        bytes.extend_from_slice(b"\x1b]52;c;");
        bytes.extend_from_slice(&random_base64(&mut seed, 48 * 1024));
        bytes.extend_from_slice(b"\x07\r\n");
    }
    corpus("osc52_large", bytes, chunk)
}

fn apc_kitty(chunk: usize) -> Corpus {
    let mut seed = 13;
    let mut bytes = Vec::new();
    let mut image = 0;
    while bytes.len() <= CORPUS_BYTES {
        image += 1;
        let chunks = range(&mut seed, 2, 6);
        for part in 0..chunks {
            let more = usize::from(part + 1 < chunks);
            write!(bytes, "\x1b_Ga=t,f=100,i={image},m={more};").expect("write corpus");
            bytes.extend_from_slice(&random_base64(&mut seed, 3072));
            bytes.extend_from_slice(b"\x1b\\");
        }
    }
    corpus("apc_kitty", bytes, chunk)
}

fn dcs(chunk: usize) -> Corpus {
    let mut seed = 14;
    let mut bytes = Vec::new();
    const ITEMS: [&[u8]; 3] = [
        b"\x1bP+q544e\x1b\\",
        b"\x1bP$qm\x1b\\",
        b"\x1bPtmux;\x1b\x1b[31mred\x1b\x1b[0m\x1b\\",
    ];
    while bytes.len() <= CORPUS_BYTES {
        bytes.extend_from_slice(ITEMS[range(&mut seed, 0, ITEMS.len() - 1)]);
        word(&mut bytes, &mut seed);
    }
    corpus("dcs", bytes, chunk)
}

fn keystroke() -> Corpus {
    let mut seed = 15;
    let mut bytes = Vec::new();
    let mut reads = Vec::new();
    for read in 1..=64 * 1024 {
        let start = bytes.len();
        // Coincident control events share their scheduled read.
        if read % 7 == 0 {
            bytes.extend_from_slice(b"\x08\x1b[K");
        }
        if read % 11 == 0 {
            bytes.extend_from_slice(b"\x1b[C");
        }
        if read % 40 == 0 {
            bytes.extend_from_slice(b"\r\n\x1b]133;D;0\x07\x1b]133;A\x07dev@host % \x1b]133;B\x07");
        }
        if bytes.len() == start {
            bytes.push(range(&mut seed, b'a' as usize, b'z' as usize) as u8);
        }
        reads.push(bytes.len());
    }
    Corpus {
        name: "keystroke".into(),
        bytes,
        plan: Plan::Reads(reads),
        cols: 120,
        rows: 40,
    }
}

fn env_number(name: &str, default: usize) -> usize {
    match std::env::var(name) {
        Ok(value) => {
            let number = value
                .parse::<usize>()
                .unwrap_or_else(|_| panic!("{name}: invalid integer {value:?}"));
            assert!(number > 0, "{name} must be positive");
            number
        }
        Err(std::env::VarError::NotPresent) => default,
        Err(error) => panic!("{name}: {error}"),
    }
}

fn recordings(chunk: usize) -> Vec<Corpus> {
    let value = match std::env::var("MERKUR_PARSER_RECORDINGS") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Vec::new(),
        Err(error) => panic!("MERKUR_PARSER_RECORDINGS: {error}"),
    };
    let mut result = Vec::new();
    if value.is_empty() {
        return result;
    }
    for entry in value.split(',') {
        let (name, rest) = entry
            .split_once('=')
            .expect("MERKUR_PARSER_RECORDINGS: expected name=path=COLSxROWS");
        let (path, size) = rest
            .rsplit_once('=')
            .expect("MERKUR_PARSER_RECORDINGS: missing =COLSxROWS");
        assert!(
            !name.is_empty() && !name.chars().any(char::is_whitespace),
            "MERKUR_PARSER_RECORDINGS: invalid name {name:?}"
        );
        let (cols, rows) = size
            .split_once('x')
            .expect("MERKUR_PARSER_RECORDINGS: expected COLSxROWS");
        let cols = cols
            .parse::<usize>()
            .expect("MERKUR_PARSER_RECORDINGS: invalid columns");
        let rows = rows
            .parse::<usize>()
            .expect("MERKUR_PARSER_RECORDINGS: invalid rows");
        assert!(
            cols >= 2 && rows > 0 && rows <= i32::MAX as usize,
            "MERKUR_PARSER_RECORDINGS: invalid terminal size"
        );
        let bytes = std::fs::read(path)
            .unwrap_or_else(|error| panic!("MERKUR_PARSER_RECORDINGS: {path:?}: {error}"));
        assert!(
            !bytes.is_empty(),
            "MERKUR_PARSER_RECORDINGS: empty file {path:?}"
        );
        result.push(Corpus {
            name: format!("rec_{name}"),
            bytes,
            plan: Plan::Chunks(chunk),
            cols,
            rows,
        });
    }
    result
}

/// The daemon's per-byte provenance hooks (`EventForwarder` in
/// apps/daemon/dataplane/src/pty/terminal.rs), so that the number of
/// observation and control-start callbacks a parser design makes costs here
/// what it costs in production. Every other event is dropped.
#[derive(Default)]
struct Provenance {
    ignored_shell_evidence_bytes: usize,
    last_application_fresh: bool,
    control_fresh: bool,
}

impl EventListener for Provenance {
    #[inline]
    fn observe_terminal_bytes(&mut self, bytes: &[u8]) {
        let ignored = self.ignored_shell_evidence_bytes.min(bytes.len());
        self.ignored_shell_evidence_bytes -= ignored;
        self.last_application_fresh = ignored < bytes.len();
    }

    fn terminal_control_started(&mut self) {
        self.control_fresh = self.last_application_fresh;
    }
}

fn terminal(corpus: &Corpus) -> Term<Provenance> {
    Term::new(
        Config {
            kitty_keyboard: true,
            modify_other_keys: true,
            ..Config::default()
        },
        &TermSize::new(corpus.cols, corpus.rows),
        Provenance::default(),
    )
}

fn feed(
    parser: &mut ansi::Processor<ansi::StdSyncHandler>,
    term: &mut Term<Provenance>,
    bytes: &[u8],
) {
    let mut rest = bytes;
    while !rest.is_empty() {
        let n = parser.advance(term, rest);
        assert!(n > 0, "parser made no progress");
        rest = &rest[n..];
    }
}

fn pass(
    corpus: &Corpus,
    parser: &mut ansi::Processor<ansi::StdSyncHandler>,
    term: &mut Term<Provenance>,
) {
    match &corpus.plan {
        Plan::Chunks(chunk) => {
            for bytes in corpus.bytes.chunks(*chunk) {
                feed(parser, term, bytes);
            }
        }
        Plan::Reads(ends) => {
            let mut start = 0;
            for &end in ends {
                feed(parser, term, &corpus.bytes[start..end]);
                start = end;
            }
        }
    }
    black_box(term);
}

fn measure(corpus: &Corpus, target: usize, samples: usize) {
    let mut term = terminal(corpus);
    let mut parser = ansi::Processor::<ansi::StdSyncHandler>::new();
    // Warm until the scrollback stops growing, so the counted passes neither
    // allocate rows nor take the page faults that growth brings with it.
    loop {
        let history = term.grid().history_size();
        pass(corpus, &mut parser, &mut term);
        if term.grid().history_size() == history {
            break;
        }
    }
    let passes = target.div_ceil(corpus.bytes.len()).max(1);
    let total_bytes = corpus.bytes.len() as f64 * passes as f64;
    ALLOCATIONS.set(0);
    ALLOCATED_BYTES.set(0);
    let before = instructions();
    TRACK.set(true);
    let start = Instant::now();
    for _ in 0..passes {
        pass(corpus, &mut parser, &mut term);
    }
    let elapsed = start.elapsed();
    TRACK.set(false);
    let retired = before
        .zip(instructions())
        .map(|(before, after)| after - before);
    let allocations = ALLOCATIONS.get();
    let allocated_bytes = ALLOCATED_BYTES.get();

    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        pass(corpus, &mut parser, &mut term);
        times.push(start.elapsed().as_nanos() as f64 / corpus.bytes.len() as f64);
    }
    times.sort_by(f64::total_cmp);
    let median = if samples % 2 == 0 {
        (times[samples / 2 - 1] + times[samples / 2]) / 2.0
    } else {
        times[samples / 2]
    };
    let chunk = match corpus.plan {
        Plan::Chunks(chunk) => chunk.to_string(),
        Plan::Reads(_) => "reads".into(),
    };
    let instruction_count = retired.map_or_else(|| "na".into(), |n| n.to_string());
    let instructions_per_byte =
        retired.map_or_else(|| "na".into(), |n| format!("{:.4}", n as f64 / total_bytes));
    let ns = elapsed.as_nanos() as f64;
    print!(
        "@@parser corpus={} bytes={} passes={} chunk={} ns_per_byte={:.4} mb_s={:.1} median_ns_per_byte={:.4} min_ns_per_byte={:.4} instructions_per_byte={} instructions={} allocations_per_pass={:.2} allocated_bytes_per_pass={:.1}",
        corpus.name,
        corpus.bytes.len(),
        passes,
        chunk,
        ns / total_bytes,
        total_bytes / elapsed.as_secs_f64() / 1e6,
        median,
        times[0],
        instructions_per_byte,
        instruction_count,
        allocations as f64 / passes as f64,
        allocated_bytes as f64 / passes as f64
    );
    if let Plan::Reads(ends) = &corpus.plan {
        let reads = ends.len() as f64 * passes as f64;
        let instructions_per_read =
            retired.map_or_else(|| "na".into(), |n| format!("{:.1}", n as f64 / reads));
        print!(
            " reads={} ns_per_read={:.1} instructions_per_read={}",
            ends.len(),
            ns / reads,
            instructions_per_read
        );
    }
    println!();
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn digest(corpus: &Corpus) -> u64 {
    let mut term = terminal(corpus);
    let mut parser = ansi::Processor::<ansi::StdSyncHandler>::new();
    pass(corpus, &mut parser, &mut term);
    let mut hash = 0xcbf29ce484222325;
    for row in 0..corpus.rows {
        for col in 0..corpus.cols {
            let cell = &term.grid()[Line(row as i32)][Column(col)];
            hash_bytes(&mut hash, &(cell.c as u32).to_le_bytes());
            let zerowidth = cell.zerowidth().unwrap_or_default();
            for c in zerowidth {
                hash_bytes(&mut hash, &(*c as u32).to_le_bytes());
            }
            hash_bytes(&mut hash, &cell.flags.bits().to_le_bytes());
            hash_bytes(&mut hash, format!("{:?}{:?}", cell.fg, cell.bg).as_bytes());
        }
    }
    let cursor = &term.grid().cursor;
    hash_bytes(&mut hash, &cursor.point.line.0.to_le_bytes());
    hash_bytes(&mut hash, &(cursor.point.column.0 as u64).to_le_bytes());
    hash_bytes(&mut hash, &[u8::from(cursor.input_needs_wrap)]);
    hash
}

#[test]
#[ignore = "parser throughput workload"]
fn parser_throughput() {
    let chunk = env_number("MERKUR_PARSER_CHUNK", 32768);
    let target = env_number("MERKUR_PARSER_BYTES", 32 * 1024 * 1024);
    let samples = env_number("MERKUR_PARSER_SAMPLES", 7);
    let mut corpora = vec![
        ascii(chunk),
        ascii_lines(chunk),
        cjk(chunk),
        unicode_mixed(chunk),
        emoji(chunk),
        controls(chunk),
        tui_redraw(chunk),
        sgr_random(chunk),
        csi_mix(chunk),
        osc_prompt(chunk),
        osc_title(chunk),
        osc52_large(chunk),
        apc_kitty(chunk),
        dcs(chunk),
        keystroke(),
    ];
    corpora.extend(recordings(chunk));
    for (index, corpus) in corpora.iter().enumerate() {
        assert!(
            !corpora[..index]
                .iter()
                .any(|other| other.name == corpus.name),
            "MERKUR_PARSER_RECORDINGS: duplicate corpus {}",
            corpus.name
        );
    }
    match std::env::var("MERKUR_PARSER_CORPUS") {
        Ok(value) => {
            let names: Vec<&str> = value.split(',').collect();
            for name in &names {
                assert!(
                    corpora.iter().any(|corpus| corpus.name == *name),
                    "MERKUR_PARSER_CORPUS: unknown corpus {name:?}"
                );
            }
            corpora.retain(|corpus| names.contains(&corpus.name.as_str()));
        }
        Err(std::env::VarError::NotPresent) => {}
        Err(error) => panic!("MERKUR_PARSER_CORPUS: {error}"),
    }
    for corpus in &corpora {
        measure(corpus, target, samples);
    }
    for corpus in &corpora {
        println!(
            "@@parser_digest corpus={} digest={:016x}",
            corpus.name,
            digest(corpus)
        );
    }
}
