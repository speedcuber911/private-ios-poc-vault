# Editorial Ember Design Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Roll the approved "Editorial Ember" design language (spec: `docs/superpowers/specs/2026-08-11-editorial-ember-design.md`) across every screen of the Relay iOS app.

**Architecture:** Token-first rollout. Task 1 rewrites `AppTheme` (in `POCVaultApp.swift`) with the new palette/type/shape tokens plus three shared primitives (`RelayCapsLabel`, `RelayPrimaryButtonStyle`, `RelayOutlineButtonStyle`), keeping the old token names as clearly-marked legacy aliases so every screen keeps compiling. Tasks 2–7 migrate one screen cluster each. Task 8 deletes the legacy aliases, greps for stragglers, and runs full verification.

**Tech Stack:** SwiftUI, iOS app `POCVault` (product name Relay), Xcode project `ios/POCVault/POCVault.xcodeproj`, scheme `POCVault`, simulator `iPhone 17`. Custom fonts DM Sans (`DMSans-9ptRegular`) and DM Mono (`DMMono-Regular`) are already bundled; serif is the system New York via `design: .serif`.

## Global Constraints

- Palette (spec §3): canvasTop `#1E1B17`, canvasBottom `#151310`, ink `#EDE8DF` (opacity steps 1.0 / 0.55 / 0.38 / 0.25), hairline ink@0.10, hairlineStrong ink@0.16, emberBright `#E8965C`, ember `#D4804A`, emberDeep `#C96F35`, onEmber `#1C1207`, statusError `#D9776B`, statusWarn `#E0B25C`. Success states have **no color** (cream text).
- **No dots** (spec rule 5): no colored `Circle()` status indicators, no badge dots, no colored blob pills. Status is small-caps words; liveness is a ticking duration / animated ellipsis.
- **Ember is earned** (rule 3): full-chroma gradient only on a screen's primary action, the user chat bubble, and live-activity text. Never render accent at reduced opacity over dark ground for a control fill (disabled = cream at 0.08).
- **One surface** (rule 2): no gray boxes-in-boxes. Lists are full-bleed rows with 1px hairlines. Rounded containers only for things that genuinely float (sheets, menus, the user bubble).
- Serif for identity, DM Sans for function, DM Mono for paths/sizes/durations/code (rule 1).
- Copy: no instructional footnotes; taglines ≤ 6 words (rule 6).
- Preserve every `accessibilityIdentifier` and `accessibilityLabel` that exists today (e.g. `relay-model-chip`, `relay-credential-submit`, `relay-username`, `relay-password`, `relay-send`, `relay-open-chat`, `relay-threads`, `relay-viewer-wrap-toggle`).
- The app stays dark-only (`.preferredColorScheme(.dark)` pins stay).
- No new files: shared primitives live in `POCVaultApp.swift` under `AppTheme` (the project uses classic pbxproj groups; adding files means pbxproj surgery we don't need).
- Build check per task: `xcodebuild build -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17' -quiet` → `** BUILD SUCCEEDED **`.
- Full suite (Tasks 1 and 8): same command with `test` instead of `build` → `** TEST SUCCEEDED **`.
- Commit after every task with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and the Claude-Session line used earlier in this repo.

---

### Task 1: AppTheme retune + shared primitives

**Files:**
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift:581-631` (the `AppTheme` enum)

**Interfaces:**
- Produces (used by every later task):
  - `AppTheme.canvasTop`, `.canvasBottom`, `.bgCanvas` (solid `#1A1815`), `.canvasGradient`
  - `.textPrimary/.textSecondary/.textTertiary/.textFaint` (ink at 1.0/0.55/0.38/0.25)
  - `.hairline`, `.hairlineStrong`
  - `.accent/.accentBright/.accentDeep/.onEmber/.accentGradient/.userBubbleGradient`
  - `.statusWarn`, `.statusError`, `.shadowColor`, `.emberShadow`
  - `AppTheme.serifFont(size:weight:)` (New York), existing `.uiFont`/`.monoFont` unchanged
  - `RelayCapsLabel(text:color:size:)` view
  - `RelayPrimaryButtonStyle(isEnabled:)`, `RelayOutlineButtonStyle()` button styles
  - Legacy aliases kept until Task 8: `bgSurface`, `bgSurfaceHi`, `threadPreviewBackground`, `strokeSubtle`, `strokeStrong`, `inactiveTab`, `statusOK`, `statusInfo`, `statusNeutral`, `glassTint`, `glassStroke`

- [ ] **Step 1: Replace the `AppTheme` enum** at `POCVaultApp.swift:581-631` with:

```swift
/// Editorial Ember design language — see docs/superpowers/specs/2026-08-11-editorial-ember-design.md.
/// Serif for identity, sans for function; one surface with hairlines; ember only where
/// attention belongs; status is typographic, never a dot.
enum AppTheme {
    // Canvas
    static let canvasTop = Color(hex: 0x1E1B17)
    static let canvasBottom = Color(hex: 0x151310)
    /// Solid canvas for sheets and fills that cannot take the gradient.
    static let bgCanvas = Color(hex: 0x1A1815)
    static let canvasGradient = LinearGradient(
        colors: [canvasTop, canvasBottom],
        startPoint: .top,
        endPoint: .bottom
    )

    // Ink — cream at four opacity steps. Success/neutral status text uses these.
    static let textPrimary = ink
    static let textSecondary = ink.opacity(0.55)
    static let textTertiary = ink.opacity(0.38)
    static let textFaint = ink.opacity(0.25)

    // Structure — hairlines instead of boxes.
    static let hairline = ink.opacity(0.10)
    static let hairlineStrong = ink.opacity(0.16)

    // Ember — the primary action, the user's own words, live activity. Nothing else.
    static let accent = Color(hex: 0xD4804A)
    static let accentBright = Color(hex: 0xE8965C)
    static let accentDeep = Color(hex: 0xC96F35)
    static let onEmber = Color(hex: 0x1C1207)
    static let accentGradient = LinearGradient(
        colors: [accentBright, accentDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let userBubbleGradient = accentGradient

    // Status text colors (words, not shapes). Success stays cream on purpose.
    static let statusWarn = Color(hex: 0xE0B25C)
    static let statusError = Color(hex: 0xD9776B)

    // Depth
    static let shadowColor = Color.black.opacity(0.35)
    static let emberShadow = accentDeep.opacity(0.25)

    private static let ink = Color(hex: 0xEDE8DF)

    // LEGACY tokens — remaining call sites migrate screen-by-screen in Tasks 2–7;
    // deleted in Task 8. Do not add new uses.
    static let bgSurface = ink.opacity(0.06)
    static let bgSurfaceHi = Color(hex: 0x232220)
    static let threadPreviewBackground = Color(hex: 0x272522)
    static let strokeSubtle = hairline
    static let strokeStrong = hairlineStrong
    static let inactiveTab = ink.opacity(0.38)
    static let statusOK = ink.opacity(0.55)
    static let statusInfo = ink.opacity(0.55)
    static let statusNeutral = ink.opacity(0.38)
    static let glassTint = ink.opacity(0.04)
    static let glassStroke = ink.opacity(0.10)

    static func uiFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMSans-9ptRegular", size: size).weight(weight)
    }

    static func monoFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMMono-Regular", size: size).weight(weight)
    }

    /// New York serif — screen titles, wordmark, folder/chat headers only.
    static func serifFont(size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

/// Small-caps letterspaced label — the only rendering for status words, bylines,
/// and section labels (spec rule 5: status is typographic, never a dot).
struct RelayCapsLabel: View {
    let text: String
    var color: Color = AppTheme.textTertiary
    var size: CGFloat = 10

    var body: some View {
        Text(text.uppercased())
            .font(AppTheme.uiFont(size: size, weight: .semibold))
            .tracking(1.1)
            .foregroundStyle(color)
    }
}

/// Primary action: full-chroma ember pill, one per screen at most.
/// Disabled state desaturates to cream — never dimmed ember (spec rule 3).
struct RelayPrimaryButtonStyle: ButtonStyle {
    var isEnabled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTheme.uiFont(size: 16, weight: .semibold))
            .foregroundStyle(isEnabled ? AppTheme.onEmber : AppTheme.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(
                isEnabled
                    ? AnyShapeStyle(AppTheme.accentGradient)
                    : AnyShapeStyle(AppTheme.textPrimary.opacity(0.08)),
                in: Capsule()
            )
            .shadow(color: isEnabled ? AppTheme.emberShadow : .clear, radius: 20, y: 6)
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Secondary action: hairline outline pill, cream text.
struct RelayOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTheme.uiFont(size: 15, weight: .medium))
            .foregroundStyle(AppTheme.textPrimary)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
```

- [ ] **Step 2: Build**

Run: `xcodebuild build -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17' -quiet`
Expected: `** BUILD SUCCEEDED **` (legacy aliases keep every call site compiling).

- [ ] **Step 3: Full test suite**

Run: `xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17' -quiet`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 4: Commit** — `feat(ios): Editorial Ember tokens + shared primitives`

---

### Task 2: Entry flow — AuthenticationView, RelayOnboardingView, RelayRestoringView

**Files:**
- Modify: `ios/POCVault/POCVault/Views/AuthenticationView.swift` (body, `brand`, `authCard` → `form`, `authFieldStyle`)
- Modify: `ios/POCVault/POCVault/Views/RelayOnboardingView.swift` (icon tiles, CTA, page dots)
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift:91-106` (`RelayRestoringView`)

**Interfaces:**
- Consumes: `RelayCapsLabel`, `RelayPrimaryButtonStyle`, `AppTheme.serifFont`, `.hairlineStrong`, `.onEmber` from Task 1.
- Preserves: identifiers `relay-username`, `relay-email`, `relay-password`, `relay-credential-submit`, `relay-sign-in-with-apple`, `relay-onboarding-continue`; the `Mode` enum and all submit/Apple/nonce logic untouched.

- [ ] **Step 1: Restyle AuthenticationView.** Keep everything from `credentialsAreValid` down unchanged. Replace `body`, `brand`, `authCard`, and the `authFieldStyle` extension with:

```swift
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case username, email, password
    }

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()

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
                .padding(.top, 72)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
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
                if accountStore.isWorking {
                    ProgressView().tint(AppTheme.onEmber)
                } else {
                    Text(mode.rawValue)
                }
            }
            .buttonStyle(RelayPrimaryButtonStyle(isEnabled: credentialsAreValid && !accountStore.isWorking))
            .disabled(!credentialsAreValid || accountStore.isWorking)
            .accessibilityIdentifier("relay-credential-submit")

            SignInWithAppleButton(.continue) { request in
                let nonce = Self.randomNonce()
                appleNonce = nonce
                request.requestedScopes = [.fullName, .email]
                request.nonce = Self.sha256(nonce)
            } onCompletion: { result in
                handleAppleCompletion(result)
            }
            .signInWithAppleButtonStyle(.whiteOutline)
            .frame(height: 50)
            .clipShape(Capsule())
            .disabled(accountStore.isWorking)
            .accessibilityIdentifier("relay-sign-in-with-apple")
        }
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
```

Delete the old `authCard`, the `Mode` `Picker`, both footnote `Text` blocks, and the `authFieldStyle()` extension at the bottom of the file. The `Mode` enum itself stays (its `rawValue` labels the CTA).

- [ ] **Step 2: Restyle RelayOnboardingView.** In `RelayOnboardingView.swift`:
  - Page icon: replace the 116pt glass tile block (lines 45–53) with a bare glyph:

```swift
                            Image(systemName: item.icon)
                                .font(.system(size: 48, weight: .medium))
                                .foregroundStyle(AppTheme.accentGradient)
