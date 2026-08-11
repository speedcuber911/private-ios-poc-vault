# Relay "Editorial Ember" design language — spec

**Date:** 2026-08-11
**Status:** approved direction (brainstormed with visual mockups; user selected
"Editorial Ember" over "Instrument" and "Native Glass", then locked it with one
amendment: no dot/blob status indicators).
**Scope:** app-wide. `AppTheme` in `POCVaultApp.swift` is the single source of
truth; every screen (Authentication, Onboarding, FileBrowser, FileViewer,
RelayChat, Library, AccountSettings, Diagnostics) adopts the language.

## 1. Why

The current UI reads as an unstyled template: near-identical dark-gray rounded
rects stacked inside each other, an accent gradient that renders as muddy brown
on the primary CTA, three competing type voices (system serif wordmark, DM Sans
body, network-glyph icon), and instructional copy that states the obvious. The
redesign commits to one voice — warm, editorial, restrained — so Relay reads
like a deliberate product.

## 2. The six rules

1. **Serif for identity, sans for function.** Screen titles, the wordmark, and
   folder/chat headers use the system serif (New York). Rows, buttons, chat
   bodies, and controls use DM Sans. DM Mono is reserved for paths, byte sizes,
   durations, and code.
2. **One surface, hairline structure.** The warm canvas gradient is the only
   background. Lists and sections separate with 1 px hairlines at low cream
   opacity. No cards-inside-cards; a rounded container appears only when
   something genuinely floats (sheets, menus, the user chat bubble).
3. **Ember is earned.** The full-chroma ember gradient appears only on: the
   primary action of a screen, the user's own chat bubble, and live-activity
   text. Everything else is cream at four opacity steps. Never render the
   accent at reduced opacity over dark ground (that is where the mud came
   from) — disabled states desaturate to cream instead.
4. **Agent replies are prose, not bubbles.** Attribution ("CODEX · GPT-5-CODEX")
   is a small-caps byline above the text. Only the user's messages get a
   bubble.
5. **Status is typographic — never a dot.** No colored circles, blobs, or badge
   dots anywhere. Status is a small-caps word in the status color
   ("RUNNING · 2:14", "OFFLINE", "DONE"); liveness is conveyed by the ticking
   duration (and optionally an animated ellipsis), not by a pulsing shape.
   Neutral/good states stay cream; color appears only when something needs
   attention.
