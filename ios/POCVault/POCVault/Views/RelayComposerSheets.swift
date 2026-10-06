import SwiftUI
import UIKit

// Composer sheets (model, effort, add, permissions, skills). Owned by the composer lane.
//
// Everything here is a standalone view: the composer itself is private to
// RelayChatView.swift, so these take values, bindings and closures and know nothing
// about the view model.

// MARK: - Tokens

/// Colours the composer and its sheets need beyond `AppTheme`. Kept here rather than
/// in the theme because nothing outside the composer uses them yet.
enum RelayComposerPalette {
    /// The floating composer card.
    static let raisedCard = Color(hex: 0x272421)
    /// Ground of every composer sheet.
    static let sheetGround = Color(hex: 0x211E1A)
    /// "+", mic, close, back, stop: one quiet circle.
    static let quietFill = AppTheme.textPrimary.opacity(0.08)
    static let groupFill = AppTheme.textPrimary.opacity(0.05)
    static let tileFill = AppTheme.textPrimary.opacity(0.06)
    static let selectedPillFill = AppTheme.textPrimary.opacity(0.16)
    /// Values beside a row title, and the effort word in the model pill.
    static let value = AppTheme.textPrimary.opacity(0.6)
    /// Disabled send: cream, never dimmed ember.
    static let disabledDisc = AppTheme.textPrimary.opacity(0.10)
    static let disabledGlyph = AppTheme.textPrimary.opacity(0.38)
}

// MARK: - Pure logic

enum RelayAttachmentSource: Equatable {
    case camera
    case photos
    case files
}

/// The pages of the Add sheet. `root` is the tiles and the value rows.
enum RelayAddSheetPage: String, Equatable, Identifiable {
    case root
    case permissions
    case fileAccess
    case approvals
    case skills

    var id: String { rawValue }
}

enum RelayModelSheetPage: Equatable {
    case model
    case effort
}

/// One pill in the new-chat model sheet: a harness, or the flat chat-model list.
enum RelayModelSheetTab: Hashable, Identifiable {
    case agent(CodexProvider)
    case chat

    var id: String {
        switch self {
        case .agent(let provider): return "agent:\(provider.rawValue)"
        case .chat: return "chat"
        }
    }

    var title: String {
        switch self {
        case .agent(let provider): return RelayModelChoice.harnessTitle(for: provider)
        case .chat: return "Chat"
        }
    }

    static func tabs(for sections: RelayModelPickerSections) -> [RelayModelSheetTab] {
        sections.agents.map { RelayModelSheetTab.agent($0.provider) }
            + (sections.chatModels.isEmpty ? [] : [.chat])
    }

    /// The sheet opens on the tab that owns the current selection, so the checkmark
    /// is on screen without the user hunting for it.
    static func initial(
        for sections: RelayModelPickerSections,
        selectedChoice: RelayModelChoice?
    ) -> RelayModelSheetTab? {
        owner(of: selectedChoice, in: sections) ?? tabs(for: sections).first
    }

    /// The tab whose list holds this choice; nil when the catalog does not have it.
    static func owner(
        of choice: RelayModelChoice?,
        in sections: RelayModelPickerSections
    ) -> RelayModelSheetTab? {
        guard let choice else { return nil }
        if let group = sections.agents.first(where: { $0.choices.contains(choice) }) {
            return .agent(group.provider)
        }
        return sections.chatModels.contains(choice) ? .chat : nil
    }

    /// Effort belongs to the selected model. While the sheet is showing some other
    /// agent's list, the row would be reporting a setting that list does not have.
    /// Picking a model on that list makes its tab the owner, and because a pick
    /// leaves the sheet open the row appears there and then.
    static func showsEffort(
        visibleTab: RelayModelSheetTab?,
        sections: RelayModelPickerSections,
        selectedChoice: RelayModelChoice?,
        threadProvider: CodexProvider?
    ) -> Bool {
        // Inside a thread every list on the page is the thread's own harness.
        if threadProvider != nil { return true }
        guard let visibleTab else { return false }
        return visibleTab == owner(of: selectedChoice, in: sections)
    }

    func choices(in sections: RelayModelPickerSections) -> [RelayModelChoice] {
        switch self {
        case .agent(let provider):
            return sections.agents.first(where: { $0.provider == provider })?.choices ?? []
        case .chat:
            return sections.chatModels
        }
    }

