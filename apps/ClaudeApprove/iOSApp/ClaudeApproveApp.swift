import SwiftUI
import UIKit

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions:
                     [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationManager.shared.configure()
        SettingsSync.shared.activate()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationManager.shared.handleDeviceToken(deviceToken)
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push registration failed: \(error)")
    }
}

@main
struct ClaudeApproveApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { url in
                    // claudeapprove://config?url=...&secret=... — one-tap setup
                    // from the QR/link that setup-backend.sh prints.
                    guard url.scheme == "claudeapprove", url.host == "config",
                          let comps = URLComponents(url: url,
                                                    resolvingAgainstBaseURL: false)
                    else { return }
                    for item in comps.queryItems ?? [] {
                        if item.name == "url", let v = item.value, !v.isEmpty {
                            UserDefaults.standard.set(v, forKey: "serverURL")
                        }
                        if item.name == "secret", let v = item.value, !v.isEmpty {
                            UserDefaults.standard.set(v, forKey: "secret")
                        }
                    }
                    SettingsSync.shared.pushSettings()
                }
        }
    }
}
