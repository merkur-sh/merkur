//! Cold CLI operation: retain a kernel process identity through graceful exit.

use std::io;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

pub fn run(args: &[String]) -> i32 {
    let result = match args {
        [pid] => pid
            .parse::<libc::pid_t>()
            .ok()
            .filter(|pid| *pid > 0)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "expected a positive pid"))
            .and_then(|pid| {
                let process = Process::open(pid)?;
                io::stdout().write_all(b"ready\n")?;
                io::stdout().flush()?;
                let mut request = [0];
                io::stdin().read_exact(&mut request)?;
                if request != [b's'] {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "expected stop request",
                    ));
                }
                process.stop()
            }),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected one pid",
        )),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("graceful process stop failed: {error}");
            1
        }
    }
}

impl Process {
    fn stop(&self) -> io::Result<()> {
        // A supervisor may have stopped the captured process after registration.
        // ESRCH is safe only because the kernel exit watch is already armed.
        if let Err(error) = self.terminate() {
            if error.raw_os_error() == Some(libc::ESRCH) {
                #[cfg(target_os = "linux")]
                return self.wait();
                #[cfg(target_os = "macos")]
                return if self.exit_event(false)? {
                    Ok(())
                } else {
                    // Exec changes Darwin's audit-token version without an
                    // exit. Do not wait forever on an unsignalled process.
                    Err(error)
                };
            }
            return Err(error);
        }
        self.wait()
    }
}

#[cfg(target_os = "linux")]
struct Process(OwnedFd);

