import SafariServices
import SwiftUI
import WebKit

/// Direct provider sign-in from this iPhone, with no laptop in the loop.
/// Presented as a sheet wherever a machine's coding agent needs connecting
/// (Account & Settings → Coding agents, and the composer's readiness notice).
///
/// Two completion shapes, both driven by `ProviderLoginFlowModel`:
/// - Codex: the sign-in page redirects to the CLI's localhost login server.
///   Nothing listens on this phone, so an in-app browser captures that
///   redirect and Relay replays it on the machine, where the server runs.
/// - Paste-back (Claude Code and the rest): the provider's page shows a code
///   after sign-in; the user pastes it here and Relay types it into the CLI.
struct ProviderLoginView: View {
    @StateObject private var flow: ProviderLoginFlowModel
    @Environment(\.dismiss) private var dismiss

    @State private var safariTarget: ProviderLoginBrowserTarget?
    @State private var callbackBrowserTarget: ProviderLoginBrowserTarget?
    @State private var didCopyCode = false

    init(client: CodexClient, provider: CodexProvider) {
        _flow = StateObject(wrappedValue: ProviderLoginFlowModel(client: client, provider: provider))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                content
                    .padding(.horizontal, 26)
            }
            .navigationTitle("Connect \(flow.provider.displayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(doneButtonTitle) {
                        finish()
                    }
                    .accessibilityIdentifier("relay-provider-login-close")
                }
            }
        }
        .task { await flow.start() }
        .onChange(of: flow.step) { _, newStep in
            // The machine confirmed while the browser was up — bring the
            // native success state forward.
            if newStep == .succeeded || !isWorking(newStep) {
                callbackBrowserTarget = nil
            }
        }
        .sheet(item: $safariTarget) { target in
            ProviderLoginSafariView(url: target.url)
                .ignoresSafeArea()
        }
        .fullScreenCover(item: $callbackBrowserTarget) { target in
            ProviderLoginCallbackBrowser(
                url: target.url,
                title: "\(flow.provider.displayName) sign-in",
                onLocalCallback: { url in
                    callbackBrowserTarget = nil
                    Task { await flow.deliverBrowserCallback(url) }
                },
                onCancel: { callbackBrowserTarget = nil }
            )
        }
        .interactiveDismissDisabled(flow.step == .completing)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        switch flow.step {
        case .idle, .starting:
            statusColumn(
                symbol: "bolt.horizontal.circle",
                title: "Starting sign-in on your machine",
                detail: "Relay is launching \(flow.provider.displayName)'s own sign-in there. Nothing is stored on this iPhone."
            )
        case .waitingForSignIn(let op):
            signInColumn(op: op)
        case .completing:
            statusColumn(
                symbol: "bolt.horizontal.circle",
                title: "Finishing sign-in",
                detail: "Your machine is completing the \(flow.provider.displayName) sign-in."
            )
        case .succeeded:
            successColumn
        case .failed(let message):
            failureColumn(message: message)
        }
    }

    private func signInColumn(op: RelayHarnessOp) -> some View {
        VStack(spacing: 22) {
            Spacer()

            RelayProviderMark(provider: flow.provider, size: 40)

            VStack(spacing: 10) {
                Text("Sign in to \(flow.provider.displayName)")
                    .font(AppTheme.serifFont(size: 26))
                    .foregroundStyle(AppTheme.textPrimary)
                    .multilineTextAlignment(.center)
                Text(signInDetail(op: op))
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textTertiary)
                    .multilineTextAlignment(.center)
            }

            if let code = op.userCode {
                Button {
                    UIPasteboard.general.string = code
                    didCopyCode = true
                } label: {
                    VStack(spacing: 6) {
                        Text(code)
                            .font(.system(size: 28, weight: .semibold, design: .monospaced))
                            .foregroundStyle(AppTheme.textPrimary)
                        Text(didCopyCode ? "Copied" : "Tap to copy, then enter it on the sign-in page")
                            .font(AppTheme.uiFont(size: 11))
                            .foregroundStyle(AppTheme.textTertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background {
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(AppTheme.hairlineStrong, lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-provider-login-code")
            }

            if op.verificationURL == nil {
                HStack(spacing: 10) {
                    ProgressView().tint(AppTheme.accent)
                    Text("Waiting for the sign-in link from your machine…")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            } else {
                Button("Open sign-in page") {
                    openSignInPage(op: op)
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-provider-login-open")
            }

            if !flow.usesLocalCallback {
                VStack(spacing: 10) {
                    TextField("Paste the code from the sign-in page", text: $flow.pastedCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(size: 15, design: .monospaced))
                        .padding(12)
                        .background {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(AppTheme.hairlineStrong, lineWidth: 1)
                        }
                        .accessibilityIdentifier("relay-provider-login-paste")

                    Button("Complete sign-in") {
                        Task { await flow.submitPastedCode() }
                    }
                    .buttonStyle(RelayOutlineButtonStyle())
                    .disabled(flow.pastedCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("relay-provider-login-complete")
                }
            }

            Spacer()
        }
    }

    private var successColumn: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(AppTheme.accentGradient)
            Text("\(flow.provider.displayName) is connected")
                .font(AppTheme.serifFont(size: 26))
                .foregroundStyle(AppTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text("The session lives on your machine. You can start working from this iPhone right away.")
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textTertiary)
                .multilineTextAlignment(.center)
            Button("Done") { finish() }
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-provider-login-done")
            Spacer()
        }
    }

    private func failureColumn(message: String) -> some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(AppTheme.statusError)
            Text(message)
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("relay-provider-login-error")
            Button("Try again") {
                Task { await flow.start() }
            }
            .buttonStyle(RelayPrimaryButtonStyle())
            Button("Not now") { finish() }
                .buttonStyle(RelayOutlineButtonStyle())
            Spacer()
        }
    }

    private func statusColumn(symbol: String, title: String, detail: String) -> some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: symbol)
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(AppTheme.accentGradient)
            Text(title)
                .font(AppTheme.serifFont(size: 26))
                .foregroundStyle(AppTheme.textPrimary)
                .multilineTextAlignment(.center)
            Text(detail)
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textTertiary)
                .multilineTextAlignment(.center)
            ProgressView().tint(AppTheme.accent)
            Spacer()
        }
    }

    private func signInDetail(op: RelayHarnessOp) -> String {
        if flow.usesLocalCallback {
            return "Sign in with your own \(flow.provider.displayName) account. When the page finishes, Relay hands the result to your machine automatically."
        }
        if op.userCode != nil {
            return "Open the sign-in page and enter the code below. Your machine confirms as soon as the provider approves it."
        }
        return "Sign in with your own \(flow.provider.displayName) account, then paste the code the page shows you below."
    }

    private var doneButtonTitle: String {
        flow.step == .succeeded ? "Done" : "Cancel"
    }

    private func openSignInPage(op: RelayHarnessOp) {
        guard let url = op.verificationURL else { return }
        didCopyCode = false
        if flow.usesLocalCallback {
            callbackBrowserTarget = ProviderLoginBrowserTarget(url: url)
        } else {
            safariTarget = ProviderLoginBrowserTarget(url: url)
        }
    }

    private func finish() {
        switch flow.step {
        case .starting, .waitingForSignIn:
            // Leaving mid-flow frees the machine's login slot immediately
            // instead of letting the abandoned CLI wait out its timeout.
            Task { await flow.cancel() }
        case .idle, .completing, .succeeded, .failed:
            break
        }
        dismiss()
    }

    private func isWorking(_ step: ProviderLoginFlowModel.Step) -> Bool {
        switch step {
        case .starting, .waitingForSignIn, .completing:
            return true
        case .idle, .succeeded, .failed:
            return false
        }
    }
}

