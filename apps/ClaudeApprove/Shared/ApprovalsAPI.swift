import Foundation

enum APIError: Error {
    case badURL
    case badStatus(Int)
}

/// Client for the /api/claude-approve endpoints on the Cloudflare Worker.
/// Server URL and secret live in UserDefaults ("serverURL", "secret");
/// the iPhone app edits them and syncs them to the watch (SettingsSync).
struct ApprovalsAPI {
    static var baseURL: String {
        let stored = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        return stored.isEmpty ? "https://christopherrathbun.com/api/claude-approve" : stored
    }

    static var secret: String {
        UserDefaults.standard.string(forKey: "secret") ?? ""
    }

    private static func send(_ path: String, method: String = "GET",
                             body: [String: String]? = nil) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return data
    }

    static func pending() async throws -> [ApprovalRequest] {
        let data = try await send("/requests?status=pending")
        return try JSONDecoder().decode(RequestList.self, from: data).requests
    }

    static func respond(id: String, decision: String, device: String) async throws {
        _ = try await send("/requests/\(id)/respond", method: "POST",
                           body: ["decision": decision, "device": device])
    }

    static func registerDevice(token: String, topic: String,
                               platform: String, name: String) async {
        _ = try? await send("/devices", method: "POST",
                            body: ["token": token, "topic": topic,
                                   "platform": platform, "name": name])
    }
}
