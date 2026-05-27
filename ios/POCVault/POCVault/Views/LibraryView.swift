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
            .fullScreenCover(isPresented: $showingDiagnostics) {
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
                Text("Loading prototypes")
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
                        title: "Relay unavailable",
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
                            title: "No prototypes yet",
                            message: "The signed manifest is valid, but it does not list any deployed prototypes."
                        )

                        diagnosticsLink()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
            } else if visibleEntriesForCurrentFilter.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header(count: viewModel.entries.count)
                        SearchBox(text: $viewModel.searchText)
                        StatusCard(
                            symbol: emptyState.symbol,
                            title: emptyState.title,
                            message: emptyState.message
                        )

                        diagnosticsLink()
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header(count: viewModel.entries.count)
                            .padding(.horizontal, 20)
                            .padding(.bottom, 14)
                        SearchBox(text: $viewModel.searchText)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 14)

                        POCSectionHeader(selectedFilter: $selectedFilter)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 12)
                        Text("Library")
                            .font(.system(size: 12))
                            .foregroundStyle(AppTheme.textSecondary)
                            .padding(.horizontal, 20)
                            .padding(.bottom, 8)
                        LazyVStack(spacing: 0) {
                            ForEach(visibleEntriesForCurrentFilter) { entry in
                                entryLink(entry)
                            }
                        }
                        .overlay(alignment: .top) {
                            Rectangle()
                                .fill(AppTheme.strokeSubtle)
                                .frame(height: 0.5)
                        }

                        diagnosticsLink()
                    }
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

    private var visibleEntriesForCurrentFilter: [POCEntry] {
        let recentEntries = recentEntries(from: viewModel.filteredEntries)
        return filteredEntries(from: viewModel.filteredEntries, recentEntries: recentEntries)
    }

    private func filteredEntries(from entries: [POCEntry], recentEntries: [POCEntry]) -> [POCEntry] {
        switch selectedFilter {
        case .all:
            let recentIDs = Set(recentEntries.map(\.id))
            return recentEntries + entries.filter { !recentIDs.contains($0.id) }
        case .recent:
            return recentEntries
        case .signed:
            return entries.filter(\.requiresClientCertificate)
        }
    }

    private var emptyState: (symbol: String, title: String, message: String) {
        if !viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return (
                "magnifyingglass",
                "No matches",
                "Nothing in the library matches \"\(viewModel.searchText)\"."
            )
        }

        switch selectedFilter {
        case .all:
            return (
                "tray",
                "No prototypes",
                "The signed manifest is valid, but no prototypes are available for this view."
            )
        case .recent:
            return (
                "clock",
                "No recent prototypes",
                "Open a prototype and it will stay at the top of this view for quick access."
            )
        case .signed:
            return (
                "lock",
                "No signed prototypes",
                "No entries in the current manifest are marked as client-certificate protected."
            )
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
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center, spacing: 10) {
                RelayLogoMark(size: 30)

                Text("Relay")
                    .font(.system(size: 24, weight: .medium, design: .serif))
                    .foregroundStyle(AppTheme.textPrimary)

                Spacer()

                HeaderButton(symbol: "arrow.clockwise", label: "Refresh", action: onRefresh)
            }

            Text(subtitle)
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
        }
    }

    private var subtitle: String {
        var parts = ["Signed manifest"]
        if let count {
            parts.append("\(count) \(count == 1 ? "prototype" : "prototypes")")
        }
        return parts.joined(separator: " · ")
    }
}

struct RelayLogoMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(AppTheme.bgSurfaceHi)

            Image(systemName: "terminal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
        }
        .frame(width: size, height: size)
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
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 32, height: 32)
                .background(AppTheme.bgSurface, in: Circle())
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
                .font(.system(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
            TextField("Search prototypes", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.system(size: 15))
                .foregroundStyle(AppTheme.textPrimary)
                .submitLabel(.search)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .tint(AppTheme.accent)
    }
}

private struct POCSectionHeader: View {
    @Binding var selectedFilter: LibraryFilter

    var body: some View {
        HStack(spacing: 6) {
            ForEach(LibraryFilter.allCases) { filter in
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        selectedFilter = filter
                    }
                } label: {
                    Text(filter.rawValue)
                        .font(.system(size: 13, weight: selectedFilter == filter ? .medium : .regular))
                        .foregroundStyle(selectedFilter == filter ? AppTheme.textPrimary : AppTheme.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 5)
                        .background {
                            if selectedFilter == filter {
                                Capsule()
                                    .fill(AppTheme.textPrimary.opacity(0.12))
                            }
                        }
                }
                .buttonStyle(.plain)
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
                Image(systemName: "scope")
                    .font(.system(size: 20))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)

                Text(entry.detailText)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(1)

                Text(metaText)
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            HStack(spacing: 8) {
                if entry.requiresClientCertificate {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.textTertiary)
                        .accessibilityLabel("Requires client certificate")
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
        .frame(minHeight: 62)
        .background(AppTheme.bgCanvas)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppTheme.strokeSubtle)
                .frame(height: 0.5)
                .padding(.leading, 72)
        }
        .contentShape(Rectangle())
    }

    private var metaText: String {
        "\(locationLabel) · \(relativeUpdatedAt)"
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
                Image(systemName: "list.clipboard")
                    .font(.system(size: 15))
                    .foregroundStyle(AppTheme.textSecondary)
                Text("Diagnostics")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
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
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
