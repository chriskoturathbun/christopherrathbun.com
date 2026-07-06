import Foundation

enum APIError: Error {
    case badURL
    case badStatus(Int)
}

struct PairResponse: Codable {
    let account_token: String
    let pair_code: String
    let expires_in_seconds: Int
}

struct PairCodeResponse: Codable {
    let pair_code: String
    let expires_in_seconds: Int
}

/// Client for the multi-tenant /api/claude-approve backend. The account
/// token is created at onboarding (POST /pair/new) and stored in
/// UserDefaults ("accountToken"); the iPhone syncs it to the Watch.
struct ApprovalsAPI {
    static let defaultBaseURL = "https://christopherrathbun.com/api/claude-approve"

    static var baseURL: String {
        let stored = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        return stored.isEmpty ? defaultBaseURL : stored
    }

    static var accountToken: String {
        UserDefaults.standard.string(forKey: "accountToken") ?? ""
    }

    private static func send(_ path: String, method: String = "GET",
                             body: [String: String]? = nil,
                             authorized: Bool = true) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if authorized {
            req.setValue("Bearer \(accountToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.badStatus(code) }
        return data
    }

    // ---- pairing ----

    /// Create a new account and the first pairing code (onboarding).
    static func pairNew() async throws -> PairResponse {
        let data = try await send("/pair/new", method: "POST", authorized: false)
        return try JSONDecoder().decode(PairResponse.self, from: data)
    }

    /// Issue another pairing code for the existing account (extra Macs).
    static func pairCode() async throws -> PairCodeResponse {
        let data = try await send("/pair/code", method: "POST")
        return try JSONDecoder().decode(PairCodeResponse.self, from: data)
    }

    // ---- approvals ----

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