    /// Agent rows drop the harness prefix (the pill already says it); chat rows keep
    /// their full chip label because nothing above them names the provider.
    func rowTitle(for choice: RelayModelChoice) -> String {
        switch self {
        case .agent: return choice.shortModelLabel
        case .chat: return choice.chipLabel
        }
    }
}

enum RelayComposerLogic {
    /// The effort word shown in the pill and on the Effort row. Nil hides both.
    static func effortLabel(
        efforts: [CodexReasoningEffort],
        selected: CodexReasoningEffort?
    ) -> String? {
        guard let first = efforts.first else { return nil }
        return (selected ?? first).label
    }

    static func pillAccessibilityLabel(model: String?, effort: String?) -> String {
        guard let model else { return "Choose model" }
        guard let effort else { return "Model \(model)" }
        return "Model \(model), effort \(effort)"
    }

    static func skillsValueLabel(selectedCount: Int) -> String {
        selectedCount <= 0 ? "None" : "\(selectedCount) on"
    }

    /// Which value rows the Add sheet shows for a provider, in order.
    static func addRows(for provider: CodexProvider?) -> [RelayAddSheetPage] {
        guard let provider else { return [] }
        var rows: [RelayAddSheetPage] = []
        if provider.hasTaskPermissionControls {
            rows += provider == .claude ? [.permissions] : [.fileAccess, .approvals]
        }
        rows.append(.skills)
        return rows
    }

    /// Where `/permissions` lands. Claude Code has one page. Codex-style providers
    /// have two (file access and approvals), so they land on the list showing both.
    static func permissionsStartPage(for provider: CodexProvider?) -> RelayAddSheetPage {
        provider == .claude ? .permissions : .root
    }

    static func canSend(
        text: String,
        hasAttachments: Bool,
        isSending: Bool,
        isListening: Bool,
        providerReady: Bool
    ) -> Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasAttachments)
            && !isSending
            // Only LISTENING blocks an ordinary send. Once capture has stopped the
            // words are already in the field.
            && !isListening
            && providerReady
    }

    /// Send was tapped while the microphone was open. Once the final transcript has
    /// landed the message goes out on its own, unless the user cancelled meanwhile
    /// or nothing was heard.
    static func shouldSendAfterDictation(
        text: String,
        hasAttachments: Bool,
        isSending: Bool,
        providerReady: Bool,
        stillWanted: Bool
    ) -> Bool {
        stillWanted && canSend(
            text: text,
            hasAttachments: hasAttachments,
            isSending: isSending,
            isListening: false,
            providerReady: providerReady
        )
    }

    /// The field while dictating: the draft that was already there, then what was
    /// said. Nil means nothing was heard yet, so the field is left alone.
    static func dictatedText(prefix: String, transcript: String) -> String? {
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return nil }
        let base = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
        return base.isEmpty ? spoken : "\(base)\n\n\(spoken)"
    }

    /// A short session must still fill the strip from the right, so the history is
    /// left-padded with silence rather than drawn from the leading edge.
    static func paddedLevels(_ levels: [Double], count: Int) -> [Double] {
        let live = levels.suffix(max(0, count))
        return Array(repeating: 0, count: max(0, count - live.count)) + live
    }

    /// Where wrapping chips land: left to right, onto a new line when the next one
    /// would pass the trailing edge. Nothing is ever placed wider than `maxWidth`,
    /// so a row of chips can grow taller but never scroll sideways.
    static func flowFrames(
        sizes: [CGSize],
        maxWidth: CGFloat,
        spacing: CGFloat,
        lineSpacing: CGFloat
    ) -> (frames: [CGRect], size: CGSize) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for size in sizes {
            let width = min(size.width, maxWidth)
            if x > 0, x + width > maxWidth {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            frames.append(CGRect(x: x, y: y, width: width, height: size.height))
            widest = max(widest, x + width)
            x += width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return (frames, CGSize(width: widest, height: y + lineHeight))
    }

    static let sheetMaxScreenFraction: CGFloat = 0.7

    /// A sheet is as tall as its content up to about 70% of the screen; past that the
    /// content scrolls.
    static func sheetHeight(content: CGFloat, screen: CGFloat) -> CGFloat {
        let cap = (screen * sheetMaxScreenFraction).rounded()
        guard content > 0 else { return min(360, cap) }
        return min(content.rounded(.up), cap)
    }
}

