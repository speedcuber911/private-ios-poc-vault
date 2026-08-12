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

    private var contentHorizontalPadding: CGFloat {
        showsNavigationChrome ? 16 : 16
    }
    private let cardCornerRadius: CGFloat = 16

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()
                VStack(spacing: 0) {
                    if showsNavigationChrome {
                        diagnosticsNavBar
                            .padding(.horizontal, 16)
                            .padding(.top, 10)
                            .padding(.bottom, 18)
                    }

                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !showsNavigationChrome {
                                EmptyView()
                            }

                        VStack(alignment: .leading, spacing: 6) {
                            Text(screenTitle)
                                .font(titleFont)
                                .foregroundStyle(AppTheme.textPrimary)
                            RelayCapsLabel(text: AppConfiguration.runtimeMode)
                        }
                        .padding(.top, showsNavigationChrome ? 18 : 0)

                        certificatePanel

                        VStack(alignment: .leading, spacing: 0) {
                            RelayCapsLabel(text: "Checks", size: 11)
                                .padding(.bottom, 8)
                            ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                                DiagnosticRow(check: check)
                                if index < checks.count - 1 {
                                    Rectangle()
                                        .fill(AppTheme.hairline)
                                        .frame(height: 0.5)
                                        .padding(.leading, 46)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .diagnosticCard(cornerRadius: cardCornerRadius)
                    }
                    .padding(.horizontal, contentHorizontalPadding)
                    .padding(.bottom, showsNavigationChrome ? 28 : 110)
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                refreshChecks()
            }
            .onAppear(perform: refreshAndImportFromSetupEnvironmentIfNeeded)
        }
        // Presented as a sheet/cover of its own: re-pin the deliberate dark-only
        // appearance so the surface can never flash light.
        .preferredColorScheme(.dark)
    }

    private var diagnosticsNavBar: some View {
        ZStack {
            HStack {
                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .frame(height: 32)
                        .background(AppTheme.textPrimary.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    refreshChecks()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 32, height: 32)
                        .background(AppTheme.textPrimary.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh diagnostics")
            }

            Text("Diagnostics")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
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
                    detail: "Local signed manifest at 127.0.0.1",
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
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 32, height: 32)
                .background(AppTheme.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(detail)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }

            Spacer(minLength: 0)
        }
    }

    private var importCertificateForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 10) {
                SecureField(
                    "",
                    text: $passphrase,
                    prompt: Text("P12 passphrase").foregroundColor(AppTheme.textTertiary)
                )
                .textContentType(.password)
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textPrimary)
                Rectangle()
                    .fill(AppTheme.hairlineStrong)
                    .frame(height: 1)
            }

            Button {
                importDefaultCertificate()
            } label: {
                Label("Import certificate", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(RelayPrimaryButtonStyle())

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

    private var titleFont: Font {
        showsNavigationChrome
            ? AppTheme.serifFont(size: 28)
            : AppTheme.serifFont(size: 20)
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
            RelayCapsLabel(
                text: check.isPassing ? "OK" : "Fail",
                color: check.isPassing ? AppTheme.textSecondary : AppTheme.statusError,
                size: 9
            )
            .frame(width: 34, alignment: .leading)
            .padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(check.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(check.detail)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
    }
}

private struct DiagnosticCardModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(AppTheme.hairline, lineWidth: 1)
            }
    }
}

private extension View {
    func diagnosticCard(cornerRadius: CGFloat) -> some View {
        modifier(DiagnosticCardModifier(cornerRadius: cornerRadius))
    }
}
