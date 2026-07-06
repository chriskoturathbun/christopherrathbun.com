import SwiftUI

struct ContentView: View {
    @AppStorage("onboardingDone") private var onboardingDone = false

    var body: some View {
        if onboardingDone {
            PendingListView()
        } else {
            OnboardingView()
        }
    }
}

// MARK: - Onboarding: one tap creates the account and shows the pairing code.

struct OnboardingView: View {
    @AppStorage("accountToken") private var accountToken = ""
    @AppStorage("onboardingDone") private var onboardingDone = false
    @State private var pairCode: String?
    @State private var busy = false
    @State private var errorText: String?

    private let installCommand =
        "curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash"

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "applewatch.radiowaves.left.and.right")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Approve Claude Code\nfrom your wrist")
                .font(.title2).bold()
                .multilineTextAlignment(.center)

            if let pairCode {
                VStack(spacing: 14) {
                    Text("On the Mac where you run Claude Code, paste this in Terminal:")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                    Text(installCommand)
                        .font(.system(.caption2, design: .monospaced))
                        .padding(10)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        .textSelection(.enabled)
                    ShareLink(item: installCommand) {
                        Label("Send command to my Mac", systemImage: "square.and.arrow.up")
                            .font(.footnote)
                    }
                    Text("…and enter this pairing code:")
                        .font(.footnote)
                    Text(pairCode)
                        .font(.system(.largeTitle, design: .monospaced)).bold()
                        .textSelection(.enabled)
                    Text("Code expires in 10 minutes — generate another from the menu anytime.")
                        .font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Done — take me to approvals") {
                        onboardingDone = true
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                Text("One tap creates your anonymous account and pairs your Mac. No sign-up.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    Task { await setUp() }
                } label: {
                    Text(busy ? "Setting up…" : "Set Up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
            }

            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(.red)
            }
            Spacer()
        }
        .padding(24)
    }

    private func setUp() async {
        busy = true
        defer { busy = false }
        do {
            // If a prior setup was interrupted, reuse the account instead of
            // creating an orphan — just issue a fresh pairing code.
            if accountToken.isEmpty {
                let p = try await ApprovalsAPI.pairNew()
                accountToken = p.account_token
                pairCode = p.pair_code
            } else {
                pairCode = try await ApprovalsAPI.pairCode().pair_code
            }
            errorText = nil
            NotificationManager.registerSavedToken()
            SettingsSync.shared.pushSettings()
        } catch {
            errorText = "Couldn't reach the server — check your connection and try again."
        }
    }
}

// MARK: - Main list

struct PendingListView: View {
    @StateObject private var model = PendingModel()
    @State private var newPairCode: PairCodeResponse?
    @State private var showAdvanced = false

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
                Menu {
                    Button {
                        Task { newPairCode = try? await ApprovalsAPI.pairCode() }
                    } label: {
                        Label("Pair a Computer", systemImage: "desktopcomputer")
                    }
                    Button {
                        showAdvanced = true
                    } label: {
                        Label("Advanced", systemImage: "gearshape")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            .refreshable { await model.refresh() }
            .task { await model.autoRefresh() }
            .sheet(item: $newPairCode) { code in
                PairCodeSheet(code: code)
            }
            .sheet(isPresented: $showAdvanced) { AdvancedView() }
            .overlay(alignment: .bottom) {
                if let err = model.lastError {
                    Text(err).font(.caption2).foregroundStyle(.red).padding(8)
                }
            }
        }
    }
}

extension PairCodeResponse: Identifiable {
    var id: String { pair_code }
}

struct PairCodeSheet: View {
    let code: PairCodeResponse
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Pair a Computer").font(.headline)
            Text("On that Mac, run:")
                .font(.footnote)
            Text("curl -fsSL https://christopherrathbun.com/claude-approve/install.sh | bash")
                .font(.system(.caption2, design: .monospaced))
                .padding(10)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                .textSelection(.enabled)
            Text("and enter:")
                .font(.footnote)
            Text(code.pair_code)
                .font(.system(.largeTitle, design: .monospaced)).bold()
                .textSelection(.enabled)
            Text("Expires in \(code.expires_in_seconds / 60) minutes.")
                .font(.caption2).foregroundStyle(.secondary)
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
        }
        .padding(24)
        .presentationDetents([.medium])
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

struct AdvancedView: View {
    @AppStorage("serverURL") private var serverURL = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField(ApprovalsAPI.defaultBaseURL, text: $serverURL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Text("Leave empty for the default. Only change this if you self-host the backend.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Advanced")
            .toolbar {
                Button("Done") {
                    SettingsSync.shared.pushSettings()
                    dismiss()
                }
            }
        }
    }
}
