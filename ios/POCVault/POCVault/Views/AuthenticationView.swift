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

    private enum Mode: String, CaseIterable, Identifiable {
        case signIn = "Sign in"
        case createAccount = "Create account"

        var id: String { rawValue }
    }

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 28) {
                    brand
                    authCard
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 22)
                .padding(.top, 52)
                .padding(.bottom, 36)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .preferredColorScheme(.dark)
    }

    private var brand: some View {
        VStack(spacing: 14) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 31, weight: .medium))
                .foregroundStyle(AppTheme.accentGradient)
                .frame(width: 68, height: 68)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(AppTheme.glassStroke, lineWidth: 1)
                }

            Text("Relay")
                .font(.system(size: 38, weight: .medium, design: .serif))
                .foregroundStyle(AppTheme.textPrimary)

            Text("Your secure control surface for remote agent work.")
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var authCard: some View {
        VStack(spacing: 20) {
            Picker("Authentication mode", selection: $mode) {
                ForEach(Mode.allCases) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: mode) { _, _ in
                accountStore.dismissError()
                password = ""
            }

            SignInWithAppleButton(.continue) { request in
                let nonce = Self.randomNonce()
                appleNonce = nonce
                request.requestedScopes = [.fullName, .email]
                request.nonce = Self.sha256(nonce)
            } onCompletion: { result in
                handleAppleCompletion(result)
            }
            .signInWithAppleButtonStyle(.white)
            .frame(height: 50)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .disabled(accountStore.isWorking)
            .accessibilityIdentifier("relay-sign-in-with-apple")

            HStack(spacing: 12) {
                Rectangle().fill(AppTheme.strokeSubtle).frame(height: 1)
                Text("or")
                    .font(AppTheme.uiFont(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                Rectangle().fill(AppTheme.strokeSubtle).frame(height: 1)
            }

            VStack(spacing: 12) {
                authField(
                    title: "Username",
                    text: $username,
                    contentType: .username,
                    keyboard: .asciiCapable
                )

                if mode == .createAccount {
                    authField(
                        title: "Email",
                        text: $email,
                        contentType: .emailAddress,
                        keyboard: .emailAddress
                    )
                }

                SecureField("Password", text: $password)
                    .textContentType(mode == .signIn ? .password : .newPassword)
                    .submitLabel(.go)
                    .onSubmit(submitCredentials)
                    .authFieldStyle()
                    .accessibilityIdentifier("relay-password")
            }

            if let error = accountStore.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.statusError)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(AppTheme.statusError.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
            }

            Button(action: submitCredentials) {
                Group {
                    if accountStore.isWorking {
                        ProgressView().tint(.white)
                    } else {
                        Text(mode.rawValue)
                            .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .foregroundStyle(.white)
                .background(AppTheme.accentGradient, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!credentialsAreValid || accountStore.isWorking)
            .opacity(credentialsAreValid ? 1 : 0.48)
            .accessibilityIdentifier("relay-credential-submit")

            Text(mode == .createAccount
                 ? "Your password is handled by Better Auth on the Relay server."
                 : "Sign in is required before Relay can access your workspaces.")
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(AppTheme.glassStroke, lineWidth: 1)
        }
    }

    private func authField(
        title: String,
        text: Binding<String>,
        contentType: UITextContentType,
        keyboard: UIKeyboardType
    ) -> some View {
        TextField(title, text: text)
            .textContentType(contentType)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(keyboard)
            .authFieldStyle()
            .accessibilityIdentifier("relay-\(title.lowercased())")
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
            Task {
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

private extension View {
    func authFieldStyle() -> some View {
        self
            .font(AppTheme.uiFont(size: 16))
            .foregroundStyle(AppTheme.textPrimary)
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppTheme.strokeSubtle, lineWidth: 1)
            }
    }
}
