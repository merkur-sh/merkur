//! Mandatory namespace confinement. Unsupported kernel authority is an error.
use crate::linux_policy::Policy;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path};

fn checked(value: libc::c_long) -> io::Result<()> {
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn name(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)
}

// Every component is an original, ordinary private File/directory, not a symlink.
fn pin_kind(path: &Path, expected: libc::mode_t) -> io::Result<OwnedFd> {
    let directory = expected == libc::S_IFDIR;
    let mut current = unsafe { libc::open(c"/".as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    checked(current as libc::c_long)?;
    let mut fd = unsafe { OwnedFd::from_raw_fd(current) };
    let parts: Vec<_> = path
        .components()
        .filter(|p| *p != Component::RootDir)
        .collect();
    for (index, part) in parts.iter().enumerate() {
        if !matches!(part, Component::Normal(_)) {
            return Err(io::Error::other("non-original confinement path"));
        }
        let leaf = index + 1 == parts.len();
        let flags = libc::O_PATH
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if !leaf || directory {
                libc::O_DIRECTORY
            } else {
                0
            };
        current = unsafe {
            libc::openat(
                fd.as_raw_fd(),
                name(Path::new(part.as_os_str()))?.as_ptr(),
                flags,
            )
        };
        checked(current as libc::c_long)?;
        fd = unsafe { OwnedFd::from_raw_fd(current) };
    }
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    checked(unsafe { libc::fstat(fd.as_raw_fd(), info.as_mut_ptr()) } as libc::c_long)?;
    let info = unsafe { info.assume_init() };
    if info.st_mode & libc::S_IFMT != expected {
        return Err(io::Error::other(
            "confinement input is not its ordinary declared File",
        ));
    }
    Ok(fd)
}

fn pin(path: &Path, directory: bool) -> io::Result<OwnedFd> {
    pin_kind(
        path,
        if directory {
            libc::S_IFDIR
        } else {
            libc::S_IFREG
        },
    )
}
fn null_resource() -> io::Result<OwnedFd> {
    let fd = pin_kind(Path::new("/dev/null"), libc::S_IFCHR)?;
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    checked(unsafe { libc::fstat(fd.as_raw_fd(), info.as_mut_ptr()) } as libc::c_long)?;
    let info = unsafe { info.assume_init() };
    if libc::major(info.st_rdev) != 1 || libc::minor(info.st_rdev) != 3 {
        return Err(io::Error::other(
            "/dev/null is not the original null kernel device",
        ));
    }
    Ok(fd)
}

fn mirrored(root: &Path, path: &Path) -> io::Result<std::path::PathBuf> {
    Ok(root.join(path.strip_prefix("/").map_err(io::Error::other)?))
}
fn mount(
    source: Option<&CString>,
    target: &CString,
    kind: Option<&CString>,
    flags: libc::c_ulong,
) -> io::Result<()> {
    checked(unsafe {
        libc::mount(
            source.map_or(std::ptr::null(), |p| p.as_ptr()),
            target.as_ptr(),
            kind.map_or(std::ptr::null(), |p| p.as_ptr()),
            flags,
            std::ptr::null(),
        )
    } as libc::c_long)
}
fn bind_flags(fd: &OwnedFd, target: &Path, flags: libc::c_ulong) -> io::Result<()> {
    let source =
        CString::new(format!("/proc/self/fd/{}", fd.as_raw_fd())).map_err(io::Error::other)?;
    let target = name(target)?;
    mount(Some(&source), &target, None, libc::MS_BIND)?;
    mount(
        None,
        &target,
        None,
        libc::MS_BIND | libc::MS_REMOUNT | libc::MS_NOSUID | flags,
    )
}

fn bind(fd: &OwnedFd, target: &Path, readonly: bool) -> io::Result<()> {
    bind_flags(
        fd,
        target,
        libc::MS_NODEV | if readonly { libc::MS_RDONLY } else { 0 },
    )
}

#[repr(C)]
struct CapHeader {
    version: u32,
    pid: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}
fn capabilities() -> io::Result<[CapData; 2]> {
    let header = CapHeader {
        version: 0x20080522,
        pid: 0,
    };
    let mut data = [CapData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    checked(unsafe { libc::syscall(libc::SYS_capget, &header, data.as_mut_ptr()) })?;
    Ok(data)
}
fn drop_capabilities() -> io::Result<()> {
    // Lock NOROOT and NO_SETUID_FIXUP before clearing the current capability sets.
    checked(unsafe { libc::prctl(libc::PR_SET_SECUREBITS, 0x0f, 0, 0, 0) } as libc::c_long)?;
    checked(unsafe {
        libc::prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL,
            0,
            0,
            0,
        )
    } as libc::c_long)?;
    let mut cap = 0;
    loop {
        let present = unsafe { libc::prctl(libc::PR_CAPBSET_READ, cap, 0, 0, 0) };
        if present < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
                break;
            }
            return Err(io::Error::last_os_error());
        }
        checked(unsafe { libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) } as libc::c_long)?;
        cap += 1;
    }
    let header = CapHeader {
        version: 0x20080522,
        pid: 0,
    };
    let data = [CapData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    checked(unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) })?;
    if capabilities()?
        .iter()
        .any(|c| c.effective | c.permitted | c.inheritable != 0)
    {
        return Err(io::Error::other("compiler capabilities were not removed"));
    }
    Ok(())
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Filter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}
#[repr(C)]
struct Program {
    len: u16,
    filter: *const Filter,
}
const LD: u16 = 0x20;
const JEQ: u16 = 0x15;
const JSET: u16 = 0x45;
const RET: u16 = 0x06;
const ALLOW: u32 = 0x7fff0000;
const KILL: u32 = 0x80000000;
const DENY: u32 = 0x00050000 | libc::EPERM as u32;
fn statement(code: u16, k: u32) -> Filter {
    Filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}