#[cfg(target_os = "linux")]
impl Process {
    fn open(pid: libc::pid_t) -> io::Result<Self> {
        // SAFETY: pidfd_open takes the validated pid and zero flags, no pointers.
        let result = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = i32::try_from(result).map_err(io::Error::other)?;
        // SAFETY: the successful syscall returned a new descriptor owned here.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    fn terminate(&self) -> io::Result<()> {
        // SAFETY: this live pidfd names the captured process. A null siginfo asks
        // the kernel to generate the ordinary SIGTERM information.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.0.as_raw_fd(),
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn wait(&self) -> io::Result<()> {
        let mut event = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        loop {
            // SAFETY: event is one initialized pollfd and remains live for this call.
            if unsafe { libc::poll(&raw mut event, 1, -1) } >= 0 {
                return if event.revents & (libc::POLLIN | libc::POLLHUP) != 0 {
                    Ok(())
                } else {
                    Err(io::Error::other("unexpected pidfd event"))
                };
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::*;

    // These are the public Mach audit token ABI and TASK_AUDIT_TOKEN flavor.
    const AUDIT_TOKEN_WORDS: u32 = 8;
    const TASK_AUDIT_TOKEN: u32 = 15;

    unsafe extern "C" {
        static mach_task_self_: u32;
        fn task_name_for_pid(task: u32, pid: libc::pid_t, name: *mut u32) -> i32;
        fn mach_port_deallocate(task: u32, name: u32) -> i32;
        fn proc_signal_with_audittoken(token: *const [u32; 8], signal: i32) -> i32;
    }

    pub(super) struct Process {
        queue: OwnedFd,
        token: [u32; 8],
    }

    fn audit_token(pid: libc::pid_t) -> io::Result<[u32; 8]> {
        let mut name = 0;
        // SAFETY: Mach writes one task-name port into name. This read-only
        // process right is released below after extracting its audit token.
        let result = unsafe { task_name_for_pid(mach_task_self_, pid, &raw mut name) };
        if result != 0 {
            return Err(io::Error::other(format!("task name: {result}")));
        }
        let mut token = [0u32; 8];
        let mut words = AUDIT_TOKEN_WORDS;
        // SAFETY: the fixed audit-token buffer has exactly the advertised
        // number of words. The returned token includes the kernel PID version.
        let result = unsafe {
            libc::task_info(
                name,
                TASK_AUDIT_TOKEN,
                token.as_mut_ptr().cast(),
                &raw mut words,
            )
        };
        // SAFETY: name is the send right just returned by task_name_for_pid.
        let _ = unsafe { mach_port_deallocate(mach_task_self_, name) };
        if result != 0 || words != AUDIT_TOKEN_WORDS {
            return Err(io::Error::other(format!("task audit token: {result}")));
        }
        Ok(token)
    }

    impl Process {
        pub(super) fn open(pid: libc::pid_t) -> io::Result<Self> {
            let token = audit_token(pid)?;
            // SAFETY: kqueue creates a new descriptor without pointer arguments.
            let fd = unsafe { libc::kqueue() };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: this is the newly created descriptor, owned only here.
            let queue = unsafe { OwnedFd::from_raw_fd(fd) };
            let change = libc::kevent {
                ident: usize::try_from(pid).map_err(io::Error::other)?,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            // SAFETY: change is initialized and registration has no output buffer.
            if unsafe {
                libc::kevent(
                    queue.as_raw_fd(),
                    &raw const change,
                    1,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            } < 0
            {
                return Err(io::Error::last_os_error());
            }
            // Registration uses a numeric PID. Recapture after it succeeds so
            // both the exit watch and signal token identify this incarnation.
            // If the PID changed or disappeared, fail before publishing ready.
            if audit_token(pid)? != token {
                return Err(io::Error::other(
                    "process identity changed during watch registration",
                ));
            }
            Ok(Self { queue, token })
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            // SAFETY: the complete kernel audit token names the captured process,
            // including PID version, so reuse cannot signal a successor process.
            let result =
                unsafe { proc_signal_with_audittoken(&raw const self.token, libc::SIGTERM) };
            if result == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(result))
            }
        }

        pub(super) fn wait(&self) -> io::Result<()> {
            self.exit_event(true).map(|_| ())
        }

        pub(super) fn exit_event(&self, blocking: bool) -> io::Result<bool> {
            let mut event = std::mem::MaybeUninit::<libc::kevent>::uninit();
            let immediate = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let timeout = if blocking {
                std::ptr::null()
            } else {
                &raw const immediate
            };
            loop {
                // SAFETY: kevent initializes one event on a successful return.
                let result = unsafe {
                    libc::kevent(
                        self.queue.as_raw_fd(),
                        std::ptr::null(),
                        0,
                        event.as_mut_ptr(),
                        1,
                        timeout,
                    )
                };
                if result == 1 {
                    // SAFETY: exactly one initialized event was returned.
                    let event = unsafe { event.assume_init() };
                    return if event.flags & libc::EV_ERROR == 0
                        && event.fflags & libc::NOTE_EXIT != 0
                    {
                        Ok(true)
                    } else {
                        Err(io::Error::other("unexpected process exit event"))
                    };
                }
                if result == 0 {
                    return Ok(false);
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
use darwin::Process;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn graceful_stop_waits_for_the_real_process_after_three_seconds() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "trap 'printf \"%s\\n\" retiring; read release; exit 0' TERM; printf '%s\\n' ready; read waiting"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        let pid = libc::pid_t::try_from(child.id()).unwrap();
        let (done, completed) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            done.send(Process::open(pid).unwrap().stop()).unwrap();
        });
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "retiring");
        std::thread::sleep(Duration::from_millis(3100));
        assert!(matches!(
            completed.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        completed.recv().unwrap().unwrap();
        worker.join().unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn an_unavailable_process_watch_fails_closed() {
        assert!(Process::open(libc::pid_t::MAX).is_err());
        assert_eq!(run(&["0".into()]), 1);
    }

    #[test]
    fn a_supervisor_exit_after_registration_keeps_the_captured_exit_fence() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "read release"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let process = Process::open(libc::pid_t::try_from(child.id()).unwrap()).unwrap();
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
        process.stop().unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_exec_after_registration_fails_without_waiting_on_an_unsignalled_process() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf '%s\\n' ready; read execute; exec /bin/sh -c 'printf \"%s\\n\" replaced; read release'"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");
        let process = Process::open(libc::pid_t::try_from(child.id()).unwrap()).unwrap();
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"execute\n")
            .unwrap();
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "replaced");
        assert_eq!(
            process.stop().unwrap_err().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert!(child.try_wait().unwrap().is_none());
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
    }
}
