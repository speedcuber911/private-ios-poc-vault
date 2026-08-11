import SwiftUI

/// Presented as a sheet from the onboarding fork's "Try instantly" button. Drives
/// `RelayTrialFlowModel.start` end to end and renders its `Step` as a checklist
/// (Creating → Booting → Pairing → Ready), offering a retry once the flow lands in
/// `.failed`. Completes onboarding automatically once the flow reaches `.done` —
/// at that point `RelayAccountStore.phase` flips to `.ready` and the whole
/// onboarding stack (this sheet included) is torn down by `POCVaultApp`.
struct TrialProvisioningView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var flow: RelayTrialFlowModel
    let deviceName: String

    @Environment(\.dismiss) private var dismiss
    @State private var reachedStageIndex = 0

    private static let stageTitles = ["Creating", "Booting", "Pairing", "Ready"]

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()
            VStack(spacing: 28) {
                Spacer()

                Image(systemName: isFailed ? "exclamationmark.triangle" : "bolt.horizontal.circle")
                    .font(.system(size: 40, weight: .medium))
                    .foregroundStyle(AppTheme.accentGradient)

                VStack(spacing: 10) {
                    Text(isFailed ? "Trial setup ran into a problem" : "Setting up your trial machine")
                        .font(AppTheme.serifFont(size: 26))
                        .foregroundStyle(AppTheme.textPrimary)
                        .multilineTextAlignment(.center)
                    Text("Trial machines run on Relay infrastructure — connect your own machine for full privacy.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 28)

                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(Self.stageTitles.enumerated()), id: \.offset) { index, title in
                        checklistRow(title: title, index: index)
                    }
                }
                .padding(.horizontal, 32)
                .frame(maxWidth: .infinity, alignment: .leading)

                if case .failed(let message) = flow.step {
                    Text(message)
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.statusError)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .accessibilityIdentifier("relay-trial-error")
                }

                Spacer()

                actions
                    .padding(.horizontal, 22)
                    .padding(.bottom, 24)
            }
        }
        .interactiveDismissDisabled(isActivelyWorking)
        .task { await runFlow() }
        .onChange(of: flow.step) { _, newStep in
            if let index = Self.stageIndex(for: newStep) {
                reachedStageIndex = max(reachedStageIndex, index)
            }
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var actions: some View {
        if isFailed {
            VStack(spacing: 12) {
                Button("Retry") {
                    Task { await runFlow() }
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-trial-retry")

                Button("Not now") { dismiss() }
                    .buttonStyle(RelayOutlineButtonStyle())
                    .accessibilityIdentifier("relay-trial-cancel")
            }
        } else if flow.step != .done {
            ProgressView()
                .tint(AppTheme.accent)
        }
    }

    private func checklistRow(title: String, index: Int) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbolName(for: index))
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(color(for: index))
                .frame(width: 22)

            Text(title)
                .font(AppTheme.uiFont(size: 16, weight: index == reachedStageIndex ? .semibold : .regular))
                .foregroundStyle(index <= reachedStageIndex ? AppTheme.textPrimary : AppTheme.textTertiary)

            Spacer()

            if index == reachedStageIndex, isActivelyWorking {
                ProgressView().tint(AppTheme.accent)
            }
        }
    }

    private var isFailed: Bool {
        if case .failed = flow.step { return true }
        return false
    }

    private var isActivelyWorking: Bool {
        switch flow.step {
        case .failed, .done:
            return false
        case .idle, .creating, .waitingForMachine, .pairing, .importingIdentity:
            return true
        }
    }

    private func symbolName(for index: Int) -> String {
        if isFailed && index == reachedStageIndex {
            return "exclamationmark.circle.fill"
        }
        if index < reachedStageIndex || (index == reachedStageIndex && flow.step == .done) {
            return "checkmark.circle.fill"
        }
        return "circle"
    }

    private func color(for index: Int) -> Color {
        if isFailed && index == reachedStageIndex {
            return AppTheme.statusError
        }
        return index <= reachedStageIndex ? AppTheme.accent : AppTheme.textTertiary
    }

    private static func stageIndex(for step: RelayTrialFlowModel.Step) -> Int? {
        switch step {
        case .idle, .failed:
            return nil
        case .creating:
            return 0
        case .waitingForMachine:
            return 1
        case .pairing, .importingIdentity:
            return 2
        case .done:
            return 3
        }
    }

    private func runFlow() async {
        reachedStageIndex = 0
        await flow.start(bearer: accountStore.currentSessionToken ?? "", deviceName: deviceName)
        if flow.step == .done {
            accountStore.completeOnboarding()
        }
    }
}
