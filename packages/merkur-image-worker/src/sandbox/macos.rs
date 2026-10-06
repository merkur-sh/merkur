//! Compile policy and inventory memory before permanently freezing the address space.
use std::io;

#[repr(C)]
struct Profile {
    builtin: *mut libc::c_char,
    data: *const u8,
    size: usize,
}

#[link(name = "sandbox")]
unsafe extern "C" {
    fn sandbox_compile_string(
        source: *const libc::c_char,
        parameters: *mut libc::c_void,
        error: *mut *mut libc::c_char,
    ) -> *mut Profile;
    fn sandbox_apply(profile: *mut Profile) -> libc::c_int;
    fn sandbox_free_profile(profile: *mut Profile);
    fn sandbox_free_error(error: *mut libc::c_char);
    fn mach_vm_region_recurse(
        task: u32,
        address: *mut u64,
        size: *mut u64,
        depth: *mut u32,
        info: *mut i32,
        count: *mut u32,
    ) -> libc::c_int;
}

#[link(name = "proc")]
unsafe extern "C" {
    fn proc_pidinfo(
        pid: libc::c_int,
        flavor: libc::c_int,
        arg: u64,
        buffer: *mut libc::c_void,
        size: libc::c_int,
    ) -> libc::c_int;
}

pub(super) fn enter() -> io::Result<()> {
    // Default-deny alone does not filter all BSD, Mach-trap or kernel-MIG calls.
    // No memory, port, timer, thread or message allocation is permitted after READY.
    let source = c"(version 1)
        (deny default (with no-log))
        (deny syscall-unix (with no-log))
        (deny syscall-mach (with no-log))
        (deny syscall-mig (with no-log))
        (allow syscall-unix (syscall-number
            SYS_read SYS_read_nocancel SYS_pread SYS_pread_nocancel
            SYS_write SYS_write_nocancel SYS_close
            SYS_fstat64 SYS_fcntl SYS_getpid SYS_getppid SYS_thread_selfid
            SYS_sigreturn SYS_sigaction SYS_sigprocmask SYS_sigaltstack SYS_exit))";
    // Compile before inventory: the compiler's own mappings must be charged too.
    let mut error = std::ptr::null_mut();
    // SAFETY: static NUL-terminated source, null parameters, initialized out pointer.
    let profile =
        unsafe { sandbox_compile_string(source.as_ptr(), std::ptr::null_mut(), &mut error) };
    let compile_error = if error.is_null() {
        None
    } else {
        // SAFETY: the compiler owns this NUL-terminated diagnostic until freed below.
        let message = unsafe { std::ffi::CStr::from_ptr(error) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: `error` is the non-null diagnostic the compiler allocated; it
        // was copied into `message` above and is freed exactly once, here.
        unsafe { sandbox_free_error(error) };
        Some(message)
    };
    if profile.is_null() {
        return Err(io::Error::other(format!(
            "sandbox_compile_string: {}",
            compile_error.as_deref().unwrap_or("no compiler diagnostic")
        )));
    }
    let prepared = prepare();
    if let Err(error) = prepared {
        // SAFETY: compilation returned this live profile; confinement is not installed.
        unsafe { sandbox_free_profile(profile) };
        return Err(error);
    }
    // Apply the already compiled policy. Retain its finite allocation until exit:
    // freeing it through the system allocator could request a now-forbidden unmap.
    // SAFETY: profile stays live through application and the remaining process lifetime.
    if unsafe { sandbox_apply(profile) } != 0 {
        return Err(io::Error::other(format!(
            "sandbox_apply: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn prepare() -> io::Result<()> {
    // Only this clean executable's three pipes survive. No input has been consumed.
    // SAFETY: `getpid` takes no argument and cannot fail.
    let pid = unsafe { libc::getpid() };
    // SAFETY: a null buffer of size zero asks libproc only for the byte count
    // of the descriptor list (flavor 1); nothing is written.
    let count = unsafe { proc_pidinfo(pid, 1, 0, std::ptr::null_mut(), 0) };
    if !(24..=1024 * 1024).contains(&count) || count % 8 != 0 {
        return Err(io::Error::other("descriptor inventory failed"));
    }
    let mut descriptors = vec![0u32; count as usize / 4];
    // SAFETY: `descriptors` is `count / 4` initialized `u32`s, exactly the
    // `count` bytes libproc is told it may write.
    let bytes = unsafe { proc_pidinfo(pid, 1, 0, descriptors.as_mut_ptr().cast(), count) };
    if bytes < 24 || bytes > count || bytes % 8 != 0 {
        return Err(io::Error::other("descriptor inventory changed"));
    }
    for descriptor in descriptors[..bytes as usize / 4].chunks_exact(2) {
        if descriptor[0] >= 3 {
            // SAFETY: `close` takes an integer. libproc just listed this
            // descriptor as open in this process, above the three standard
            // ones, and this runs before the helper opens anything of its own,
            // so no Rust owner exists for it.
            unsafe { libc::close(descriptor[0] as libc::c_int) };
        }
    }
    super::limit_descriptors()?;
    let writable = writable_bytes()?;
    if writable > merkur_image_worker::WORKSPACE_BYTES as u64 {
        return Err(io::Error::other(format!(
            "worker writable space {writable} exceeds reservation {}",
            merkur_image_worker::WORKSPACE_BYTES
        )));
    }
    // SAFETY: `proc_taskinfo` holds only integers, for which all-zero bytes
    // are a valid value.
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    // SAFETY: `info` is a live `proc_taskinfo` of exactly `size` bytes, the
    // extent libproc writes for the task-info flavor (4).
    let written = unsafe {
        proc_pidinfo(
            pid,
            4,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    };
    if written != size {
        return Err(io::Error::other("address-space inventory failed"));
    }
    // No additional virtual address space during policy installation either.
    // The large kernel-reserved regions confer no post-confinement credit:
    // both BSD and Mach mapping/protection/deallocation calls are denied.
    let limits = libc::rlimit {
        rlim_cur: info.pti_virtual_size,
        rlim_max: info.pti_virtual_size,
    };
    // SAFETY: `limits` is an initialized `rlimit` that `setrlimit` only reads.
    if unsafe { libc::setrlimit(libc::RLIMIT_AS, &limits) } != 0 {
        return Err(io::Error::other(format!(
            "setrlimit(RLIMIT_AS): {}",
            io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn writable_bytes() -> io::Result<u64> {
    // ABI: VM_REGION_SUBMAP_INFO_V0_COUNT_64 is sixteen 32-bit words; protection
    // is word 0 and is_submap is word 12. Recursing matters: top-level submaps can
    // report read-only while their leaves contain writable copy-on-write pages.
    // Resource bound on startup inventory work, including all dyld-cache leaves.
    const MAX_REGIONS: usize = 65536;
    // SAFETY: `mach_task_self` takes no argument and returns this task's own
    // port name by value.
    #[expect(deprecated, reason = "libc prefers a Mach wrapper crate; the stable C ABI suffices")]
    let task = unsafe { libc::mach_task_self() };
    let mut address = 0;
    let mut depth = 0;
    // Charge full stack headroom as well as the currently mapped stack.
    let mut total = super::STACK_BYTES;
    for _ in 0..MAX_REGIONS {
        let start = address;
        let mut size = 0;
        let mut info = [0i32; 16];
        let mut count = info.len() as u32;
        // SAFETY: all out arguments have the ABI's exact writable extent. This
        // read-only walk targets our own task and completes before confinement.
        let result = unsafe {
            mach_vm_region_recurse(
                task,
                &mut address,
                &mut size,
                &mut depth,
                info.as_mut_ptr(),
                &mut count,
            )
        };
        if result == libc::KERN_INVALID_ADDRESS {
            return Ok(total);
        }
        if result != 0 || count != 16 || size == 0 || address < start {
            return Err(io::Error::other("writable-space inventory failed"));
        }
        if info[12] != 0 {
            depth = depth
                .checked_add(1)
                .ok_or_else(|| io::Error::other("submap depth overflow"))?;
        } else {
            if info[0] & libc::VM_PROT_WRITE != 0 {
                total = total
                    .checked_add(size)
                    .ok_or_else(|| io::Error::other("writable-space overflow"))?;
            }
            address = address
                .checked_add(size)
                .ok_or_else(|| io::Error::other("address overflow"))?;
        }
    }
    Err(io::Error::other("mapping inventory exceeds resource bound"))
}
