//! CargoShear 1.13.2 with engine-owned locked metadata, without a Cargo subprocess.
use std::path::PathBuf;
use std::process::ExitCode;

use cargo_shear::{CargoShear, CargoShearOptions};

fn run() -> Result<ExitCode, Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let metadata_path = PathBuf::from(arguments.next().ok_or("missing declared metadata File")?);
    let source_root =
        PathBuf::from(arguments.next().ok_or("missing copied source root")?).canonicalize()?;
    if arguments.next().is_some() {
        return Err("expected metadata File and copied source root only".into());
    }
    let metadata = serde_json::from_slice(&std::fs::read(metadata_path)?)?;
    let options = CargoShearOptions::new(source_root)
        .with_locked()
        .with_deny_warnings()
        .with_excludes(vec!["alacritty_terminal".to_owned(), "vte".to_owned()]);
    Ok(CargoShear::new(std::io::stdout(), options, metadata).run())
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("declared CargoShear input failed: {error}");
            ExitCode::from(2)
        }
    }
}
