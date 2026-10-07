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
/// - Paste-back (Claude Code and the rest): the sign-in page opens by itself
///   in a real Safari view (Google sign-in and saved passwords work there,
///   which an embedded web view breaks); the provider's page shows a code
///   after sign-in, and one tap on the system Paste control hands it to the
///   CLI on the machine. Typing it in stays available as a fallback.
struct ProviderLoginView: View {
    @StateObject private var flow: ProviderLoginFlowModel
    @Environment(\.dismiss) private var dismiss

    @State private var safariTarget: ProviderLoginBrowserTarget?
    @State private var callbackBrowserTarget: ProviderLoginBrowserTarget?
    @State private var didCopyCode = false
    @State private var showsNoLinkHint = false
    @State private var showsManualEntry = false
    /// The sign-in page opened by itself once for this link; reopening is
    /// the user's call after that.
    @State private var autoOpenedURL: URL?

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
                safariTarget = nil
            }
            openSignInPageOnceIfReady(newStep)
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
                VStack(spacing: 12) {
                    HStack(spacing: 10) {
                        ProgressView().tint(AppTheme.accent)
                        Text(flow.progressDetail ?? "Waiting for the sign-in link from your machine…")
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textSecondary)
                    }

                    if let tail = flow.terminalTail {
                        // The machine's own words beat any guess: whatever the
                        // login command printed instead of a link is the
                        // diagnosis, so put it on the sheet.
                        VStack(alignment: .leading, spacing: 4) {
                            Text("From your machine:")
                                .font(AppTheme.uiFont(size: 10, weight: .semibold))
                                .foregroundStyle(AppTheme.textTertiary)
                            Text(tail)
                                .font(AppTheme.monoFont(size: 11))
                                .foregroundStyle(AppTheme.textSecondary)
                                .lineLimit(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(10)
                        .background {
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(AppTheme.hairlineStrong, lineWidth: 1)
                        }
                        .accessibilityIdentifier("relay-provider-login-terminal-tail")
                    } else if showsNoLinkHint, flow.isUsingTerminalEngine {
                        Text("The machine's terminal hasn't produced any output yet.")
                            .font(AppTheme.uiFont(size: 12))
                            .foregroundStyle(AppTheme.statusWarn)
                            .multilineTextAlignment(.center)
                            .accessibilityIdentifier("relay-provider-login-no-output")
                    }

                    if showsNoLinkHint {
                        // The CLI started but never printed a link relayd could
                        // scrape — usually an outdated Relay build on the
                        // machine, or a login command that needs configuring
                        // there. The Terminal path works regardless.
                        Text("Still nothing? You can also open this folder's Terminal and run \(flow.provider.displayName)'s own login command — the link and code appear right there.")
                            .font(AppTheme.uiFont(size: 12))
                            .foregroundStyle(AppTheme.statusWarn)
                            .multilineTextAlignment(.center)
                            .accessibilityIdentifier("relay-provider-login-stall-hint")
                    }
                }
                .task {
                    try? await Task.sleep(for: .seconds(20))
                    if !Task.isCancelled { showsNoLinkHint = true }
                }
            } else if flow.usesLocalCallback || op.userCode != nil {
                Button("Open sign-in page") {
                    openSignInPage(op: op)
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-provider-login-open")
            } else if flow.usesPasteBack {
                pasteBackControls(op: op)
            } else {
                approvalControls(op: op)
            }

            Spacer()
        }
    }

    /// Cursor-style: the CLI on the machine is waiting for the browser
    /// approval and finishes by itself, so there is nothing to bring back.
    private func approvalControls(op: RelayHarnessOp) -> some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                ProgressView().tint(AppTheme.accent)
                Text("Waiting for you to approve in the browser…")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            Button("Open sign-in page again") {
                openSignInPage(op: op)
            }
            .buttonStyle(RelayOutlineButtonStyle())
            .accessibilityIdentifier("relay-provider-login-open")
        }
    }

    /// Back from the sign-in page with the code copied: one tap on the system
    /// Paste control (no permission prompt, no typing) finishes the sign-in.
    private func pasteBackControls(op: RelayHarnessOp) -> some View {
        VStack(spacing: 14) {
            PasteButton(payloadType: String.self) { strings in
                Task { @MainActor in await flow.submitPasted(strings) }
            }
            .labelStyle(.titleAndIcon)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .tint(AppTheme.accent)
            .accessibilityIdentifier("relay-provider-login-paste-button")

            if let pasteError = flow.pasteError {
                Text(pasteError)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.statusError)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("relay-provider-login-paste-error")
            }

            Button("Open sign-in page again") {
                openSignInPage(op: op)
            }
            .buttonStyle(RelayOutlineButtonStyle())
            .accessibilityIdentifier("relay-provider-login-open")

            if showsManualEntry {
                VStack(spacing: 10) {
                    TextField("Code from the sign-in page", text: $flow.pastedCode)
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
            } else {
                Button("Type the code instead") { showsManualEntry = true }
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textTertiary)
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("relay-provider-login-type-instead")
            }
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
        if !flow.usesPasteBack {
            return "Sign in with your own \(flow.provider.displayName) account and approve the request. Your machine finishes the sign-in by itself."
        }
        return "Sign in with your own \(flow.provider.displayName) account and copy the code the page shows. Then come back and tap Paste."
    }

    /// Paste-back sign-ins open the provider's page the moment the machine
    /// hands over the link, so the first thing the user sees is the sign-in
    /// itself rather than a button that leads to it.
    private func openSignInPageOnceIfReady(_ step: ProviderLoginFlowModel.Step) {
        guard case .waitingForSignIn(let op) = step,
              !flow.usesLocalCallback, op.userCode == nil,
              let url = op.verificationURL, url != autoOpenedURL else { return }
        autoOpenedURL = url
        safariTarget = ProviderLoginBrowserTarget(url: url)
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
