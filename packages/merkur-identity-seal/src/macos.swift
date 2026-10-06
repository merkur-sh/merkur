import CryptoKit
import Foundation
import Security

// C ABI: zero means success; failures are fixed codes, never exceptions or
// messages containing material. 1 = no Secure Enclave, 2 = operation failed,
// 3 = this enclave cannot hold an ML-DSA-87 key. Each returned opaque handle
// has one Rust owner, released through `merkur_enclave_release`.
private enum EnclaveFailure: Error { case malformed, unavailable }

private let sealInfo = Data("merkur-key-custody-seal\0".utf8)

private struct Prehash: CryptoKit.Digest {
    static let byteCount = 32
    let bytes: [UInt8]
    func withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try bytes.withUnsafeBytes(body)
    }
}

@available(macOS 14.0, *)
private final class P256Handle {
    let key: SecureEnclave.P256.Signing.PrivateKey
    init(_ key: SecureEnclave.P256.Signing.PrivateKey) { self.key = key }
}

@available(macOS 26.0, *)
private final class MlDsaHandle {
    let key: SecureEnclave.MLDSA87.PrivateKey
    init(_ key: SecureEnclave.MLDSA87.PrivateKey) { self.key = key }
}

@available(macOS 14.0, *)
private func accessControl() throws -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage], &error
    ) else { throw EnclaveFailure.unavailable }
    return access
}

private func field(_ bytes: Data, into output: inout Data) throws {
    guard !bytes.isEmpty, bytes.count <= Int(UInt16.max) else { throw EnclaveFailure.malformed }
    var length = UInt16(bytes.count).bigEndian
    withUnsafeBytes(of: &length) { output.append(contentsOf: $0) }
    output.append(bytes)
}

private func takeField(_ input: Data, offset: inout Int) throws -> Data {
    guard offset <= input.count - 2 else { throw EnclaveFailure.malformed }
    let length = Int(input[offset]) << 8 | Int(input[offset + 1])
    offset += 2
    guard length > 0, length <= input.count - offset else { throw EnclaveFailure.malformed }
    defer { offset += length }
    return input.subdata(in: offset..<(offset + length))
}

private func emit(_ blob: Data, _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int,
                  _ length: UnsafeMutablePointer<Int>) throws {
    guard blob.count <= capacity else { throw EnclaveFailure.malformed }
    blob.copyBytes(to: output, count: blob.count)
    length.pointee = blob.count
}

@_cdecl("merkur_enclave_available")
func merkurEnclaveAvailable() -> Int32 {
    if #available(macOS 14.0, *) { return SecureEnclave.isAvailable ? 1 : 0 }
    return 0
}

@_cdecl("merkur_enclave_release")
func merkurEnclaveRelease(_ handle: UnsafeMutableRawPointer) {
    Unmanaged<AnyObject>.fromOpaque(handle).release()
}

// P-256 signing keys.

@_cdecl("merkur_enclave_p256_create")
func merkurEnclaveP256Create(
    _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int, _ length: UnsafeMutablePointer<Int>,
    _ publicKey: UnsafeMutablePointer<UInt8>, _ handle: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) -> Int32 {
    guard #available(macOS 14.0, *), SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: try accessControl())
            let pk = key.publicKey.x963Representation
            guard pk.count == 65 else { throw EnclaveFailure.malformed }
            try emit(key.dataRepresentation, output, capacity, length)
            pk.copyBytes(to: publicKey, count: 65)
            handle.pointee = Unmanaged.passRetained(P256Handle(key)).toOpaque()
            return 0
        } catch { return 2 }
    }
}

@_cdecl("merkur_enclave_p256_open")
func merkurEnclaveP256Open(
    _ input: UnsafePointer<UInt8>, _ length: Int, _ publicKey: UnsafeMutablePointer<UInt8>,
    _ handle: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) -> Int32 {
    guard #available(macOS 14.0, *), SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: Data(bytes: input, count: length))
            let pk = key.publicKey.x963Representation
            guard pk.count == 65 else { throw EnclaveFailure.malformed }
            pk.copyBytes(to: publicKey, count: 65)
            handle.pointee = Unmanaged.passRetained(P256Handle(key)).toOpaque()
            return 0
        } catch { return 2 }
    }
}