```

  - Title: `.font(.system(size: 31, weight: .medium, design: .serif))` → `.font(AppTheme.serifFont(size: 31))`.
  - Header "Relay": `.font(.system(size: 24, weight: .medium, design: .serif))` → `.font(AppTheme.serifFont(size: 24))`; the `"\(page + 1) of \(pages.count)"` counter becomes `RelayCapsLabel(text: "\(page + 1) of \(pages.count)")`.
  - Page dots: `.tabViewStyle(.page(indexDisplayMode: .always))` → `.indexDisplayMode: .never` (the header counter already shows position; dots violate rule 5).
  - CTA: replace the label styling + `.background(AppTheme.accentGradient, …)` with `.buttonStyle(RelayPrimaryButtonStyle())` around a plain `Text(page == pages.count - 1 ? "Enter Relay" : "Continue")`; keep `relay-onboarding-continue`.

- [ ] **Step 3: Restyle RelayRestoringView** (`POCVaultApp.swift:91-106`): keep structure, change tint only — `ProgressView().tint(AppTheme.accent)` stays, no other change needed.

- [ ] **Step 4: Build** (same command). Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 5: Commit** — `feat(ios): Editorial Ember entry flow (auth, onboarding)`

---

### Task 3: FileBrowserView — workspace browser

**Files:**
- Modify: `ios/POCVault/POCVault/Browser/FileBrowserView.swift`

**Interfaces:**
- Consumes: `RelayCapsLabel`, `AppTheme.serifFont`, `.hairline`, `.textFaint`.
- Preserves: `relay-open-chat`, "Folder options" labels, all view-model wiring, `.searchable`, context menus, create-folder alert.
- Deferred (noted in spec §5): the "folder shows *task running* in metadata" item needs job data the directory listing does not carry — out of scope here; recorded in Task 8's notes.

- [ ] **Step 1: Serif screen title.** The root keeps `.navigationTitle(viewModel.folderName)` for the nav stack, but display switches to inline with a custom in-content header. Change lines 52–53 to:

```swift
        .navigationTitle(viewModel.folderName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleDisplayMode(.inline)
```

  and add a serif title header as the first element inside `listContent`'s `LazyVStack` (before the error banner):

```swift
                if isRoot {
                    VStack(alignment: .leading, spacing: 6) {
                        RelayCapsLabel(
                            text: viewModel.errorMessage == nil ? "Connected · mTLS" : "Offline",
                            color: viewModel.errorMessage == nil ? AppTheme.textTertiary : AppTheme.statusError
                        )
                        Text("Workspaces")
                            .font(AppTheme.serifFont(size: 32))
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 6)
                    .padding(.bottom, 14)
                }
```

  In simulator builds the connection line reads from the same condition — no special casing.
  Non-root screens keep the system inline title; add a serif principal item to `toolbarContent`:

```swift
        ToolbarItem(placement: .principal) {
            Text(viewModel.folderName)
                .font(AppTheme.serifFont(size: 17))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
        }
```

  Guard it with `if !isRoot` (root shows its own header; keep the root nav bar title empty by changing the root's `.navigationTitle` argument to `isRoot ? "" : viewModel.folderName`).

- [ ] **Step 2: Rows.** In `FileBrowserRow`:
  - Icon tile: 40→32pt, radius 11→9, folder fill `AppTheme.accent.opacity(0.14)`→`0.12`, file fill `AppTheme.bgSurface`→`AppTheme.textPrimary.opacity(0.06)`, glyph size 16→14.
  - Name font: `uiFont(size: 15, weight: .semibold)` → `uiFont(size: 15, weight: .medium)`.
  - Row padding: `.padding(.vertical, 10)` → `.padding(.vertical, 13)`; horizontal 16→20.
  - Chevron color `AppTheme.textTertiary` → `AppTheme.textFaint`.
  - Divider: keep the hairline overlay, change `.fill(AppTheme.strokeSubtle)` → `.fill(AppTheme.hairline)` and `.padding(.leading, 69)` → `.padding(.leading, 64)`.
  - Workspace badge: replace the ember-pill badge body with a bare caps label (no background):

```swift
    @ViewBuilder
    private var workspaceBadge: some View {
        if entry.isRegistered {
            RelayCapsLabel(text: "Workspace", color: AppTheme.accent, size: 9)
        }
    }
```

- [ ] **Step 3: Empty state + truncation + error banner.**
  - Empty-state title `uiFont(size: 16, weight: .semibold)` → `serifFont(size: 20)`.
  - `FileBrowserErrorBanner`: swap the filled background for a hairline: remove `.background(AppTheme.statusError.opacity(0.10), …)` and add `.overlay { RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AppTheme.statusError.opacity(0.3), lineWidth: 1) }`.
  - `truncationRow` divider → `AppTheme.hairline`.

- [ ] **Step 4: Build.** Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 5: Commit** — `feat(ios): Editorial Ember file browser`

---

### Task 4: RelayChatView + RelayMarkdownViews — the conversation

**Files:**
- Modify: `ios/POCVault/POCVault/Views/RelayChatView.swift`
- Modify: `ios/POCVault/POCVault/Views/RelayChatViewModel.swift` (one computed property)
- Modify: `ios/POCVault/POCVault/Rendering/RelayMarkdownViews.swift` (token swaps only)

**Interfaces:**
- Consumes: `RelayCapsLabel`, `AppTheme.serifFont`, `.onEmber`, `.hairline`, `.hairlineStrong`.
- Produces: `RelayChatViewModel.folderPathLabel: String?` (the jail path for the header subtitle).
- Preserves: `relay-model-chip`, `relay-effort-chip`, `relay-send`, `relay-stop`, `relay-threads`, all VM calls, streaming/scroll behavior, haptics.

- [ ] **Step 1: VM path label.** In `RelayChatViewModel.swift`, directly below `folderDisplayName` (line ~268), add:

```swift
    /// Full jail path shown under the chat header; nil for the root chat.
    var folderPathLabel: String? {
        workspacePath
    }
