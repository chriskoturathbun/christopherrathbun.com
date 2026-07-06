import Foundation

struct ApprovalRequest: Codable, Identifiable, Equatable {
    let id: String
    let tool: String
    let detail: String
    let cwd: String
    let status: String
    let created_at: Double
    let responded_at: Double?
    let responded_by: String?
}

struct RequestList: Codable {
    let requests: [ApprovalRequest]
}
