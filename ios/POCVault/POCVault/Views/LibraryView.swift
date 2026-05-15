import SwiftUI

struct LibraryView: View {
    @ObservedObject var viewModel: LibraryViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient

    @AppStorage("recentPOCEntryIDs") private var recentEntryIDs = ""
    @State private var showingDiagnostics = false
    @State private var path: [POCEntry] = []

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                VaultTheme.background.ignoresSafeArea()
                content
            }
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .refreshable {
                    await viewModel.load()
                }
                .sheet(isPresented: $showingDiagnostics) {
                    DiagnosticsView(identityStore: identityStore, manifestClient: manifestClient)
                }
                .navigationDestination(for: POCEntry.self) { entry in
                    AuthenticatedWebView(
                        url: entry.url,
                        title: entry.title,
                        identityStore: identityStore
                    )
                    .onAppear {
                        markRecent(entry)
                    }
                }
                .task {
                    if case .idle = viewModel.state {
                        await viewModel.load()
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle, .loading:
            VStack(spacing: 18) {
                header()
                Spacer()
                ProgressView()
                    .controlSize(.large)
                Text("Loading private POCs")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header()

                    StatusCard(
                        symbol: "exclamationmark.lock",
                        title: "Vault unavailable",
                        message: message
                    ) {
                        Button {
                            Task { await viewModel.load() }
                        } label: {
                            Label("Retry", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.borderedProminent)

                        Button {
                            showingDiagnostics = true
                        } label: {
                            Label("Diagnostics", systemImage: "stethoscope")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(20)
            }
        case .loaded:
            if viewModel.entries.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(count: 0)
                        StatusCard(
                            symbol: "tray",
                            title: "No POCs yet",
                            message: "The signed manifest is valid, but it does not list any deployed POCs."
                        ) {
                            EmptyView()
                        }
                    }
                    .padding(20)
                }
            } else if viewModel.filteredEntries.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(count: viewModel.entries.count)
                        StatusCard(
                            symbol: "magnifyingglass",
                            title: "No matches",
                            message: "Nothing in the vault matches \(viewModel.searchText)."
                        ) {
                            EmptyView()
                        }
                    }
                    .padding(20)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header(count: viewModel.entries.count)
                        SearchBox(text: $viewModel.searchText)

                        let recentEntries = recentEntries(from: viewModel.filteredEntries)
                        let libraryEntries = libraryEntries(from: viewModel.filteredEntries, excluding: recentEntries)
                        if !recentEntries.isEmpty {
                            POCSection(title: "Recent") {
                                ForEach(recentEntries) { entry in
                                    entryLink(entry)
                                }
                            }
                        }

                        if !libraryEntries.isEmpty {
                            POCSection(title: "Library") {
                                ForEach(libraryEntries) { entry in
                                    entryLink(entry)
                                }
                            }
                        }
                    }
                    .padding(20)
                }
            }
        }
    }

    private func header(count: Int? = nil) -> some View {
        VaultHeader(
            count: count,
            onRefresh: {
                Task { await viewModel.load() }
            },
            onDiagnostics: {
                showingDiagnostics = true
            }
        )
    }

    private func entryLink(_ entry: POCEntry) -> some View {
        NavigationLink(value: entry) {
            POCEntryCard(entry: entry)
        }
        .buttonStyle(.plain)
    }

    private func recentEntries(from entries: [POCEntry]) -> [POCEntry] {
        let ids = recentEntryIDs
            .split(separator: ",")
            .map(String.init)
        return ids.compactMap { id in entries.first { $0.id == id } }
    }

    private func libraryEntries(from entries: [POCEntry], excluding recentEntries: [POCEntry]) -> [POCEntry] {
        let recentIDs = Set(recentEntries.map(\.id))
        return entries.filter { !recentIDs.contains($0.id) }
    }

    private func markRecent(_ entry: POCEntry) {
        var ids = recentEntryIDs
            .split(separator: ",")
            .map(String.init)
            .filter { $0 != entry.id }
        ids.insert(entry.id, at: 0)
        recentEntryIDs = ids.prefix(5).joined(separator: ",")
    }
}

enum VaultTheme {
    static let background = LinearGradient(
        colors: [
            Color(red: 0.94, green: 0.97, blue: 0.96),
            Color(red: 0.86, green: 0.92, blue: 0.90)
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let ink = Color(red: 0.05, green: 0.12, blue: 0.14)
    static let muted = Color(red: 0.33, green: 0.42, blue: 0.42)
    static let mint = Color(red: 0.11, green: 0.72, blue: 0.62)
}

private struct VaultHeader: View {
    var count: Int?
    var onRefresh: () -> Void
    var onDiagnostics: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(VaultTheme.ink)
                Image(systemName: "lock.rectangle.stack")
                    .font(.system(size: 27, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 58, height: 58)

            VStack(alignment: .leading, spacing: 4) {
                Text("POC Vault")
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .foregroundStyle(VaultTheme.ink)
                Text(subtitle)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(VaultTheme.muted)
            }
            Spacer()

            HStack(spacing: 10) {
                HeaderButton(symbol: "arrow.clockwise", label: "Refresh", action: onRefresh)
                HeaderButton(symbol: "stethoscope", label: "Diagnostics", action: onDiagnostics)
            }
        }
        .padding(.top, 4)
    }

    private var subtitle: String {
        if let count {
            return "\(count) private \(count == 1 ? "prototype" : "prototypes")"
        }
        return AppConfiguration.runtimeMode
    }
}

private struct HeaderButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(VaultTheme.ink)
                .frame(width: 42, height: 42)
                .background(.white.opacity(0.78), in: Circle())
                .overlay {
                    Circle()
                        .stroke(.white.opacity(0.86), lineWidth: 1)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct SearchBox: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
            TextField("Search POCs", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
        .background(.white.opacity(0.86), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(.white.opacity(0.7), lineWidth: 1)
        }
    }
}

private struct POCSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
                .foregroundStyle(VaultTheme.ink)
            VStack(spacing: 12) {
                content
            }
        }
    }
}

private struct POCEntryCard: View {
    let entry: POCEntry

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(VaultTheme.mint.opacity(0.16))
                Image(systemName: "safari")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(VaultTheme.mint)
            }
            .frame(width: 52, height: 52)

            VStack(alignment: .leading, spacing: 5) {
                Text(entry.title)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(VaultTheme.ink)

                Text(entry.detailText)
                    .font(.subheadline)
                    .foregroundStyle(VaultTheme.muted)
                    .lineLimit(2)

                Text(locationLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            if entry.requiresClientCertificate {
                Image(systemName: "lock.shield")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(VaultTheme.mint)
                    .accessibilityLabel("Requires client certificate")
            }
        }
        .padding(14)
        .background(.white.opacity(0.86), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(.white.opacity(0.72), lineWidth: 1)
        }
    }

    private var locationLabel: String {
        if entry.displayHost == "127.0.0.1" || entry.displayHost == "localhost" {
            return AppConfiguration.runtimeMode
        }
        return entry.displayHost
    }
}

private struct StatusCard<Actions: View>: View {
    let symbol: String
    let title: String
    let message: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(VaultTheme.mint)
            Text(title)
                .font(.title2.weight(.bold))
                .foregroundStyle(VaultTheme.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(VaultTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                actions
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.88), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }
}