@_cdecl("merkur_enclave_p256_sign")
func merkurEnclaveP256Sign(
    _ handle: UnsafeMutableRawPointer, _ digest: UnsafePointer<UInt8>,
    _ signature: UnsafeMutablePointer<UInt8>
) -> Int32 {
    guard #available(macOS 14.0, *) else { return 1 }
    return autoreleasepool {
        do {
            let key = Unmanaged<P256Handle>.fromOpaque(handle).takeUnretainedValue().key
            // Digest overload: Rust has already hashed the domain and transcript.
            let prehash = Prehash(bytes: Array(UnsafeBufferPointer(start: digest, count: 32)))
            let raw = try key.signature(for: prehash).rawRepresentation
            guard raw.count == 64 else { throw EnclaveFailure.malformed }
            raw.copyBytes(to: signature, count: 64)
            return 0
        } catch { return 2 }
    }
}

// ML-DSA-87 keys, macOS 26 and newer.

@_cdecl("merkur_enclave_mldsa_create")
func merkurEnclaveMlDsaCreate(
    _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int, _ length: UnsafeMutablePointer<Int>,
    _ publicKey: UnsafeMutablePointer<UInt8>, _ handle: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) -> Int32 {
    guard #available(macOS 26.0, *) else { return 3 }
    guard SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        let key: SecureEnclave.MLDSA87.PrivateKey
        do {
            key = try SecureEnclave.MLDSA87.PrivateKey(accessControl: try accessControl())
        } catch { return 3 }
        do {
            let pk = key.publicKey.rawRepresentation
            guard pk.count == 2592 else { throw EnclaveFailure.malformed }
            try emit(key.dataRepresentation, output, capacity, length)
            pk.copyBytes(to: publicKey, count: 2592)
            handle.pointee = Unmanaged.passRetained(MlDsaHandle(key)).toOpaque()
            return 0
        } catch { return 2 }
    }
}

@_cdecl("merkur_enclave_mldsa_open")
func merkurEnclaveMlDsaOpen(
    _ input: UnsafePointer<UInt8>, _ length: Int, _ publicKey: UnsafeMutablePointer<UInt8>,
    _ handle: UnsafeMutablePointer<UnsafeMutableRawPointer?>
) -> Int32 {
    guard #available(macOS 26.0, *) else { return 3 }
    guard SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        do {
            let key = try SecureEnclave.MLDSA87.PrivateKey(
                dataRepresentation: Data(bytes: input, count: length))
            let pk = key.publicKey.rawRepresentation
            guard pk.count == 2592 else { throw EnclaveFailure.malformed }
            pk.copyBytes(to: publicKey, count: 2592)
            handle.pointee = Unmanaged.passRetained(MlDsaHandle(key)).toOpaque()
            return 0
        } catch { return 2 }
    }
}

@_cdecl("merkur_enclave_mldsa_sign")
func merkurEnclaveMlDsaSign(
    _ handle: UnsafeMutableRawPointer, _ context: UnsafePointer<UInt8>, _ contextLength: Int,
    _ message: UnsafePointer<UInt8>, _ messageLength: Int, _ signature: UnsafeMutablePointer<UInt8>
) -> Int32 {
    guard #available(macOS 26.0, *) else { return 3 }
    return autoreleasepool {
        do {
            let key = Unmanaged<MlDsaHandle>.fromOpaque(handle).takeUnretainedValue().key
            // FIPS 204 pure ML-DSA under an external context, as libcrux verifies.
            let raw = try key.signature(
                for: Data(bytes: message, count: messageLength),
                context: Data(bytes: context, count: contextLength))
            guard raw.count == 4627 else { throw EnclaveFailure.malformed }
            raw.copyBytes(to: signature, count: 4627)
            return 0
        } catch { return 2 }
    }
}

// Sealing a 32-byte secret to a fresh enclave key-agreement key with HPKE,
// authenticated under the caller's binding.

