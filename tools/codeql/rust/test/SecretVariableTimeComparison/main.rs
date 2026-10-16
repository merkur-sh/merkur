use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

fn checked(credential: &Zeroizing<[u8; 32]>, presented: &[u8; 32]) -> bool {
    if credential.len() != presented.len() {
        return false;
    }
    bool::from(credential.ct_eq(presented))
}

fn compared(credential: &Zeroizing<[u8; 32]>, presented: &[u8; 32]) -> bool {
    **credential == *presented // $ Alert
}

fn sliced(token: Zeroizing<Vec<u8>>, presented: &[u8]) -> bool {
    token.as_slice() != presented // $ Alert
}

fn method(token: &Zeroizing<Vec<u8>>, presented: &[u8]) -> bool {
    let bytes = token.as_slice(); // $ Source
    bytes.eq(presented) // $ Alert
}

fn main() {
    let credential = Zeroizing::new([7u8; 32]);
    let presented = [7u8; 32];
    let token = Zeroizing::new(vec![7u8; 32]);
    let _ = checked(&credential, &presented);
    let _ = compared(&credential, &presented);
    let _ = method(&token, &presented);
    let _ = sliced(token, &presented);
}