// MARK: - Shared pieces

/// 36pt quiet disc in a 44pt hit area. Shared by the composer row and sheet headers.
struct RelayQuietCircleLabel: View {
    let systemImage: String
    var glyphSize: CGFloat = 15
    var weight: Font.Weight = .semibold

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: glyphSize, weight: weight))
            .foregroundStyle(AppTheme.textPrimary)
            .frame(width: 36, height: 36)
            .background(RelayComposerPalette.quietFill, in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

/// Chips that wrap onto further lines instead of scrolling sideways.
struct RelayFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    private func arrange(_ subviews: Subviews, maxWidth: CGFloat) -> (frames: [CGRect], size: CGSize) {
        let sizes = subviews.map { subview -> CGSize in
            let ideal = subview.sizeThatFits(.unspecified)
            guard ideal.width > maxWidth else { return ideal }
            return subview.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        }
        return RelayComposerLogic.flowFrames(
            sizes: sizes,
            maxWidth: maxWidth,
            spacing: spacing,
            lineSpacing: lineSpacing
        )
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let arranged = arrange(subviews, maxWidth: maxWidth)
        return CGSize(
            width: maxWidth.isFinite ? maxWidth : arranged.size.width,
            height: arranged.size.height
        )
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arranged = arrange(subviews, maxWidth: bounds.width)
        for (subview, frame) in zip(subviews, arranged.frames) {
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }
}

private struct RelaySheetHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Bottom sheet sized to whatever it holds. The content is measured and the detent
/// follows it, so moving between pages of different lengths resizes the sheet.
struct RelayFittedSheet<Content: View>: View {
    /// A page with a search field wants the whole screen: a fitted sheet would sit
    /// under the keyboard.
    var expands = false
    @ViewBuilder var content: Content
    @State private var contentHeight: CGFloat = 0

    private var detent: PresentationDetent {
        if expands { return .large }
        return .height(RelayComposerLogic.sheetHeight(
            content: contentHeight,
            screen: UIScreen.main.bounds.height
        ))
    }

    var body: some View {
        ScrollView {
            content
                .frame(maxWidth: .infinity)
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(key: RelaySheetHeightKey.self, value: proxy.size.height)
                    }
                }
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .onPreferenceChange(RelaySheetHeightKey.self) { height in
            guard abs(height - contentHeight) > 0.5 else { return }
            contentHeight = height
        }
        .presentationDetents([detent])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(RelayComposerPalette.sheetGround)
        .preferredColorScheme(.dark)
    }
}

/// Close or back circle on the leading side, serif title centred.
struct RelaySheetHeader: View {
    enum Leading {
        case close
        case back(to: String)
    }

    let title: String
    let leading: Leading
    let action: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                switch leading {
                case .close:
                    RelayQuietCircleLabel(systemImage: "xmark", glyphSize: 13)
                case .back:
                    RelayQuietCircleLabel(systemImage: "chevron.left", glyphSize: 14)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel)

            Text(title)
                .font(AppTheme.serifFont(size: 19))
                .foregroundStyle(AppTheme.textPrimary)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)

            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 10)
        .padding(.top, 19)
        .padding(.bottom, 8)
    }

    private var accessibilityLabel: String {
        switch leading {
        case .close: return "Close"
        case .back(let destination): return "Back to \(destination)"
        }
    }
}

/// One rounded group of rows with inset hairlines between them.
struct RelaySheetGroup<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(
                RelayComposerPalette.groupFill,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .padding(.horizontal, 16)
    }
}

struct RelaySheetDivider: View {
    var leadingInset: CGFloat = 16

    var body: some View {
        Rectangle()
            .fill(AppTheme.hairline)
            .frame(height: 1)
            .padding(.leading, leadingInset)
            .padding(.trailing, 16)
    }
}

