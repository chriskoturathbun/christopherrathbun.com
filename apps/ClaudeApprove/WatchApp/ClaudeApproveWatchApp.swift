import SwiftUI
import WatchKit

class WatchAppDelegate: NSObject, WKApplicationDelegate {
    func applicationDidFinishLaunching() {
        NotificationManager.shared.configure()
        SettingsSync.shared.activate()
    }

    func didRegisterForRemoteNotifications(withDeviceToken deviceToken: Data) {
        NotificationManager.shared.handleDeviceToken(deviceToken)
    }

    func didFailToRegisterForRemoteNotificationsWithError(_ error: Error) {
        print("push registration failed: \(error)")
    }
}

@main
struct ClaudeApproveWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) var delegate

    var body: some Scene {
        WindowGroup {
            WatchContentView()
        }
    }
}
