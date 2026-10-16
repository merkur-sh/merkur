use zeroize::Zeroizing;

fn kept(secret: &Zeroizing<Vec<u8>>) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(secret.to_vec())
}

fn copied(secret: &Zeroizing<Vec<u8>>) -> Vec<u8> {
    secret.to_vec() // $ Alert
}

fn printed(secret: &Zeroizing<String>) -> String {
    secret.to_string() // $ Alert
}

fn filled(secret: &Zeroizing<[u8; 32]>, wire: &mut [u8; 32], held: &mut Zeroizing<[u8; 32]>) {
    held.copy_from_slice(secret.as_slice());
    wire.copy_from_slice(secret.as_slice()); // $ Alert
}

fn converted(secret: Zeroizing<Vec<u8>>) -> Vec<u8> {
    Vec::from(secret.as_slice()) // $ Alert
}

fn main() {
    let secret = Zeroizing::new(vec![7u8; 32]);
    let _ = kept(&secret);
    let _ = copied(&secret);
    let _ = printed(&Zeroizing::new(String::from("fixture")));
    let mut wire = [0u8; 32];
    let mut held = Zeroizing::new([0u8; 32]);
    filled(&Zeroizing::new([7u8; 32]), &mut wire, &mut held);
    let _ = converted(secret);
}
