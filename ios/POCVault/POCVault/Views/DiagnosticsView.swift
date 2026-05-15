import SwiftUI

struct DiagnosticsView: View {
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient

    @Environment(\.dismiss) private var dismiss
    @State private var passphrase = ""
    @State private var checks: [DiagnosticCheck] = []
    @State private var importError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                VaultTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Diagnostics")
                                .font(.system(size: 34, weight: .bold, design: .rounded))
                            Text(AppConfiguration.runtimeMode)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 18)

                        certificatePanel

                        VStack(alignment: .leading, spacing: 12) {
                            Text("Checks")
                                .font(.headline)
                            ForEach(checks) { check in
                                DiagnosticRow(check: check)
                            }
                        }
                        .padding(18)
                        .background(.white.opacity(0.88), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 28)
                }
            }
            .navigationTitle("Diagnostics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
            .onAppear(perform: refreshChecks)
        }
    }

    private func importDefaultCertificate() {
        do {
            _ = try identityStore.importIdentityFromSupport(passphrase: passphrase)
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
            Label(isSimulatorPreview ? "Simulator Preview" : "Client Certificate", systemImage: isSimulatorPreview ? "macwindow" : "key")
                .font(.headline)

            if isSimulatorPreview {
                Text("The simulator uses a local signed vault at 127.0.0.1. Physical iPhone builds still use the installed client certificate.")
                    .font(.subheadline)
                    .foregroundStyle(VaultTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Expected file")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Documents/support/client.p12")
                    .font(.callout.monospaced())
                    .foregroundStyle(VaultTheme.ink)

                SecureField("P12 passphrase", text: $passphrase)
                    .textContentType(.password)
                    .textFieldStyle(.roundedBorder)

                Button {
                    importDefaultCertificate()
                } label: {
                    Label("Import Certificate", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                if let importError {
                    Text(importError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(18)
        .background(.white.opacity(0.88), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var isSimulatorPreview: Bool {
        AppConfiguration.runtimeMode == "Simulator Preview"
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
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(check.isPassing ? .green : .red)
            VStack(alignment: .leading, spacing: 3) {
                Text(check.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(VaultTheme.ink)
                Text(check.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .truncationMode(.middle)
            }
        }
    }
}