@_cdecl("merkur_enclave_seal")
func merkurEnclaveSeal(
    _ secret: UnsafePointer<UInt8>, _ binding: UnsafePointer<UInt8>,
    _ output: UnsafeMutablePointer<UInt8>, _ capacity: Int, _ length: UnsafeMutablePointer<Int>
) -> Int32 {
    guard #available(macOS 14.0, *), SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        do {
            let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                accessControl: try accessControl())
            var sender = try HPKE.Sender(recipientKey: agreement.publicKey,
                ciphersuite: .P256_SHA256_AES_GCM_256, info: sealInfo)
            var plaintext = Data(bytes: secret, count: 32)
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }
            let ciphertext = try sender.seal(plaintext, authenticating: Data(bytes: binding, count: 65))
            var blob = Data()
            try field(agreement.dataRepresentation, into: &blob)
            blob.append(sender.encapsulatedKey)
            blob.append(ciphertext)
            try emit(blob, output, capacity, length)
            return 0
        } catch { return 2 }
    }
}

@_cdecl("merkur_enclave_unseal")
func merkurEnclaveUnseal(
    _ input: UnsafePointer<UInt8>, _ length: Int, _ binding: UnsafePointer<UInt8>,
    _ secret: UnsafeMutablePointer<UInt8>
) -> Int32 {
    guard #available(macOS 14.0, *), SecureEnclave.isAvailable else { return 1 }
    return autoreleasepool {
        do {
            let blob = Data(bytes: input, count: length)
            var offset = 0
            let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(
                dataRepresentation: takeField(blob, offset: &offset))
            // A 65-byte encapsulated key, then 32 bytes of ciphertext and its tag.
            guard blob.count - offset == 65 + 48 else { throw EnclaveFailure.malformed }
            let enc = blob.subdata(in: offset..<(offset + 65))
            var recipient = try HPKE.Recipient(privateKey: agreement,
                ciphersuite: .P256_SHA256_AES_GCM_256, info: sealInfo, encapsulatedKey: enc)
            var plaintext = try recipient.open(blob.subdata(in: (offset + 65)..<blob.count),
                authenticating: Data(bytes: binding, count: 65))
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }
            guard plaintext.count == 32 else { throw EnclaveFailure.malformed }
            plaintext.copyBytes(to: secret, count: 32)
            return 0
        } catch { return 2 }
    }
}

// Generic passwords live in the login Keychain. They are never synchronized.
// The operating system controls access and may ask the user to unlock it.
private func credentialQuery(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>) -> [CFString: Any] {
    [kSecClass: kSecClassGenericPassword,
     kSecAttrService: String(cString: service),
     kSecAttrAccount: String(cString: account),
     kSecAttrSynchronizable: false]
}

@_cdecl("merkur_keychain_put")
func merkurKeychainPut(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>,
    _ bytes: UnsafePointer<UInt8>, _ length: Int) -> Int32 {
    guard length >= 0 else { return errSecParam }
    let query = credentialQuery(service, account)
    let secret = NSMutableData(bytes: bytes, length: length)
    defer { secret.resetBytes(in: NSRange(location: 0, length: length)) }
    let attributes: [CFString: Any] = [kSecValueData: secret]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status != errSecItemNotFound { return status }
    var added = query
    added[kSecValueData] = secret
    return SecItemAdd(added as CFDictionary, nil)
}

@_cdecl("merkur_keychain_get")
func merkurKeychainGet(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>,
    _ handle: UnsafeMutablePointer<UnsafeMutableRawPointer?>,
    _ bytes: UnsafeMutablePointer<UnsafePointer<UInt8>?>,
    _ length: UnsafeMutablePointer<Int>) -> Int32 {
    var query = credentialQuery(service, account)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return status }
    guard let data = result as? Data else { return errSecDecode }
    let buffer = NSMutableData(data: data)
    handle.pointee = Unmanaged.passRetained(buffer).toOpaque()
    length.pointee = buffer.length
    bytes.pointee = buffer.bytes.assumingMemoryBound(to: UInt8.self)
    return errSecSuccess
}

@_cdecl("merkur_keychain_delete")
func merkurKeychainDelete(_ service: UnsafePointer<CChar>, _ account: UnsafePointer<CChar>) -> Int32 {
    SecItemDelete(credentialQuery(service, account) as CFDictionary)
}

@_cdecl("merkur_keychain_release")
func merkurKeychainRelease(_ handle: UnsafeMutableRawPointer) {
    let buffer = Unmanaged<NSMutableData>.fromOpaque(handle).takeRetainedValue()
    buffer.resetBytes(in: NSRange(location: 0, length: buffer.length))
}
