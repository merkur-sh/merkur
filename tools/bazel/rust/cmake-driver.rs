//! Close CMake's pre-toolchain uname lookup with declared native executables.

use std::env;
#[cfg(not(make_driver))]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{self, Command};

fn executable(variable: &str) -> io::Result<OsString> {
    let value = env::var_os(variable).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("Missing declared {variable}"))
    })?;
    if !Path::new(&value).is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Declared {variable} must be an absolute action input path"),
        ));
    }
    Ok(value)
}

#[cfg(not(make_driver))]
fn configures(arguments: &[OsString]) -> bool {
    !arguments.first().is_some_and(|argument| {
        ["--build", "--install", "--open", "--version", "--help", "-E", "-P"]
            .iter()
            .any(|mode| argument == OsStr::new(mode))
    })
}

#[cfg(not(make_driver))]
fn run() -> io::Result<()> {
    let mut arguments: Vec<OsString> = env::args_os().skip(1).collect();
    let cmake = executable("MERKUR_CMAKE_EXECUTABLE")?;
    if configures(&arguments) {
        let mut uname = OsString::from("-DCMAKE_UNAME:FILEPATH=");
        uname.push(executable("MERKUR_CMAKE_UNAME")?);
        arguments.push(uname);
    }
    // Replace this process, preserving Bazel's cancellation/descendant boundary.
    Err(Command::new(cmake).args(arguments).exec())
}

#[cfg(make_driver)]
fn make_arguments(mut arguments: Vec<OsString>, shell: OsString) -> Vec<OsString> {
    let mut variable = OsString::from("SHELL=");
    variable.push(shell);
    arguments.push(variable);
    arguments
}

#[cfg(make_driver)]
fn run() -> io::Result<()> {
    let arguments = make_arguments(
        env::args_os().skip(1).collect(),
        executable("MERKUR_CMAKE_SHELL")?,
    );
    Err(Command::new(executable("MERKUR_CMAKE_MAKE_EXECUTABLE")?).args(arguments).exec())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Declared CMake driver: {error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(make_driver))]
    use super::configures;
    use std::ffi::OsString;

    #[test]
    #[cfg(not(make_driver))]
    fn original_configure_and_build_invocations_remain_distinct() {
        assert!(configures(&[OsString::from("/original/allocator")]));
        assert!(configures(&[OsString::from("-S"), OsString::from("/original/allocator")]));
        for mode in ["--build", "--install", "--open", "--version", "--help", "-E", "-P"] {
            assert!(!configures(&[OsString::from(mode), OsString::from("argument")]));
        }
    }

    #[test]
    #[cfg(make_driver)]
    fn declared_shell_follows_original_options_and_variable_assignments() {
        let original: Vec<OsString> = ["-f", "Makefile", "--", "target", "SHELL=/ambient/sh"]
            .into_iter().map(OsString::from).collect();
        let arguments = super::make_arguments(original.clone(), OsString::from("/declared/bash"));
        assert_eq!(&arguments[..original.len()], original.as_slice());
        assert_eq!(arguments.last(), Some(&OsString::from("SHELL=/declared/bash")));
    }
}
