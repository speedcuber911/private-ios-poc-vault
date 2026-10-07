import SwiftUI

/// A paired machine's name for sentences, with "Your machine" standing in when
/// the app has no name for it (a personal install configured by file).
enum RelayMachineLabel {
    static let fallback = "Your machine"

    /// The name where it does not start the sentence.
    static func inSentence(_ name: String) -> String {
        name == fallback ? "your machine" : name
    }
}

/// What a screen that needs the machine shows while EC2 says it is not
/// serving: off, on its way up, or on its way down. It reads the app's one
/// power model, so every tab agrees with Settings about whether the machine
/// is on, and offers the one useful action, Start, where the user already is.
struct RelayMachineDownView: View {
    @ObservedObject var powerModel: RelayMachinePowerModel
    let machineName: String
    /// What the screen would show once the machine is up, in the user's
    /// words: "your chats", "this folder".
    let purpose: String

    var body: some View {
        VStack(spacing: 14) {
            Text(title)
                .font(AppTheme.serifFont(size: 26))
                .foregroundStyle(AppTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text(detail)
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            if powerModel.status == .off {
                Button("Start machine") {
                    Task { await powerModel.start() }
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .padding(.top, 8)
                .accessibilityIdentifier("relay-machine-start")
            } else {
                ProgressView()
                    .tint(AppTheme.accent)
                    .padding(.top, 8)
            }
            if let notice = powerModel.notice {
                Text(notice)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.statusError)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("relay-machine-down")
    }

    private var title: String {
        switch powerModel.status {
        case .starting: return "Starting \(RelayMachineLabel.inSentence(machineName))"
        case .stopping: return "\(machineName) is stopping"
        default: return "\(machineName) is off"
        }
    }

    private var detail: String {
        switch powerModel.status {
        case .starting:
            return "This usually takes under a minute. \(purpose.prefix(1).uppercased() + purpose.dropFirst()) will appear once it is up."
        case .stopping:
            return "Start it again once it has stopped."
        default:
            if powerModel.autoStopEnabled == true {
                return "Start it to see \(purpose). It turns itself off again after an hour with nothing running."
            }
            return "Start it to see \(purpose)."
        }
    }
}

/// One line over content that is still worth reading while the machine is
/// down (the saved Chats list): what state it is in, and Start. Typographic,
/// never a dot (Editorial Ember rule 5).
struct RelayMachineDownBanner: View {
    @ObservedObject var powerModel: RelayMachinePowerModel
    let machineName: String

    var body: some View {
        HStack(spacing: 10) {
            RelayCapsLabel(text: label, color: AppTheme.statusWarn)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if powerModel.status == .off {
                Button("Start") {
                    Task { await powerModel.start() }
                }
                .font(AppTheme.uiFont(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("relay-machine-start")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .tint(AppTheme.accent)
                    .frame(minHeight: 44)
            }
        }
        .padding(.horizontal, 18)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("relay-machine-down-banner")
    }

    private var label: String {
        switch powerModel.status {
        case .starting: return "Starting \(RelayMachineLabel.inSentence(machineName))"
        case .stopping: return "\(machineName) is stopping"
        default: return "\(machineName) is off"
        }
    }
}

/// The composer's line while the machine is down. Sending still works: the
/// request starts the machine first, which the line says up front.
struct RelayComposerMachineState {
    let status: RelayMachinePowerModel.Status
    let machineName: String
    let onStart: () -> Void

    var message: String {
        switch status {
        case .starting: return "Starting \(RelayMachineLabel.inSentence(machineName))…"
        case .stopping: return "\(machineName) is stopping."
        default: return "\(machineName) is off. Start it, or send and Relay starts it first."
        }
    }
}

/// Under a run the provider refused for its sign-in (a revoked or expired
/// token): the next step is signing in again, so it is right there, in the
/// composer's readiness-line style.
struct RelaySignInAgainRow: View {
    let provider: CodexProvider
    let action: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("\(provider.displayName) is signed out on this machine.")
                .font(RelayChatStyle.labelFont)
                .foregroundStyle(AppTheme.statusWarn)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Sign in", action: action)
                .font(RelayChatStyle.labelFont.weight(.semibold))
                .foregroundStyle(AppTheme.accent)
                .frame(minWidth: 44, minHeight: 44)
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-job-sign-in")
        }
        .accessibilityElement(children: .contain)
    }
}
