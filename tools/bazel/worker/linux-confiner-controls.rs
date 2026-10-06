//! Real Linux syscall controls. Missing namespace authority fails, never skips.
mod linux_confinement;
mod linux_policy;
use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

fn denied<T>(result: io::Result<T>, allowed: &[i32]) -> io::Result<()> {
    match result {
        Err(error) if allowed.contains(&error.raw_os_error().unwrap_or(0)) => Ok(()),
        Err(error) => Err(io::Error::other(format!("wrong denial: {error}"))),
        Ok(_) => Err(io::Error::other(
            "kernel unexpectedly granted ambient authority",
        )),
    }
}
fn syscall_denied(value: libc::c_long) -> io::Result<()> {
    if value == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
        Ok(())
    } else {
        Err(io::Error::other("mandatory syscall denial was absent"))
    }
}
struct OriginalIpc(i32);
impl Drop for OriginalIpc {
    fn drop(&mut self) {
        unsafe {
            libc::shmctl(self.0, libc::IPC_RMID, std::ptr::null_mut());
        }
    }
}

fn inside(profile: &str, mode: &str, path: &Path) -> io::Result<()> {
    if ["source-alias", "source-fifo"].contains(&mode) {
        return match linux_confinement::initialize(profile) {
            Err(_) => Ok(()),
            Ok(()) => Err(io::Error::other("non-original input admitted")),
        };
    }
    linux_confinement::initialize(profile)?;
    let mut leaf: serde_json::Value = serde_json::from_str(profile).map_err(io::Error::other)?;
    leaf["leaf"] = serde_json::json!(true);
    linux_confinement::initialize(&leaf.to_string())?;
    match mode {
        "read" | "runtime-read" => {
            if fs::read(path)? != b"original declared bytes" {
                return Err(io::Error::other("declared bytes differ"));
            }
        }
        "ambient" => denied(fs::read(path), &[libc::ENOENT, libc::EACCES])?,
        "write" => {
            fs::write(path, b"owned output")?;
        }
        "root-write" => denied(fs::write(path, b"foreign bytes"), &[libc::EROFS])?,
        "null" => {
            use std::io::{Read, Write};
            let mut null = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/null")?;
            null.write_all(b"discarded")?;
            if null.read(&mut [0u8; 1])? != 0 {
                return Err(io::Error::other("null resource differs"));
            }
        }
        "input-write" | "shared-input-write" | "runtime-write" => {
            denied(fs::write(path, b"foreign bytes"), &[libc::EROFS])?
        }
        "input-remove" | "shared-input-remove" => {
            denied(fs::remove_file(path), &[libc::EROFS, libc::EBUSY])?
        }
        "input-mode" => denied(
            fs::set_permissions(path, fs::Permissions::from_mode(0o777)),
            &[libc::EROFS],
        )?,
        "input-parent-rename" => denied(
            fs::rename(path, path.with_file_name("foreign")),
            &[libc::EROFS, libc::EBUSY],
        )?,
        "socket" => syscall_denied(
            unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) } as libc::c_long
        )?,
        "namespace" => {
            syscall_denied(unsafe { libc::unshare(libc::CLONE_NEWUSER) } as libc::c_long)?
        }
        "fork" => {
            let child = unsafe { libc::fork() };
            if child == 0 {
                unsafe { libc::_exit(91) };
            }
            if child > 0 {
                let mut status = 0;
                unsafe { libc::waitpid(child, &mut status, 0) };
            }
            syscall_denied(child as libc::c_long)?;
        }
        "thread" => {
            if std::thread::spawn(|| 42)
                .join()
                .map_err(|_| io::Error::other("thread panicked"))?
                != 42
            {
                return Err(io::Error::other("native compiler thread did not complete"));
            }
        }
        "ambient-ipc" => {
            let id: i32 = path
                .to_str()
                .ok_or_else(|| io::Error::other("missing IPC identity"))?
                .parse()
                .map_err(io::Error::other)?;
            let mut info = std::mem::MaybeUninit::<libc::shmid_ds>::uninit();
            if unsafe { libc::shmctl(id, libc::IPC_STAT, info.as_mut_ptr()) } != -1
                || ![libc::EINVAL, libc::EIDRM, libc::ENOENT]
                    .contains(&io::Error::last_os_error().raw_os_error().unwrap_or(0))
            {
                return Err(io::Error::other("ambient host IPC remained visible"));
            }
        }
        "inherited" => {
            let fd: i32 = path
                .to_str()
                .ok_or_else(|| io::Error::other("missing inherited descriptor"))?
                .parse()
                .map_err(io::Error::other)?;
            let mut byte = 0u8;
            if unsafe { libc::read(fd, (&mut byte as *mut u8).cast(), 1) } != -1
                || io::Error::last_os_error().raw_os_error() != Some(libc::EBADF)
            {
                return Err(io::Error::other(
                    "inherited ambient File survived confinement",
                ));
            }
        }
        _ => return Err(io::Error::other("unknown kernel control")),
    }
    Ok(())
}