/// A row you pick: title, optional detail, ember check when it is the current one.
struct RelaySheetChoiceRow: View {
    let title: String
    var detail: String? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(AppTheme.uiFont(size: 16, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(RelayComposerPalette.value)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, detail == nil ? 0 : 11)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A row that opens a page: title, current value, chevron.
struct RelaySheetValueRow: View {
    var systemImage: String? = nil
    let title: String
    let value: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(RelayChatStyle.secondary)
                        .frame(width: 18)
                }
                Text(title)
                    .font(AppTheme.uiFont(size: 16, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                Text(value)
                    .font(AppTheme.uiFont(size: 15))
                    .foregroundStyle(RelayComposerPalette.value)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(RelayComposerPalette.value)
            }
            .padding(.leading, 16)
            .padding(.trailing, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(value)")
        .accessibilityAddTraits(.isButton)
        // Collapsing the children drops the button's own activation, so name it.
        .accessibilityAction(.default, action)
    }
}

private extension AnyTransition {
    static var relaySheetPush: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .trailing).combined(with: .opacity),
            removal: .move(edge: .trailing).combined(with: .opacity)
        )
    }

    static var relaySheetRoot: AnyTransition {
        .asymmetric(
            insertion: .move(edge: .leading).combined(with: .opacity),
            removal: .move(edge: .leading).combined(with: .opacity)
        )
    }
}

// MARK: - Model sheet

struct RelayModelSheet: View {
    /// Already restricted to the thread's provider by the composer.
    let visibleSections: RelayModelPickerSections
    let selectedChoice: RelayModelChoice?
    let threadProvider: CodexProvider?
    let efforts: [CodexReasoningEffort]
    let selectedEffort: CodexReasoningEffort?
    /// Goes through the composer's provider guard.
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onClose: () -> Void

    var startPage: RelayModelSheetPage = .model
    /// The agent tab to open on instead of the one that owns the selection.
    var startTab: RelayModelSheetTab? = nil

    @State private var shownPage: RelayModelSheetPage?
    @State private var pickedTab: RelayModelSheetTab?

    private var page: RelayModelSheetPage { shownPage ?? startPage }

    private var tabs: [RelayModelSheetTab] { RelayModelSheetTab.tabs(for: visibleSections) }

    private var tab: RelayModelSheetTab? {
        if let pickedTab, tabs.contains(pickedTab) { return pickedTab }
        if let startTab, tabs.contains(startTab) { return startTab }
        return RelayModelSheetTab.initial(for: visibleSections, selectedChoice: selectedChoice)
    }

    var body: some View {
        RelayFittedSheet {
            ZStack(alignment: .top) {
                switch page {
                case .model:
                    modelPage.transition(.relaySheetRoot)
                case .effort:
                    effortPage.transition(.relaySheetPush)
                }
            }
            // The sheet's own bottom safe area supplies the rest of the margin.
            .padding(.bottom, 4)
        }
    }

    private var modelPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelaySheetHeader(title: "Model", leading: .close, action: onClose)

            if threadProvider == nil {
                agentPills
                if let tab {
                    choiceGroup(tab.choices(in: visibleSections), tab: tab)
                }
            } else {
                // A thread stays with its harness, so there is nothing to switch
                // between: the harness is named once, above its models.
                ForEach(visibleSections.agents) { harness in
                    groupLabel(harness.title)
                    choiceGroup(harness.choices, tab: .agent(harness.provider))
                }
                if !visibleSections.chatModels.isEmpty {
                    groupLabel(visibleSections.agents.isEmpty
                        ? RelayModelChoice.harnessTitle(for: threadProvider ?? .codex)
                        : "Chat")
                    choiceGroup(visibleSections.chatModels, tab: .chat)
                }
            }