```

  (If `workspacePath` is declared `private`, change it to `private(set) var` access or keep the computed property inside the class — the computed property inside the class works regardless.)

- [ ] **Step 2: Top bar.** Replace the gradient folder circle + bold title block (lines 107–127) with a serif header; keep the dismiss and new-conversation buttons but flatten them (no `bgSurfaceHi` circles — bare glyphs):

```swift
            VStack(alignment: .leading, spacing: 2) {
                Text(viewModel.folderDisplayName)
                    .font(AppTheme.serifFont(size: 24))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                if let path = viewModel.folderPathLabel {
                    Text(path)
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
```

  Dismiss/new buttons: drop `.background(AppTheme.bgSurfaceHi, in: Circle())`, set glyph color `AppTheme.textSecondary`, keep frames and accessibility labels. Remove the ember blur halo at lines 17–21 (`AppTheme.accent.opacity(0.06).blur(…)` block) — the canvas stands alone.

- [ ] **Step 3: Threads access bar → hairline row.** Replace the boxed banner (its `.background(AppTheme.bgSurface, …)` + stroke overlay) with a full-bleed row: leading glyph `bubble.left.and.bubble.right` in `AppTheme.textSecondary` (no circle tile), title `uiFont(14, .medium)`, count in `monoFont(11)` `textTertiary` (no capsule fill), chevron `textFaint`, separated from the transcript by a bottom `AppTheme.hairline` rectangle overlay. Keep `relay-threads` identifier and the label.

- [ ] **Step 4: Bubbles — prose replies.** In `RelayChatBubble`:
  - Assistant messages lose the container: apply `.padding/.background/.overlay/.clipShape/.shadow` only `if isUser`. Concretely, split the message column out and conditionally wrap:

```swift
            Group {
                if isUser {
                    messageColumn
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(AppTheme.userBubbleGradient)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .shadow(color: AppTheme.shadowColor.opacity(0.4), radius: 10, y: 4)
                } else {
                    messageColumn
                        .padding(.vertical, 2)
                }
            }
```

    where `messageColumn` is the existing `VStack(alignment: .leading, spacing: 7)`.
  - Delete the `avatar` view and its call site; delete `bubbleBackground`/`bubbleStroke`.
  - Byline: replace the label `HStack` head with `RelayCapsLabel(text: bylineText, color: isUser ? AppTheme.onEmber.opacity(0.7) : AppTheme.accent)` where:

```swift
    private var bylineText: String {
        if isUser { return "You" }
        let provider = item.provider?.displayName ?? "Relay"
        if let model = item.modelLabel { return "\(provider) · \(model)" }
        return provider
    }
```

    "Copied" flash becomes `RelayCapsLabel(text: "Copied", color: AppTheme.textSecondary, size: 9)` (kills a `statusOK` use).
  - User bubble text colors: `metaColor`/footer already derive from `bgCanvas` — change to `AppTheme.onEmber.opacity(0.7)`; in `RelayMarkdownText` (Step 7) the user-aligned prose color changes to `onEmber`.
  - `RelayTypingDots`: dots shrink to 5pt and recolor `AppTheme.textTertiary` (animated ellipsis = allowed liveness).
  - Streaming caret fill `AppTheme.accent` stays (live-activity ember).

- [ ] **Step 5: Job card + status pill → typographic status.** In `RelayJobCard` / `RelayStatusPill` / `relayTint`:
  - Replace `RelayStatusPill` body with a ticking caps label (no capsule fill):

```swift
private struct RelayStatusPill: View {
    let status: CodexJobStatus
    let startedAt: Date?

    var body: some View {
        if status.isActive, let startedAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                RelayCapsLabel(
                    text: "\(status.label) · \(elapsedLabel(to: context.date))",
                    color: AppTheme.accentBright
                )
            }
        } else {
            RelayCapsLabel(text: status.label, color: status.relayTint)
        }
    }

    private func elapsedLabel(to now: Date) -> String {
        guard let startedAt else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
```

    Call site: `RelayStatusPill(status: job.status, startedAt: job.startedAt ?? job.createdAt)`.
  - `relayTint` mapping (spec: success has no color): `.succeeded` → `AppTheme.textSecondary`, `.failed` → `AppTheme.statusError`, `.queued/.running/.canceling` → `AppTheme.accentBright`, `.canceled/.timeout/.unknown` → `AppTheme.textTertiary`.
  - Card container: replace `.background(AppTheme.bgSurfaceHi, …)` + ember stroke with a hairline only:

```swift
        .padding(14)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(job.status.isActive ? AppTheme.accent.opacity(0.35) : AppTheme.hairline, lineWidth: 1)
        }
```

  - Provider name next to the status becomes part of one caps line: replace the `Text(job.provider.displayName)` with nothing and fold provider into the leading label: `RelayCapsLabel(text: job.provider.displayName, color: AppTheme.textTertiary)` after the status pill. Duration trailing text stays mono.

- [ ] **Step 6: Composer.** In `RelayComposer`:
  - `chipLabel`: background `AppTheme.bgSurfaceHi` → none; add `.overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))`; chip text becomes caps: replace the inner `Text(text)` font with `AppTheme.uiFont(size: 11, weight: .semibold)` + `.tracking(0.8)` + `.textCase(.uppercase)`; icon + badge colors stay ember.
  - Input container: replace the `.ultraThinMaterial`/glassTint/glassStroke background block with:

```swift
            .background {
                Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1)
            }
