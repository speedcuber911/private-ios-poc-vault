import SwiftUI

struct RelayTerminalView: View {
    let client: CodexClient
    let workspaceID: String
    let workspaceName: String
    let onDismiss: () -> Void

    @State private var terminal: CodexTerminal?
    @State private var output = ""
    @State private var input = ""
    @State private var errorMessage: String?
    @State private var streamTask: Task<Void, Never>?
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(output.isEmpty ? "Starting terminal…" : output)
                            .font(AppTheme.monoFont(size: 12))
                            .foregroundStyle(AppTheme.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(14)
                            .id("terminal-end")
                    }
                    .background(Color.black.opacity(0.32))
                    .onChange(of: output) { _, _ in
                        withAnimation(.linear(duration: 0.08)) { proxy.scrollTo("terminal-end", anchor: .bottom) }
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.statusError)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                }

                HStack(spacing: 8) {
                    Button("^C") { send("\u{3}") }
                        .font(AppTheme.monoFont(size: 13, weight: .semibold))
                        .buttonStyle(.bordered)
                    TextField("Command", text: $input)
                        .font(AppTheme.monoFont(size: 14))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.send)
                        .focused($inputFocused)
                        .onSubmit(sendLine)
                    Button(action: sendLine) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AppTheme.accent)
                    .disabled(terminal?.isRunning != true || input.isEmpty)
                }
                .padding(10)
                .background(AppTheme.canvasTop)
            }
            .background(AppTheme.bgCanvas.ignoresSafeArea())
            .navigationTitle(workspaceName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        close()
                        onDismiss()
                    }
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text("Terminal").font(AppTheme.uiFont(size: 14, weight: .semibold))
                        Text(terminal?.status.capitalized ?? "Connecting")
                            .font(AppTheme.uiFont(size: 10))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            }
            .task { await start() }
            .onDisappear { close() }
        }
        .preferredColorScheme(.dark)
    }

    private func start() async {
        do {
            let created = try await client.createTerminal(workspaceID: workspaceID)
            terminal = created
            inputFocused = true
            streamTask = Task {
                do {
                    for try await event in client.terminalEvents(id: created.id) {
                        if Task.isCancelled { break }
                        switch event {
                        case .snapshot(let value, let snapshot): terminal = value; output = snapshot
                        case .output(let text): output += text
                        case .done(let value): terminal = value
                        }
                    }
                } catch {
                    if !Task.isCancelled { errorMessage = error.localizedDescription }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sendLine() {
        guard !input.isEmpty else { return }
        let value = input
        input = ""
        send("\(value)\n")
    }

    private func send(_ text: String) {
        guard let terminal else { return }
        Task {
            do { try await client.sendTerminalInput(id: terminal.id, text: text) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    private func close() {
        streamTask?.cancel()
        guard let terminal, terminal.isRunning else { return }
        Task { try? await client.closeTerminal(id: terminal.id) }
    }
}
