//! GF(2^8) arithmetic.
//!
//! Field: GF(2^8) with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1).
//! Generator: g = 2 (a primitive element under this polynomial).
//!
//! Log/exp tables are built at compile time. `EXP` is duplicated to length 512
//! so multiplication can skip the `mod 255` reduction.

const PRIMITIVE: u16 = 0x11D;

const TABLES: ([u8; 512], [u8; 256]) = build_tables();

pub(crate) const EXP: [u8; 512] = TABLES.0;
pub(crate) const LOG: [u8; 256] = TABLES.1;

const fn build_tables() -> ([u8; 512], [u8; 256]) {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut x: u16 = 1;
    let mut i: usize = 0;
    while i < 255 {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= PRIMITIVE;
        }
        i += 1;
    }
    let mut k: usize = 0;
    while k < 255 {
        exp[255 + k] = exp[k];
        k += 1;
    }
    (exp, log)
}

/// Multiply two field elements. Const-callable.
pub(crate) const fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    let la = LOG[a as usize] as usize;
    let lb = LOG[b as usize] as usize;
    EXP[la + lb]
}

/// Multiplicative inverse. `a` must be non-zero.
pub(crate) const fn inv(a: u8) -> u8 {
    let la = LOG[a as usize] as usize;
    EXP[255 - la]
}

/// Multiply by the generator 2: one shift and a conditional reduction.
const fn xtime(a: u8) -> u8 {
    (a << 1) ^ (((a >> 7) & 1) * (PRIMITIVE as u8))
}

/// Build a pair of 16-byte nibble tables for `simd::combine`.
/// `low[i] = i * c`, `high[i] = (i << 4) * c`. Const-callable, so the parity
/// matrix's tables are built at compile time.
///
/// Multiplication by `c` is linear over GF(2), so each entry is the entry
/// without its lowest set bit, XOR `c * 2^bit`: seven doublings and 30 XORs,
/// with no table lookups.
pub(crate) const fn nibble_tables(c: u8) -> ([u8; 16], [u8; 16]) {
    let mut basis = [0u8; 8];
    basis[0] = c;
    let mut bit = 1;
    while bit < 8 {
        basis[bit] = xtime(basis[bit - 1]);
        bit += 1;
    }
    let mut low = [0u8; 16];
    let mut high = [0u8; 16];
    let mut i: usize = 1;
    while i < 16 {
        let rest = i & (i - 1);
        let lowest = i.trailing_zeros() as usize;
        low[i] = low[rest] ^ basis[lowest];
        high[i] = high[rest] ^ basis[4 + lowest];
        i += 1;
    }
    (low, high)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_zero() {
        for b in 0..=255u8 {
            assert_eq!(mul(0, b), 0);
            assert_eq!(mul(b, 0), 0);
        }
    }

    #[test]
    fn mul_one_is_identity() {
        for b in 0..=255u8 {
            assert_eq!(mul(1, b), b);
            assert_eq!(mul(b, 1), b);
        }
    }

    #[test]
    fn mul_inv_is_one() {
        for a in 1..=255u8 {
            assert_eq!(mul(a, inv(a)), 1);
        }
    }

    #[test]
    fn nibble_tables_match_scalar() {
        for c in 0..=255u8 {
            let (low, high) = nibble_tables(c);
            for b in 0..=255u8 {
                let lo = (b & 0x0F) as usize;
                let hi = ((b >> 4) & 0x0F) as usize;
                assert_eq!(low[lo] ^ high[hi], mul(b, c), "nibble_tables[{c}][{b}]");
            }
        }
    }
}