```

  - Send button: keep the ember gradient circle; inactive state fill `AppTheme.bgSurface` → `AppTheme.textPrimary.opacity(0.08)`; drop the ember shadow when enabled (`.shadow(color: .clear, …)` or remove the modifier).
  - Composer wrapper `.background(AppTheme.bgCanvas)` → `.background(AppTheme.canvasBottom)`.
  - Mic recording tint `AppTheme.statusWarn` stays.

- [ ] **Step 7: Empty conversation + drawer + banner + markdown.**
  - `RelayEmptyConversation`: replace the 78pt gradient circle with a bare 30pt glyph in `AppTheme.accentGradient`; title → `serifFont(size: 24)`; chip: hairline outline instead of `bgSurfaceHi` fill.
  - `RelayThreadDrawer`: `historyRow` — delete the `Circle().fill(AppTheme.statusWarn)` active dot, replace with `RelayCapsLabel(text: "Active", color: AppTheme.accentBright, size: 9)`; the mode label pill loses its `.background(AppTheme.accent.opacity(0.15), in: Capsule())` and becomes `RelayCapsLabel(text: historyModeLabel(item), color: AppTheme.accent, size: 9)`; `.listRowBackground(AppTheme.bgSurface)` → `.listRowBackground(Color.clear)` (both occurrences); "New conversation" row keeps ember text.
  - `RelayStatusBanner`: same hairline treatment as `FileBrowserErrorBanner` (Task 3 Step 3).
  - `RelayMarkdownViews.swift`: user-aligned prose color `AppTheme.bgCanvas.opacity(0.94)` → `AppTheme.onEmber`; table `tableFill` user-aligned `AppTheme.bgCanvas.opacity(0.13)` → `AppTheme.onEmber.opacity(0.10)`, assistant fill `bgCanvas.opacity(0.72)` → `Color.clear` with hairline border `AppTheme.hairline`; `RelayCodeBlock` background `AppTheme.bgCanvas` → `AppTheme.textPrimary.opacity(0.05)`.

- [ ] **Step 8: Build.** Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 9: Commit** — `feat(ios): Editorial Ember chat — prose replies, typographic status`

---

### Task 5: FileViewerView — reader

**Files:**
- Modify: `ios/POCVault/POCVault/Browser/FileViewerView.swift`

**Interfaces:**
- Consumes: `AppTheme.serifFont`, `.hairline`, `RelayCapsLabel`.
- Preserves: `relay-viewer-wrap-toggle`, `relay-viewer-raw-toggle`, all fetch/paging logic (`FileViewerViewModel` untouched).

- [ ] **Step 1: Toolbar identity.** In `toolbarContent`'s principal item: title font `uiFont(size: 15, weight: .semibold)` → `serifFont(size: 16)`; metadata line font `uiFont(size: 10)` → `monoFont(size: 10)`.
- [ ] **Step 2: Fallback tile.** In `fallbackContent`: replace the 78pt `accent.opacity(0.14)` tile with a bare 30pt glyph in `AppTheme.accent`; name → `serifFont(size: 20)`; the ShareLink pill: `.background(AppTheme.accent.opacity(0.14), in: Capsule())` → `.overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))` with text `AppTheme.textPrimary`.
- [ ] **Step 3: Banners + dividers.** `FileViewerErrorBanner` → hairline treatment (as Task 3); `statusRows` divider `strokeSubtle` → `hairline`.
- [ ] **Step 4: Build.** Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 5: Commit** — `feat(ios): Editorial Ember file viewer`

---

### Task 6: LibraryView + CodexStatusView + root chrome

**Files:**
- Modify: `ios/POCVault/POCVault/Views/LibraryView.swift`
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift` (`CodexStatusView`, `CodexActivityRow`, `libraryCover` close button, `CodexProvider.activityTint`)