fn jump(code: u16, k: u32, jt: u8, jf: u8) -> Filter {
    Filter { code, jt, jf, k }
}

fn filters(leaf: bool) -> Vec<Filter> {
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    compile_error!(
        "Linux worker confinement requires a qualified native x86_64/aarch64 syscall ABI"
    );
    #[cfg(target_arch = "x86_64")]
    let arch = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    let arch = 0xc00000b7;
    let mut f = vec![
        statement(LD, 4),
        jump(JEQ, arch, 1, 0),
        statement(RET, KILL),
        statement(LD, 0),
    ];
    // x32 shares AUDIT_ARCH_X86_64, but has a separate syscall number namespace.
    #[cfg(target_arch = "x86_64")]
    f.extend([jump(JSET, 0x40000000, 0, 1), statement(RET, KILL)]);
    for nr in [
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_open_by_handle_at,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_mount_setattr,
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_pidfd_getfd,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_io_uring_setup,
        libc::SYS_userfaultfd,
        libc::SYS_kexec_load,
        libc::SYS_kexec_file_load,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_reboot,
    ] {
        f.extend([jump(JEQ, nr as u32, 0, 1), statement(RET, DENY)]);
    }
    if leaf {
        #[cfg(target_arch = "x86_64")]
        for nr in [libc::SYS_fork, libc::SYS_vfork] {
            f.extend([jump(JEQ, nr as u32, 0, 1), statement(RET, DENY)]);
        }
        // A pointer-valued clone3 argument cannot be safely inspected by classic BPF.
        // ENOSYS permits libc's supported pthread fallback to inspectable clone flags.
        f.extend([
            jump(JEQ, libc::SYS_clone3 as u32, 0, 1),
            statement(RET, 0x00050000 | libc::ENOSYS as u32),
        ]);
        f.push(jump(JEQ, libc::SYS_clone as u32, 0, 8));
        f.extend([
            statement(LD, 20),
            jump(JEQ, 0, 1, 0),
            statement(RET, DENY),
            statement(LD, 16),
            jump(JSET, libc::CLONE_THREAD as u32, 1, 0),
            statement(RET, DENY),
            // Only the documented thread-sharing/TLS flags are admitted; no namespace,
            // parent, pidfd, signal-number or process creation flags are inherited.
            jump(
                JSET,
                !(libc::CLONE_VM
                    | libc::CLONE_FS
                    | libc::CLONE_FILES
                    | libc::CLONE_SIGHAND
                    | libc::CLONE_THREAD
                    | libc::CLONE_SYSVSEM
                    | libc::CLONE_SETTLS
                    | libc::CLONE_PARENT_SETTID
                    | libc::CLONE_CHILD_CLEARTID
                    | libc::CLONE_CHILD_SETTID) as u32,
                0,
                1,
            ),
            statement(RET, DENY),
        ]);
    }
    f.push(statement(RET, ALLOW));
    f
}
fn restrict_syscalls(leaf: bool) -> io::Result<()> {
    checked(unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } as libc::c_long)?;
    let filter = filters(leaf);
    let program = Program {
        len: filter.len().try_into().map_err(io::Error::other)?,
        filter: filter.as_ptr(),
    };
    checked(unsafe { libc::syscall(libc::SYS_seccomp, 1, 0, &program) })
}

