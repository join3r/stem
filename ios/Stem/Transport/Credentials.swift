import Foundation
import Security

/// What pairing hands the phone: where the server is and the bearer token it
/// accepts. Stored as one Keychain item so the three fields never disagree.
struct Credentials: Codable, Equatable, Sendable {
    var serverUrl: String
    var deviceId: String
    var token: String
}

enum CredentialStore {
    private static let service = "sk.awantech.stem"
    private static let account = "stem.pairing"

    static func load() -> Credentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    static func save(_ creds: Credentials) {
        clear()
        guard let data = try? JSONEncoder().encode(creds) else { return }
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            // A push can launch the app in the background before first unlock
            // is long past; the token must still be readable then.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
