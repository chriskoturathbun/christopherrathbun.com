import Foundation
import UserNotifications
#if os(iOS)
import UIKit
#elseif os(watchOS)
import WatchKit
#endif

/// Registers the CLAUDE_APPROVAL notification category (Approve/Deny buttons),
/// requests permission, registers for remote notifications, and handles
/// action taps — including on the Watch, where the buttons render natively.
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()
    var onRefreshNeeded: (() -> Void)?

    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let approve = UNNotificationAction(identifier: "APPROVE_ACTION",
                                           title: "Approve", options: [])
        let deny = UNNotificationAction(identifier: "DENY_ACTION",
                                        title: "Deny", options: [.destructive])
        let category = UNNotificationCategory(identifier: "CLAUDE_APPROVAL",
                                              actions: [approve, deny],
                                              intentIdentifiers: [], options: [])
        center.setNotificationCategories([category])

        Task {
            let granted = (try? await center.requestAuthorization(
                options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            await MainActor.run {
                #if os(iOS)
                UIApplication.shared.registerForRemoteNotifications()
                #elseif os(watchOS)
                WKApplication.shared().registerForRemoteNotifications()
                #endif
            }
        }
    }

    func handleDeviceToken(_ deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        let topic = Bundle.main.bundleIdentifier ?? ""
        #if os(iOS)
        let platform = "ios"
        let name = UIDevice.current.name
        #elseif os(watchOS)
        let platform = "watchos"
        let name = "Apple Watch"
        #endif
        Task {
            await ApprovalsAPI.registerDevice(token: token, topic: topic,
                                              platform: platform, name: name)
        }
    }

    // Show the notification even when the app is in the foreground.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    // Approve/Deny button taps (and plain notification taps) land here.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        guard let requestId = userInfo["requestId"] as? String else { return }
        switch response.actionIdentifier {
        case "APPROVE_ACTION":
            try? await ApprovalsAPI.respond(id: requestId, decision: "approve",
                                            device: deviceLabel())
        case "DENY_ACTION":
            try? await ApprovalsAPI.respond(id: requestId, decision: "deny",
                                            device: deviceLabel())
        default:
            onRefreshNeeded?()
        }
    }

    private func deviceLabel() -> String {
        #if os(iOS)
        return "iPhone notification"
        #elseif os(watchOS)
        return "Watch notification"
        #endif
    }
}
