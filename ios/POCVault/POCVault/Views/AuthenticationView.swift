import AuthenticationServices
import CryptoKit
import Security
import SwiftUI

struct AuthenticationView: View {
    @ObservedObject var accountStore: RelayAccountStore

    @State private var mode = Mode.signIn
    @State private var username = ""
    @State private var email = ""
    @State private var password = ""
    @State private var appleNonce = ""
    @State private var appleSignInPending = false

    private enum Mode: String, CaseIterable, Identifiable {
        case signIn = "Sign in"
        case createAccount = "Create account"

        var id: String { rawValue }
    }

    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case username, email, password
    }

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()

            // Centered in the available height (with extra bottom padding so the block
            // sits just above optical center) and scrollable once the keyboard shrinks it.
            GeometryReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        brand
                        fields
                            .padding(.top, 44)

                        if let error = accountStore.errorMessage {
                            errorBanner(error)
                                .padding(.top, 18)
                        }

                        actions
                            .padding(.top, 30)
                        modeSwitch
                            .padding(.top, 22)
                    }
                    .frame(maxWidth: 520)
                    .padding(.horizontal, 26)
                    .padding(.top, 40)
                    .padding(.bottom, 108)
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: proxy.size.height, alignment: .center)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .preferredColorScheme(.dark)
    }

    private var brand: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 34, weight: .medium))
                .foregroundStyle(AppTheme.accentGradient)

            VStack(alignment: .leading, spacing: 8) {
                Text("Relay")
                    .font(AppTheme.serifFont(size: 40))
                    .foregroundStyle(AppTheme.textPrimary)
                Text("Your agents, within reach.")
                    .font(AppTheme.serifFont(size: 15, weight: .regular).italic())
                    .foregroundStyle(AppTheme.textSecondary)
            }
        }
    }

    private var fields: some View {
        VStack(spacing: 22) {
            underlineField(
                title: "Username",
                text: $username,
                field: .username,
                contentType: .username,
                keyboard: .asciiCapable
            )

            if mode == .createAccount {
                underlineField(
                    title: "Email",
                    text: $email,
                    field: .email,
                    contentType: .emailAddress,
                    keyboard: .emailAddress
                )
            }

            VStack(spacing: 10) {
                SecureField("Password", text: $password)
                    .textContentType(mode == .signIn ? .password : .newPassword)
                    .submitLabel(.go)
                    .onSubmit(submitCredentials)
                    .focused($focusedField, equals: .password)
                    .font(AppTheme.uiFont(size: 16))
                    .foregroundStyle(AppTheme.textPrimary)
                    .accessibilityIdentifier("relay-password")
                Rectangle()
                    .fill(focusedField == .password ? AppTheme.accent : AppTheme.hairlineStrong)
                    .frame(height: 1)
            }
        }
    }

    private func underlineField(
        title: String,
        text: Binding<String>,
        field: Field,
        contentType: UITextContentType,
        keyboard: UIKeyboardType
    ) -> some View {
        VStack(spacing: 10) {
            TextField(title, text: text)
                .textContentType(contentType)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(keyboard)
                .focused($focusedField, equals: field)
                .font(AppTheme.uiFont(size: 16))
                .foregroundStyle(AppTheme.textPrimary)
                .accessibilityIdentifier("relay-\(title.lowercased())")
            Rectangle()
                .fill(focusedField == field ? AppTheme.accent : AppTheme.hairlineStrong)
                .frame(height: 1)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            Button(action: submitCredentials) {
                // During Apple finish, keep the label and only disable — the Apple
                // slot owns the spinner so two busy indicators don't compete.
                if accountStore.isWorking && !appleSignInPending {
                    ProgressView().tint(AppTheme.onEmber)
                } else {
                    Text(mode.rawValue)
                }
            }
            .buttonStyle(RelayPrimaryButtonStyle(isEnabled: credentialsAreValid && !accountStore.isWorking))
            .disabled(!credentialsAreValid || accountStore.isWorking)
            .accessibilityIdentifier("relay-credential-submit")

            if appleSignInPending {
                appleSigningInStatus
            } else {
                SignInWithAppleButton(.continue) { request in
                    let nonce = Self.randomNonce()
                    appleNonce = nonce
                    request.requestedScopes = [.fullName, .email]
                    request.nonce = Self.sha256(nonce)
                } onCompletion: { result in
                    handleAppleCompletion(result)
                }
                // Black-on-dark keeps Apple's button quieter than the ember CTA; the white
                // variants outrank the brand's own primary action on this canvas.
                .signInWithAppleButtonStyle(.black)
                .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
                .frame(height: 50)
                .clipShape(Capsule())
                .disabled(accountStore.isWorking)
                .accessibilityIdentifier("relay-sign-in-with-apple")
            }
        }
    }

    private var appleSigningInStatus: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(AppTheme.textPrimary)
            Text("Signing in…")
                .font(AppTheme.uiFont(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .background(Color.black, in: Capsule())
        .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("relay-sign-in-with-apple-pending")
        .accessibilityLabel("Signing in")
    }

    private var modeSwitch: some View {
        HStack(spacing: 6) {
            Text(mode == .signIn ? "New here?" : "Already have an account?")
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textTertiary)
            Button(mode == .signIn ? "Create an account" : "Sign in") {
                mode = mode == .signIn ? .createAccount : .signIn
                accountStore.dismissError()
                password = ""
            }
            .font(AppTheme.uiFont(size: 13, weight: .semibold))
            .foregroundStyle(AppTheme.accent)
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
    }

    private func errorBanner(_ text: String) -> some View {
        Text(text)
            .font(AppTheme.uiFont(size: 13))
            .foregroundStyle(AppTheme.statusError)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppTheme.statusError.opacity(0.3), lineWidth: 1)
            }
    }

    private var credentialsAreValid: Bool {
        let validUsername = username.trimmingCharacters(in: .whitespacesAndNewlines).count >= 3
        let validPassword = password.count >= 8
        if mode == .createAccount {
            return validUsername && validPassword && email.contains("@")
        }
        return validUsername && validPassword
    }

    private func submitCredentials() {
        guard credentialsAreValid, !accountStore.isWorking else { return }
        Task {
            if mode == .signIn {
                await accountStore.signIn(username: username, password: password)
            } else {
                await accountStore.signUp(username: username, email: email, password: password)
            }
        }
    }

    private func handleAppleCompletion(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            guard
                let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let data = credential.identityToken,
                let identityToken = String(data: data, encoding: .utf8),
                !appleNonce.isEmpty
            else {
                accountStore.errorMessage = "Apple did not return a valid identity token."
                return
            }
            let components = credential.fullName
            appleSignInPending = true
            Task {
                defer { appleSignInPending = false }
                await accountStore.signInWithApple(
                    identityToken: identityToken,
                    nonce: appleNonce,
                    email: credential.email,
                    firstName: components?.givenName,
                    lastName: components?.familyName
                )
            }
        case .failure(let error):
            if let authorizationError = error as? ASAuthorizationError,
               authorizationError.code == .canceled {
                return
            }
            accountStore.errorMessage = error.localizedDescription
        }
    }

    private static func randomNonce(length: Int = 32) -> String {
        let characters = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var remaining = length
        while remaining > 0 {
            var bytes = [UInt8](repeating: 0, count: 16)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                return UUID().uuidString.replacingOccurrences(of: "-", with: "")
            }
            for byte in bytes where remaining > 0 && Int(byte) < characters.count {
                result.append(characters[Int(byte)])
                remaining -= 1
            }
        }
        return result
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
