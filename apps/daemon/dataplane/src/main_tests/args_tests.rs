use super::*;

fn parse(values: &[&str]) -> Result<Args, Box<dyn std::error::Error>> {
    parse_args(values.iter().map(|value| (*value).to_string()))
}

#[test]
fn shell_is_required_and_has_no_ambient_fallback() {
    assert_eq!(
        parse(&[]).expect_err("missing shell must fail").to_string(),
        "missing required --shell"
    );
    assert_eq!(
        parse(&["--shell", ""])
            .expect_err("empty shell must fail")
            .to_string(),
        "--shell must not be empty"
    );
}

/// The pinned port is an operator contract — a router forward and a
/// firewall rule name it — so a value the daemon cannot actually bind has
/// to fail at parse rather than silently produce a server nothing reaches.
#[test]
fn the_webtransport_port_is_pinned_or_explicitly_ephemeral() {
    let pinned = parse(&["--shell", "/bin/zsh", "--wt-port", "44433"]).expect("pinned port");
    assert_eq!(pinned.pinned_wt_port, 44_433);

    // 0 stays meaningful: local runs that never persist a config.
    let ephemeral = parse(&["--shell", "/bin/zsh", "--wt-port", "0"]).expect("ephemeral");
    assert_eq!(ephemeral.pinned_wt_port, 0);

    // A declared public endpoint is optional and parsed to a SocketAddr, so
    // a value that cannot be dialled never reaches the candidate list.
    let declared = parse(&[
        "--shell",
        "/bin/zsh",
        "--public-wt-endpoint",
        "203.0.113.10:44433",
    ])
    .expect("declared endpoint");
    assert_eq!(
        declared.public_wt_endpoint,
        Some("203.0.113.10:44433".parse().unwrap())
    );

    let declared_v6 = parse(&[
        "--shell",
        "/bin/zsh",
        "--public-wt-endpoint",
        "[2001:db8::1]:44433",
    ])
    .expect("declared v6 endpoint");
    assert_eq!(
        declared_v6.public_wt_endpoint,
        Some("[2001:db8::1]:44433".parse().unwrap())
    );

    // Rejected rather than ignored: silently dropping it would leave the
    // daemon believing it is published somewhere it is not, and offering
    // nothing, with no signal that the operator's value was wrong.
    assert!(
        parse(&[
            "--shell",
            "/bin/zsh",
            "--public-wt-endpoint",
            "203.0.113.10"
        ])
        .is_err()
    );
    assert!(parse(&["--shell", "/bin/zsh", "--public-wt-endpoint", "not-an-addr"]).is_err());

    assert_eq!(
        parse(&["--shell", "/bin/zsh"])
            .expect("no endpoint")
            .public_wt_endpoint,
        None
    );

    // Absent is the same as ephemeral, so an unconfigured dev run works.
    assert_eq!(
        parse(&["--shell", "/bin/zsh"])
            .expect("default")
            .pinned_wt_port,
        0
    );

    assert_eq!(
        parse(&["--shell", "/bin/zsh", "--wt-port", "80"])
            .expect_err("privileged port must fail")
            .to_string(),
        "--wt-port must be 0 or >= 1024"
    );
    assert_eq!(
        parse(&["--shell", "/bin/zsh", "--wt-port", "70000"])
            .expect_err("out-of-range port must fail")
            .to_string(),
        "invalid --wt-port"
    );
}

#[test]
fn exact_shell_and_dimensions_are_accepted() {
    let args = parse(&["--shell", "/bin/zsh", "--cols", "132", "--rows", "48"])
        .expect("current arguments");
    assert_eq!(args.shell, "/bin/zsh");
    assert_eq!(args.cols, 132);
    assert_eq!(args.rows, 48);
}

#[test]
fn telemetry_windows_are_positive_and_measure_actual_elapsed_time() {
    let start = Instant::now();
    assert_eq!(positive_interval_ms(start, start), 1);
    assert_eq!(
        positive_interval_ms(start, start + Duration::from_millis(37)),
        37
    );
}