            if showsEffort,
               let effortLabel = RelayComposerLogic.effortLabel(efforts: efforts, selected: selectedEffort) {
                RelaySheetGroup {
                    RelaySheetValueRow(title: "Effort", value: effortLabel) {
                        withAnimation(.easeOut(duration: 0.22)) { shownPage = .effort }
                    }
                    .accessibilityIdentifier("relay-effort-chip")
                }
                .padding(.top, 12)
                .transition(.opacity)
            }
        }
    }

    /// A tap on a model row. It selects the model and leaves the sheet open, so the
    /// Effort row for that model is on screen at once instead of on a second visit.
    /// The sheet closes by its close circle, a drag down or a tap outside. Animated
    /// so the check, the Effort row and the fitted height move together.
    func pick(_ choice: RelayModelChoice) {
        withAnimation(.easeOut(duration: 0.22)) { onPickChoice(choice) }
    }

    private var showsEffort: Bool {
        RelayModelSheetTab.showsEffort(
            visibleTab: tab,
            sections: visibleSections,
            selectedChoice: selectedChoice,
            threadProvider: threadProvider
        )
    }

    /// Every agent is on screen at once and nothing scrolls sideways: one row of
    /// pills when they fit the sheet, otherwise a three-column grid of names.
    private var agentPills: some View {
        ViewThatFits(in: .horizontal) {
            agentPillRow
            agentGrid
        }
    }

    private func agentButton<Label: View>(
        _ candidate: RelayModelSheetTab,
        @ViewBuilder label: () -> Label
    ) -> some View {
        Button {
            pickedTab = candidate
        } label: {
            label()
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(candidate == tab ? .isSelected : [])
        .accessibilityIdentifier("relay-model-agent-\(candidate.id)")
    }

    private var agentPillRow: some View {
        HStack(spacing: 8) {
            ForEach(tabs) { candidate in
                let isSelected = candidate == tab
                agentButton(candidate) {
                    HStack(spacing: 7) {
                        switch candidate {
                        case .agent(let provider):
                            RelayComposerProviderMark(
                                provider: provider,
                                size: 14,
                                color: isSelected ? AppTheme.textPrimary : RelayChatStyle.secondary
                            )
                        case .chat:
                            Image(systemName: "bubble.left")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        Text(candidate.title)
                            .font(AppTheme.uiFont(size: 14, weight: .medium))
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .foregroundStyle(isSelected ? AppTheme.textPrimary : RelayChatStyle.secondary)
                    .padding(.leading, 12)
                    .padding(.trailing, 14)
                    .frame(height: 36)
                    .background {
                        if isSelected {
                            Capsule().fill(RelayComposerPalette.selectedPillFill)
                        } else {
                            Capsule().strokeBorder(AppTheme.hairlineStrong, lineWidth: 1)
                        }
                    }
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 10)
    }

    /// Too many agents for one row: equal cells, names only, all visible.
    private var agentGrid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 8), count: 3),
            spacing: 8
        ) {
            ForEach(tabs) { candidate in
                let isSelected = candidate == tab
                agentButton(candidate) {
                    Text(candidate.title)
                        .font(AppTheme.uiFont(size: 14, weight: isSelected ? .semibold : .medium))
                        .foregroundStyle(isSelected ? AppTheme.textPrimary : RelayChatStyle.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, 8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background {
                            let cell = RoundedRectangle(cornerRadius: 12, style: .continuous)
                            if isSelected {
                                cell.fill(RelayComposerPalette.selectedPillFill)
                            } else {
                                cell.strokeBorder(AppTheme.hairlineStrong, lineWidth: 1)
                            }
                        }
                        .contentShape(Rectangle())
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 16)
    }

    private func groupLabel(_ title: String) -> some View {
        RelayCapsLabel(text: title, color: RelayComposerPalette.value)
            .padding(.horizontal, 32)
            .padding(.top, 6)
            .padding(.bottom, 8)
            .accessibilityAddTraits(.isHeader)
    }

    private func choiceGroup(_ choices: [RelayModelChoice], tab: RelayModelSheetTab) -> some View {
        RelaySheetGroup {
            ForEach(choices) { choice in
                RelaySheetChoiceRow(
                    title: tab.rowTitle(for: choice),
                    selected: choice == selectedChoice
                ) {
                    pick(choice)
                }
                if choice.id != choices.last?.id {
                    RelaySheetDivider()
                }
            }
        }
    }

    private var effortPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelaySheetHeader(title: "Effort", leading: .back(to: "Model")) {
                withAnimation(.easeOut(duration: 0.22)) { shownPage = .model }
            }
            RelaySheetGroup {
                ForEach(efforts) { effort in
                    RelaySheetChoiceRow(
                        title: effort.label,
                        selected: effort == (selectedEffort ?? efforts.first)
                    ) {
                        onPickEffort(effort)
                        withAnimation(.easeOut(duration: 0.22)) { shownPage = .model }
                    }
                    if effort.id != efforts.last?.id {
                        RelaySheetDivider()
                    }
                }
            }
            .padding(.top, 2)
        }
    }
}

// MARK: - Add sheet

/// Attachments, permissions and skills behind the composer's "+". Replaces both the
/// old run-settings sheet and the attach dialog.
struct RelayAddSheet: View {
    let provider: CodexProvider?
    let cameraAvailable: Bool
    /// True while a message is going out or streaming back.
    let attachDisabled: Bool
    let claudePermissionMode: RelayClaudePermissionMode
    let codexApprovalPolicy: RelayCodexApprovalPolicy
    let codexSandbox: RelayCodexSandbox
    let skills: [CodexSkillDescriptor]
    let selectedSkillIDs: Set<String>
    /// The sheet closes first; the composer starts the picker once it has gone.
    let onPickSource: (RelayAttachmentSource) -> Void
    let onPickClaudePermission: (RelayClaudePermissionMode) -> Void
    let onPickCodexApproval: (RelayCodexApprovalPolicy) -> Void
    let onPickCodexSandbox: (RelayCodexSandbox) -> Void
    let onToggleSkill: (CodexSkillDescriptor) -> Void
    let onClose: () -> Void

    @State private var page: RelayAddSheetPage
    @State private var skillSearch = ""

    init(
        startPage: RelayAddSheetPage = .root,
        provider: CodexProvider?,
        cameraAvailable: Bool,
        attachDisabled: Bool,
        claudePermissionMode: RelayClaudePermissionMode,
        codexApprovalPolicy: RelayCodexApprovalPolicy,
        codexSandbox: RelayCodexSandbox,
        skills: [CodexSkillDescriptor],
        selectedSkillIDs: Set<String>,
        onPickSource: @escaping (RelayAttachmentSource) -> Void,
        onPickClaudePermission: @escaping (RelayClaudePermissionMode) -> Void,
        onPickCodexApproval: @escaping (RelayCodexApprovalPolicy) -> Void,
        onPickCodexSandbox: @escaping (RelayCodexSandbox) -> Void,
        onToggleSkill: @escaping (CodexSkillDescriptor) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.provider = provider
        self.cameraAvailable = cameraAvailable
        self.attachDisabled = attachDisabled
        self.claudePermissionMode = claudePermissionMode
        self.codexApprovalPolicy = codexApprovalPolicy
        self.codexSandbox = codexSandbox
        self.skills = skills
        self.selectedSkillIDs = selectedSkillIDs
        self.onPickSource = onPickSource
        self.onPickClaudePermission = onPickClaudePermission
        self.onPickCodexApproval = onPickCodexApproval
        self.onPickCodexSandbox = onPickCodexSandbox
        self.onToggleSkill = onToggleSkill
        self.onClose = onClose
        _page = State(initialValue: startPage)
    }

    private var rows: [RelayAddSheetPage] { RelayComposerLogic.addRows(for: provider) }

    var body: some View {
        RelayFittedSheet(expands: page == .skills) {
            ZStack(alignment: .top) {
                switch page {
                case .root:
                    rootPage.transition(.relaySheetRoot)
                case .permissions:
                    permissionsPage.transition(.relaySheetPush)
                case .fileAccess:
                    fileAccessPage.transition(.relaySheetPush)
                case .approvals:
                    approvalsPage.transition(.relaySheetPush)
                case .skills:
                    skillsPage.transition(.relaySheetPush)
                }
            }
            // The sheet's own bottom safe area supplies the rest of the margin.
            .padding(.bottom, 4)
        }
    }

    private func go(to next: RelayAddSheetPage) {
        withAnimation(.easeOut(duration: 0.22)) { page = next }
    }

    // MARK: Root

    private var rootPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelaySheetHeader(title: "Add", leading: .close, action: onClose)

            HStack(spacing: 8) {
                if cameraAvailable {
                    tile("Camera", systemImage: "camera", source: .camera)
                }
                tile("Photos", systemImage: "photo.on.rectangle", source: .photos)
                tile("Files", systemImage: "folder", source: .files)
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .disabled(attachDisabled)

            if !rows.isEmpty {
                RelaySheetGroup {
                    ForEach(rows) { row in
                        valueRow(for: row)
                        if row != rows.last {
                            RelaySheetDivider(leadingInset: 44)
                        }
                    }
                }
                .padding(.top, 12)
            }
        }
    }

    private func tile(_ title: String, systemImage: String, source: RelayAttachmentSource) -> some View {
        Button {
            onPickSource(source)
        } label: {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.system(size: 20, weight: .regular))
                    .frame(height: 22)
                Text(title)
                    .font(AppTheme.uiFont(size: 14, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(attachDisabled ? AppTheme.textTertiary : AppTheme.textPrimary)
            .frame(maxWidth: .infinity)
            .frame(height: 84)
            .background(
                RelayComposerPalette.tileFill,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-add-\(title.lowercased())")
    }

    @ViewBuilder
    private func valueRow(for row: RelayAddSheetPage) -> some View {
        switch row {
        case .permissions:
            RelaySheetValueRow(
                systemImage: "hand.raised",
                title: "Permissions",
                value: claudePermissionMode.label
            ) { go(to: .permissions) }
            .accessibilityIdentifier("relay-permission-chip")
        case .fileAccess:
            RelaySheetValueRow(
                systemImage: "folder",
                title: "File access",
                value: codexSandbox.label
            ) { go(to: .fileAccess) }
            .accessibilityIdentifier("relay-permission-chip")
        case .approvals:
            RelaySheetValueRow(
                systemImage: "hand.raised",
                title: "Approvals",
                value: codexApprovalPolicy.label
            ) { go(to: .approvals) }
            .accessibilityIdentifier("relay-approval-chip")
        case .skills:
            RelaySheetValueRow(
                systemImage: "hammer",
                title: "Skills",
                value: RelayComposerLogic.skillsValueLabel(selectedCount: selectedSkillIDs.count)
            ) { go(to: .skills) }
            .accessibilityIdentifier("relay-skill-chip")
        case .root:
            EmptyView()
        }
    }

    // MARK: Permission pages

    private func subpage<Rows: View>(_ title: String, @ViewBuilder rows: () -> Rows) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            RelaySheetHeader(title: title, leading: .back(to: "Add")) { go(to: .root) }
            rows()
        }
    }

    private var permissionsPage: some View {
        subpage("Permissions") {
            RelaySheetGroup {
                ForEach(RelayClaudePermissionMode.allCases) { mode in
                    RelaySheetChoiceRow(
                        title: mode.label,
                        detail: mode.detail,
                        selected: mode == claudePermissionMode
                    ) { onPickClaudePermission(mode) }
                    if mode != RelayClaudePermissionMode.allCases.last {
                        RelaySheetDivider()
                    }
                }
            }
            .padding(.top, 2)
        }
    }

    private var fileAccessPage: some View {
        subpage("File access") {
            RelaySheetGroup {
                ForEach(RelayCodexSandbox.allCases) { level in
                    RelaySheetChoiceRow(
                        title: level.label,
                        detail: level.detail,
                        selected: level == codexSandbox
                    ) { onPickCodexSandbox(level) }
                    if level != RelayCodexSandbox.allCases.last {
                        RelaySheetDivider()
                    }
                }
            }
            .padding(.top, 2)

            // Full access states its consequence where it is chosen.
            if codexSandbox.isUnsandboxed {
                Text("Codex will not be stopped from changing anything on this machine, including files outside your work.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.statusWarn)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 32)
                    .padding(.top, 12)
                    .accessibilityIdentifier("relay-sandbox-consequence")
            }
        }
    }

    private var approvalsPage: some View {
        subpage("Approvals") {
            RelaySheetGroup {
                ForEach(RelayCodexApprovalPolicy.allCases) { policy in
                    RelaySheetChoiceRow(
                        title: policy.label,
                        detail: policy.detail,
                        selected: policy == codexApprovalPolicy
                    ) { onPickCodexApproval(policy) }
                    if policy != RelayCodexApprovalPolicy.allCases.last {
                        RelaySheetDivider()
                    }
                }
            }
            .padding(.top, 2)
        }
    }

    // MARK: Skills

    private var filteredSkills: [CodexSkillDescriptor] {
        let query = skillSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return skills }
        return skills.filter {
            $0.name.lowercased().contains(query)
                || $0.title.lowercased().contains(query)
                || $0.description.lowercased().contains(query)
        }
    }

    private var skillsPage: some View {
        let matches = filteredSkills
        let noun = (provider ?? .codex).relayPresentation.skillsTitle.lowercased()
        return subpage("Skills") {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(RelayComposerPalette.value)
                TextField(
                    "",
                    text: $skillSearch,
                    prompt: Text("Search installed skills").foregroundStyle(AppTheme.textSecondary)
                )
                .font(AppTheme.uiFont(size: 16))
                .foregroundStyle(AppTheme.textPrimary)
                .tint(AppTheme.accent)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityLabel("Search installed skills")
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .background(
                RelayComposerPalette.tileFill,
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 12)

            RelaySheetGroup {
                if matches.isEmpty {
                    Text(skillSearch.isEmpty ? "No installed \(noun)" : "No matching \(noun)")
                        .font(AppTheme.uiFont(size: 15))
                        .foregroundStyle(RelayComposerPalette.value)
                        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                        .padding(.horizontal, 16)
                } else {
                    ForEach(matches) { skill in
                        RelaySheetChoiceRow(
                            title: skill.title,
                            detail: skill.description,
                            selected: selectedSkillIDs.contains(skill.id)
                        ) { onToggleSkill(skill) }
                        if skill.id != matches.last?.id {
                            RelaySheetDivider()
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Neutral provider mark

/// The provider's mark in ink rather than its brand accent. Inside the composer and
/// its sheets the mark only names the harness; colour is kept for the primary action.
struct RelayComposerProviderMark: View {
    let provider: CodexProvider
    var size: CGFloat = 14
    var color: Color = RelayChatStyle.secondary

    var body: some View {
        Group {
            if let assetName = provider.relayPresentation.assetName {
                Image(assetName)
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
            } else {
                Image(systemName: provider.relayPresentation.systemImage)
                    .resizable()
                    .scaledToFit()
            }
        }
        .foregroundStyle(color)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Dictation, in the control row

/// What the composer's second row holds while the microphone is open: cancel, the
/// live waveform, the clock, stop. Send stays in the row beside it. Same height as
/// the idle controls, so starting to dictate never moves the composer.
struct RelayDictationControls: View {
    let levels: [Double]
    let elapsed: TimeInterval
    /// Capture has stopped and the tail of the transcript is still arriving.
    let finalizing: Bool
    let onCancel: () -> Void
    let onStop: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            Button(action: onCancel) {
                RelayQuietCircleLabel(systemImage: "xmark", glyphSize: 13)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-dictate-cancel")
            .accessibilityLabel("Cancel dictation")

            waveform

            Text(RelayStreamingTranscriber.durationLabel(elapsed))
                .font(AppTheme.monoFont(size: 12))
                .monospacedDigit()
                .foregroundStyle(finalizing ? AppTheme.textTertiary : RelayChatStyle.secondary)
                .fixedSize()
                .padding(.leading, 8)
                .padding(.trailing, 4)
                .accessibilityLabel(
                    finalizing
                        ? "Transcribing"
                        : "Listening, \(RelayStreamingTranscriber.durationLabel(elapsed))"
                )

            Button(action: onStop) {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(finalizing ? RelayComposerPalette.disabledGlyph : AppTheme.textPrimary)
                    .frame(width: 12, height: 12)
                    .frame(width: 36, height: 36)
                    .background(RelayComposerPalette.quietFill, in: Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(finalizing)
            .accessibilityIdentifier("relay-dictate")
            .accessibilityLabel("Stop dictation and keep the text")
        }
        .frame(height: 44)
    }

    /// Centre-anchored bars of measured loudness, newest at the trailing edge and
    /// older ones fading out, so the shape reads as moving in a direction. The two
    /// newest carry the brighter ember: that is where the eye should land.
    ///
    /// Not a progress fill (dictation has no end point to fill toward) and not a
    /// spinner, which would prove only that a timer is running.
    private var waveform: some View {
        let samples = RelayComposerLogic.paddedLevels(
            levels,
            count: RelayStreamingTranscriber.waveformSampleCount
        )
        let newest = samples.count - 1
        // The bars are an overlay on a flexible spacer: however many there are, they
        // take the width the row has left and are clipped at the leading edge, so
        // the row can never grow or wrap.
        return Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 30)
            .overlay(alignment: .trailing) {
                HStack(alignment: .center, spacing: 2) {
                    ForEach(samples.indices, id: \.self) { index in
                        Capsule(style: .continuous)
                            .fill(index >= newest - 1 ? AppTheme.accentBright : AppTheme.accent)
                            .frame(width: 3, height: max(3, 30 * samples[index]))
                            .opacity(0.2 + 0.8 * (Double(index) / Double(max(1, newest))))
                    }
                }
                .fixedSize()
                // Capture has stopped, so the bars are history, not a live reading.
                .opacity(finalizing ? 0.3 : 1)
            }
            .clipped()
            .overlay {
                if finalizing {
                    RelayCapsLabel(text: "Transcribing", color: AppTheme.accent)
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 2)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.1), value: samples)
            .animation(.easeOut(duration: 0.18), value: finalizing)
            .accessibilityHidden(true)
    }
}
