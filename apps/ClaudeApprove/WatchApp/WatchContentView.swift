import SwiftUI

struct WatchContentView: View {
    @AppStorage("accountToken") private var accountToken = ""
    @StateObject private var model = PendingModel()

    var body: some View {
        NavigationStack {
            Group {
                if accountToken.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "iphone")
                            .font(.title2)
                        Text("Open ClaudeApprove on your iPhone and tap Set Up")
                            .font(.caption)
                            .multilineTextAlignment(.center)
                    }
                } else if model.requests.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.seal")
                            .font(.title2)
                        Text("No pending approvals")
                            .font(.caption)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    List(model.requests) { req in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(req.tool).font(.headline)
                            Text(req.detail)
                                .font(.system(.caption2, design: .monospaced))
                                .lineLimit(3)
                            Button {
                                Task { await model.respond(req.id, "approve", device: "Watch app") }
                            } label: {
                                Label("Approve", systemImage: "checkmark")
                            }
                            .tint(.green)
                            Button {
                                Task { await model.respond(req.id, "deny", device: "Watch app") }
                            } label: {
                                Label("Deny", systemImage: "xmark")
                            }
                            .tint(.red)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("Claude")
            .task(id: accountToken) {
                NotificationManager.registerSavedToken()
                // Don't poll (guaranteed 401s) until pairing has synced over.
                if !accountToken.isEmpty {
                    await model.autoRefresh()
                }
            }
        }
    }
}
