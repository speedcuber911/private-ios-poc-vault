import SwiftUI
import UIKit

/// Connect the phone to a machine the user owns.
///
/// Scan the QR that `relayd pair` prints, or type what it printed. There is no
/// account step: pairing is a direct, out-of-band-authenticated exchange with
/// hardware the user already has, and signing in comes later, from Settings,
/// only if they want handoff or push.
struct NodePairingView: View {
    @StateObject private var model: NodePairingModel
    @ObservedObject var nodeStore: RelayNodeStore
    /// Always supplied. This screen closes itself the moment pairing succeeds —
    /// see `Step.paired`.
    let onDismiss: () -> Void

    @State private var showingManualEntry = false

    init(
        identityStore: ClientIdentityStore,
        nodeStore: RelayNodeStore,
        accountStore: RelayAccountStore,
        authClient: RelayAuthClient,
        onDismiss: @escaping () -> Void
    ) {
        self.nodeStore = nodeStore
        self.onDismiss = onDismiss
        _model = StateObject(wrappedValue: NodePairingModel(
            identityStore: identityStore,
            nodeStore: nodeStore,
            accountStore: accountStore,
            authClient: authClient,
            deviceName: UIDevice.current.name
        ))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                content
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { onDismiss() }
                }
            }
            // Pairing is done and the credential is installed; comparing the
            // confirmation code happens from the root, where it survives this
            // screen being replaced.
            .onChange(of: model.step) { _, step in
                if case .paired = step { onDismiss() }
            }
        }
        .preferredColorScheme(.dark)
        .accessibilityIdentifier("relay-node-pairing")
    }

    @ViewBuilder
    private var content: some View {
        switch model.step {
        case .entry:
            entryBody
        case .pairing:
            statusBody(
                title: "Pairing",
                detail: "Verifying your machine's certificate and installing this phone's credential…",
                showsProgress: true
            )
        case .paired:
            statusBody(
                title: "Paired",
                detail: "Opening your workspaces…",
                showsProgress: true
            )
        case .failed(let message, let isSecurityEvent):
            failedBody(message: message, isSecurityEvent: isSecurityEvent)
        }
    }

    // MARK: Scan

    private var entryBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Connect your machine")
                        .font(AppTheme.serifFont(size: 31))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("On the computer or server you want to work from, run `relayd pair`. Scan the QR code it prints.")
                        .font(AppTheme.uiFont(size: 16))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 22)
                .padding(.top, 8)

                scanner
                    .padding(.horizontal, 22)

                Text("The code carries your machine's address and the fingerprint of its certificate authority, so this phone can verify the very first connection. Nothing is sent to Relay.")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 22)

                manualEntry
                    .padding(.horizontal, 22)
                    .padding(.bottom, 28)
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder
    private var scanner: some View {
        #if !targetEnvironment(simulator)
        ZStack {
            RelayQRCameraPreview(
                onCode: { code in Task { await model.submitScanned(code) } },
                onDenied: { model.cameraDenied = true }
            )
            .id(model.scanGeneration)
            .frame(maxWidth: .infinity)
            .frame(height: 280)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            if model.cameraDenied {
                cameraUnavailable
            }
        }
        #else
        cameraUnavailable
        #endif
    }

    private var cameraUnavailable: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Camera unavailable")
                .font(AppTheme.uiFont(size: 17, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text("Relay uses the camera to scan the pairing code. You can enter it by hand instead.")
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .font(AppTheme.uiFont(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: Type it instead

    private var manualEntry: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { showingManualEntry.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("Enter it by hand")
                    Image(systemName: showingManualEntry ? "chevron.up" : "chevron.down")
                        .font(AppTheme.uiFont(size: 12, weight: .semibold))
                }
                .font(AppTheme.uiFont(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-pair-manual-toggle")

            if showingManualEntry {
                VStack(alignment: .leading, spacing: 14) {
                    field(
                        title: "Machine address",
                        placeholder: "https://192.168.1.20:8443",
                        text: $model.manualNodeURL,
                        mono: true,
                        keyboard: .URL,
                        identifier: "relay-pair-node-url"
                    )
                    field(
                        title: "Pairing token",
                        placeholder: "the long string under the QR code",
                        text: $model.manualToken,
                        mono: true,
                        keyboard: .asciiCapable,
                        identifier: "relay-pair-token"
                    )
                    field(
                        title: "CA fingerprint",
                        placeholder: "sha256 of the CA public key",
                        text: $model.manualFingerprint,
                        mono: true,
                        keyboard: .asciiCapable,
                        identifier: "relay-pair-fingerprint"
                    )

                    Text("`relayd pair` prints all three. The token is the credential — not the short code, which is only for comparing afterwards. Relay needs the fingerprint too, because a typed token carries no way to check your machine's certificate, and an app that offers to trust an unknown certificate on a tap is an app that trusts anything.")
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)

                    if let problem = model.manualEntryProblem, !model.manualToken.isEmpty {
                        Text(problem.message)
                            .font(AppTheme.uiFont(size: 12))
                            .foregroundStyle(AppTheme.statusWarn)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("relay-pair-manual-problem")
                    }

                    Button("Pair machine") {
                        Task { await model.submitManualEntry() }
                    }
                    .buttonStyle(RelayPrimaryButtonStyle(isEnabled: model.isManualEntryComplete))
                    .disabled(!model.isManualEntryComplete)
                    .accessibilityIdentifier("relay-pair-manual-submit")
                }
            }
        }
    }

    private func field(
        title: String,
        placeholder: String,
        text: Binding<String>,
        mono: Bool,
        keyboard: UIKeyboardType,
        autocapitalizes: Bool = false,
        identifier: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(AppTheme.uiFont(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
            TextField(placeholder, text: text)
                .font(mono ? AppTheme.monoFont(size: 15) : AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textPrimary)
                .textInputAutocapitalization(autocapitalizes ? .characters : .never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .padding(12)
                .background(AppTheme.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityIdentifier(identifier)
        }
    }

    // MARK: Outcomes

    private func statusBody(title: String, detail: String, showsProgress: Bool) -> some View {
        VStack(spacing: 14) {
            Spacer()
            if showsProgress {
                ProgressView().tint(AppTheme.accent)
            }
            Text(title)
                .font(AppTheme.serifFont(size: 28))
                .foregroundStyle(AppTheme.textPrimary)
            Text(detail)
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity)
    }

    private func failedBody(message: String, isSecurityEvent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer()
            Image(systemName: isSecurityEvent ? "exclamationmark.shield" : "exclamationmark.triangle")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(isSecurityEvent ? AppTheme.statusError : AppTheme.statusWarn)
            Text(isSecurityEvent ? "Pairing stopped" : "Couldn't pair")
                .font(AppTheme.serifFont(size: 28))
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            // A security failure gets no one-tap retry: retrying against the
            // same attacker is exactly the wrong reflex, and the code is spent
            // either way.
            Button(isSecurityEvent ? "Start over" : "Try again") { model.retry() }
                .buttonStyle(isSecurityEvent
                    ? AnyButtonStyleBox(RelayOutlineButtonStyle())
                    : AnyButtonStyleBox(RelayPrimaryButtonStyle(isEnabled: true)))
                .accessibilityIdentifier("relay-pair-retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(28)
        .accessibilityIdentifier("relay-pair-failed")
    }
}

/// Type-erases the two button styles so one `Button` can carry either without
/// the branches disagreeing about their opaque result types.
struct AnyButtonStyleBox: ButtonStyle {
    private let make: (Configuration) -> AnyView

    init<S: ButtonStyle>(_ style: S) {
        make = { configuration in AnyView(style.makeBody(configuration: configuration)) }
    }

    func makeBody(configuration: Configuration) -> some View {
        make(configuration)
    }
}

/// Compare the code on the phone with the code in the terminal.
///
/// This is a **confirmation, not an approval**. The exchange has already
/// completed and the credential is already installed by the time this appears —
/// it has to be, because the code is delivered inside the pairing response, and
/// the response is what proves the machine holds the pairing token. What the
/// comparison catches is the case the cryptography cannot speak to: that the
/// machine which answered is the one the user is actually sitting in front of.
/// The copy says so rather than implying a gate that is not there.
///
/// The QR deliberately does not carry this code. Comparing a value the phone
/// just read off the same QR would prove nothing at all.
struct NodeVerificationView: View {
    @ObservedObject var nodeStore: RelayNodeStore
    let code: String
    let onUnpair: () -> Void

    @State private var showingMismatch = false

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                if showingMismatch {
                    mismatchBody
                } else {
                    compareBody
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled()
        .accessibilityIdentifier("relay-node-verification")
    }

    private var compareBody: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("Check the code")
                .font(AppTheme.serifFont(size: 30))
                .foregroundStyle(AppTheme.textPrimary)

            Text(code)
                .font(AppTheme.monoFont(size: 40, weight: .medium))
                .tracking(4)
                .foregroundStyle(AppTheme.accent)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity)
                .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(AppTheme.hairlineStrong, lineWidth: 1)
                }
                .accessibilityLabel("Confirmation code \(code.map(String.init).joined(separator: " "))")
                .accessibilityIdentifier("relay-verification-code")

            Text("Confirm this matches the code shown in your terminal.")
                .font(AppTheme.uiFont(size: 16))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            Text("Your machine is already connected — this is a check, not a gate. It catches the one thing the pairing itself cannot: that the machine which answered is the one in front of you.")
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textTertiary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)

            Spacer()

            VStack(spacing: 12) {
                Button("It matches") { nodeStore.confirmVerification() }
                    .buttonStyle(RelayPrimaryButtonStyle(isEnabled: true))
                    .accessibilityIdentifier("relay-verification-confirm")

                Button("It doesn't match") {
                    withAnimation(.easeInOut(duration: 0.18)) { showingMismatch = true }
                }
                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.statusError)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("relay-verification-mismatch")
            }
        }
        .padding(28)
    }

    private var mismatchBody: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Image(systemName: "exclamationmark.shield")
                .font(.system(size: 32, weight: .medium))
                .foregroundStyle(AppTheme.statusError)
            Text("Unpair and revoke")
                .font(AppTheme.serifFont(size: 28))
                .foregroundStyle(AppTheme.textPrimary)
            Text("Something else answered the pairing request. This phone already holds a credential it issued, so removing it here is only half the job — revoke it on your machine as well.")
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                Text("On your machine")
                    .font(AppTheme.uiFont(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                Text(revokeCommand)
                    .font(AppTheme.monoFont(size: 13))
                    .foregroundStyle(AppTheme.textPrimary)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(AppTheme.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            Spacer()
            Button("Unpair this phone", role: .destructive) { onUnpair() }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: true))
                .accessibilityIdentifier("relay-verification-unpair")
            Button("Back") {
                withAnimation(.easeInOut(duration: 0.18)) { showingMismatch = false }
            }
            .font(AppTheme.uiFont(size: 15))
            .foregroundStyle(AppTheme.textSecondary)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(28)
    }

    /// The exact command, with this phone's device id filled in when the
    /// machine sent one — advice the user has to go and look something up for
    /// is advice they will skip.
    private var revokeCommand: String {
        guard let deviceID = nodeStore.pairedNode?.deviceID?.trimmedNonEmpty else {
            return "relayd devices list\nrelayd devices revoke <device-id>"
        }
        return "relayd devices revoke \(deviceID)"
    }
}