fn main() -> io::Result<()> {
    if !cfg!(target_os = "linux") {
        return Err(io::Error::other("native Linux kernel is mandatory"));
    }
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--inside") {
        if args.len() != 5 {
            return Err(io::Error::other("exact child control arguments required"));
        }
        return inside(&args[2], &args[3], Path::new(&args[4]));
    }
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let base =
        std::env::temp_dir().join(format!("merkur-linux-confinement-{}", std::process::id()));
    fs::create_dir(&base)?;
    fs::set_permissions(&base, fs::Permissions::from_mode(0o700))?;
    let result = (|| {
        let ambient = base.join("ambient");
        fs::write(&ambient, b"outside original bytes")?;
        let inherited = fs::File::open(&ambient)?;
        let id = unsafe { libc::shmget(libc::IPC_PRIVATE, 4096, libc::IPC_CREAT | 0o600) };
        if id < 0 {
            return Err(io::Error::last_os_error());
        }
        let ipc = OriginalIpc(id);
        let cases = [
            "read",
            "ambient",
            "write",
            "input-write",
            "input-remove",
            "input-mode",
            "input-parent-rename",
            "socket",
            "namespace",
            "fork",
            "thread",
            "inherited",
            "root-write",
            "null",
            "runtime-read",
            "runtime-write",
            "shared-input-write",
            "shared-input-remove",
            "source-alias",
            "source-fifo",
            "ambient-ipc",
        ];
        for (index, mode) in cases.into_iter().enumerate() {
            let slot = base.join(index.to_string());
            fs::create_dir(&slot)?;
            let workspace = slot.join("execroot");
            let incremental = slot.join("incremental");
            let root = slot.join("root");
            let scratch = workspace.join(".scratch");
            for dir in [&workspace, &incremental, &root, &scratch] {
                fs::create_dir(dir)?;
            }
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
            let shared = mode.starts_with("shared-input-");
            let member = if shared { "out/input" } else { "src/input" };
            let source = workspace.join(member);
            fs::create_dir(source.parent().unwrap())?;
            fs::write(&source, b"original declared bytes")?;
            if !workspace.join("out").exists() {
                fs::create_dir(workspace.join("out"))?;
            }
            if mode == "source-alias" {
                fs::remove_file(&source)?;
                std::os::unix::fs::symlink(&ambient, &source)?;
            } else if mode == "source-fifo" {
                fs::remove_file(&source)?;
                let name = std::ffi::CString::new(source.as_os_str().as_encoded_bytes())
                    .map_err(io::Error::other)?;
                if unsafe { libc::mkfifo(name.as_ptr(), 0o600) } != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let runtime = if mode.starts_with("runtime-") {
                serde_json::json!([{"input":member,"path":"/runtime/original"}])
            } else {
                serde_json::json!([])
            };
            let profile = serde_json::json!({"workspace":workspace,"incremental":incremental,"root":root,"scratch":scratch,"inputs":[member],"outputs":["out/result"],"runtime":runtime,"leaf":false}).to_string();
            let path = match mode {
                "ambient" => ambient.clone(),
                "root-write" => "/foreign".into(),
                "runtime-read" | "runtime-write" => "/runtime/original".into(),
                "write" => workspace.join("out/result"),
                "input-parent-rename" => workspace.join("src"),
                "inherited" => inherited.as_raw_fd().to_string().into(),
                "ambient-ipc" => ipc.0.to_string().into(),
                _ => source.clone(),
            };
            let mut command = Command::new(&executable);
            command
                .args(["--inside", &profile, mode])
                .arg(path)
                .env_clear();
            let fd = inherited.as_raw_fd();
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(fd, libc::F_SETFD, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let output = command.output()?;
            if !output.status.success() {
                return Err(io::Error::other(format!(
                    "{mode}: {} {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                )));
            }
            if (!matches!(mode, "source-alias" | "source-fifo")
                && fs::read(&source)? != b"original declared bytes")
                || fs::read(&ambient)? != b"outside original bytes"
            {
                return Err(io::Error::other("original/caller File changed"));
            }
            if mode == "write" && fs::read(workspace.join("out/result"))? != b"owned output" {
                return Err(io::Error::other(
                    "output was not actually published by confined process",
                ));
            }
            println!("kernel control {mode}: PASS");
        }
        Ok(())
    })();
    fs::remove_dir_all(&base)?;
    result
}
