import SwiftUI

struct DiagnosticsView: View {
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient
    var showsNavigationChrome = true

    @Environment(\.dismiss) private var dismiss
    @State private var passphrase = ""
    @State private var checks: [DiagnosticCheck] = []
    @State private var importError: String?
    @State private var isImportExpanded = false

    private let contentHorizontalPadding: CGFloat = AppTheme.screenHorizontalPadding
    private let cardCornerRadius: CGFloat = AppTheme.cardRadius

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(screenTitle)
                                .font(AppTheme.screenTitleFont)
                                .foregroundStyle(AppTheme.textPrimary)
                            Text(AppConfiguration.runtimeMode)
                                .font(AppTheme.bodyFont)
                                .foregroundStyle(AppTheme.textSecondary)
                        }
                        .padding(.top, AppTheme.screenTopPadding)

                        certificatePanel

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Checks")
                                .font(AppTheme.cardTitleFont)
                                .foregroundStyle(AppTheme.textPrimary)
                            ForEach(checks) { check in
                                DiagnosticRow(check: check)
                            }
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .diagnosticCard(cornerRadius: cardCornerRadius)
                    }
                    .padding(.horizontal, contentHorizontalPadding)
                    .padding(.bottom, showsNavigationChrome ? 28 : AppTheme.tabBarClearance)
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsNavigationChrome {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") {
                            dismiss()
                        }
                    }

                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            refreshChecks()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .accessibilityLabel("Refresh diagnostics")
                    }
                }
            }
            .toolbar(showsNavigationChrome ? .visible : .hidden, for: .navigationBar)
            .refreshable {
                refreshChecks()
            }
            .onAppear(perform: refreshAndImportFromSetupEnvironmentIfNeeded)
        }
    }

    private func refreshAndImportFromSetupEnvironmentIfNeeded() {
        refreshChecks()
        let setupPassphrase = ClientIdentityStore.resolvedImportPassphrase(explicitPassphrase: "")
        guard
            !setupPassphrase.isEmpty,
            !identityStore.hasStoredIdentity,
            FileManager.default.fileExists(atPath: identityStore.expectedSupportP12URL.path)
        else {
            return
        }
        importDefaultCertificate()
    }

    private func importDefaultCertificate() {
        do {
            let resolvedPassphrase = ClientIdentityStore.resolvedImportPassphrase(explicitPassphrase: passphrase)
            _ = try identityStore.importIdentityFromSupport(passphrase: resolvedPassphrase)
            importError = nil
            passphrase = ""
        } catch {
            importError = error.localizedDescription
        }
        refreshChecks()
    }

    private func refreshChecks() {
        let supportExists = identityStore.ensureSupportDirectoryExists()
        let candidates = identityStore.supportP12Candidates()
        let supportConfigExists = FileManager.default.fileExists(atPath: identityStore.supportConfigURL.path)
        let manifestURLIsReachableRuntime = manifestClient.manifestURL.scheme == "https" || isSimulatorPreview

        checks = [
            DiagnosticCheck(
                title: "Runtime",
                detail: AppConfiguration.runtimeMode,
                isPassing: true
            ),
            DiagnosticCheck(
                title: "Support directory",
                detail: isSimulatorPreview
                    ? "Not required for simulator preview."
                    : supportExists ? "Documents/support exists." : "Could not create Documents/support.",
                isPassing: isSimulatorPreview || supportExists
            ),
            DiagnosticCheck(
                title: "Support config",
                detail: isSimulatorPreview
                    ? "Not required for simulator preview."
                    : supportConfigExists ? "vault-config.json found." : "Using Xcode build setting endpoint.",
                isPassing: true
            ),
            DiagnosticCheck(
                title: "P12 file available",
                detail: isSimulatorPreview
                    ? "Not required for simulator preview."
                    : candidates.isEmpty ? "Expected \(identityStore.expectedSupportP12URL.lastPathComponent)." : "\(candidates.count) .p12 file(s) found.",
                isPassing: isSimulatorPreview || !candidates.isEmpty
            ),
            DiagnosticCheck(
                title: "Keychain identity",
                detail: isSimulatorPreview
                    ? "Device builds use the installed client certificate."
                    : identityStore.hasStoredIdentity ? "Client certificate is available for mTLS." : "Import client.p12 to enable mTLS.",
                isPassing: isSimulatorPreview || identityStore.hasStoredIdentity
            ),
            DiagnosticCheck(
                title: "Manifest URL",
                detail: manifestClient.manifestURL.absoluteString,
                isPassing: manifestURLIsReachableRuntime
            ),
            DiagnosticCheck(
                title: "Signature public key",
                detail: manifestClient.hasTrustedPublicKey ? "Ed25519 public key configured." : "No trusted key configured.",
                isPassing: manifestClient.hasTrustedPublicKey
            )
        ]
    }

    @ViewBuilder
    private var certificatePanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            if isSimulatorPreview {
                certificateHeader(
                    title: "Simulator Preview",
                    detail: "Local signed vault at 127.0.0.1",
                    symbol: "macwindow",
                    isPassing: true
                )
            } else {
                certificateHeader(
                    title: "Client certificate",
                    detail: identityStore.hasStoredIdentity ? "Installed for mTLS" : "Import required",
                    symbol: "key.fill",
                    isPassing: identityStore.hasStoredIdentity
                )

                VStack(alignment: .leading, spacing: 6) {
                    Text("Expected file")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.textTertiary)
                    Text("Documents/support/client.p12")
                        .font(.footnote.monospaced())
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }

                if identityStore.hasStoredIdentity {
                    DisclosureGroup(isExpanded: $isImportExpanded) {
                        importCertificateForm
                            .padding(.top, 10)
                    } label: {
                        Text("Reimport certificate")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                    .tint(AppTheme.textSecondary)
                } else {
                    importCertificateForm
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .diagnosticCard(cornerRadius: cardCornerRadius)
    }

    private func certificateHeader(title: String, detail: String, symbol: String, isPassing: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(isPassing ? AppTheme.statusOK : AppTheme.statusWarn)
                .frame(width: 34, height: 34)
                .background((isPassing ? AppTheme.statusOK : AppTheme.statusWarn).opacity(0.16), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(AppTheme.cardTitleFont)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(detail)
                    .font(AppTheme.bodyFont)
                    .foregroundStyle(AppTheme.textSecondary)
            }

            Spacer(minLength: 0)
        }
    }

    private var importCertificateForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            SecureField(
                "",
                text: $passphrase,
                prompt: Text("P12 passphrase").foregroundColor(AppTheme.textTertiary)
            )
            .textContentType(.password)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(AppTheme.textPrimary)
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: AppTheme.controlRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: AppTheme.controlRadius, style: .continuous)
                    .stroke(AppTheme.strokeSubtle, lineWidth: 1)
            }

            Button {
                importDefaultCertificate()
            } label: {
                Label("Import certificate", systemImage: "square.and.arrow.down")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .frame(height: 42)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.black.opacity(0.82))
            .background(AppTheme.accent, in: RoundedRectangle(cornerRadius: AppTheme.controlRadius, style: .continuous))

            if let importError {
                Text(importError)
                    .font(.footnote)
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var isSimulatorPreview: Bool {
        AppConfiguration.runtimeMode == "Simulator Preview"
    }

    private var screenTitle: String {
        showsNavigationChrome ? "Diagnostics" : "Health"
    }
}

private struct DiagnosticCheck: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let isPassing: Bool
}

private struct DiagnosticRow: View {
    let check: DiagnosticCheck

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: check.isPassing ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(check.isPassing ? AppTheme.statusOK : AppTheme.statusError)
                .frame(width: 24, height: 24, alignment: .top)
            VStack(alignment: .leading, spacing: 3) {
                Text(check.title)
                    .font(AppTheme.cardTitleFont)
                    .foregroundStyle(AppTheme.textPrimary)
                Text(check.detail)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }
}

private struct DiagnosticCardModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(AppTheme.strokeSubtle, lineWidth: 1)
            }
    }
}

private extension View {
    func diagnosticCard(cornerRadius: CGFloat) -> some View {
        modifier(DiagnosticCardModifier(cornerRadius: cornerRadius))
    }
}
