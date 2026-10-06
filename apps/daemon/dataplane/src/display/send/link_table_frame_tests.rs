use super::*;
use alacritty_terminal::term::cell::Hyperlink;

#[test]
fn a_reset_flags_its_first_frame_and_records_run_to_the_body_end() {
    let mut table = crate::pty::links::LinkTable::default();
    let links = [
        Hyperlink::new(None::<String>, "https://a.example".into()),
        Hyperlink::new(None::<String>, "https://bb.example".into()),
    ];
    for link in &links {
        table.intern(link);
    }
    let frames = encode_link_table_frames(true, table.live());
    assert_eq!(frames.len(), 1);
    let frame = &frames[0];
    assert_eq!(frame[0], MSG_TYPE_DISPLAY_LINK_TABLE);
    let body_len = u32::from_be_bytes([0, frame[1], frame[2], frame[3]]) as usize;
    assert_eq!(body_len, frame.len() - PROTO_HEADER_BYTES);
    assert_eq!(frame[4], DISPLAY_LINK_TABLE_FLAG_RESET);

    let mut offset = 5;
    let mut records = Vec::new();
    while offset < frame.len() {
        let id = u32::from_be_bytes(frame[offset..offset + 4].try_into().unwrap());
        let len = u32::from_be_bytes(frame[offset + 4..offset + 8].try_into().unwrap()) as usize;
        records.push((
            id,
            std::str::from_utf8(&frame[offset + 8..offset + 8 + len]).unwrap(),
        ));
        offset += 8 + len;
    }
    assert_eq!(
        records,
        [(1, "https://a.example"), (2, "https://bb.example")]
    );

    let extension = encode_link_table_frames(false, table.issued_after(1));
    assert_eq!(extension[0][4], 0);

    let empty_reset = encode_link_table_frames(true, &[]);
    assert_eq!(
        empty_reset,
        [vec![
            MSG_TYPE_DISPLAY_LINK_TABLE,
            0,
            0,
            1,
            DISPLAY_LINK_TABLE_FLAG_RESET
        ]]
    );
    assert!(encode_link_table_frames(false, &[]).is_empty());
}
