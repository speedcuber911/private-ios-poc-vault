import SwiftUI

struct LibraryView: View {
    @ObservedObject var viewModel: LibraryViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient

    @AppStorage("recentPOCEntryIDs") private var recentEntryIDs = ""
    @State private var showingDiagnostics = false
    @State private var selectedFilter: LibraryFilter = .all
    @State private var path: [POCEntry] = []

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()
                content
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
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
            VStack(spacing: 16) {
                header()
                Spacer()
                ProgressView()
                    .controlSize(.large)
                    .tint(AppTheme.accent)
                Text("Loading private POCs")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.textSecondary)
                Spacer()
                diagnosticsLink()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header()

                    StatusCard(
                        symbol: "exclamationmark.lock",
                        title: "Vault unavailable",
                        message: message
                    )

                    diagnosticsLink()
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
        case .loaded:
            if viewModel.entries.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(count: 0)
                        StatusCard(
                            symbol: "tray",
                            title: "No POCs yet",
                            message: "The signed manifest is valid, but it does not list any deployed POCs."
                        )

                        diagnosticsLink()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
            } else if viewModel.filteredEntries.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(count: viewModel.entries.count)
                        SearchBox(text: $viewModel.searchText)
                        StatusCard(
                            symbol: "magnifyingglass",
                            title: "No matches",
                            message: "Nothing in the vault matches \(viewModel.searchText)."
                        )

                        diagnosticsLink()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        header(count: viewModel.entries.count)
                        SearchBox(text: $viewModel.searchText)

                        let recentEntries = recentEntries(from: viewModel.filteredEntries)
                        let visibleEntries = filteredEntries(from: viewModel.filteredEntries, recentEntries: recentEntries)
                        POCSectionHeader(selectedFilter: $selectedFilter)
                        LazyVStack(spacing: 8) {
                            ForEach(visibleEntries) { entry in
                                entryLink(entry)
                            }
                        }

                        diagnosticsLink()
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 112)
                }
            }
        }
    }

    private func header(count: Int? = nil) -> some View {
        VaultHeader(
            count: count,
            onRefresh: {
                Task { await viewModel.load() }
            }
        )
    }

    private func diagnosticsLink() -> some View {
        DiagnosticsLinkRow {
            showingDiagnostics = true
        }
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

    private func filteredEntries(from entries: [POCEntry], recentEntries: [POCEntry]) -> [POCEntry] {
        switch selectedFilter {
        case .all:
            let recentIDs = Set(recentEntries.map(\.id))
            return recentEntries + entries.filter { !recentIDs.contains($0.id) }
        case .recent:
            return recentEntries.isEmpty ? entries : recentEntries
        case .signed:
            return entries.filter(\.requiresClientCertificate)
        }
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

private enum LibraryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case recent = "Recent"
    case signed = "Signed"

    var id: String { rawValue }
}

private struct VaultHeader: View {
    var count: Int?
    var onRefresh: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VaultLogoMark(size: 36)

            VStack(alignment: .leading, spacing: 4) {
                Text("POC Vault")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(AppTheme.accent)
                    Text(subtitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer()

            HeaderButton(symbol: "arrow.clockwise", label: "Refresh", action: onRefresh)
        }
        .padding(.top, 2)
    }

    private var subtitle: String {
        var parts = ["Signed manifest"]
        if let count {
            parts.append("\(count) \(count == 1 ? "prototype" : "prototypes")")
        }
        parts.append(shortTime)
        return parts.joined(separator: " / ")
    }

    private var shortTime: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: Date())
    }
}

struct VaultLogoMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .fill(AppTheme.bgSurfaceHi)

            Image(systemName: "lock.fill")
                .font(.system(size: size * 0.44, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
        }
        .frame(width: size, height: size)
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .stroke(AppTheme.strokeStrong, lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}

private struct HeaderButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .frame(width: 36, height: 36)
                .background(AppTheme.bgSurfaceHi, in: Circle())
                .overlay {
                    Circle()
                        .stroke(AppTheme.strokeStrong, lineWidth: 1)
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
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textTertiary)
            TextField("Search prototypes", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(AppTheme.textPrimary)
                .submitLabel(.search)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.strokeStrong, lineWidth: 1)
        }
        .tint(AppTheme.accent)
    }
}

private struct POCSectionHeader: View {
    @Binding var selectedFilter: LibraryFilter

    var body: some View {
        HStack(alignment: .center) {
            Text("Library")
                .font(.caption.weight(.bold))
                .textCase(.uppercase)
                .foregroundStyle(AppTheme.textTertiary)
                .tracking(1.4)

            Spacer()

            HStack(spacing: 2) {
                ForEach(LibraryFilter.allCases) { filter in
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            selectedFilter = filter
                        }
                    } label: {
                        Text(filter.rawValue)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(selectedFilter == filter ? AppTheme.accent : AppTheme.textSecondary)
                            .padding(.horizontal, 14)
                            .frame(height: 30)
                            .background {
                                if selectedFilter == filter {
                                    Capsule()
                                        .fill(AppTheme.accent.opacity(0.16))
                                }
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(AppTheme.bgSurface, in: Capsule())
            .overlay {
                Capsule().stroke(AppTheme.strokeSubtle, lineWidth: 1)
            }
        }
    }
}

private struct POCEntryCard: View {
    let entry: POCEntry

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(AppTheme.bgSurfaceHi)
                Image(systemName: "safari")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            }
            .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 6) {
                Text(entry.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)

                Text(entry.detailText)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(1)

                Text(metaText)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            HStack(spacing: 8) {
                if entry.requiresClientCertificate {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                        .accessibilityLabel("Requires client certificate")
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 72)
        .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(AppTheme.strokeSubtle, lineWidth: 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var metaText: String {
        "\(locationLabel) / \(relativeUpdatedAt)"
    }

    private var locationLabel: String {
        if entry.displayHost == "127.0.0.1" || entry.displayHost == "localhost" {
            return AppConfiguration.runtimeMode
        }
        return entry.displayHost
    }

    private var relativeUpdatedAt: String {
        guard let updatedAt = entry.updatedAt else { return "fresh" }
        return Self.relativeFormatter.localizedString(for: updatedAt, relativeTo: Date())
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

private struct DiagnosticsLinkRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "stethoscope")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                Text("Diagnostics")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(AppTheme.textTertiary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 34)
        }
        .buttonStyle(.plain)
    }
}

private struct StatusCard: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
            Text(title)
                .font(.headline.weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.strokeSubtle, lineWidth: 1)
        }
    }
}