**Interfaces:**
- Consumes: `RelayCapsLabel`, `serifFont`, `.hairline`.
- Preserves: filter behavior, recents, navigation, refresh, "Close library" label.

- [ ] **Step 1: LibraryView.**
  - `VaultHeader`: "Relay" `.font(.system(size: 24, …, design: .serif))` → `serifFont(size: 28)`; subtitle stays; `HeaderButton` loses its `bgSurface` circle (bare glyph, `textSecondary`).
  - `RelayLogoMark`: `bgSurfaceHi` tile → `AppTheme.textPrimary.opacity(0.06)` fill, glyph `textSecondary`.
  - `SearchBox`: `.background(AppTheme.bgSurfaceHi, …)` → `Capsule` hairline: `.overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))`, no fill.
  - `POCSectionHeader` filter pills: selected keeps `textPrimary` text but loses the `Capsule().fill(textPrimary.opacity(0.12))` — selected = `textPrimary` + underline `Rectangle` 2pt `AppTheme.accent` beneath; unselected = `textTertiary`, no decoration.
  - `POCEntryCard`: icon tile `bgSurfaceHi` → `textPrimary.opacity(0.06)`; divider → `hairline`.
  - `StatusCard`: filled `bgSurfaceHi` card → hairline outline (`RoundedRectangle(cornerRadius: 16)` stroke `AppTheme.hairline`), glyph color `AppTheme.textSecondary` (ember not earned here).
  - Small `Text("Library")` section caption at line 130 → `RelayCapsLabel(text: "Library")`.
