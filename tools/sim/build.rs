//! On glibc, `getrandom` 0.3 and later, and `std`, find `getrandom` with
//! `dlsym(RTLD_DEFAULT)`, which sees only dynamically exported symbols. Export
//! this binary's own definition (`src/entropy.rs`) so they draw from the run's
//! stream as every static caller does.

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo::rustc-link-arg=-Wl,--export-dynamic-symbol=getrandom");
    }
}
