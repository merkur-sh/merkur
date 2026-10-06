import Foundation
import CryptoKit
import Security

public func publicHash(_ data: Data) -> String {
    SHA256.hash(data: data).description
}