- [ ] **Step 2: CodexStatusView (POCVaultApp.swift).**
  - Title font → `serifFont(size: 28)`.
  - Section toggle (`Activity`/`Health`): remove the `bgSurfaceHi` container + `textPrimary.opacity(0.12)` selection fill; text-tab style as in LibraryView Step 1 (selected = cream + 2pt ember underline).
  - `CodexActivityRow`: icon tile `bgSurface` → `textPrimary.opacity(0.06)`; provider capsule → `RelayCapsLabel(text: provider.displayName, color: provider == .codex ? AppTheme.textTertiary : AppTheme.accent, size: 9)` with no background; status `HStack` → `RelayCapsLabel(text: item.status?.label ?? "Thread", color: statusColor, size: 9)` and drop the `statusSymbol` glyph entirely; `statusColor` remap: active → `AppTheme.accentBright`, succeeded → `AppTheme.textSecondary`, failed/timeout → `AppTheme.statusError`, else `AppTheme.textTertiary` (kills `statusOK`/`statusWarn` greens here); divider → `hairline`.
  - `CodexProvider.activityTint`: `.claude/.cursor/...` cases `AppTheme.accent` stays; `.codex` `textSecondary` stays (no change beyond compiling).
  - `libraryCover` close button: drop `bgSurfaceHi` circle, bare chevron glyph.