pub fn initialize(value: &str) -> io::Result<()> {
    let p = Policy::parse(value)?;
    if p.leaf {
        // The outer confiner has already established the owned filesystem before the
        // wrapper parses files or forks. This stage only tightens its compiler child.
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        checked(unsafe { libc::statfs(c"/".as_ptr(), info.as_mut_ptr()) } as libc::c_long)?;
        if unsafe { info.assume_init() }.f_type != 0x01021994
            || unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } != 1
            || unsafe { libc::prctl(libc::PR_GET_SECCOMP, 0, 0, 0, 0) } != 2
            || capabilities()?
                .iter()
                .any(|c| c.effective | c.permitted | c.inheritable != 0)
        {
            return Err(io::Error::other(
                "compiler leaf lacks mandatory outer confinement",
            ));
        }
        return restrict_syscalls(true);
    }
    let root = pin(&p.root, true)?;
    if fs::read_dir(&p.root)?.next().is_some()
        || fs::metadata(&p.root)?.permissions().mode() & 0o777 != 0o700
    {
        return Err(io::Error::other(
            "confinement root is not a fresh private directory",
        ));
    }
    let null = null_resource()?;
    let workspace = pin(&p.workspace, true)?;
    let incremental = pin(&p.incremental, true)?;
    let writable = p.writable();
    let mut writable_fds = Vec::new();
    for path in &writable {
        writable_fds.push((path, pin(path, true)?));
    }
    // Pin every original File before namespace construction; changed/special inputs fail.
    let mut originals = std::collections::BTreeMap::new();
    for input in &p.inputs {
        originals.insert(input, pin(&p.workspace.join(input), false)?);
    }
    let mut readonly_fds = Vec::new();
    for path in p.readonly() {
        let directory = fs::symlink_metadata(&path)?.is_dir();
        readonly_fds.push((path.clone(), pin(&path, directory)?));
    }
    // System-V/POSIX message queues must not expose an ambient host IPC namespace.
    checked(unsafe { libc::unshare(libc::CLONE_NEWNS | libc::CLONE_NEWIPC) } as libc::c_long)?;
    mount(
        None,
        &name(Path::new("/"))?,
        None,
        libc::MS_REC | libc::MS_PRIVATE,
    )?;
    // The root FD remains held through initial mount setup; mounting never escapes the
    // worker's already private empty directory or changes the enclosing host namespace.
    let root_fd_path =
        CString::new(format!("/proc/self/fd/{}", root.as_raw_fd())).map_err(io::Error::other)?;
    mount(
        Some(&CString::new("tmpfs").map_err(io::Error::other)?),
        &root_fd_path,
        Some(&CString::new("tmpfs").map_err(io::Error::other)?),
        libc::MS_NOSUID | libc::MS_NODEV,
    )?;
    for path in [&p.workspace, &p.incremental] {
        fs::create_dir_all(mirrored(&p.root, path)?)?;
    }
    bind(&workspace, &mirrored(&p.root, &p.workspace)?, true)?;
    bind(&incremental, &mirrored(&p.root, &p.incremental)?, false)?;
    for (path, fd) in &writable_fds {
        bind(fd, &mirrored(&p.root, path)?, false)?;
    }
    for (path, fd) in &readonly_fds {
        bind(fd, &mirrored(&p.root, path)?, true)?;
    }
    // ProcessWrapper opens Stdio::null after exec. This is the sole fixed kernel
    // device, not an ambient /dev mount or a publisher-owned runtime File.
    let null_target = p.root.join("dev/null");
    fs::create_dir_all(
        null_target
            .parent()
            .ok_or_else(|| io::Error::other("null parent"))?,
    )?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&null_target)?;
    bind_flags(&null, &null_target, 0)?;
    for runtime in &p.runtime {
        let target = mirrored(&p.root, &runtime.path)?;
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| io::Error::other("runtime destination has no parent"))?,
        )?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        bind(&originals[&runtime.input], &target, true)?;
    }
    // Prefix directories and the root itself are not scratch. Keep the tmpfs read-only;
    // only the separately bound output parents, scratch and incremental mounts can write.
    mount(
        None,
        &name(&p.root)?,
        None,
        libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV,
    )?;
    checked(unsafe { libc::chroot(name(&p.root)?.as_ptr()) } as libc::c_long)?;
    std::env::set_current_dir(&p.workspace)?;
    drop_capabilities()?;
    drop((
        root,
        null,
        workspace,
        incremental,
        writable_fds,
        readonly_fds,
        originals,
    ));
    // No inherited directory, socket or filesystem capability can bypass the new root.
    checked(unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) })?;
    restrict_syscalls(false)
}
