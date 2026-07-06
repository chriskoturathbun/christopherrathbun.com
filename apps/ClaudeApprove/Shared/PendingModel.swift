import Foundation

@MainActor
final class PendingModel: ObservableObject {
    @Published var requests: [ApprovalRequest] = []
    @Published var lastError: String?

    func refresh() async {
        do {
            requests = try await ApprovalsAPI.pending()
            lastError = nil
        } catch {
            lastError = String(describing: error)
        }
    }

    func respond(_ id: String, _ decision: String, device: String) async {
        try? await ApprovalsAPI.respond(id: id, decision: decision, device: device)
        await refresh()
    }

    /// Refresh now, then every few seconds while the view is on screen.
    func autoRefresh() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }
}