- [ ] **Step 3: Build.** Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 4: Commit** — `feat(ios): Editorial Ember library + status feed`

---

### Task 7: DiagnosticsView + AccountSettingsView

**Files:**
- Modify: `ios/POCVault/POCVault/Views/DiagnosticsView.swift`
- Modify: `ios/POCVault/POCVault/Views/AccountSettingsView.swift`

**Interfaces:**
- Consumes: `RelayCapsLabel`, `serifFont`, `RelayPrimaryButtonStyle`, `.hairline`.
- Preserves: `relay-delete-account`, all identity-store logic, alert flows, `showsNavigationChrome` variant.

- [ ] **Step 1: Diagnostics check rows → typographic status.** Replace `DiagnosticRow`'s colored `checkmark.circle.fill`/`xmark.circle.fill` icon with:

```swift
            RelayCapsLabel(
                text: check.isPassing ? "OK" : "Fail",
                color: check.isPassing ? AppTheme.textSecondary : AppTheme.statusError,
                size: 9
            )
            .frame(width: 34, alignment: .leading)
            .padding(.top, 3)
```

  This removes the last colored-glyph status indicators (and a `statusOK` use).
- [ ] **Step 2: Diagnostics cards + chrome.**
  - `diagnosticCard` modifier: `bgSurfaceHi` fill → hairline outline (`RoundedRectangle(cornerRadius: 16).stroke(AppTheme.hairline, lineWidth: 1)`), no fill.
  - Screen title already serif — switch to `AppTheme.serifFont(size: 28)` / `20` respectively; the runtime subtitle under it → `RelayCapsLabel(text: AppConfiguration.runtimeMode)`.
  - "Checks" section heading → `RelayCapsLabel(text: "Checks", size: 11)`.
  - `certificateHeader` icon tile `bgSurface` → `textPrimary.opacity(0.06)`.
  - Import button: `.foregroundStyle(AppTheme.bgCanvas)` + `.background(AppTheme.accent, …)` → `.buttonStyle(RelayPrimaryButtonStyle())` on a plain `Label`.
  - Passphrase field: `bgCanvas` box → underline hairline (same pattern as auth fields, no focus tracking needed: static `AppTheme.hairlineStrong` underline).
  - Nav "Done" pill keeps its shape but fill `textPrimary.opacity(0.08)` stays (it floats on a sheet — allowed).