6. **Copy earns its place.** No instructional footnotes ("Sign in is required
   before…"). State is shown, not explained. Taglines are ≤ 6 words.

## 3. Tokens (`AppTheme` replacement)

### Color

| Token | Value | Use |
|---|---|---|
| `canvasTop` | `#1E1B17` | top of canvas gradient |
| `canvasBottom` | `#151310` | bottom of canvas gradient |
| `ink` | `#EDE8DF` | primary text (cream) |
| `inkSecondary` | ink @ 0.55 | metadata, subtitles |
| `inkTertiary` | ink @ 0.38 | placeholders, timestamps |
| `inkFaint` | ink @ 0.25 | disabled, decorative glyphs |
| `hairline` | ink @ 0.10 | separators, outlines |
| `hairlineStrong` | ink @ 0.16 | field/chip outlines |
| `emberBright` | `#E8965C` | gradient start, live-status text |
| `ember` | `#D4804A` | links, inline accent text |
| `emberDeep` | `#C96F35` | gradient end |
| `onEmber` | `#1C1207` | text/icons on ember fills |
| `statusError` | `#D9776B` | error text (warm terracotta) |
| `statusWarn` | `#E0B25C` | warning text (warm amber) |

Success has no color: completed states render in `inkSecondary` ("DONE",
"18 tests green"). Remove `statusOK` green and all uses of colored dots.
`accentGradient` = `emberBright → emberDeep`, 135°. Shadows: ember CTA gets
`emberDeep @ 0.25`, y 6, blur 20; everything else `black @ 0.35`.

### Type

| Role | Font | Size/weight |
|---|---|---|
| Wordmark / hero | serif (New York) | 40 medium |
| Screen title | serif | 32–34 medium |
| Section / chat header | serif | 22 medium |
| Tagline / editorial aside | serif italic | 15 |
| Body / rows | DM Sans | 14–15 regular–medium |
| Metadata | DM Sans | 11–12 |
| Small-caps label | DM Sans | 10–11 semibold, uppercase, tracking 0.08–0.14 em |
| Paths, sizes, durations, code | DM Mono | 11–13 |

### Shape

- Actions, chips, search, composer: pill (999).
- User chat bubble: 18 with a 4 tail corner.
- Glyph tiles (folder/file icons): 9–10.
- Sheets and menus: 24 top radius, canvas-colored with hairline stroke.

## 4. Component rules

- **Primary button:** ember gradient pill, `onEmber` text, semibold. One per
  screen at most. Disabled = `ink @ 0.08` fill with `inkTertiary` text (never
  dimmed ember).
- **Secondary button:** hairline-outline pill, `ink` text.
- **Destructive:** outline pill with `statusError` text.
- **Sign in with Apple:** the white-outline HIG variant (hairline pill, white
  text) so it no longer outranks the brand CTA.
- **Text fields (auth):** underline hairline only — no boxes. Focus state
  thickens the underline and warms it to `ember`.
- **Search / composer fields:** hairline pill.
- **Chips (model, effort, status):** hairline pill, small-caps DM Sans label.
  Live-task chip: "RUNNING · 2:14" in `emberBright` with ticking duration,
  hairline border `ember @ 0.35`, fill `ember @ 0.08`, no dot.
- **Segmented controls:** eliminated where possible. Auth drops
  Sign in / Create account segments for a footer link ("New here? *Create an
  account*" with the link in `ember`).
- **Lists:** full-bleed rows on canvas, 15 px vertical padding, hairline
  separators, glyph tile left (`ember @ 0.12` fill for folders, `ink @ 0.06`
  for files), name + metadata stack, chevron in `inkFaint`.

## 5. Per-screen application

- **AuthenticationView:** icon (bare, no container square) → serif wordmark →
  serif-italic tagline ("Your agents, within reach.") → underline fields →
  ember pill "Sign in" → Apple outline pill → footer create-account link.
  Footnote deleted. Segmented control deleted.
- **FileBrowserView:** small-caps connection line ("CONNECTED · MTLS", cream;
  `statusError` text when offline) above a serif "Workspaces" title (root) or
  folder-name title (children); hairline search pill; list rows per §4. A
  folder with an active task shows "task running" in `ember` inside its
  metadata line — not a dot. Toolbar keeps terminal + overflow glyphs in
  `inkSecondary`.
- **RelayChatView:** serif folder-name header with DM Mono jail path beneath;
  user messages in ember-gradient bubbles; agent replies as prose with
  small-caps bylines; job status as the typographic chip with a "tail" link;
  composer = model/effort chips (small-caps pills) above a hairline pill field
  with an ember circular send button.
- **FileViewerView:** serif filename header, DM Mono path/size line, content on
  bare canvas; code in DM Mono.
- **Library / AccountSettings / Diagnostics / Onboarding:** same grammar —
  serif screen titles, hairline-separated full-bleed rows, small-caps section
  labels, no gray boxes. Diagnostics tables move to DM Mono values with
  typographic status words.
- **App-wide:** replace `bgSurface`/`bgSurfaceHi`/`threadPreviewBackground`
  box fills with canvas + hairline treatments; audit every `statusOK/Warn`
  dot or `Circle()` indicator and convert to status text.

## 6. Out of scope

- App icon artwork (dot-network mark stays as-is for now).
- Light mode — the app remains dark-only (`preferredColorScheme(.dark)`).
- Server/API changes: none.

## 7. Verification

- Screenshot pass on simulator for every screen listed in §5, checked against
  the six rules (grep the codebase for `Circle()` / `statusOK` /
  `bgSurface` to confirm no stragglers).
- Existing unit/UI test suite stays green; accessibility labels and
  identifiers (e.g. `relay-model-chip`) are preserved.
- Contrast: body text ≥ 4.5:1 against canvas (cream steps chosen to pass);
  `onEmber` on ember gradient ≥ 4.5:1.
