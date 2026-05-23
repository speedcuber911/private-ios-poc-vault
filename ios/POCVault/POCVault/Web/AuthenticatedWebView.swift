import SwiftUI
import WebKit

struct AuthenticatedWebView: View {
    let url: URL
    let title: String
    @ObservedObject var identityStore: ClientIdentityStore
    @Environment(\.dismiss) private var dismiss
    @State private var isChromeDimmed = false
    @State private var restoreChromeTask: Task<Void, Never>?

    var body: some View {
        ZStack(alignment: .topLeading) {
            WebView(
                url: url,
                identityStore: identityStore,
                onScrollActivityChanged: handleScrollActivityChanged
            )
                .ignoresSafeArea()

            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 54, height: 54)
                    .background(.ultraThinMaterial.opacity(isChromeDimmed ? 0.46 : 1), in: Circle())
                    .overlay {
                        Circle()
                            .stroke(.white.opacity(0.18), lineWidth: 1)
                    }
                    .shadow(color: .black.opacity(isChromeDimmed ? 0.04 : 0.18), radius: 18, y: 8)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back")
            .opacity(isChromeDimmed ? 0.18 : 1)
            .scaleEffect(isChromeDimmed ? 0.88 : 1)
            .padding(.top, 16)
            .padding(.leading, 16)
            .animation(.easeOut(duration: 0.18), value: isChromeDimmed)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .statusBarHidden(false)
        .onDisappear {
            restoreChromeTask?.cancel()
        }
    }

    private func handleScrollActivityChanged(_ isActive: Bool) {
        restoreChromeTask?.cancel()

        if isActive {
            withAnimation(.easeOut(duration: 0.14)) {
                isChromeDimmed = true
            }
            return
        }

        restoreChromeTask = Task {
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                    isChromeDimmed = false
                }
            }
        }
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL
    let identityStore: ClientIdentityStore
    let onScrollActivityChanged: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            identityStore: identityStore,
            initialURL: url,
            onScrollActivityChanged: onScrollActivityChanged
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.delegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.onScrollActivityChanged = onScrollActivityChanged
        if uiView.url != url {
            uiView.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, UIScrollViewDelegate {
        private let identityStore: ClientIdentityStore
        private let initialHost: String?
        fileprivate var onScrollActivityChanged: (Bool) -> Void
        private var isReportingScrollActivity = false

        init(
            identityStore: ClientIdentityStore,
            initialURL: URL,
            onScrollActivityChanged: @escaping (Bool) -> Void
        ) {
            self.identityStore = identityStore
            self.initialHost = initialURL.host(percentEncoded: false) ?? initialURL.host
            self.onScrollActivityChanged = onScrollActivityChanged
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            let scheme = url.scheme?.localizedLowercase
            let host = url.host(percentEncoded: false) ?? url.host
            let isExpectedHost = host == nil || host == initialHost
            let isAllowedScheme = scheme == "https" || (scheme == "http" && isLocalhost(host))

            decisionHandler(isAllowedScheme && isExpectedHost ? .allow : .cancel)
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            switch challenge.protectionSpace.authenticationMethod {
            case NSURLAuthenticationMethodClientCertificate:
                if let credential = identityStore.credential() {
                    completionHandler(.useCredential, credential)
                } else {
                    completionHandler(.performDefaultHandling, nil)
                }
            default:
                completionHandler(.performDefaultHandling, nil)
            }
        }

        private func isLocalhost(_ host: String?) -> Bool {
            guard let host else { return false }
            return host == "localhost" || host == "127.0.0.1" || host == "::1"
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            setScrollActivity(true)
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate {
                setScrollActivity(false)
            }
        }

        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
            setScrollActivity(false)
        }

        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
            setScrollActivity(false)
        }

        func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
            setScrollActivity(false)
        }

        private func setScrollActivity(_ isActive: Bool) {
            guard isReportingScrollActivity != isActive else { return }
            isReportingScrollActivity = isActive
            DispatchQueue.main.async {
                self.onScrollActivityChanged(isActive)
            }
        }
    }
}