- [ ] **Step 3: AccountSettings.** Keep the `Form` (it is a native settings sheet — a floating surface), but: `.tint(AppTheme.accent)` on the Form, section headers via `Text` stay, delete nothing functional. Only change: error `Label` color already `statusError`; no dot indicators exist here. This screen is deliberately light-touch.
- [ ] **Step 4: Build.** Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 5: Commit** — `feat(ios): Editorial Ember diagnostics + settings`

---

### Task 8: Legacy-token removal, audit, full verification

**Files:**
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift` (delete legacy aliases)
- Modify: any files the greps surface

- [ ] **Step 1: Audit greps.** From `ios/POCVault/POCVault`:

```bash
grep -rn "statusOK\|bgSurfaceHi\|bgSurface\|threadPreviewBackground\|glassTint\|glassStroke\|strokeSubtle\|strokeStrong\|inactiveTab\|statusInfo\|statusNeutral" --include="*.swift" .
grep -rn "Circle()" --include="*.swift" . | grep -v "in: Circle()"
```

Expected: first grep hits only the `AppTheme` legacy block itself (fix any stragglers with the treatments from Tasks 2–7 — e.g. `threadPreviewBackground` lives in `RelayChatSessionStore.swift` or model files if used; `statusInfo/statusNeutral` may appear in `CodexModels.swift` helpers). Second grep: remaining `Circle()` uses must be non-status (record buttons, send button) — any status dot found gets the `RelayCapsLabel` treatment.

- [ ] **Step 2: Delete the legacy alias block** from `AppTheme` (everything between the `// LEGACY tokens` comment and the font functions). Re-run the first grep. Expected: zero hits.
- [ ] **Step 3: Full test suite.**

Run: `xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17' -quiet`
Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 4: Simulator screenshot pass.** `ios/launch-simulator.sh`, then `xcrun simctl io booted screenshot <scratchpad>/ember-auth.png` on the sign-in screen. If the local auth fixture (`127.0.0.1:8790`) is available, drive deeper screens with the `RELAY_UITEST_CREATE_*` / `RELAY_UITEST_PATH` / `RELAY_UITEST_CHAT` env hooks and screenshot browser + chat; otherwise verify those visually via the build products and note it. Check every shot against the six rules.
- [ ] **Step 5: Note deferred item.** Append to the spec's §5 browser bullet: folder-level "task running" metadata deferred — the directory listing API carries no job state; needs a server-side field or session-store wiring, tracked as follow-up.
- [ ] **Step 6: Commit** — `feat(ios): Editorial Ember cleanup — legacy tokens removed`

---

## Self-Review Notes

- Spec coverage: §2 rules 1–6 land in Tasks 2–7 (serif headers, hairline structure, earned ember, prose replies, typographic status, copy cuts); §3 tokens in Task 1; §4 components in Tasks 1–2 (buttons/fields), 4 (chips), 3/6 (lists/tabs); §5 per-screen in Tasks 2–7; §7 verification in Task 8. Gap: browser "task running" metadata — explicitly deferred with reason (no data source), recorded in Task 8 Step 5.
- Types: `RelayCapsLabel(text:color:size:)`, `RelayPrimaryButtonStyle(isEnabled:)`, `AppTheme.serifFont(size:weight:)`, `folderPathLabel` used consistently across tasks.
- No placeholder steps; every code step shows the code.
