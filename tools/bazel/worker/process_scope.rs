//! Linux per-request process ownership. No compiler runs outside its fresh PID namespace.
//!
//! Reaping namespace init is the kernel's completion boundary for every descendant,
//! including forked processes which change their session or close inherited pipes.
//! This is not filesystem confinement; worker eligibility still requires both boundaries.
#[cfg(target_os = "linux")]
mod linux {
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

    static CANCELLED: AtomicBool = AtomicBool::new(false);
    static INIT: AtomicI32 = AtomicI32::new(0);

    extern "C" fn cancel(_: i32) {
        CANCELLED.store(true, Ordering::SeqCst);
        let child = INIT.load(Ordering::SeqCst);
        if child > 0 {
            // INIT remains an unreaped direct child until this handler is blocked.
            // Killing PID 1 closes the namespace to new forks and reaps descendants.
            unsafe { libc::kill(child, libc::SIGKILL) };
        }
    }

    fn checked(result: i32) -> io::Result<()> {
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn block_cancellation() -> io::Result<()> {
        let mut blocked = unsafe { std::mem::zeroed::<libc::sigset_t>() };
        checked(unsafe { libc::sigemptyset(&mut blocked) })?;
        checked(unsafe { libc::sigaddset(&mut blocked, libc::SIGTERM) })?;
        checked(unsafe { libc::sigprocmask(libc::SIG_BLOCK, &blocked, std::ptr::null_mut()) })
    }

    struct NamespaceChild(Option<i32>);
    impl NamespaceChild {
        fn reap(&mut self) -> io::Result<i32> {
            block_cancellation()?;
            let child = self
                .0
                .ok_or_else(|| io::Error::other("namespace already reaped"))?;
            let mut status = 0;
            loop {
                if unsafe { libc::waitpid(child, &mut status, 0) } == child {
                    self.0 = None;
                    INIT.store(0, Ordering::SeqCst);
                    return Ok(status);
                }
                let failure = io::Error::last_os_error();
                if failure.kind() != io::ErrorKind::Interrupted {
                    return Err(failure);
                }
            }
        }
    }
    impl Drop for NamespaceChild {
        fn drop(&mut self) {
            if let Some(child) = self.0 {
                // Every post-fork error uses this same teardown boundary.
                unsafe { libc::kill(child, libc::SIGKILL) };
                let _ = self.reap();
            }
        }
    }

    fn parent_alive(parent: &OwnedFd) -> io::Result<()> {
        let mut event = libc::pollfd {
            fd: parent.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut event, 1, 0) };
        if ready < 0 {
            return Err(io::Error::last_os_error());
        }
        if ready != 0 || event.revents != 0 {
            return Err(io::Error::other(
                "process owner exited before namespace admission",
            ));
        }
        Ok(())
    }

    fn namespace_child(parent: &OwnedFd, command: &[String]) -> io::Result<()> {
        // Parent death is unsuppressable. The held pidfd closes the fork/prctl race:
        // readiness is an event on this exact parent, not a reusable numeric PID.
        checked(unsafe {
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGKILL as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            )
        })?;
        parent_alive(parent)?;
        if unsafe { libc::getpid() } != 1 {
            return Err(io::Error::other("compiler wrapper is not namespace init"));
        }
        // The outer supervisor owns cancellation. Do not carry its handler across exec.
        unsafe { libc::signal(libc::SIGTERM, libc::SIG_DFL) };
        Err(Command::new(&command[0]).args(&command[1..]).exec())
    }

    pub fn run(owner: &OwnedFd, command: &[String]) -> io::Result<i32> {
        if command.is_empty() {
            return Err(io::Error::other("missing compiler wrapper"));
        }
        let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
        action.sa_sigaction = cancel as *const () as usize;
        checked(unsafe { libc::sigemptyset(&mut action.sa_mask) })?;
        checked(unsafe { libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut()) })?;
        checked(unsafe {
            libc::prctl(
                libc::PR_SET_PDEATHSIG,
                libc::SIGTERM as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
                0 as libc::c_ulong,
            )
        })?;
        // The caller opens its own pidfd before spawning us. Unlike getppid(), this
        // retains the original owner even if it died before this executable started.
        parent_alive(owner)?;
        // Validate the inherited capability in the owner's namespace. Namespace init
        // may poll its parent's held pidfd but cannot signal into an ancestor namespace.
        if unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                owner.as_raw_fd(),
                0,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let parent = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
        if parent < 0 {
            return Err(io::Error::last_os_error());
        }
        let parent = unsafe { OwnedFd::from_raw_fd(parent as i32) };
        // Mandatory kernel authority. Never fall back to a process-group snapshot.
        checked(unsafe { libc::unshare(libc::CLONE_NEWPID) })?;
        if CANCELLED.load(Ordering::SeqCst) {
            return Ok(130);
        }
        let child = unsafe { libc::fork() };
        if child < 0 {
            return Err(io::Error::last_os_error());
        }
        if child == 0 {
            let failure = namespace_child(&parent, command).unwrap_err();
            eprintln!("process namespace admission failed: {failure}");
            unsafe { libc::_exit(1) };
        }
        INIT.store(child, Ordering::SeqCst);
        let mut namespace = NamespaceChild(Some(child));
        if CANCELLED.load(Ordering::SeqCst) {
            cancel(libc::SIGTERM);
        }
        // Keep the exact PID reserved through exit readiness and cancellation.
        loop {
            let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    child as u32,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            } == 0
            {
                break;
            }
            let failure = io::Error::last_os_error();
            if failure.kind() != io::ErrorKind::Interrupted {
                return Err(failure);
            }
        }
        let status = namespace.reap()?;
        Ok(if CANCELLED.load(Ordering::SeqCst) {
            130
        } else if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            128 + libc::WTERMSIG(status)
        })
    }
}

fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() < 4 || args[0] != "--owner-fd" || args[2] != "--" {
        return Err(std::io::Error::other(
            "process scope requires --owner-fd <inherited owner pidfd> -- <compiler wrapper>",
        ));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{FromRawFd, OwnedFd};
        let descriptor = args[1].parse::<i32>().map_err(std::io::Error::other)?;
        if descriptor < 3 {
            return Err(std::io::Error::other("invalid process-owner descriptor"));
        }
        let owner = unsafe { OwnedFd::from_raw_fd(descriptor) };
        std::process::exit(linux::run(&owner, &args[3..])?);
    }
    #[cfg(not(target_os = "linux"))]
    Err(std::io::Error::other(
        "PID namespace process ownership requires Linux",
    ))
}
