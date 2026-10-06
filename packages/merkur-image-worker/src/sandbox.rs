//! The worker is a clean executable. Install confinement before its READY byte.
use std::io;

/// Stack resource bound, also charged for possible demand growth on Linux.
const STACK_BYTES: u64 = 8 * 1024 * 1024;

pub fn enter() -> io::Result<()> {
    // Resource ceilings: one job, no files, no core dumps, bounded virtual space
    // and eight CPU seconds. Waiting for input consumes none of the CPU budget.
    // SAFETY: each limit structure is initialized and lives through its syscall.
    // This executable is single-threaded and has not consumed untrusted bytes.
    unsafe {
        for (resource, limit) in [
            (libc::RLIMIT_CORE, 0),
            (libc::RLIMIT_FSIZE, 0),
            (libc::RLIMIT_CPU, 8),
            (libc::RLIMIT_STACK, STACK_BYTES),
        ] {
            let limits = libc::rlimit {
                rlim_cur: limit,
                rlim_max: limit,
            };
            if libc::setrlimit(resource, &limits) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    platform()
}

fn limit_descriptors() -> io::Result<()> {
    // Only stdin/stdout/stderr exist. This also prohibits creating a socket
    // before its denied connect/bind operation on Darwin.
    // SAFETY: the initialized rlimit is borrowed only for the call.
    unsafe {
        let limits = libc::rlimit {
            rlim_cur: 3,
            rlim_max: 3,
        };
        if libc::setrlimit(libc::RLIMIT_NOFILE, &limits) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[path = "sandbox/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn platform() -> io::Result<()> {
    macos::enter()
}

#[cfg(target_os = "linux")]
fn platform() -> io::Result<()> {
    use libc::{sock_filter, sock_fprog};
    // Audit before seccomp closes procfs. The fixed arena is already mapped;
    // stack growth is separately covered even when not resident yet.
    let statm = std::fs::read_to_string("/proc/self/statm")?;
    let pages = statm
        .split_whitespace()
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .ok_or_else(|| io::Error::other("address-space inventory failed"))?;
    // SAFETY: sysconf has no pointer arguments.
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0
        || pages
            .checked_mul(page_size as u64)
            .and_then(|bytes| bytes.checked_add(STACK_BYTES))
            .is_none_or(|bytes| bytes > merkur_image_worker::WORKSPACE_BYTES as u64)
    {
        return Err(io::Error::other("worker address space exceeds reservation"));
    }
    const LOAD: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
    const EQ: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
    const RET: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
    #[cfg(target_arch = "x86_64")]
    const ARCH: u32 = 0xc000003e;
    #[cfg(target_arch = "aarch64")]
    const ARCH: u32 = 0xc00000b7;
    let stmt = |code, k| sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    };
    let mut filter = vec![
        stmt(LOAD, 4),
        sock_filter {
            code: EQ,
            jt: 1,
            jf: 0,
            k: ARCH,
        },
        stmt(RET, libc::SECCOMP_RET_KILL_PROCESS),
        stmt(LOAD, 0),
    ];
    // No open/socket/exec/clone/ptrace/process_vm/IPC/ioctl syscall exists in
    // this allowlist. Only inherited pipe descriptors survive close_range.
    for syscall in [
        libc::SYS_read,
        libc::SYS_pread64,
        libc::SYS_write,
        libc::SYS_close,
        libc::SYS_fstat,
        libc::SYS_lseek,
        libc::SYS_futex,
        libc::SYS_clock_gettime,
        libc::SYS_rt_sigaction,
        libc::SYS_rt_sigprocmask,
        libc::SYS_rt_sigreturn,
        libc::SYS_sigaltstack,
        libc::SYS_exit,
        libc::SYS_exit_group,
    ] {
        filter.push(sock_filter {
            code: EQ,
            jt: 0,
            jf: 1,
            k: syscall as u32,
        });
        filter.push(stmt(RET, libc::SECCOMP_RET_ALLOW));
    }
    filter.push(stmt(RET, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32));
    let program = sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    let limits = libc::rlimit {
        rlim_cur: merkur_image_worker::WORKSPACE_BYTES as u64,
        rlim_max: merkur_image_worker::WORKSPACE_BYTES as u64,
    };
    // SAFETY: `limits` is an initialized `rlimit` that `setrlimit` only reads.
    if unsafe { libc::setrlimit(libc::RLIMIT_AS, &limits) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `close_range` takes three integers in the platform ABI. Only this
    // single-threaded worker's descriptors above the three standard ones are
    // closed, and the worker has opened none of its own, so no Rust owner
    // exists for any of them.
    if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } != 0 {
        return Err(io::Error::last_os_error());
    }
    limit_descriptors()?;
    // SAFETY: `PR_SET_DUMPABLE` takes integer arguments only.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `PR_SET_NO_NEW_PRIVS` takes integer arguments only.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel copies the filter during prctl; its backing vector and
    // sock_fprog remain live and aligned for that call.
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform() -> io::Result<()> {
    Err(io::Error::other("unsupported image sandbox platform"))
}
