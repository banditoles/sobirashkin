import Foundation
import Security

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrAccount as String: NSUserName(),
    kSecAttrService as String: "com.sobirashkin.wb-fbs-panel"
]

func check(_ status: OSStatus) {
    guard status != errSecSuccess else { return }
    if status == errSecItemNotFound { exit(44) }
    FileHandle.standardError.write(Data("Keychain OSStatus \(status)\n".utf8))
    exit(1)
}

switch CommandLine.arguments.dropFirst().first {
case "read":
    var item: CFTypeRef?
    let request = query.merging([kSecReturnData as String: true]) { _, new in new }
    check(SecItemCopyMatching(request as CFDictionary, &item))
    guard let data = item as? Data else { exit(1) }
    FileHandle.standardOutput.write(data)
case "write":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else { exit(2) }
    let value = [kSecValueData as String: data]
    let status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
    if status == errSecItemNotFound {
        check(SecItemAdd(query.merging(value) { _, new in new } as CFDictionary, nil))
    } else {
        check(status)
    }
default:
    exit(2)
}
