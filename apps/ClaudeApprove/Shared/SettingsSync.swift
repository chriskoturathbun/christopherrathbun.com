import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity

/// Syncs the server URL + secret from the iPhone to the Watch so you only
/// type them once (on the phone).
final class SettingsSync: NSObject, WCSessionDelegate {
    static let shared = SettingsSync()

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession,
                 activationDidCompleteWith activationState: WCSessionActivationState,
                 error: Error?) {
        #if os(iOS)
        if activationState == .activated { pushSettings() }
        #endif
    }

    #if os(iOS)
    func pushSettings() {
        let ctx: [String: Any] = [
            "serverURL": UserDefaults.standard.string(forKey: "serverURL") ?? "",
            "accountToken": UserDefaults.standard.string(forKey: "accountToken") ?? "",
        ]
        try? WCSession.default.updateApplicationContext(ctx)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif

    #if os(watchOS)
    func session(_ session: WCSession,
                 didReceiveApplicationContext applicationContext: [String: Any]) {
        if let s = applicationContext["serverURL"] as? String, !s.isEmpty {
            UserDefaults.standard.set(s, forKey: "serverURL")
        }
        if let s = applicationContext["accountToken"] as? String, !s.isEmpty {
            UserDefaults.standard.set(s, forKey: "accountToken")
            // Now that the account exists, register this watch for pushes.
            NotificationManager.registerSavedToken()
        }
    }
    #endif
}
#endif
