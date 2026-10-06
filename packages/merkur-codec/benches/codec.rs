use criterion::{Criterion, criterion_group, criterion_main};
use merkur_codec::{
    CellAttrs, CellRepr, FrameHeader, FrameKind, RowRef, cell_iter, encode_cells, encode_frame_into,
    iter_rows, row_hash, try_encode_frame_into,
};
use std::hint::black_box;

fn mixed_row(cols: usize, seed: usize) -> Vec<CellRepr> {
    (0..cols)
        .map(|col| {
            let index = col + seed;
            CellRepr {
                codepoint: u32::from(b'!' + (index % 94) as u8),
                fg: if index.is_multiple_of(17) {
                    [0x89, 0xb4, 0xfa]
                } else {
                    [240, 240, 240]
                },
                bg: if index.is_multiple_of(29) {
                    [0x31, 0x32, 0x44]
                } else {
                    [10, 10, 10]
                },
                attrs: CellAttrs::NONE
                    .with(CellAttrs::BOLD, index.is_multiple_of(19))
                    .with(CellAttrs::ITALIC, index.is_multiple_of(31))
                    .with(CellAttrs::UNDERLINE, index.is_multiple_of(37)),
                link: 0,
            }
        })
        .collect()
}

fn bench_codec(c: &mut Criterion) {
    let row = vec![
        CellRepr {
            codepoint: u32::from(' '),
            fg: [240, 240, 240],
            bg: [10, 10, 10],
            attrs: CellAttrs::NONE,
            link: 0,
        };
        120
    ];
    let header = FrameHeader {
        memory_only: false,
        kind: FrameKind::Delta,
        cols: 120,
        rows: 40,
        cursor_col: 0,
        cursor_row: 0,
        cursor_shape: 1,
        cursor_visible: 1,
        mode_flags: 0,
        row_count: 1,
        frame_id: 0,
        presentation_id: 0,
        presentation_member_index: 0,
        presentation_member_count: 0,
        row_predecessor_presentation_id: 0,
        presentation_coherent: false,
        presentation_end: false,
        chunk_index: 0,
        chunk_count: 1,
        demand_serial: 0,
        demand_limited: false,
        demand_prompt: false,
        demand_awaits_grant: false,
        closure_digest: 0,
        scroll_serial: 0,
        echo_horizon: 0,
    };
    let mut encoded = Vec::new();
    encode_frame_into(
        &mut encoded,
        &header,
        [RowRef {
            graphics: &[],
            row_index: 0,
            left: 0,
            cells: &row,
        }]
        .into_iter(),
    );
    let row_bytes = iter_rows(&encoded).next().unwrap().unwrap().cells.to_vec();

    c.bench_function("encode_row", |b| {
        b.iter(|| {
            encode_frame_into(
                black_box(&mut encoded),
                black_box(&header),
                [RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: &row,
                }]
                .into_iter(),
            )
        })
    });
    c.bench_function("encode_row_checked", |b| {
        b.iter(|| {
            try_encode_frame_into(
                black_box(&mut encoded),
                black_box(&header),
                [RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: &row,
                }]
                .into_iter(),
            )
            .unwrap()
        })
    });
    let mut encoded_cells = Vec::new();
    c.bench_function("encode_cells_row", |b| {
        b.iter(|| {
            encoded_cells.clear();
            encode_cells(black_box(&mut encoded_cells), black_box(&row));
            black_box(encoded_cells.len())
        })
    });
    c.bench_function("decode_row", |b| {
        b.iter(|| cell_iter(black_box(row_bytes.as_slice())).count())
    });

    // The all-blank row above is deliberately RLE-friendly. Production rows
    // also contain mostly distinct glyphs, which exercises the literal-cell
    // path and its allocation/copying costs.
    let mixed = mixed_row(120, 0);
    let mut encoded_mixed = Vec::new();
    c.bench_function("encode_row_mixed_120", |b| {
        b.iter(|| {
            encode_frame_into(
                black_box(&mut encoded_mixed),
                black_box(&header),
                [RowRef {
                    graphics: &[],
                    row_index: 0,
                    left: 0,
                    cells: black_box(&mixed),
                }]
                .into_iter(),
            )
        })
    });
    c.bench_function("row_hash_mixed_120", |b| {
        b.iter(|| row_hash(black_box(&mixed)))
    });
    c.bench_function("row_hash_blank_120", |b| {
        b.iter(|| row_hash(black_box(&row)))
    });

    let full_rows: Vec<Vec<CellRepr>> = (0..40)
        .map(|row_index| mixed_row(120, row_index * 7))
        .collect();
    let full_header = FrameHeader {
        memory_only: false,
        row_count: full_rows.len() as u16,
        ..header
    };
    let mut encoded_full = Vec::new();
    c.bench_function("encode_frame_mixed_40x120", |b| {
        b.iter(|| {
            encode_frame_into(
                black_box(&mut encoded_full),
                black_box(&full_header),
                full_rows
                    .iter()
                    .enumerate()
                    .map(|(row_index, cells)| RowRef {
                        graphics: &[],
                        row_index: row_index as u16,
                        left: 0,
                        cells: black_box(cells),
                    }),
            )
        })
    });
}

criterion_group!(benches, bench_codec);
criterion_main!(benches);
