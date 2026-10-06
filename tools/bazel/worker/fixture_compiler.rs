//! Declared native compiler simulator for isolation and cancellation controls.
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::{env, fs, io};
fn main() -> io::Result<()> {
    if env::args().any(|arg| arg == "--hold-child-pipes" || arg == "--hold-child-closed") {
        fs::write("out/descendant-started", std::process::id().to_string())?;
        loop {
            std::thread::park();
        }
    }
    match env::var("FIXTURE_MODE").unwrap_or_default().as_str() {
        "read" => {
            let bytes = fs::read(env::var("FIXTURE_PATH").unwrap())?;
            println!("{}", String::from_utf8_lossy(&bytes));
        }
        "write" => {
            fs::write(env::var("FIXTURE_PATH").unwrap(), b"mutated")?;
        }
        "input-alias" => {
            fs::create_dir_all("out")?;
            fs::hard_link("source", "out/input-alias")?;
            fs::write("out/input-alias", b"mutated")?;
        }
        "orphan-pipes" => {
            fs::create_dir_all("out")?;
            std::process::Command::new(env::current_exe()?)
                .arg("--hold-child-pipes")
                .spawn()?;
        }
        "orphan-closed" | "orphan-session" => {
            fs::create_dir_all("out")?;
            let mut command = std::process::Command::new(env::current_exe()?);
            command
                .arg("--hold-child-closed")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            if env::var("FIXTURE_MODE").unwrap() == "orphan-session" {
                unsafe {
                    command.pre_exec(|| {
                        unsafe extern "C" {
                            fn setsid() -> i32;
                        }
                        if setsid() < 0 {
                            return Err(io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            command.spawn()?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !std::path::Path::new("out/descendant-started").is_file() {
                if std::time::Instant::now() >= deadline {
                    return Err(io::Error::other("descendant did not acknowledge startup"));
                }
                std::thread::yield_now();
            }
            // Preserve the exact child identity after the worker prunes its workspace.
            fs::copy("out/descendant-started", "out/one")?;
            fs::write("out/two", b"two")?;
        }
        "leaf-closed" | "leaf-session" | "leaf-group" => {
            unsafe extern "C" {
                fn setsid() -> i32;
                fn setpgid(pid: i32, group: i32) -> i32;
                fn close(fd: i32) -> i32;
            }
            let mode = env::var("FIXTURE_MODE").unwrap();
            if mode == "leaf-session" && unsafe { setsid() } < 0 {
                return Err(io::Error::last_os_error());
            }
            if mode == "leaf-group" && unsafe { setpgid(0, 0) } < 0 {
                return Err(io::Error::last_os_error());
            }
            fs::create_dir_all("out")?;
            fs::write("out/leaf-started", std::process::id().to_string())?;
            unsafe {
                close(1);
                close(2);
            }
            loop {
                std::thread::park();
            }
        }
        "wait" => {
            fs::create_dir_all("out")?;
            fs::write("out/unit.0000000.rcgu.o", b"incomplete compiler temporary")?;
            loop {
                std::thread::park();
            }
        }
        "readonly-tree-and-unreadable-second" => {
            fs::create_dir_all("out/tree/nested")?;
            fs::write("out/tree/nested/file", b"tree output")?;
            fs::set_permissions("out/tree/nested", fs::Permissions::from_mode(0o555))?;
            fs::set_permissions("out/tree", fs::Permissions::from_mode(0o555))?;
            fs::write("out/two", b"second output")?;
            fs::set_permissions("out/two", fs::Permissions::from_mode(0))?;
        }
        "incomplete" => {
            fs::create_dir_all("out")?;
            fs::write("out/one", b"one")?;
        }
        "inaccessible-cleanup" | "inaccessible-second" => {
            fs::create_dir_all("out")?;
            fs::write("out/one", b"one")?;
            fs::write("out/two", b"two")?;
            if env::var("FIXTURE_MODE").unwrap() == "inaccessible-cleanup" {
                fs::create_dir("out/locked")?;
                fs::set_permissions("out/locked", fs::Permissions::from_mode(0))?;
            } else {
                fs::set_permissions("out/two", fs::Permissions::from_mode(0))?;
            }
        }
        _ => {
            fs::create_dir_all("out")?;
            fs::write("out/one", fs::read("source")?)?;
            fs::write("out/two", b"two")?;
        }
    }
    Ok(())
}
