import SwiftUI

struct ContentView: View {
    @StateObject private var model = PendingModel()
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if model.requests.isEmpty {
                    ContentUnavailableView(
                        "No pending approvals",
                        systemImage: "checkmark.seal",
                        description: Text("When Claude Code needs permission, requests appear here and on your Watch.")
                    )
                } else {
                    List(model.requests) { req in
                        RequestRow(req: req) { decision in
                            Task { await model.respond(req.id, decision, device: "iPhone app") }
                        }
                    }
                }
            }
            .navigationTitle("Claude Approve")
            .toolbar {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                }
            }
            .refreshable { await model.refresh() }
            .task { await model.autoRefresh() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .overlay(alignment: .bottom) {
                if let err = model.lastError {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .padding(8)
                }
            }
        }
    }
}

struct RequestRow: View {
    let req: ApprovalRequest
    let onDecision: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(req.tool).font(.headline)
            Text(req.detail)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(4)
            if !req.cwd.isEmpty {
                Text(req.cwd).font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                Button("Approve") { onDecision("approve") }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                Button("Deny") { onDecision("deny") }
                    .buttonStyle(.bordered)
                    .tint(.red)
            }
        }
        .padding(.vertical, 4)
    }
}

struct SettingsView: View {
    @AppStorage("serverURL") private var serverURL =
        "https://christopherrathbun.com/api/claude-approve"
    @AppStorage("secret") private var secret = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://…/api/claude-approve", text: $serverURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                Section("Secret") {
                    SecureField("APPROVE_SECRET", text: $secret)
                }
                Section {
                    Text("Settings sync to your Apple Watch automatically.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                Button("Done") {
                    SettingsSync.shared.pushSettings()
                    dismiss()
                }
            }
        }
    }
}
