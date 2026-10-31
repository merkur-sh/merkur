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

#[test]
fn link_table_frames_fit_noise_transport() {
    check_large_table(5, 1_700_000);
}

#[test]
fn link_table_reset_fits_browser_ring() {
    check_large_table(640, 8192);
}

fn check_large_table(count: usize, url_bytes: usize) {
    let links: Vec<_> = (0..count)
        .map(|index| {
            let mut uri = format!("https://example.com/{index}/");
            uri.extend(std::iter::repeat_n('x', url_bytes - uri.len()));
            Hyperlink::new(None::<String>, uri)
        })
        .collect();
    let mut table = crate::pty::links::LinkTable::default();
    for link in &links {
        assert_ne!(table.intern(link), 0);
    }
    let (mut daemon, mut browser) = super::tests::established_noise_pair();
    let lane = crate::e2e::lane_for_channel(CHANNEL_CTRL).unwrap();
    let mut received = merkur_client::viewer::links::Links::default();
    for (index, frame) in encode_link_table_frames(true, table.live())
        .iter()
        .enumerate()
    {
        let sealed = daemon
            .seal_stream(lane, frame)
            .expect("link definitions must fit Noise plaintext");
        assert!(
            frame.len() <= merkur_codec::MAX_DISPLAY_FRAME_BYTES,
            "link definitions must fit every empty browser ring cursor: {} bytes",
            frame.len()
        );
        let opened = browser.open_stream(lane, &sealed).unwrap();
        assert_eq!(
            opened[4],
            if index == 0 {
                DISPLAY_LINK_TABLE_FLAG_RESET
            } else {
                0
            }
        );
        assert!(received.receive(&opened[PROTO_HEADER_BYTES..]));
    }
    assert_eq!(received.entries().len(), count);
    for live in table.live() {
        assert_eq!(received.uri(live.id), Some(live.uri.as_ref()));
    }
}

#[test]
fn link_table_admission_bounds_a_single_definition() {
    let max_url = merkur_codec::MAX_DISPLAY_FRAME_BYTES - PROTO_HEADER_BYTES - 1 - 8;
    let mut uri = "https://example.com/".to_string();
    uri.extend(std::iter::repeat_n('x', max_url - uri.len()));
    let mut table = crate::pty::links::LinkTable::default();
    let accepted = Hyperlink::new(None::<String>, uri.clone());
    assert_ne!(table.intern(&accepted), 0);
    uri.push('x');
    let refused = Hyperlink::new(None::<String>, uri);
    assert_eq!(
        table.intern(&refused),
        0,
        "an indivisible definition must fit one receiver frame"
    );
}