private struct ProviderLoginBrowserTarget: Identifiable {
    let id = UUID()
    let url: URL
}

/// Real-Safari context for paste-back sign-ins (provider SSO pages reject
/// bare web views; SFSafariViewController is a first-class browser).
private struct ProviderLoginSafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// In-app browser for the Codex-style flow. It exists for exactly one
/// capability Safari cannot offer: intercepting the provider's redirect to
/// its localhost login server (nothing listens on the phone) and handing that
/// URL — which carries the OAuth authorization code — back to be replayed on
/// the machine.
private struct ProviderLoginCallbackBrowser: View {
    let url: URL
    let title: String
    let onLocalCallback: (URL) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            ProviderLoginWebView(url: url, onLocalCallback: onLocalCallback)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onCancel)
                    }
                }
        }
        .preferredColorScheme(.dark)
    }
}

private struct ProviderLoginWebView: UIViewRepresentable {
    let url: URL
    let onLocalCallback: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onLocalCallback: onLocalCallback)
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onLocalCallback: (URL) -> Void
        private var didCapture = false

        init(onLocalCallback: @escaping (URL) -> Void) {
            self.onLocalCallback = onLocalCallback
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if let url = navigationAction.request.url,
               ProviderLoginFlowModel.isLocalLoginCallback(url),
               !didCapture {
                didCapture = true
                decisionHandler(.cancel)
                onLocalCallback(url)
                return
            }
            decisionHandler(.allow)
        }
    }
}
