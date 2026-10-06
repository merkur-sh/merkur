//! Local, singleplex Bazel Rust compiler worker. Artifact acceptance belongs to Bazel.
#[cfg(target_os = "linux")]
mod linux_policy;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "linux")]
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

fn error(message: impl std::fmt::Display) -> io::Error {
    io::Error::other(message.to_string())
}
fn field<'a>(value: &'a Value, name: &str) -> io::Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| error(format!("missing string {name}")))
}
fn strings(value: &Value) -> io::Result<Vec<String>> {
    value
        .as_array()
        .ok_or_else(|| error("expected array"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| error("expected string"))
        })
        .collect()
}
fn relative(path: &str) -> io::Result<PathBuf> {
    let p = PathBuf::from(path);
    if path.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(error(format!("non-confined input/output path: {path}")));
    }
    Ok(p)
}
fn declared_inputs(request: &Value) -> io::Result<BTreeMap<String, String>> {
    let mut declared = BTreeMap::new();
    for input in request
        .get("inputs")
        .and_then(Value::as_array)
        .ok_or_else(|| error("no declared input inventory"))?
    {
        let path = field(input, "path")?.to_owned();
        relative(&path)?;
        let digest = field(input, "digest")?.to_owned();
        if digest.is_empty() {
            return Err(error(format!("input has no content digest: {path}")));
        }
        if declared.insert(path.clone(), digest).is_some() {
            return Err(error(format!("duplicate input: {path}")));
        }
    }
    Ok(declared)
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for group in bytes.chunks(3) {
        let n = ((group[0] as u32) << 16)
            | ((group.get(1).copied().unwrap_or(0) as u32) << 8)
            | group.get(2).copied().unwrap_or(0) as u32;
        out.push(alphabet[((n >> 18) & 63) as usize] as char);
        out.push(alphabet[((n >> 12) & 63) as usize] as char);
        out.push(if group.len() > 1 {
            alphabet[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if group.len() > 2 {
            alphabet[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
// Bazel 9.2 UnresolvedSymlinkArtifactValue hashes the normalized target text,
// then flips the first digest byte; WorkerSpawnRunner sends its hex text as bytes.
fn normalized_link(target: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir if normalized.file_name().is_some_and(|name| name != "..") => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
fn link_digest(target: &Path) -> String {
    let mut digest = Sha256::digest(normalized_link(target).as_os_str().as_bytes());
    digest[0] ^= 0xff;
    base64(format!("{digest:x}").as_bytes())
}
fn relative_link_target(path: &str, target: &Path) -> io::Result<PathBuf> {
    let mut joined = relative(path)?.parent().unwrap().to_owned();
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => joined.push(name),
            Component::ParentDir if joined.pop() => {}
            _ => {
                return Err(error(format!(
                    "input symlink escapes declared workspace: {path}"
                )));
            }
        }
    }
    Ok(joined)
}
fn declared_link_target(
    path: &str,
    links: &BTreeMap<String, PathBuf>,
    declared: &BTreeMap<String, String>,
) -> io::Result<PathBuf> {
    let mut resolved = relative_link_target(path, &links[path])?;
    let mut visited = BTreeSet::from([path.to_owned()]);
    loop {
        let mut prefix = PathBuf::new();
        let mut substitution = None;
        for component in resolved.components() {
            prefix.push(component.as_os_str());
            let name = prefix
                .to_str()
                .ok_or_else(|| error("non-UTF8 declared input symlink"))?;
            if let Some(target) = links.get(name) {
                if !visited.insert(name.to_owned()) {
                    return Err(error(format!("cyclic declared input symlink: {path}")));
                }
                let mut next = relative_link_target(name, target)?;
                let suffix = resolved.strip_prefix(&prefix).map_err(error)?;
                if !suffix.as_os_str().is_empty() {
                    next.push(suffix);
                }
                substitution = Some(next);
                break;
            }
        }
        match substitution {
            Some(next) => resolved = next,
            None => break,
        }
    }
    let name = resolved
        .to_str()
        .ok_or_else(|| error("non-UTF8 declared input symlink"))?;
    if declared.contains_key(name) {
        return Ok(resolved);
    }
    // Directory aliases may refer only to directories formed by declared descendants.
    let descendants = format!("{name}/");
    if !declared
        .range(descendants.clone()..)
        .next()
        .is_some_and(|(candidate, _)| candidate.starts_with(&descendants))
    {
        return Err(error(format!(
            "input symlink target is not declared: {path}"
        )));
    }
    Ok(resolved)
}
fn check_link_snapshot(execroot: &Path, path: &str, target: &Path, digest: &str) -> io::Result<()> {
    if fs::read_link(execroot.join(path))? != target || link_digest(target) != digest {
        return Err(error(format!(
            "input symlink changed after Bazel digested it: {path}"
        )));
    }
    Ok(())
}
fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}
// Publication never traverses a caller symlink or truncates a pre-existing hardlink.
// Keep the directory descriptor through each operation; pathname checks alone race rename.
fn component_name(name: &std::ffi::OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(error)
}
fn open_directory_at(parent: i32, name: &CStr, create: bool) -> io::Result<OwnedFd> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if descriptor < 0 && create && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
        if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0
            && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
        {
            return Err(io::Error::last_os_error());
        }
        descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    }
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}
fn public_output_parent(
    root: &Path,
    relative_path: &Path,
    create: bool,
) -> io::Result<(OwnedFd, CString)> {
    let mut components = relative_path.components().collect::<Vec<_>>();
    let last = components
        .pop()
        .ok_or_else(|| error("empty public output"))?;
    let name = component_name(last.as_os_str())?;
    let root_name = component_name(root.as_os_str())?;
    let mut parent = open_directory_at(libc::AT_FDCWD, &root_name, false)?;
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(error("non-confined public output"));
        }
        parent = open_directory_at(
            parent.as_raw_fd(),
            &component_name(component.as_os_str())?,
            create,
        )?;
    }
    Ok((parent, name))
}
fn directory_names(directory: i32) -> io::Result<Vec<CString>> {
    let duplicate = unsafe { libc::dup(directory) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let failure = io::Error::last_os_error();
        unsafe {
            libc::close(duplicate);
        }
        return Err(failure);
    }
    // readdir's null result distinguishes EOF from failure using the thread-local errno.
    let mut names = Vec::new();
    let result = loop {
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let failure = io::Error::last_os_error();
            break if failure.raw_os_error() == Some(0) {
                Ok(names)
            } else {
                Err(failure)
            };
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            names.push(name.to_owned());
        }
    };
    unsafe {
        libc::closedir(stream);
    }
    result
}
fn remove_public_entry(parent: i32, name: &CStr) -> io::Result<()> {
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            info.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        let failure = io::Error::last_os_error();
        return if failure.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(failure)
        };
    }
    let info = unsafe { info.assume_init() };
    let flags = if info.st_mode & libc::S_IFMT == libc::S_IFDIR {
        let child = open_directory_at(parent, name, false)?;
        for entry in directory_names(child.as_raw_fd())? {
            remove_public_entry(child.as_raw_fd(), &entry)?;
        }
        libc::AT_REMOVEDIR
    } else {
        0
    };
    if unsafe { libc::unlinkat(parent, name.as_ptr(), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn remove_public_output(root: &Path, path: &Path) -> io::Result<()> {
    let (parent, name) = match public_output_parent(root, path, false) {
        Ok(parent) => parent,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(failure),
    };
    remove_public_entry(parent.as_raw_fd(), &name)
}
struct PublishedDirectory {
    directory: OwnedFd,
    parent: OwnedFd,
    name: CString,
    mode: libc::mode_t,
}
fn restore_published_directories(directories: &[PublishedDirectory]) -> io::Result<()> {
    // Every descriptor was created by this worker. Reject replaced entries before chmod;
    // a caller's replacement tree is never granted ownership by a reused output pathname.
    for entry in directories {
        let mut held = std::mem::MaybeUninit::<libc::stat>::uninit();
        let mut present = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(entry.directory.as_raw_fd(), held.as_mut_ptr()) } != 0
            || unsafe {
                libc::fstatat(
                    entry.parent.as_raw_fd(),
                    entry.name.as_ptr(),
                    present.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let held = unsafe { held.assume_init() };
        let present = unsafe { present.assume_init() };
        if held.st_dev != present.st_dev || held.st_ino != present.st_ino {
            return Err(error(
                "published directory was replaced after worker ownership",
            ));
        }
    }
    for entry in directories {
        if unsafe { libc::fchmod(entry.directory.as_raw_fd(), entry.mode | 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
fn same_directory(left: &OwnedFd, right: &OwnedFd) -> io::Result<bool> {
    let mut a = std::mem::MaybeUninit::<libc::stat>::uninit();
    let mut b = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(left.as_raw_fd(), a.as_mut_ptr()) } != 0
        || unsafe { libc::fstat(right.as_raw_fd(), b.as_mut_ptr()) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let a = unsafe { a.assume_init() };
    let b = unsafe { b.assume_init() };
    Ok(a.st_dev == b.st_dev && a.st_ino == b.st_ino)
}
fn restore_prior_output(
    root: &Path,
    path: &Path,
    directories: &[PublishedDirectory],
) -> io::Result<()> {
    let Some(first) = directories.first() else {
        return Ok(());
    };
    let (parent, name) = match public_output_parent(root, path, false) {
        Ok(value) => value,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(failure),
    };
    let current = match open_directory_at(parent.as_raw_fd(), &name, false) {
        Ok(value) => value,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(failure),
    };
    if !same_directory(&current, &first.directory)? {
        return Err(error("prior published output was replaced"));
    }
    restore_published_directories(directories)
}
fn copy_public_entry(
    source: &Path,
    parent: i32,
    name: &CStr,
    created_directories: &mut Vec<PublishedDirectory>,
) -> io::Result<()> {
    let info = fs::symlink_metadata(source)?;
    if info.file_type().is_symlink() {
        return Err(error("symlink in declared directory output"));
    }
    let descriptor = if info.is_dir() {
        if unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let child = open_directory_at(parent, name, false)?;
        let parent = unsafe { libc::fcntl(parent, libc::F_DUPFD_CLOEXEC, 0) };
        if parent < 0 {
            return Err(io::Error::last_os_error());
        }
        let parent = unsafe { OwnedFd::from_raw_fd(parent) };
        created_directories.push(PublishedDirectory {
            directory: child.try_clone()?,
            parent,
            name: name.to_owned(),
            mode: (info.permissions().mode() & 0o7777) as libc::mode_t,
        });
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_public_entry(
                &entry.path(),
                child.as_raw_fd(),
                &component_name(&entry.file_name())?,
                created_directories,
            )?;
        }
        child
    } else if info.is_file() {
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let descriptor = unsafe { libc::openat(parent, name.as_ptr(), flags, 0o600) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
        let mut output = fs::File::from(descriptor);
        io::copy(&mut fs::File::open(source)?, &mut output)?;
        output.into()
    } else {
        return Err(error("non-file output"));
    };
    if unsafe {
        libc::fchmod(
            descriptor.as_raw_fd(),
            (info.permissions().mode() & 0o7777) as libc::mode_t,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn publish_public_output(
    source: &Path,
    root: &Path,
    path: &Path,
    created_directories: &mut Vec<PublishedDirectory>,
) -> io::Result<()> {
    let (parent, name) = public_output_parent(root, path, true)?;
    copy_public_entry(source, parent.as_raw_fd(), &name, created_directories)
}
fn restore_owned_directories(path: &Path) -> io::Result<()> {
    let info = match fs::symlink_metadata(path) {
        Ok(info) => info,
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(failure) => return Err(failure),
    };
    if info.is_dir() {
        // Only private leased worker state calls this recovery. Do not follow links or
        // alter declared files. A compiler cannot poison cleanup by chmodding a directory.
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(info.permissions().mode() | 0o700),
        )?;
        for entry in fs::read_dir(path)? {
            restore_owned_directories(&entry?.path())?;
        }
    }
    Ok(())
}
fn purge_transient(
    directory: &Path,
    workspace: &Path,
    retained_inputs: &BTreeSet<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let info = fs::symlink_metadata(&path)?;
        if info.is_dir() {
            purge_transient(&path, workspace, retained_inputs)?;
            if fs::read_dir(&path)?.next().is_none() {
                fs::remove_dir(&path)?;
            }
        } else {
            let retained = path
                .strip_prefix(workspace)
                .map_err(error)?
                .to_str()
                .is_some_and(|path| retained_inputs.contains(path));
            if !info.is_file() || !retained {
                // Unlink compiler/cache hardlink aliases; never truncate their retained inode.
                remove(&path)?;
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct Control {
    cancelled: bool,
    completed: bool,
    pid: Option<u32>,
}
impl Control {
    fn cancel(&mut self) {
        if self.completed {
            return;
        }
        self.cancelled = true;
        if let Some(pid) = self.pid {
            // The pinned wrapper owns and reaps its exact compiler child, even after setsid.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }
}
struct RequestChild {
    child: Child,
    control: Arc<Mutex<Control>>,
}
fn await_child_exit_without_reaping(pid: u32) -> io::Result<()> {
    // Kernel exit readiness preserves the zombie's reserved PID. Cancellation remains
    // lock-free while a live child has closed its pipes; no timeout/PID probe substitutes
    // for exit. Reap only after this exact event and under the control mutex.
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        } == 0
        {
            return Ok(());
        }
        let failure = io::Error::last_os_error();
        if failure.kind() != io::ErrorKind::Interrupted {
            return Err(failure);
        }
    }
}
impl Drop for RequestChild {
    fn drop(&mut self) {
        // Every early I/O, parser or thread error still kills and reaps the known child.
        // Its PID remains reserved until wait, so cancellation cannot hit a reused process.
        let mut state = self
            .control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.pid == Some(self.child.id()) {
            unsafe {
                libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
            }
            let _ = self.child.wait();
            state.pid = None;
        }
    }
}
fn lock(file: &fs::File, nonblocking: bool) -> io::Result<bool> {
    let flags = libc::LOCK_EX | if nonblocking { libc::LOCK_NB } else { 0 };
    if unsafe { libc::flock(file.as_raw_fd(), flags) } == 0 {
        return Ok(true);
    }
    let failure = io::Error::last_os_error();
    if nonblocking && failure.kind() == io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(failure)
    }
}
// Complete compiler/SDK policy inventories can exceed exec's argument limit.
// These owned Files live until the request's child and descendants are reaped.
struct OwnedProfile {
    path: PathBuf,
}
impl OwnedProfile {
    fn new(path: PathBuf, policy: &str) -> io::Result<Self> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        let profile = Self { path };
        file.write_all(policy.as_bytes())?;
        file.sync_all()?;
        Ok(profile)
    }
}
impl Drop for OwnedProfile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct Worker {
    root: PathBuf,
    workspace: PathBuf,
    // Current virtual workspace contains exactly this request's declared input inventory.
    inputs: BTreeMap<String, (String, u32)>,
    _lease: fs::File,
    unusable: Option<String>,
    published_outputs: BTreeMap<PathBuf, (Arc<OwnedFd>, Vec<PublishedDirectory>)>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(parent) = self.root.parent() {
            if let Ok(collection) = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(parent.join(".collection-lock"))
            {
                if lock(&collection, false).is_ok() {
                    let _ = restore_owned_directories(&self.root);
                    let _ = fs::remove_dir_all(&self.root);
                }
            }
        }
    }
}
impl Worker {
    fn new() -> io::Result<Self> {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let cache = std::env::temp_dir().join("merkur-rust-workers");
        fs::create_dir_all(&cache)?;
        if fs::symlink_metadata(&cache)?.file_type().is_symlink() {
            return Err(error("worker state root is a symlink"));
        }
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700))?;
        let cache = fs::canonicalize(cache)?;
        let collection = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(cache.join(".collection-lock"))?;
        lock(&collection, false)?;
        // An exclusive kernel lease is the exact liveness signal. No PID probe or TTL.
        for entry in fs::read_dir(&cache)? {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().starts_with("slot-") {
                continue;
            }
            if !entry.file_type()?.is_dir() {
                return Err(error("invalid worker state slot"));
            }
            let path = entry.path();
            match fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path.join(".lease"))
            {
                Ok(lease) if lock(&lease, true)? => {
                    restore_owned_directories(&path)?;
                    fs::remove_dir_all(path)?;
                }
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => fs::remove_dir_all(path)?,
                Err(e) => return Err(e),
            }
        }
        let root = cache.join(format!(
            "slot-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let lease = fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(root.join(".lease"))?;
        lock(&lease, false)?;
        drop(collection);
        let workspace = root.join("execroot");
        fs::create_dir(&workspace)?;
        Ok(Self {
            root,
            workspace,
            inputs: BTreeMap::new(),
            _lease: lease,
            unusable: None,
            published_outputs: BTreeMap::new(),
        })
    }
    fn stage(&mut self, request: &Value, execroot: &Path) -> io::Result<BTreeMap<String, String>> {
        let declared = declared_inputs(request)?;
        let retained_inputs = self
            .inputs
            .keys()
            .filter(|path| declared.contains_key(*path))
            .cloned()
            .collect();
        // A serialized request starts with inputs only. Prior compiler temporaries can be
        // hardlinked into incremental state, so remove aliases before rustc regenerates them.
        // A new input which occupies a previous output path must also get a fresh inode.
        purge_transient(&self.workspace, &self.workspace, &retained_inputs)?;
        let mut links = BTreeMap::new();
        for (path, digest) in &declared {
            let from = execroot.join(path);
            if fs::symlink_metadata(&from)?.is_symlink() {
                let target = fs::read_link(&from)?;
                if link_digest(&target) == *digest {
                    links.insert(path.clone(), target);
                }
            }
        }
        let mut resolved_links = BTreeMap::new();
        for path in links.keys() {
            resolved_links.insert(path.clone(), declared_link_target(path, &links, &declared)?);
        }
        let mut next = BTreeMap::new();
        for (path, digest) in &declared {
            // A declared directory alias and a nested input may not both own this path.
            for parent in relative(path)?.ancestors().skip(1) {
                if parent.to_str().is_some_and(|name| links.contains_key(name)) {
                    return Err(error(format!(
                        "input path traverses a declared directory symlink: {path}"
                    )));
                }
            }
            if links.contains_key(path) {
                continue;
            }
            let from = execroot.join(path);
            let to = self.workspace.join(path);
            let info = fs::metadata(&from)?;
            if !info.is_file() {
                return Err(error(format!("unexpanded tree input: {path}")));
            }
            let mode = info.permissions().mode() & 0o777;
            if self.inputs.get(path) != Some(&(digest.clone(), mode)) || !to.is_file() {
                // Copy bytes, never retain checkout/execroot symlinks. Match Bazel's SHA-256 input digest.
                let mut file = fs::File::open(&from)?;
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes)?;
                let actual = base64(sha(&bytes).as_bytes());
                if actual != *digest {
                    return Err(error(format!(
                        "input changed after Bazel digested it or unsupported digest: {path}"
                    )));
                }
                if let Some(parent) = to.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&to, bytes)?;
                fs::set_permissions(&to, fs::Permissions::from_mode(mode))?;
            }
            next.insert(path.clone(), (digest.clone(), mode));
        }
        // Recreate only authenticated relative aliases after their declared targets exist.
        // Checkout/engine carrier symlinks with content digests are still copied as bytes above.
        for (path, target) in &links {
            check_link_snapshot(execroot, path, target, &declared[path])?;
            let to = self.workspace.join(path);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            remove(&to)?;
            std::os::unix::fs::symlink(target, &to)?;
            next.insert(path.clone(), (declared[path].clone(), 0o777));
        }
        for (path, target) in &links {
            check_link_snapshot(execroot, path, target, &declared[path])?;
            let actual = fs::canonicalize(self.workspace.join(path))?;
            let expected = self.workspace.join(&resolved_links[path]);
            if actual != expected || fs::read_link(self.workspace.join(path))? != *target {
                return Err(error(format!(
                    "staged input symlink does not match its declared target: {path}"
                )));
            }
        }
        self.inputs = next;
        Ok(declared)
    }
    fn compile(
        &mut self,
        request: &Value,
        execroot: &Path,
        control: &Arc<Mutex<Control>>,
    ) -> io::Result<(i32, String)> {
        let arguments = strings(
            request
                .get("arguments")
                .ok_or_else(|| error("no arguments"))?,
        )?;
        if arguments.len() < 5 || arguments[0] != "--spec" || arguments[2] != "--command" {
            return Err(error(
                "worker requires --spec <manifest> --command <process-wrapper>",
            ));
        }
        let spec_path = arguments[1].clone();
        relative(&spec_path)?;
        if let Some(failure) = &self.unusable {
            return Err(error(format!(
                "worker is unusable after output cleanup failure: {failure}"
            )));
        }
        let inventory = declared_inputs(request)?;
        let spec_digest = inventory
            .get(&spec_path)
            .ok_or_else(|| error("undeclared worker specification"))?;
        let spec_bytes = fs::read(execroot.join(&spec_path))?;
        if base64(sha(&spec_bytes).as_bytes()) != *spec_digest {
            return Err(error("worker specification changed after input digest"));
        }
        let spec: Value = serde_json::from_slice(&spec_bytes).map_err(error)?;
        let outputs = spec
            .get("outputs")
            .and_then(Value::as_array)
            .ok_or_else(|| error("no output inventory"))?;
        if outputs.is_empty() {
            return Err(error("empty output inventory"));
        }
        let mut output_paths: Vec<PathBuf> = Vec::new();
        for output in outputs {
            let path = relative(field(output, "path")?)?;
            output
                .get("directory")
                .and_then(Value::as_bool)
                .ok_or_else(|| error("output type missing"))?;
            if inventory
                .keys()
                .any(|input| path.starts_with(input) || Path::new(input).starts_with(&path))
            {
                return Err(error("output overlaps an input"));
            }
            if output_paths
                .iter()
                .any(|other| path.starts_with(other) || other.starts_with(&path))
            {
                return Err(error("overlapping or duplicate outputs"));
            }
            output_paths.push(path);
        }
        // Only an authenticated, fully validated output inventory grants cleanup authority.
        // Every subsequent admission, staging, preparation and compilation failure passes
        // through the same all-output finalizer. Never chmod caller/Bazel-owned directories.
        let mut state_used = None;
        let mut published_directories: BTreeMap<PathBuf, (Arc<OwnedFd>, Vec<PublishedDirectory>)> =
            BTreeMap::new();
        let mut result = (|| {
            let public_root = Arc::new(open_directory_at(
                libc::AT_FDCWD,
                &component_name(execroot.as_os_str())?,
                false,
            )?);
            for path in &output_paths {
                if let Some((root, directories)) = self.published_outputs.remove(path) {
                    if same_directory(&root, &public_root)? {
                        restore_prior_output(execroot, path, &directories)?;
                    }
                }
                remove_public_output(execroot, path)?;
                remove(&self.workspace.join(path))?;
                if let Some(parent) = self.workspace.join(path).parent() {
                    fs::create_dir_all(parent)?;
                }
            }
            let inventory = match self.stage(request, execroot) {
                Ok(inventory) => inventory,
                Err(failure) => {
                    restore_owned_directories(&self.workspace)?;
                    remove(&self.workspace)?;
                    fs::create_dir(&self.workspace)?;
                    self.inputs.clear();
                    return Err(failure);
                }
            };
            if !inventory.contains_key(&spec_path) {
                return Err(error("undeclared worker specification"));
            }
            // These files are read by the pinned wrapper before its one compiler spawn.
            // Admit them before launching it; no wrapper parser may reach ambient paths.
            let wrapper_args = &arguments[4..];
            let boundary = wrapper_args
                .iter()
                .position(|arg| arg == "--")
                .ok_or_else(|| error("no compiler argument boundary"))?;
            for (index, argument) in wrapper_args[..boundary].iter().enumerate() {
                if argument == "--rustc-confiner" || argument == "--rustc-confinement-profile-file"
                {
                    return Err(error("compiler confinement is owned by the worker"));
                }
                if [
                    "--env-file",
                    "--arg-file",
                    "--stable-status-file",
                    "--volatile-status-file",
                ]
                .contains(&argument.as_str())
                {
                    let path = wrapper_args
                        .get(index + 1)
                        .ok_or_else(|| error("missing wrapper file argument"))?;
                    relative(path)?;
                    if !inventory.contains_key(path) {
                        return Err(error(format!("undeclared process-wrapper input: {path}")));
                    }
                }
            }
            let sources: BTreeSet<_> = strings(
                spec.get("sources")
                    .ok_or_else(|| error("no source inventory"))?,
            )?
            .into_iter()
            .collect();
            if sources.iter().any(|s| !inventory.contains_key(s)) {
                return Err(error("undeclared source"));
            }
            let env = spec
                .get("env")
                .and_then(Value::as_object)
                .ok_or_else(|| error("no environment inventory"))?;
            if env.contains_key("RUSTC_BOOTSTRAP") {
                return Err(error("RUSTC_BOOTSTRAP is forbidden"));
            }
            if control.lock().map_err(error)?.cancelled {
                return Ok((1, String::new()));
            }
            let dependencies: BTreeMap<_, _> = inventory
                .iter()
                .filter(|(path, _)| !sources.contains(*path) && *path != &spec_path)
                .map(|(path, digest)| (path.clone(), (digest.clone(), self.inputs[path].1)))
                .collect();
            let context = json!({"crate":field(&spec,"crate")?, "argv":arguments, "env":env,"dependencies":dependencies});
            #[cfg(target_os = "linux")]
            let context = {
                let mut context = context;
                context["process_scope"] = json!(field(&spec, "process_scope")?);
                context["linux_runtime"] = spec
                    .get("linux_runtime")
                    .ok_or_else(|| error("no declared Linux runtime mappings"))?
                    .clone();
                context
            };
            let context = sha(serde_json::to_string(&context).map_err(error)?.as_bytes());
            let incremental = self.root.join("incremental").join(&context);
            let retained = incremental.exists();
            fs::create_dir_all(&incremental)?;
            state_used = Some(incremental.clone());
            let command_path = relative(&arguments[3])?;
            if !inventory.contains_key(&arguments[3]) {
                return Err(error("undeclared process wrapper"));
            }
            let confiner_path = relative(field(&spec, "confiner")?)?;
            if !inventory.contains_key(field(&spec, "confiner")?) {
                return Err(error("undeclared confinement tool"));
            }
            let confiner = self.workspace.join(confiner_path);
            #[cfg(target_os = "linux")]
            let (mut command, compiler_policy, _process_owner, _outer_profile) =
                linux_worker_command(
                    &spec,
                    &self.root,
                    &self.workspace,
                    &incremental,
                    &inventory,
                    &output_paths,
                    &confiner,
                    &self.workspace.join(&command_path),
                )?;
            #[cfg(not(target_os = "linux"))]
            let (mut command, compiler_policy) = {
                let mut writable: Vec<_> = output_paths
                    .iter()
                    .filter_map(|path| path.parent())
                    .map(|path| self.workspace.join(path))
                    .collect();
                if let Some(temp) = env.get("TMPDIR").and_then(Value::as_str) {
                    let temp = self.workspace.join(temp);
                    if temp.starts_with(&self.workspace) {
                        writable.push(temp);
                    }
                }
                let policy =
                    confinement_policy(&self.workspace, &incremental, &self.inputs, &writable)?;
                (
                    Command::new(self.workspace.join(command_path)),
                    format!("{policy} (deny process-fork)"),
                )
            };
            // Only the pinned process wrapper can fork its one compiler child. The compiler
            // leaf cannot spawn children. The wrapper cancels its exact compiler PID even
            // if the leaf changes its own session. Executable proc macros are ineligible.
            let leaf_profile = OwnedProfile::new(
                self.workspace.join(".merkur-confinement-profile"),
                &compiler_policy,
            )?;
            command
                .arg("--rustc-confiner")
                .arg(&confiner)
                .arg("--rustc-confinement-profile-file")
                .arg(&leaf_profile.path);
            command
                .args(&arguments[4..])
                .arg(format!("-Cincremental={}", incremental.display()))
                .arg(format!(
                    "--remap-path-prefix={}=/merkur/execroot",
                    self.workspace.display()
                ))
                .current_dir(&self.workspace)
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
            for (key, value) in env {
                command.env(
                    key,
                    value
                        .as_str()
                        .ok_or_else(|| error("non-string environment value"))?,
                );
            }
            let mut child = RequestChild {
                child: command.spawn()?,
                control: control.clone(),
            };
            {
                let mut state = control.lock().map_err(error)?;
                state.pid = Some(child.child.id());
                if state.cancelled {
                    state.cancel();
                }
            }
            let stdout = child
                .child
                .stdout
                .take()
                .ok_or_else(|| error("no stdout"))?;
            let stderr = child
                .child
                .stderr
                .take()
                .ok_or_else(|| error("no stderr"))?;
            let out_thread = std::thread::spawn(move || {
                let mut out = Vec::new();
                let mut stream = stdout;
                stream.read_to_end(&mut out).map(|_| out)
            });
            let err_thread = std::thread::spawn(move || {
                let mut out = Vec::new();
                let mut stream = stderr;
                stream.read_to_end(&mut out).map(|_| out)
            });
            let out = out_thread
                .join()
                .map_err(|_| error("stdout thread failed"))??;
            let err = err_thread
                .join()
                .map_err(|_| error("stderr thread failed"))??;
            // The fork-denied compiler leaf and its pinned wrapper own these pipes. Retain
            // the unreaped direct child until drain completes: its PID/process group cannot
            // be reused while cancellation still addresses it. Reap under the control lock.
            await_child_exit_without_reaping(child.child.id())?;
            let status = {
                let mut state = control.lock().map_err(error)?;
                let status = child.child.wait()?;
                state.pid = None;
                status
            };
            let mut diagnostics = String::from_utf8_lossy(&out).to_string();
            diagnostics.push_str(&String::from_utf8_lossy(&err));
            if request
                .get("verbosity")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                > 0
            {
                diagnostics.push_str(&format!(
                    "\nmerkur incremental context={context} retained={retained}\n"
                ));
            }
            if !status.success() {
                diagnostics.push_str(&format!("\ncompiler exited {status}\n"));
            }
            let cancelled = control.lock().map_err(error)?.cancelled;
            if !status.success() || cancelled {
                // Failed compilation cannot supply retained incremental state to another request.
                restore_owned_directories(&incremental)?;
                remove(&incremental)?;
                return Ok((
                    if cancelled {
                        1
                    } else {
                        status.code().unwrap_or(1)
                    },
                    diagnostics,
                ));
            }
            // Inventory validation completes before any output is published.
            for (output, path) in outputs.iter().zip(&output_paths) {
                let info = fs::symlink_metadata(self.workspace.join(path))?;
                if info.file_type().is_symlink()
                    || (info.is_dir()
                        != output
                            .get("directory")
                            .and_then(Value::as_bool)
                            .ok_or_else(|| error("output type missing"))?)
                {
                    return Err(error(format!("invalid output type: {}", path.display())));
                }
            }
            for path in &output_paths {
                if control.lock().map_err(error)?.cancelled {
                    return Ok((1, diagnostics));
                }
                publish_public_output(
                    &self.workspace.join(path),
                    execroot,
                    path,
                    &mut published_directories
                        .entry(path.clone())
                        .or_insert_with(|| (public_root.clone(), Vec::new()))
                        .1,
                )?;
            }
            Ok((0, diagnostics))
        })();
        // Clear every undeclared compiler side output, preserving declared input bytes only.
        let cleanup = (|| {
            // This is private leased state, after all compiler processes have been reaped.
            // Preserve published modes, but restore private directories so prune can unlink.
            restore_owned_directories(&self.workspace)?;
            for entry in fs::read_dir(&self.workspace)? {
                let entry = entry?;
                prune(&entry.path(), &self.workspace, &self.inputs)?;
            }
            Ok::<_, io::Error>(())
        })();
        // Cancellation and final publication share one boundary. A cancellation accepted
        // before completion removes every output; a late cancellation cannot turn an
        // already completed publication into a cancelled response.
        let mut state = control.lock().map_err(error)?;
        if result.as_ref().map(|(code, _)| *code != 0).unwrap_or(true)
            || state.cancelled
            || cleanup.is_err()
        {
            let mut removal_error = None;
            // These descriptors belong only to directories mkdir'ed inside this request's
            // declared output trees. Restore access through held inodes, never caller paths.
            for (_, directories) in published_directories.values() {
                if let Err(failure) = restore_published_directories(directories) {
                    removal_error.get_or_insert(failure);
                }
            }
            for path in &output_paths {
                if let Err(failure) = remove_public_output(execroot, path) {
                    removal_error.get_or_insert(failure);
                }
            }
            if let Some(incremental) = state_used {
                if let Err(failure) =
                    restore_owned_directories(&incremental).and_then(|()| remove(&incremental))
                {
                    removal_error.get_or_insert(failure);
                }
            }
            if let Some(failure) = removal_error {
                self.unusable = Some(failure.to_string());
                result = Err(error(format!(
                    "output cleanup failed; worker is unusable: {failure}"
                )));
            }
        }
        if let Err(failure) = cleanup {
            result = Err(failure);
            let recovered = (|| {
                restore_owned_directories(&self.workspace)?;
                remove(&self.workspace)?;
                fs::create_dir(&self.workspace)?;
                Ok::<_, io::Error>(())
            })();
            self.inputs.clear();
            if let Err(failure) = recovered {
                result = Err(failure);
            }
        }
        if result.as_ref().map(|(code, _)| *code == 0).unwrap_or(false) && !state.cancelled {
            for (path, (root, directories)) in published_directories {
                if !directories.is_empty() {
                    self.published_outputs.insert(path, (root, directories));
                }
            }
        }
        state.completed = true;
        result
    }
}
fn prune(path: &Path, root: &Path, inputs: &BTreeMap<String, (String, u32)>) -> io::Result<()> {
    let rel = path
        .strip_prefix(root)
        .map_err(error)?
        .to_str()
        .ok_or_else(|| error("non UTF-8 workspace"))?;
    if inputs.contains_key(rel) {
        return Ok(());
    }
    if path.is_dir() && !fs::symlink_metadata(path)?.file_type().is_symlink() {
        for entry in fs::read_dir(path)? {
            prune(&entry?.path(), root, inputs)?;
        }
        if fs::read_dir(path)?.next().is_none() {
            fs::remove_dir(path)?;
        }
    } else {
        remove(path)?;
    }
    Ok(())
}
// The PID supervisor stays outside the confined namespace, holding the original
// worker pidfd. Only its namespace-init child can construct the mandatory mount view.
#[cfg(target_os = "linux")]
fn linux_worker_command(
    spec: &Value,
    slot: &Path,
    workspace: &Path,
    incremental: &Path,
    inputs: &BTreeMap<String, String>,
    outputs: &[PathBuf],
    confiner: &Path,
    wrapper: &Path,
) -> io::Result<(Command, String, OwnedFd, OwnedProfile)> {
    if spec
        .get("env")
        .and_then(|env| env.get("TMPDIR"))
        .and_then(Value::as_str)
        != Some(".merkur-scratch")
    {
        return Err(error(
            "Linux worker requires declared stable TMPDIR=.merkur-scratch",
        ));
    }
    let supervisor = field(spec, "process_scope")?;
    relative(supervisor)?;
    if !inputs.contains_key(supervisor) {
        return Err(error("undeclared PID namespace supervisor"));
    }
    let runtime = spec
        .get("linux_runtime")
        .ok_or_else(|| error("no declared Linux runtime mappings"))?;
    let root = slot.join("confinement");
    let scratch = workspace.join(".merkur-scratch");
    let profile = json!({
        "workspace":workspace,
        "incremental":incremental,
        "root":root,
        "scratch":scratch,
        "inputs":inputs.keys().collect::<Vec<_>>(),
        "outputs":outputs,
        "runtime":runtime,
        "leaf":false,
    });
    let profile = profile.to_string();
    // SAME parser checks the complete generated policy before granting directory authority.
    linux_policy::Policy::parse(&profile)?;
    for path in [&root, &scratch] {
        if !path.exists() {
            fs::DirBuilder::new().mode(0o700).create(path)?;
        }
        let info = fs::symlink_metadata(path)?;
        if !info.file_type().is_dir() || info.permissions().mode() & 0o777 != 0o700 {
            return Err(error("Linux confinement directory is not private"));
        }
    }
    if fs::read_dir(&root)?.next().is_some() {
        return Err(error("Linux confinement root is not empty"));
    }
    let owner = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
    if owner < 0 {
        return Err(io::Error::last_os_error());
    }
    let owner = unsafe { OwnedFd::from_raw_fd(owner as i32) };
    let fd = owner.as_raw_fd();
    let outer_profile = OwnedProfile::new(slot.join("outer-confinement-profile"), &profile)?;
    let mut command = Command::new(workspace.join(supervisor));
    command
        .arg("--owner-fd")
        .arg(fd.to_string())
        .arg("--")
        .arg(confiner)
        .arg("--profile-file")
        .arg(&outer_profile.path)
        .arg("--")
        .arg(wrapper);
    unsafe {
        command.pre_exec(move || {
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut leaf: Value = serde_json::from_str(&profile).map_err(error)?;
    leaf["leaf"] = json!(true);
    Ok((command, leaf.to_string(), owner, outer_profile))
}

fn confinement_policy(
    workspace: &Path,
    incremental: &Path,
    inputs: &BTreeMap<String, (String, u32)>,
    writable: &[PathBuf],
) -> io::Result<String> {
    for path in [workspace, incremental]
        .into_iter()
        .map(Path::to_path_buf)
        .chain(inputs.keys().map(|path| workspace.join(path)))
    {
        if path
            .to_string_lossy()
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\\')
        {
            return Err(error("unrepresentable compiler sandbox path"));
        }
    }
    // Derive immutable subtrees from the complete input inventory. Stop at every
    // original output/scratch parent: shared writable parents retain exact File denies.
    let mut readonly = BTreeSet::new();
    for path in inputs.keys() {
        let full = workspace.join(path);
        let mut directory = full.parent();
        let mut selected = None;
        while let Some(parent) = directory {
            if parent == workspace
                || writable
                    .iter()
                    .any(|w| parent.starts_with(w) || w.starts_with(parent))
            {
                break;
            }
            selected = Some(parent.to_path_buf());
            directory = parent.parent();
        }
        if let Some(parent) = selected {
            readonly.insert(parent);
        }
    }
    let covered = |path: &Path| readonly.iter().any(|parent| path.starts_with(parent));
    let mut directories = BTreeSet::new();
    let mut immutable = String::new();
    for parent in &readonly {
        immutable.push_str(&format!(
            "(deny file-write* (subpath \"{}\"))",
            parent.display()
        ));
    }
    for path in inputs.keys() {
        let full = workspace.join(path);
        if !covered(&full) {
            immutable.push_str(&format!(
                "(deny file-write* (literal \"{}\"))",
                full.display()
            ));
        }
        for directory in full
            .ancestors()
            .skip(1)
            .take_while(|p| p.starts_with(workspace))
        {
            if !covered(directory) {
                directories.insert(directory.to_owned());
            }
        }
    }
    for directory in directories {
        immutable.push_str(&format!(
            "(deny file-write-unlink file-write-mode (literal \"{}\"))",
            directory.display()
        ));
    }
    Ok(format!(
        "(version 1) (allow default) (deny file-read* (require-all (require-not (subpath \"{}\")) (require-not (subpath \"{}\")) (require-not (subpath \"/usr/lib\")) (require-not (subpath \"/System/Library\")) (require-not (subpath \"/System/Volumes/Preboot\")) (require-not (literal \"/\")) (require-not (literal \"/System\")) (require-not (literal \"/System/Volumes\")) (require-not (literal \"/dev/null\")) (require-not (literal \"/dev/random\")) (require-not (literal \"/dev/urandom\")))) (deny file-write* (require-all (require-not (subpath \"{}\")) (require-not (subpath \"{}\")) (require-not (literal \"/dev/null\")))) (deny process-exec (require-not (subpath \"{}\"))) (deny file-map-executable (require-all (require-not (subpath \"{}\")) (require-not (subpath \"/usr/lib\")) (require-not (subpath \"/System/Library\")) (require-not (subpath \"/System/Volumes/Preboot\")))) (deny network*) {}",
        workspace.display(),
        incremental.display(),
        workspace.display(),
        incremental.display(),
        workspace.display(),
        workspace.display(),
        immutable
    ))
}
fn respond(value: Value, stdout: &Arc<Mutex<io::Stdout>>) -> io::Result<()> {
    let mut output = stdout.lock().map_err(error)?;
    serde_json::to_writer(&mut *output, &value).map_err(error)?;
    writeln!(output)?;
    output.flush()
}
fn main() -> io::Result<()> {
    if !std::env::args().any(|arg| arg == "--persistent_worker") {
        return Err(error(
            "this compiler integration requires Bazel worker strategy",
        ));
    }
    let execroot = std::env::current_dir()?;
    let worker = Arc::new(Mutex::new(Worker::new()?));
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut active: Option<(
        i64,
        Arc<Mutex<Control>>,
        std::thread::JoinHandle<io::Result<()>>,
    )> = None;
    let input_result = (|| {
        for line in io::stdin().lock().lines() {
            let request: Value = serde_json::from_str(&line?).map_err(error)?;
            let id = request
                .get("requestId")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if request.get("cancel").and_then(Value::as_bool) == Some(true) {
                if let Some((active_id, control, handle)) = &active {
                    if *active_id == id && !handle.is_finished() {
                        control.lock().map_err(error)?.cancel();
                    }
                }
                continue;
            }
            if let Some((_, _, handle)) = active.take() {
                handle
                    .join()
                    .map_err(|_| error("compiler request thread failed"))??;
            }
            let control = Arc::new(Mutex::new(Control::default()));
            let (worker, stdout, execroot, child_control) = (
                worker.clone(),
                stdout.clone(),
                execroot.clone(),
                control.clone(),
            );
            let handle = std::thread::spawn(move || {
                let result =
                    worker
                        .lock()
                        .map_err(error)?
                        .compile(&request, &execroot, &child_control);
                let (exit_code, output) = match result {
                    Ok(result) => result,
                    Err(e) => (1, e.to_string()),
                };
                let mut state = child_control.lock().map_err(error)?;
                state.completed = true;
                if state.cancelled {
                    respond(json!({"requestId":id,"wasCancelled":true}), &stdout)
                } else {
                    state.pid = None;
                    respond(
                        json!({"requestId":id,"exitCode":exit_code,"output":output}),
                        &stdout,
                    )
                }
            });
            active = Some((id, control, handle));
        }
        Ok(())
    })();
    // Invalid JSON and input I/O errors use the same cancellation boundary as EOF.
    // An unreaped request cannot outlive the worker which owns its compiler wrapper.
    let shutdown_result = (|| {
        if let Some((_, control, handle)) = active {
            control.lock().map_err(error)?.cancel();
            handle
                .join()
                .map_err(|_| error("compiler request thread failed"))??;
        }
        Ok(())
    })();
    input_result.and(shutdown_result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn readonly_tree(source: &Path) {
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/file"), b"readonly output").unwrap();
        for path in [source.join("nested"), source.to_owned()] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o555)).unwrap();
        }
    }
    #[test]
    fn readonly_publication_survives_private_prune_and_next_request() {
        let worker = Worker::new().unwrap();
        let public = worker.root.join("public");
        fs::create_dir(&public).unwrap();
        fs::set_permissions(&public, fs::Permissions::from_mode(0o750)).unwrap();
        let source = worker.workspace.join("tree");
        for _ in 0..2 {
            readonly_tree(&source);
            let mut directories = Vec::new();
            publish_public_output(&source, &public, Path::new("tree"), &mut directories).unwrap();
            assert_eq!(
                fs::metadata(public.join("tree"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o555
            );
            restore_owned_directories(&worker.workspace).unwrap();
            prune(&source, &worker.workspace, &BTreeMap::new()).unwrap();
            assert!(!source.exists());
            restore_prior_output(&public, Path::new("tree"), &directories).unwrap();
            remove_public_output(&public, Path::new("tree")).unwrap();
            assert!(!public.join("tree").exists());
            assert_eq!(
                fs::metadata(&public).unwrap().permissions().mode() & 0o777,
                0o750
            );
        }
    }
    #[test]
    fn replaced_readonly_tree_receives_no_retained_chmod_authority() {
        let worker = Worker::new().unwrap();
        let public = worker.root.join("public");
        fs::create_dir(&public).unwrap();
        let source = worker.workspace.join("tree");
        readonly_tree(&source);
        let mut directories = Vec::new();
        publish_public_output(&source, &public, Path::new("tree"), &mut directories).unwrap();
        fs::rename(public.join("tree"), public.join("retired")).unwrap();
        readonly_tree(&public.join("tree"));
        assert!(restore_prior_output(&public, Path::new("tree"), &directories).is_err());
        for path in ["tree", "retired", "tree/nested", "retired/nested"] {
            assert_eq!(
                fs::metadata(public.join(path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o555
            );
        }
    }
    #[test]
    fn removed_prior_readonly_tree_does_not_poison_next_request() {
        let worker = Worker::new().unwrap();
        let public = worker.root.join("public");
        fs::create_dir(&public).unwrap();
        let source = worker.workspace.join("tree");
        readonly_tree(&source);
        let mut directories = Vec::new();
        publish_public_output(&source, &public, Path::new("tree"), &mut directories).unwrap();
        restore_published_directories(&directories).unwrap();
        remove_public_output(&public, Path::new("tree")).unwrap();
        restore_prior_output(&public, Path::new("tree"), &directories).unwrap();
        assert!(!public.join("tree").exists());
    }
    #[test]
    fn confines_paths() {
        for bad in ["", "/tmp/input", "../input", "a/../input", "./input"] {
            assert!(relative(bad).is_err());
        }
        assert!(relative("external/rust/bin/rustc").is_ok());
    }
    #[test]
    fn digest_encoding() {
        assert_eq!(base64(&[0, 1, 2]), "AAEC");
        assert_eq!(base64(&[0]), "AA==");
        assert_eq!(base64(&[0, 1]), "AAE=");
    }
    #[test]
    fn rejects_policy_injection_in_declared_input_names() {
        for path in ["a\"b", "a\\b", "a\nb", "a\rb", "a\0b"] {
            let inputs = BTreeMap::from([(path.to_owned(), ("digest".to_owned(), 0o600))]);
            assert!(
                confinement_policy(
                    Path::new("/workspace"),
                    Path::new("/incremental"),
                    &inputs,
                    &[]
                )
                .is_err()
            );
        }
    }
    #[test]
    fn late_cancellation_cannot_relabel_completed_publication() {
        let mut state = Control {
            completed: true,
            ..Control::default()
        };
        state.cancel();
        assert!(!state.cancelled);
    }
    #[test]
    fn rejects_symlink_outputs() {
        let root =
            std::env::temp_dir().join(format!("merkur-worker-output-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();
        assert!(
            publish_public_output(
                &root.join("link"),
                &root,
                Path::new("published"),
                &mut Vec::new()
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn sandbox_allows_declared_read_and_denies_ambient_read_and_input_write() {
        let worker = Worker::new().unwrap();
        let incremental = worker.root.join("incremental");
        fs::create_dir(&incremental).unwrap();
        let declared = worker.workspace.join("declared");
        fs::write(&declared, b"declared").unwrap();
        let ambient = worker.root.join("ambient");
        fs::write(&ambient, b"private").unwrap();
        let cat = worker.workspace.join("cat");
        fs::copy(env!("MERKUR_FIXTURE_COMPILER"), &cat).unwrap();
        let shell = worker.workspace.join("sh");
        fs::copy(env!("MERKUR_FIXTURE_COMPILER"), &shell).unwrap();
        let inventory = BTreeMap::from([("declared".to_owned(), ("digest".to_owned(), 0o600))]);
        for (path, expected) in [(&declared, true), (&ambient, false)] {
            let mut command = Command::new(fs::canonicalize(env!("MERKUR_CONFINER")).unwrap());
            let profile = OwnedProfile::new(
                worker.root.join("read-policy"),
                &confinement_policy(
                    &worker.workspace,
                    &incremental,
                    &inventory,
                    &[worker.workspace.clone()],
                )
                .unwrap(),
            )
            .unwrap();
            command.arg("--profile-file").arg(&profile.path).arg("--");
            command
                .arg(&cat)
                .env("FIXTURE_MODE", "read")
                .env("FIXTURE_PATH", path);
            let output = command.output().unwrap();
            assert_eq!(
                output.status.success(),
                expected,
                "status={} stderr={}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let mut command = Command::new(fs::canonicalize(env!("MERKUR_CONFINER")).unwrap());
        let profile = OwnedProfile::new(
            worker.root.join("write-policy"),
            &confinement_policy(
                &worker.workspace,
                &incremental,
                &inventory,
                &[worker.workspace.clone()],
            )
            .unwrap(),
        )
        .unwrap();
        command.arg("--profile-file").arg(&profile.path).arg("--");
        command.arg(shell);
        command
            .env("FIXTURE_MODE", "write")
            .env("FIXTURE_PATH", &declared)
            .current_dir(&worker.workspace);
        assert!(!command.status().unwrap().success());
        assert_eq!(fs::read(declared).unwrap(), b"declared");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn complete_policy_file_avoids_exec_argument_limit_and_retains_owned_lifetime() {
        let worker = Worker::new().unwrap();
        let incremental = worker.root.join("incremental");
        fs::create_dir(&incremental).unwrap();
        let declared = worker.workspace.join("declared");
        fs::write(&declared, b"declared").unwrap();
        let compiler = worker.workspace.join("compiler");
        fs::copy(env!("MERKUR_FIXTURE_COMPILER"), &compiler).unwrap();
        let inventory = BTreeMap::from([("declared".to_owned(), ("digest".to_owned(), 0o600))]);
        let mut text = confinement_policy(
            &worker.workspace,
            &incremental,
            &inventory,
            &[worker.workspace.clone()],
        )
        .unwrap();
        let argument_limit = unsafe { libc::sysconf(libc::_SC_ARG_MAX) };
        assert!(argument_limit > 0);
        text.push_str("\n; ");
        text.push_str(&"original-private-policy-comment".repeat(argument_limit as usize / 20 + 1));
        text.push('\n');
        let confiner = fs::canonicalize(env!("MERKUR_CONFINER")).unwrap();
        let error = Command::new(&confiner)
            .arg("--profile")
            .arg(&text)
            .arg("--")
            .arg(&compiler)
            .output()
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::E2BIG));
        let path = worker.workspace.join(".merkur-confinement-profile");
        {
            let profile = OwnedProfile::new(path.clone(), &text).unwrap();
            assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert!(OwnedProfile::new(path.clone(), "replacement").is_err());
            assert_eq!(fs::read(&path).unwrap(), text.as_bytes());
            let output = Command::new(&confiner)
                .arg("--profile-file")
                .arg(&profile.path)
                .arg("--")
                .arg(&compiler)
                .env("FIXTURE_MODE", "read")
                .env("FIXTURE_PATH", &declared)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(path.is_file());
        }
        assert!(!path.exists());
        assert!(
            !Command::new(&confiner)
                .arg("--profile-file")
                .arg(&path)
                .arg("--")
                .arg(compiler)
                .status()
                .unwrap()
                .success()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn immutable_input_subtrees_preserve_shared_output_and_scratch_authority() {
        let worker = Worker::new().unwrap();
        let incremental = worker.root.join("incremental");
        fs::create_dir(&incremental).unwrap();
        for path in ["sdk/nested", "out", "scratch"] {
            fs::create_dir_all(worker.workspace.join(path)).unwrap();
        }
        let mut inputs = BTreeMap::new();
        for path in ["sdk/first", "sdk/nested/second", "out/seed"] {
            fs::write(worker.workspace.join(path), b"original").unwrap();
            inputs.insert(path.to_owned(), ("digest".to_owned(), 0o600));
        }
        let compiler = worker.workspace.join("compiler");
        fs::copy(env!("MERKUR_FIXTURE_COMPILER"), &compiler).unwrap();
        let writable = [
            worker.workspace.join("out"),
            worker.workspace.join("scratch"),
        ];
        let text = confinement_policy(&worker.workspace, &incremental, &inputs, &writable).unwrap();
        assert!(text.contains(&format!(
            "(subpath \"{}\")",
            worker.workspace.join("sdk").display()
        )));
        assert!(text.contains(&format!(
            "(deny file-write* (literal \"{}\"))",
            worker.workspace.join("out/seed").display()
        )));
        let profile = OwnedProfile::new(worker.root.join("policy"), &text).unwrap();
        for (path, allowed) in [
            ("sdk/first", false),
            ("sdk/nested/second", false),
            ("sdk/new", false),
            ("out/seed", false),
            ("out/product", true),
            ("scratch/tmp", true),
            ("unlisted", true),
        ] {
            let output = Command::new(fs::canonicalize(env!("MERKUR_CONFINER")).unwrap())
                .arg("--profile-file")
                .arg(&profile.path)
                .arg("--")
                .arg(&compiler)
                .env("FIXTURE_MODE", "write")
                .env("FIXTURE_PATH", worker.workspace.join(path))
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                allowed,
                "{path}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        for path in inputs.keys() {
            assert_eq!(fs::read(worker.workspace.join(path)).unwrap(), b"original");
        }
        assert!(!worker.workspace.join("sdk/new").exists());
    }

    fn fixture(worker: &Worker, mode: &str, source: &[u8]) -> (PathBuf, Value) {
        let execroot = worker.root.join("request");
        fs::create_dir_all(&execroot).unwrap();
        if !execroot.join("compiler").exists() {
            fs::copy(env!("MERKUR_FIXTURE_COMPILER"), execroot.join("compiler")).unwrap();
        }
        if !execroot.join("confiner").exists() {
            fs::copy(env!("MERKUR_CONFINER"), execroot.join("confiner")).unwrap();
        }
        if !execroot.join("wrapper").exists() {
            fs::copy(env!("MERKUR_PROCESS_WRAPPER"), execroot.join("wrapper")).unwrap();
        }
        fs::write(execroot.join("source"), source).unwrap();
        let spec = json!({"crate":"//fixture:crate", "confiner":"confiner", "env":{"FIXTURE_MODE":mode}, "sources":["source"], "outputs":[{"path":"out/one", "directory":false},{"path":"out/two", "directory":false}]});
        fs::write(execroot.join("spec"), serde_json::to_vec(&spec).unwrap()).unwrap();
        let inputs:Vec<_> = ["compiler", "confiner", "wrapper", "source", "spec"].iter().map(|path|json!({"path":path,"digest":base64(sha(&fs::read(execroot.join(path)).unwrap()).as_bytes())})).collect();
        (
            execroot,
            json!({"requestId":1,"verbosity":1,"arguments":["--spec","spec","--command","wrapper","--","./compiler"],"inputs":inputs}),
        )
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn invalid_stdin_reaps_the_active_wrapper_and_compiler() {
        #[link(name = "proc")]
        unsafe extern "C" {
            fn proc_listchildpids(parent: i32, buffer: *mut i32, bytes: i32) -> i32;
        }
        fn child(parent: i32) -> i32 {
            let mut children = [0; 8];
            let count = unsafe {
                proc_listchildpids(
                    parent,
                    children.as_mut_ptr(),
                    std::mem::size_of_val(&children) as i32,
                )
            };
            assert_eq!(count, 1, "fixture must have one exact direct child");
            children[0]
        }
        let worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "wait", b"declared source");
        let temporary = worker.root.join("engine-tmp");
        fs::create_dir(&temporary).unwrap();
        let mut engine = Command::new(fs::canonicalize(env!("MERKUR_WORKER")).unwrap())
            .arg("--persistent_worker")
            .current_dir(&execroot)
            .env_clear()
            .env("PATH", "")
            .env("HOME", &temporary)
            .env("TMPDIR", &temporary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = engine.stdin.take().unwrap();
        writeln!(input, "{request}").unwrap();
        input.flush().unwrap();
        let marker = temporary.join(format!(
            "merkur-rust-workers/slot-{}-0/execroot/out/unit.0000000.rcgu.o",
            engine.id()
        ));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !marker.is_file() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture did not acknowledge live compiler"
            );
            std::thread::yield_now();
        }
        let wrapper = child(engine.id() as i32);
        let compiler = child(wrapper);
        let queue = unsafe { libc::kqueue() };
        assert!(queue >= 0);
        let changes = [wrapper, compiler].map(|pid| libc::kevent {
            ident: pid as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        });
        assert_eq!(
            unsafe {
                libc::kevent(
                    queue,
                    changes.as_ptr(),
                    2,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            },
            0
        );
        input.write_all(b"{invalid-json\n").unwrap();
        input.flush().unwrap();
        let status = engine.wait().unwrap();
        let mut events = [unsafe { std::mem::zeroed::<libc::kevent>() }; 2];
        let timeout = libc::timespec {
            tv_sec: 2,
            tv_nsec: 0,
        };
        let count =
            unsafe { libc::kevent(queue, std::ptr::null(), 0, events.as_mut_ptr(), 2, &timeout) };
        let observed: BTreeSet<_> = events
            .iter()
            .take(count.max(0) as usize)
            .map(|event| event.ident as i32)
            .collect();
        // Preserve an unchanged-engine failing control without leaving its owned fixture behind.
        if !observed.contains(&wrapper) {
            unsafe {
                libc::kill(wrapper, libc::SIGTERM);
            }
        }
        let mut retired = observed.clone();
        while retired.len() < 2 {
            let count = unsafe {
                libc::kevent(queue, std::ptr::null(), 0, events.as_mut_ptr(), 2, &timeout)
            };
            assert!(
                count > 0,
                "owned fixture cleanup did not acknowledge both process exits"
            );
            retired.extend(
                events
                    .iter()
                    .take(count as usize)
                    .map(|event| event.ident as i32),
            );
        }
        unsafe {
            libc::close(queue);
        }
        assert!(!status.success(), "malformed stdin must still refuse");
        assert_eq!(
            observed,
            BTreeSet::from([wrapper, compiler]),
            "stdin errors must retire both original process identities before worker exit"
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn retained_sources_fresh_outputs_and_incomplete_inventory() {
        let mut worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "compile", b"first");
        let request = {
            let mut v = request;
            v["arguments"].as_array_mut().unwrap().push(json!("--"));
            v
        };
        let control = Arc::new(Mutex::new(Control::default()));
        let first = worker.compile(&request, &execroot, &control).unwrap();
        assert_eq!(first.0, 0, "{}", first.1);
        assert!(first.1.contains("retained=false"));
        assert_eq!(fs::read(execroot.join("out/one")).unwrap(), b"first");
        control.lock().unwrap().cancel();
        assert!(!control.lock().unwrap().cancelled);
        assert_eq!(fs::read(execroot.join("out/one")).unwrap(), b"first");
        let (execroot, mut edited) = fixture(&worker, "compile", b"edited");
        edited["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("--"));
        let second = worker.compile(&edited, &execroot, &control).unwrap();
        assert_eq!(second.0, 0, "{}", second.1);
        assert!(second.1.contains("retained=true"));
        assert_eq!(fs::read(execroot.join("out/one")).unwrap(), b"edited");
        let mut fresh = Worker::new().unwrap();
        let (freshroot, mut freshrequest) = fixture(&fresh, "compile", b"edited");
        freshrequest["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("--"));
        assert_eq!(
            fresh
                .compile(&freshrequest, &freshroot, &control)
                .unwrap()
                .0,
            0
        );
        for path in ["out/one", "out/two"] {
            assert_eq!(
                fs::read(execroot.join(path)).unwrap(),
                fs::read(freshroot.join(path)).unwrap()
            );
        }
        let (execroot, mut incomplete) = fixture(&worker, "incomplete", b"edited");
        incomplete["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("--"));
        assert!(worker.compile(&incomplete, &execroot, &control).is_err());
        assert!(!execroot.join("out/one").exists());
        assert!(!execroot.join("out/two").exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn compiler_cannot_mutate_a_declared_input_through_a_hardlink_alias() {
        let mut worker = Worker::new().unwrap();
        let (execroot, mut request) = fixture(&worker, "input-alias", b"declared source");
        request["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("--"));
        let control = Arc::new(Mutex::new(Control::default()));
        for _ in 0..2 {
            let response = worker.compile(&request, &execroot, &control).unwrap();
            assert_ne!(response.0, 0, "{}", response.1);
            assert_eq!(
                fs::read(worker.workspace.join("source")).unwrap(),
                b"declared source"
            );
            assert_eq!(
                fs::read(execroot.join("source")).unwrap(),
                b"declared source"
            );
            assert!(!execroot.join("out/one").exists());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn compiler_leaf_cannot_spawn_a_child_which_retains_pipes() {
        let mut worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "orphan-pipes", b"source");
        let result = worker
            .compile(
                &request,
                &execroot,
                &Arc::new(Mutex::new(Control::default())),
            )
            .unwrap();
        assert_ne!(result.0, 0, "{}", result.1);
        assert!(result.1.contains("Operation not permitted"), "{}", result.1);
        assert!(!execroot.join("out/one").exists());
        assert!(!worker.workspace.join("out/descendant-started").exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn compiler_leaf_cannot_spawn_closed_stdio_or_session_descendants() {
        for mode in ["orphan-closed", "orphan-session"] {
            let mut worker = Worker::new().unwrap();
            let (execroot, request) = fixture(&worker, mode, b"source");
            let result = worker
                .compile(
                    &request,
                    &execroot,
                    &Arc::new(Mutex::new(Control::default())),
                )
                .unwrap();
            assert_ne!(result.0, 0, "{mode}: {}", result.1);
            assert!(
                result.1.contains("Operation not permitted"),
                "{mode}: {}",
                result.1
            );
            assert!(!execroot.join("out/one").exists());
            assert!(!execroot.join("out/two").exists());
            assert!(!worker.workspace.join("out/descendant-started").exists());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn private_permission_recovery_prunes_side_outputs_before_next_request() {
        let mut worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "inaccessible-cleanup", b"source");
        let response = worker
            .compile(
                &request,
                &execroot,
                &Arc::new(Mutex::new(Control::default())),
            )
            .unwrap();
        assert_eq!(response.0, 0, "{}", response.1);
        assert_eq!(fs::read(execroot.join("out/one")).unwrap(), b"one");
        assert_eq!(fs::read(execroot.join("out/two")).unwrap(), b"two");
        assert!(!worker.workspace.join("out").exists());
        assert!(worker.unusable.is_none());
        let (nextroot, next) = fixture(&worker, "compile", b"next");
        let response = worker
            .compile(&next, &nextroot, &Arc::new(Mutex::new(Control::default())))
            .unwrap();
        assert_eq!(response.0, 0, "{}", response.1);
        assert_eq!(fs::read(nextroot.join("out/one")).unwrap(), b"next");
        assert_eq!(fs::read(nextroot.join("out/two")).unwrap(), b"two");
        assert!(!worker.workspace.join("out").exists());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn publication_errors_remove_every_output_before_next_request() {
        for mode in ["inaccessible-second"] {
            let mut worker = Worker::new().unwrap();
            let (execroot, request) = fixture(&worker, mode, b"source");
            assert!(
                worker
                    .compile(
                        &request,
                        &execroot,
                        &Arc::new(Mutex::new(Control::default()))
                    )
                    .is_err(),
                "{mode}"
            );
            assert!(
                !execroot.join("out/one").exists(),
                "{mode} retained published first output"
            );
            assert!(
                !execroot.join("out/two").exists(),
                "{mode} retained second output"
            );
            let (nextroot, next) = fixture(&worker, "compile", b"next");
            let response = worker
                .compile(&next, &nextroot, &Arc::new(Mutex::new(Control::default())))
                .unwrap();
            assert_eq!(response.0, 0, "{mode}: {}", response.1);
            assert_eq!(fs::read(nextroot.join("out/one")).unwrap(), b"next");
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn inaccessible_public_output_attempts_all_cleanup_and_poison_worker() {
        let mut worker = Worker::new().unwrap();
        let (execroot, mut request) = fixture(&worker, "compile", b"source");
        let mut spec: Value =
            serde_json::from_slice(&fs::read(execroot.join("spec")).unwrap()).unwrap();
        spec["outputs"][0]["path"] = json!("blocked/one");
        fs::write(execroot.join("spec"), serde_json::to_vec(&spec).unwrap()).unwrap();
        request["inputs"][4]["digest"] = json!(base64(
            sha(&fs::read(execroot.join("spec")).unwrap()).as_bytes()
        ));
        fs::create_dir_all(execroot.join("blocked")).unwrap();
        fs::create_dir_all(execroot.join("out")).unwrap();
        fs::write(execroot.join("blocked/one"), b"old first").unwrap();
        fs::write(execroot.join("out/two"), b"old second").unwrap();
        fs::set_permissions(execroot.join("blocked"), fs::Permissions::from_mode(0)).unwrap();
        let result = worker.compile(
            &request,
            &execroot,
            &Arc::new(Mutex::new(Control::default())),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("worker is unusable")
        );
        assert!(!execroot.join("out/two").exists());
        assert_eq!(
            fs::metadata(execroot.join("blocked"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0
        );
        assert!(worker.unusable.is_some());
        // The test owns this fixture directory; production must never repair caller permissions.
        fs::set_permissions(execroot.join("blocked"), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            fs::read(execroot.join("blocked/one")).unwrap(),
            b"old first"
        );
        assert!(
            worker
                .compile(
                    &request,
                    &execroot,
                    &Arc::new(Mutex::new(Control::default()))
                )
                .is_err()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn later_publication_failure_removes_readonly_request_owned_tree() {
        let mut worker = Worker::new().unwrap();
        let (execroot, mut request) =
            fixture(&worker, "readonly-tree-and-unreadable-second", b"source");
        let mut spec: Value =
            serde_json::from_slice(&fs::read(execroot.join("spec")).unwrap()).unwrap();
        spec["outputs"][0] = json!({"path":"out/tree", "directory":true});
        fs::write(execroot.join("spec"), serde_json::to_vec(&spec).unwrap()).unwrap();
        request["inputs"][4]["digest"] = json!(base64(
            sha(&fs::read(execroot.join("spec")).unwrap()).as_bytes()
        ));
        let result = worker.compile(
            &request,
            &execroot,
            &Arc::new(Mutex::new(Control::default())),
        );
        assert!(result.is_err());
        assert!(
            !execroot.join("out/tree").exists(),
            "failed request retains readonly published tree"
        );
        assert!(!execroot.join("out/two").exists());
        assert!(
            worker.unusable.is_none(),
            "request-owned output cleanup must not poison worker"
        );
    }
    #[test]
    fn public_output_tree_preserves_bytes_modes_and_unlinks_nested_aliases_only() {
        let worker = Worker::new().unwrap();
        let source = worker.root.join("source-tree");
        let public = worker.root.join("public-root");
        let outside = worker.root.join("outside-file");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&public).unwrap();
        fs::write(source.join("nested/file"), b"declared output").unwrap();
        fs::set_permissions(
            source.join("nested/file"),
            fs::Permissions::from_mode(0o640),
        )
        .unwrap();
        fs::set_permissions(source.join("nested"), fs::Permissions::from_mode(0o710)).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o750)).unwrap();
        publish_public_output(&source, &public, Path::new("out/tree"), &mut Vec::new()).unwrap();
        assert_eq!(
            fs::read(public.join("out/tree/nested/file")).unwrap(),
            b"declared output"
        );
        for (path, mode) in [
            ("out/tree", 0o750),
            ("out/tree/nested", 0o710),
            ("out/tree/nested/file", 0o640),
        ] {
            assert_eq!(
                fs::metadata(public.join(path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                mode
            );
        }
        fs::write(&outside, b"outside bytes").unwrap();
        std::os::unix::fs::symlink(&outside, public.join("out/tree/nested/alias")).unwrap();
        remove_public_output(&public, Path::new("out/tree")).unwrap();
        assert!(!public.join("out/tree").exists());
        assert_eq!(fs::read(&outside).unwrap(), b"outside bytes");
    }
    #[test]
    fn public_publication_does_not_truncate_an_existing_hardlink() {
        let worker = Worker::new().unwrap();
        let source = worker.root.join("source-file");
        let public = worker.root.join("public-root");
        let outside = worker.root.join("outside-file");
        fs::create_dir(&public).unwrap();
        fs::write(&source, b"new output").unwrap();
        fs::write(&outside, b"outside bytes").unwrap();
        fs::hard_link(&outside, public.join("published")).unwrap();
        assert!(
            publish_public_output(&source, &public, Path::new("published"), &mut Vec::new())
                .is_err()
        );
        assert_eq!(fs::read(&outside).unwrap(), b"outside bytes");
        remove_public_output(&public, Path::new("published")).unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"outside bytes");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn public_output_parent_symlink_cannot_reach_outside_execroot() {
        let mut worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "compile", b"new output");
        let outside = worker.root.join("outside-execroot");
        fs::create_dir(&outside).unwrap();
        for name in ["one", "two"] {
            fs::write(outside.join(name), b"outside bytes").unwrap();
        }
        std::os::unix::fs::symlink(&outside, execroot.join("out")).unwrap();
        let result = worker.compile(
            &request,
            &execroot,
            &Arc::new(Mutex::new(Control::default())),
        );
        assert!(result.is_err(), "symlink output parent was accepted");
        for name in ["one", "two"] {
            assert_eq!(fs::read(outside.join(name)).unwrap(), b"outside bytes");
        }
        assert!(
            fs::symlink_metadata(execroot.join("out"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn staging_failure_after_authenticated_inventory_clears_all_current_outputs() {
        let mut worker = Worker::new().unwrap();
        let (execroot, request) = fixture(&worker, "compile", b"source");
        fs::create_dir_all(execroot.join("out")).unwrap();
        for path in ["out/one", "out/two"] {
            fs::write(execroot.join(path), b"old output").unwrap();
        }
        fs::write(execroot.join("source"), b"changed after digest").unwrap();
        assert!(
            worker
                .compile(
                    &request,
                    &execroot,
                    &Arc::new(Mutex::new(Control::default()))
                )
                .is_err()
        );
        for path in ["out/one", "out/two"] {
            assert!(!execroot.join(path).exists());
        }
        assert!(worker.unusable.is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn cancellation_reaps_exact_leaf_after_closed_stdio_or_session_change() {
        for mode in ["leaf-closed", "leaf-session", "leaf-group"] {
            let worker = Worker::new().unwrap();
            let (execroot, request) = fixture(&worker, mode, b"source");
            let marker = worker.workspace.join("out/leaf-started");
            let control = Arc::new(Mutex::new(Control::default()));
            let child_control = control.clone();
            let child_root = execroot.clone();
            let thread = std::thread::spawn(move || {
                let mut worker = worker;
                let result = worker.compile(&request, &child_root, &child_control);
                (worker, result)
            });
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !marker.exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "{mode}: leaf did not acknowledge startup"
                );
                std::thread::yield_now();
            }
            let pid: i32 = fs::read_to_string(marker).unwrap().parse().unwrap();
            control.lock().unwrap().cancel();
            let (_worker, result) = thread.join().unwrap();
            assert_ne!(result.unwrap().0, 0, "{mode}");
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "{mode}: leaf remains alive or unreaped"
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
            assert!(control.lock().unwrap().pid.is_none());
            assert!(!execroot.join("out/one").exists());
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn cancellation_waits_for_process_and_next_request_succeeds() {
        let worker = Worker::new().unwrap();
        let (execroot, mut request) = fixture(&worker, "wait", b"source");
        let incomplete = worker.workspace.join("out/unit.0000000.rcgu.o");
        request["arguments"]
            .as_array_mut()
            .unwrap()
            .push(json!("--"));
        let control = Arc::new(Mutex::new(Control::default()));
        let child_control = control.clone();
        let childroot = execroot.clone();
        let thread = std::thread::spawn(move || {
            let mut worker = worker;
            let result = worker.compile(&request, &childroot, &child_control);
            (worker, result)
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let mut state = control.lock().unwrap();
            if state.pid.is_some() && incomplete.exists() {
                state.cancel();
                break;
            }
            drop(state);
            assert!(
                std::time::Instant::now() < deadline,
                "compiler did not publish its startup temporary"
            );
            std::thread::yield_now();
        }
        let (mut worker, result) = thread.join().unwrap();
        assert!(result.is_ok());
        assert!(control.lock().unwrap().pid.is_none());
        assert!(!execroot.join("out/one").exists());
        let (execroot, mut next) = fixture(&worker, "compile", b"next");
        next["arguments"].as_array_mut().unwrap().push(json!("--"));
        assert_eq!(
            worker
                .compile(&next, &execroot, &Arc::new(Mutex::new(Control::default())))
                .unwrap()
                .0,
            0
        );
        assert!(!incomplete.exists());
        assert_eq!(fs::read(execroot.join("out/one")).unwrap(), b"next");
    }
    #[test]
    fn digest_mismatch_rejected() {
        let mut worker = Worker::new().unwrap();
        let source = worker.root.join("source");
        fs::write(&source, b"changed").unwrap();
        let request = json!({"inputs":[{"path":"source","digest":base64(sha(b"old").as_bytes())}]});
        let execroot = worker.root.clone();
        assert!(worker.stage(&request, &execroot).is_err());
        assert!(!worker.workspace.join("source").exists());
    }
    #[test]
    fn missing_input_inventory_fails() {
        let mut worker = Worker::new().unwrap();
        assert!(worker.stage(&json!({}), Path::new("/tmp")).is_err());
    }
    #[test]
    fn undeclared_stale_inputs_removed() {
        let mut worker = Worker::new().unwrap();
        fs::write(worker.workspace.join("old"), "old").unwrap();
        worker.inputs.insert("old".into(), ("old".into(), 0o600));
        worker
            .stage(&json!({"inputs":[]}), Path::new("/tmp"))
            .unwrap();
        assert!(!worker.workspace.join("old").exists());
    }
    #[test]
    fn transient_cleanup_unlinks_cached_objects_and_does_not_follow_symlinks() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir(&execroot).unwrap();
        fs::write(execroot.join("source"), b"source").unwrap();
        let request =
            json!({"inputs":[{"path":"source","digest":base64(sha(b"source").as_bytes())}]});
        worker.stage(&request, &execroot).unwrap();
        let cache = worker.root.join("incremental");
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("unit.o"), b"cached object").unwrap();
        let transient = worker.workspace.join("out");
        fs::create_dir(&transient).unwrap();
        fs::hard_link(cache.join("unit.o"), transient.join("unit.0000000.rcgu.o")).unwrap();
        let ambient = worker.root.join("ambient");
        fs::write(&ambient, b"untouched").unwrap();
        std::os::unix::fs::symlink(&ambient, transient.join("leftover-link")).unwrap();
        worker.stage(&request, &execroot).unwrap();
        assert!(!transient.exists());
        assert_eq!(fs::read(cache.join("unit.o")).unwrap(), b"cached object");
        assert_eq!(fs::read(ambient).unwrap(), b"untouched");
        assert_eq!(
            fs::read(worker.workspace.join("source")).unwrap(),
            b"source"
        );
    }
    #[test]
    fn prior_output_becoming_an_input_cannot_truncate_its_cached_inode() {
        let mut worker = Worker::new().unwrap();
        let cache = worker.root.join("cached.o");
        fs::write(&cache, b"retained").unwrap();
        fs::hard_link(&cache, worker.workspace.join("source")).unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir(&execroot).unwrap();
        fs::write(execroot.join("source"), b"new input").unwrap();
        let request =
            json!({"inputs":[{"path":"source","digest":base64(sha(b"new input").as_bytes())}]});
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(fs::read(cache).unwrap(), b"retained");
        assert_eq!(
            fs::read(worker.workspace.join("source")).unwrap(),
            b"new input"
        );
    }
    #[test]
    fn equal_temporary_names_in_active_worker_slots_are_isolated() {
        let mut first = Worker::new().unwrap();
        let second = Worker::new().unwrap();
        assert_ne!(first.workspace, second.workspace);
        for (worker, bytes) in [
            (&first, b"first".as_slice()),
            (&second, b"second".as_slice()),
        ] {
            fs::write(worker.root.join("cached.o"), bytes).unwrap();
            fs::hard_link(
                worker.root.join("cached.o"),
                worker.workspace.join("unit.0000000.rcgu.o"),
            )
            .unwrap();
        }
        first
            .stage(&json!({"inputs":[]}), Path::new("/tmp"))
            .unwrap();
        assert!(!first.workspace.join("unit.0000000.rcgu.o").exists());
        assert_eq!(fs::read(first.root.join("cached.o")).unwrap(), b"first");
        assert_eq!(
            fs::read(second.workspace.join("unit.0000000.rcgu.o")).unwrap(),
            b"second"
        );
        assert_eq!(fs::read(second.root.join("cached.o")).unwrap(), b"second");
    }
    fn link_input(path: &str, target: &str) -> Value {
        // Original pinned Bazel normalized symlink digest, independently fixed below.
        let digest = match target {
            "A" => {
                "YWE5YWVhZDA4MjY0ZDU3OTVkMzkwOTcxOGNkZDA1YWJkNDk1NzJlODRmZTU1NTkwZWVmMzFhODhhMDhmZGZmZA=="
            }
            "Versions/Current/data" => {
                "NThiMjhiNjkyZTc0ODE3YjcxNmM4MmY3NjI4M2FmNDEzOGQ3MjE4NTgyMmU4OTIzMGQ1NGE2OGFlMzhlZDAwNQ=="
            }
            "Versions/Current/Headers" => {
                "ZDE3NDU5YWQyYTBmZThmMDRhOTYxYzM1M2MyYzY1Zjc2YTcwODE4MzZhZDc2MjY1YzQ3ZTBjYzA4ZWQwYTczNw=="
            }
            "missing" => {
                "MDBhNjM1ODNkZmE2NzA2Yjg3ZDI4NGI4NmIwZDY5M2ExNjFlNDg0MGFhZDJjNWNmNmI1ZDI3YzNiOTYyMWY3ZA=="
            }
            "../outside" => {
                "OWRjYTFkOTJjNGEzZmM0NGE1ZmEzMGQxZGRjNTkzYmUxYTk5NDVjYTIxYzA4MjFhZjUzZDRmMmI2MDQwNzVlNw=="
            }
            "second" => {
                "ZTkzNjdhYWNiNjdhNGEwMTdjOGRhOGFiOTU2ODJjY2IzOTA4NjM3ODBmNzExNGRkYTBhMGUwYzU1NjQ0YzdjNA=="
            }
            "first" => {
                "NTg5MzdiNjRiOGNhYTU4ZjAzNzIxYmI2YmFjZjVjNzhjYjIzNWZlYmUwZTcwYjFiODRjZDk5NTQxNDYxYTA4ZQ=="
            }
            "b" => {
                "YzEyM2U4MTYwMDM5NTk0YTMzODk0ZjY1NjRlMWIxMzQ4YmJkN2EwMDg4ZDQyYzRhY2I3M2VlYWVkNTljMDA5ZA=="
            }
            "a" => {
                "MzU5NzgxMTJjYTFiYmRjYWZhYzIzMWIzOWEyM2RjNGRhNzg2ZWZmODE0N2M0ZTcyYjk4MDc3ODVhZmVlNDhiYg=="
            }
            _ => panic!("unexpected symlink fixture target"),
        };
        json!({"path":path,"digest":digest})
    }
    #[test]
    fn declared_sdk_file_and_directory_aliases_preserve_target_authority() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir_all(execroot.join("Framework/Versions/A/Headers")).unwrap();
        fs::write(execroot.join("Framework/Versions/A/data"), b"original").unwrap();
        fs::write(
            execroot.join("Framework/Versions/A/Headers/header"),
            b"header",
        )
        .unwrap();
        std::os::unix::fs::symlink("A", execroot.join("Framework/Versions/Current")).unwrap();
        std::os::unix::fs::symlink("Versions/Current/data", execroot.join("Framework/data"))
            .unwrap();
        std::os::unix::fs::symlink(
            "Versions/Current/Headers",
            execroot.join("Framework/Headers"),
        )
        .unwrap();
        let mut request = json!({"inputs":[
            {"path":"Framework/Versions/A/data","digest":base64(sha(b"original").as_bytes())},
            {"path":"Framework/Versions/A/Headers/header","digest":base64(sha(b"header").as_bytes())},
            link_input("Framework/Versions/Current","A"),
            link_input("Framework/data","Versions/Current/data"),
            link_input("Framework/Headers","Versions/Current/Headers")
        ]});
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(worker.workspace.join("Framework/data")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(worker.workspace.join("Framework/Headers/header")).unwrap(),
            b"header"
        );
        assert_eq!(
            fs::read_link(worker.workspace.join("Framework/data")).unwrap(),
            Path::new("Versions/Current/data")
        );
        fs::write(execroot.join("Framework/Versions/A/data"), b"edited").unwrap();
        request["inputs"][0]["digest"] = json!(base64(sha(b"edited").as_bytes()));
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(worker.workspace.join("Framework/data")).unwrap(),
            b"edited"
        );
        let final_request = json!({"inputs":[request["inputs"][0].clone()]});
        worker.stage(&final_request, &execroot).unwrap();
        assert!(fs::symlink_metadata(worker.workspace.join("Framework/data")).is_err());
        assert_eq!(
            fs::read(worker.workspace.join("Framework/Versions/A/data")).unwrap(),
            b"edited"
        );
    }
    #[test]
    fn symlink_inputs_refuse_undeclared_targets_digest_changes_escapes_and_cycles() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir(&execroot).unwrap();
        fs::write(execroot.join("missing"), b"not declared").unwrap();
        std::os::unix::fs::symlink("missing", execroot.join("link")).unwrap();
        let request = json!({"inputs":[link_input("link","missing")]});
        assert!(
            worker
                .stage(&request, &execroot)
                .unwrap_err()
                .to_string()
                .contains("not declared")
        );
        let request = json!({"inputs":[link_input("link","first"),{"path":"missing","digest":base64(sha(b"not declared").as_bytes())}]});
        assert!(worker.stage(&request, &execroot).is_err());
        fs::remove_file(execroot.join("link")).unwrap();
        std::os::unix::fs::symlink("../outside", execroot.join("link")).unwrap();
        let request = json!({"inputs":[link_input("link","../outside")]});
        assert!(
            worker
                .stage(&request, &execroot)
                .unwrap_err()
                .to_string()
                .contains("escapes")
        );
        std::os::unix::fs::symlink("b", execroot.join("a")).unwrap();
        std::os::unix::fs::symlink("a", execroot.join("b")).unwrap();
        let request = json!({"inputs":[link_input("a","b"),link_input("b","a")]});
        assert!(
            worker
                .stage(&request, &execroot)
                .unwrap_err()
                .to_string()
                .contains("cyclic")
        );
        let request = json!({"inputs":[{"path":"missing","digest":base64(sha(b"changed").as_bytes())},link_input("link","missing")]});
        fs::remove_file(execroot.join("link")).unwrap();
        std::os::unix::fs::symlink("missing", execroot.join("link")).unwrap();
        assert!(worker.stage(&request, &execroot).is_err());
        assert!(!worker.workspace.join("link").exists());
    }
    #[test]
    fn symlink_snapshot_refuses_retargeting_before_publication() {
        let worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir(&execroot).unwrap();
        fs::write(execroot.join("first"), b"first").unwrap();
        fs::write(execroot.join("second"), b"second").unwrap();
        std::os::unix::fs::symlink("first", execroot.join("link")).unwrap();
        let input = link_input("link", "first");
        check_link_snapshot(
            &execroot,
            "link",
            Path::new("first"),
            field(&input, "digest").unwrap(),
        )
        .unwrap();
        fs::remove_file(execroot.join("link")).unwrap();
        std::os::unix::fs::symlink("second", execroot.join("link")).unwrap();
        assert!(
            check_link_snapshot(
                &execroot,
                "link",
                Path::new("first"),
                field(&input, "digest").unwrap()
            )
            .is_err()
        );
        assert_eq!(fs::read(execroot.join("first")).unwrap(), b"first");
        assert_eq!(fs::read(execroot.join("second")).unwrap(), b"second");
    }
    #[test]
    fn engine_content_digest_carrier_is_copied_without_retaining_alias() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir(&execroot).unwrap();
        let original = worker.root.join("source-file");
        fs::write(&original, b"declared ordinary File").unwrap();
        std::os::unix::fs::symlink(&original, execroot.join("carrier")).unwrap();
        worker.stage(&json!({"inputs":[{"path":"carrier","digest":base64(sha(b"declared ordinary File").as_bytes())}]}),&execroot).unwrap();
        assert!(
            !fs::symlink_metadata(worker.workspace.join("carrier"))
                .unwrap()
                .is_symlink()
        );
        assert_eq!(
            fs::read(worker.workspace.join("carrier")).unwrap(),
            b"declared ordinary File"
        );
    }
    #[test]
    fn original_ruby_parent_directory_alias_preserves_declared_headers() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir_all(execroot.join("Ruby.framework/Headers/ruby")).unwrap();
        fs::write(
            execroot.join("Ruby.framework/Headers/ruby/header.h"),
            b"ruby header",
        )
        .unwrap();
        // The original Apple SDK alias is literally "."; Bazel normalizes it to empty text.
        std::os::unix::fs::symlink(".", execroot.join("Ruby.framework/Headers/ruby/ruby")).unwrap();
        let request = json!({"inputs":[
            {"path":"Ruby.framework/Headers/ruby/header.h","digest":base64(sha(b"ruby header").as_bytes())},
            {"path":"Ruby.framework/Headers/ruby/ruby","digest":"MWNiMGM0NDI5OGZjMWMxNDlhZmJmNGM4OTk2ZmI5MjQyN2FlNDFlNDY0OWI5MzRjYTQ5NTk5MWI3ODUyYjg1NQ=="}
        ]});
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(
                worker
                    .workspace
                    .join("Ruby.framework/Headers/ruby/ruby/header.h")
            )
            .unwrap(),
            b"ruby header"
        );
        assert_eq!(
            fs::read_link(worker.workspace.join("Ruby.framework/Headers/ruby/ruby")).unwrap(),
            Path::new(".")
        );
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(
                worker
                    .workspace
                    .join("Ruby.framework/Headers/ruby/ruby/ruby/header.h")
            )
            .unwrap(),
            b"ruby header"
        );
    }
    #[test]
    fn original_ruby_stub_file_alias_chain_resolves_exact_declared_file() {
        let mut worker = Worker::new().unwrap();
        let execroot = worker.root.join("request");
        fs::create_dir_all(execroot.join("Ruby.framework/Versions/2.6/usr/lib")).unwrap();
        fs::write(
            execroot.join("Ruby.framework/Versions/2.6/Ruby.tbd"),
            b"ruby stub",
        )
        .unwrap();
        std::os::unix::fs::symlink(
            "libruby.2.6.tbd",
            execroot.join("Ruby.framework/Versions/2.6/usr/lib/libruby.tbd"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            "../../Ruby.tbd",
            execroot.join("Ruby.framework/Versions/2.6/usr/lib/libruby.2.6.tbd"),
        )
        .unwrap();
        let request = json!({"inputs":[
            {"path":"Ruby.framework/Versions/2.6/Ruby.tbd","digest":base64(sha(b"ruby stub").as_bytes())},
            {"path":"Ruby.framework/Versions/2.6/usr/lib/libruby.tbd","digest":"NjY4ZjdjZGQzY2Q5Y2I5ZTdkZWM4ODVhZjQxNzZiYTAwYzY5NjJhM2VjOTc1ZjEyZmYxMTAxZmMzZjRlY2Y4Zg=="},
            {"path":"Ruby.framework/Versions/2.6/usr/lib/libruby.2.6.tbd","digest":"N2ViMGNmYmJmZjQzODk4ODBlOTUyNmE0N2RmMDI2ZDIzOTNiYTRlOTdkMzcwZGI5MjY3ZWIyMWZlYTAyY2NhNg=="}
        ]});
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(
                worker
                    .workspace
                    .join("Ruby.framework/Versions/2.6/usr/lib/libruby.tbd")
            )
            .unwrap(),
            b"ruby stub"
        );
        assert_eq!(
            fs::read_link(
                worker
                    .workspace
                    .join("Ruby.framework/Versions/2.6/usr/lib/libruby.tbd")
            )
            .unwrap(),
            Path::new("libruby.2.6.tbd")
        );
        worker.stage(&request, &execroot).unwrap();
        assert_eq!(
            fs::read(
                worker
                    .workspace
                    .join("Ruby.framework/Versions/2.6/usr/lib/libruby.2.6.tbd")
            )
            .unwrap(),
            b"ruby stub"
        );
    }
}
