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

    @Environment(\.relayTheme) private var theme
    @State private var showingManualEntry = false
    @State private var pasteNotice: String?

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
                theme.surface0.ignoresSafeArea()
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
                if step != .entry { pasteNotice = nil }
                if case .paired = step { onDismiss() }
            }
        }
        .tint(theme.accentBright)
        .preferredColorScheme(theme.colorScheme)
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
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("Connect your machine")
                            .font(RelayTheme.uiFont(31, weight: .semibold))
                            .foregroundStyle(theme.foreground)
                        RelayInfoButton(
                            title: "Pairing",
                            message: "The code carries your machine's address and the fingerprint of its certificate authority, so this phone can verify the very first connection. Nothing is sent to Relay."
                        )
                    }
                    Text("On the computer or server you want to work from, run `relayd pair`. Scan the QR code it prints.")
                        .font(RelayTheme.uiFont(16))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 22)
                .padding(.top, 8)

                scanner
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
                .font(RelayTheme.uiFont(17, weight: .semibold))
                .foregroundStyle(theme.foreground)
            Text("Relay uses the camera to scan the pairing code. You can paste the pairing link or enter it by hand instead.")
                .font(RelayTheme.uiFont(14))
                .foregroundStyle(theme.foregroundMuted)
            if let url = URL(string: UIApplication.openSettingsURLString) {
                Link("Open Settings", destination: url)
                    .font(RelayTheme.uiFont(15, weight: .semibold))
                    .foregroundStyle(theme.accentBright)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
    }

    // MARK: Paste or type it instead

    private var manualEntry: some View {
        VStack(alignment: .leading, spacing: 14) {
            RelayButton(
                "Paste pairing link",
                variant: .outline,
                systemImage: "doc.on.clipboard",
                isFullWidth: true
            ) {
                if let pasted = UIPasteboard.general.string?.trimmedNonEmpty {
                    pasteNotice = nil
                    Task { await model.submitScanned(pasted) }
                } else {
                    pasteNotice = "Clipboard is empty — copy the link printed by `relayd pair`, or scan the QR code."
                }
            }
            .accessibilityIdentifier("relay-pair-paste-link")

            if let pasteNotice {
                Text(pasteNotice)
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.statusWarning)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                withAnimation(.easeInOut(duration: 0.18)) { showingManualEntry.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("Enter it by hand")
                    Image(systemName: showingManualEntry ? "chevron.up" : "chevron.down")
                        .font(RelayTheme.uiFont(12, weight: .semibold))
                }
                .font(RelayTheme.uiFont(14, weight: .semibold))
                .foregroundStyle(theme.foregroundMuted)
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
                        .font(RelayTheme.uiFont(12))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)

                    if let problem = model.manualEntryProblem, !model.manualToken.isEmpty {
                        Text(problem.message)
                            .font(RelayTheme.uiFont(12))
                            .foregroundStyle(theme.statusWarning)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("relay-pair-manual-problem")
                    }

                    RelayButton(
                        "Pair machine",
                        variant: .primary,
                        isFullWidth: true,
                        isDisabled: !model.isManualEntryComplete
                    ) {
                        Task { await model.submitManualEntry() }
                    }
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
                .font(RelayTheme.uiFont(13, weight: .semibold))
                .foregroundStyle(theme.foregroundMuted)
            TextField(placeholder, text: text)
                .font(mono ? RelayTheme.monoFont(15) : RelayTheme.uiFont(15))
                .foregroundStyle(theme.foreground)
                .textInputAutocapitalization(autocapitalizes ? .characters : .never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .padding(12)
                .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                }
                .accessibilityIdentifier(identifier)
        }
    }

    // MARK: Outcomes

    private func statusBody(title: String, detail: String, showsProgress: Bool) -> some View {
        VStack(spacing: 14) {
            Spacer()
            if showsProgress {
                ProgressView().tint(theme.accentBright)
            }
            Text(title)
                .font(RelayTheme.uiFont(28, weight: .semibold))
                .foregroundStyle(theme.foreground)
            Text(detail)
                .font(RelayTheme.uiFont(15))
                .foregroundStyle(theme.foregroundMuted)
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
                .foregroundStyle(isSecurityEvent ? theme.statusDanger : theme.statusWarning)
            Text(isSecurityEvent ? "Pairing stopped" : "Couldn't pair")
                .font(RelayTheme.uiFont(28, weight: .semibold))
                .foregroundStyle(theme.foreground)
            Text(message)
                .font(RelayTheme.uiFont(15))
                .foregroundStyle(theme.foregroundMuted)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            // A security failure gets no one-tap retry: retrying against the
            // same attacker is exactly the wrong reflex, and the code is spent
            // either way.
            RelayButton(
                isSecurityEvent ? "Start over" : "Try again",
                variant: isSecurityEvent ? .outline : .primary,
                isFullWidth: true
            ) {
                pasteNotice = nil
                model.retry()
            }
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

    @Environment(\.relayTheme) private var theme
    @State private var showingMismatch = false

    var body: some View {
        NavigationStack {
            ZStack {
                theme.surface0.ignoresSafeArea()
                if showingMismatch {
                    mismatchBody
                } else {
                    compareBody
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(theme.accentBright)
        .preferredColorScheme(theme.colorScheme)
        .interactiveDismissDisabled()
        .accessibilityIdentifier("relay-node-verification")
    }

    private var compareBody: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("Check the code")
                .font(RelayTheme.uiFont(30, weight: .semibold))
                .foregroundStyle(theme.foreground)

            Text(code)
                .font(RelayTheme.monoFont(40, weight: .medium))
                .tracking(4)
                .foregroundStyle(theme.accentBright)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity)
                .background(theme.surface1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(theme.borderAccent, lineWidth: 1)
                }
                .accessibilityLabel("Confirmation code \(code.map(String.init).joined(separator: " "))")
                .accessibilityIdentifier("relay-verification-code")

            Text("Confirm this matches the code shown in your terminal.")
                .font(RelayTheme.uiFont(16))
                .foregroundStyle(theme.foregroundMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            Text("Your machine is already connected — this is a check, not a gate. It catches the one thing the pairing itself cannot: that the machine which answered is the one in front of you.")
                .font(RelayTheme.uiFont(12))
                .foregroundStyle(theme.foregroundExtraMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)

            Spacer()

            VStack(spacing: 12) {
                RelayButton("It matches", variant: .primary, isFullWidth: true) {
                    nodeStore.confirmVerification()
                }
                .accessibilityIdentifier("relay-verification-confirm")

                Button("It doesn't match") {
                    withAnimation(.easeInOut(duration: 0.18)) { showingMismatch = true }
                }
                .font(RelayTheme.uiFont(15, weight: .semibold))
                .foregroundStyle(theme.statusDanger)
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
                .foregroundStyle(theme.statusDanger)
            Text("Unpair and revoke")
                .font(RelayTheme.uiFont(28, weight: .semibold))
                .foregroundStyle(theme.foreground)
            Text("Something else answered the pairing request. This phone already holds a credential it issued, so removing it here is only half the job — revoke it on your machine as well.")
                .font(RelayTheme.uiFont(15))
                .foregroundStyle(theme.foregroundMuted)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                Text("On your machine")
                    .font(RelayTheme.uiFont(12, weight: .semibold))
                    .foregroundStyle(theme.foregroundExtraMuted)
                Text(revokeCommand)
                    .font(RelayTheme.monoFont(13))
                    .foregroundStyle(theme.foreground)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
            }

            Spacer()
            RelayButton("Unpair this phone", variant: .destructive, isFullWidth: true) {
                onUnpair()
            }
            .accessibilityIdentifier("relay-verification-unpair")
            Button("Back") {
                withAnimation(.easeInOut(duration: 0.18)) { showingMismatch = false }
            }
            .font(RelayTheme.uiFont(15))
            .foregroundStyle(theme.foregroundMuted)
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
