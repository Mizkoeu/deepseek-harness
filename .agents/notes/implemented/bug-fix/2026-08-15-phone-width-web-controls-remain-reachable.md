# Agent Note: Phone-width Web controls remain reachable

Status: implemented

English | [中文](2026-08-15-phone-width-web-controls-remain-reachable.zh.md)

## Problem

The Web shell treated every narrow frame as a smaller desktop. On a 390×844 phone the closed sidebar kept a 56px rail in the grid, and opening it restored a 280px grid column that left the conversation about 110px. The question card's Submit and the plan-review card's Approve ran past the card's right edge, and the Settings panel kept its 188px navigation column beside an options column too narrow for its rows. The composer draft used 14px text, so iOS Safari zoomed the page whenever it gained focus, and the page did not account for the notch, status bar, or home indicator.

## Decision

[AppFrame](../../../../packages/client/ui-layout/src/client/AppFrame.tsx) uses a phone layout in browser documents below 560px (`SIDEBAR_OVERLAY_BREAKPOINT`); the macOS and Windows desktop windows, whose minimum width is 520px, keep their own chrome layouts. The sidebar takes no grid track in either state, and the columns carry explicit grid lines. Closed, the column has zero width like the macOS desktop collapse and is also `visibility: hidden`, so its rail controls leave the focus order and accessibility tree; the frame mounts the existing `shell.leading` seat, where ui-sidebar's `HeaderLeadingControls` provides Open sidebar and New Session; the frame publishes `--dsh-frame-leading-clearance` so the conversation title clears them. Open, the same mounted column is absolutely positioned over the full-width conversation at the preferred sidebar width, capped so at least 56px stays uncovered. A scrim over the rest closes it, and a change of main-view Session or main panel closes it through the idempotent `dismissSidebarOverlay` store action. The overlay has no resize handle. On coarse pointers the seat controls are 36px.

Decision cards wrap at the same width. Approval buttons share their row and wrap. The question footer keeps the pager and feedback on its first row and gives Skip and Submit a full second row. The plan-review decision row spans the card under the feedback line and wraps. In browser documents Settings fills the screen inside the safe area, turns its navigation into one horizontally scrolling row under the title, and places feature actions and a 36px close control at the title row's end.

On coarse pointers the composer draft and the question answer field use at least 16px text, which stops iOS focus zoom; the question field keeps its 24px line, so its six-line cap is unchanged. The `apps/web` viewport declares `viewport-fit=cover` and `interactive-widget=resizes-content`, and `#root` pads by `env(safe-area-inset-*)`.

## Alternatives considered

**A 44px floating sidebar toggle.** Rejected: the macOS collapse already defines a zero-width column plus the `shell.leading` reopen seat and its clearance contract. Reusing that path avoids a second compact sidebar presentation and keeps New Session reachable while navigation is closed.

**Keep the rail and only overlay the open sidebar.** Rejected: the 56px rail still costs a seventh of a 390px conversation.

**Disable zoom with `maximum-scale=1`.** Rejected: Android Chrome then also blocks user pinch zoom; raising the focused fields to 16px avoids the iOS zoom without that accessibility cost.

**Per-row Settings fixes.** Rejected: every feature contributes its own row styles, while the cramped options column has one cause in the panel's two-column layout.

## Consequences

Portrait users keep the full conversation width, reach navigation from the top-left seat, and return to the conversation after choosing a Session without a second tap. Decision cards may gain one footer row, trading vertical space for reachable actions. Fixed-position overlays (Settings, menus) are not padded by the root safe-area inset; Settings pads itself, and menus anchor to their triggers. The right panel keeps upstream's narrow-screen rule and opens fullscreen. iOS Safari does not resize the layout for the on-screen keyboard; it scrolls the focused composer into view.

The layout unit tests pin the zero-width tracks, the overlay width and gutter, scrim and navigation dismissal, the breakpoint return to the rail, and the unchanged macOS and Windows desktop layouts. The [phone-shell Web scenario](../../../../apps/web/tests/phone-shell.e2e.ts) measures a 390×844 touch page: navigation, wide markdown containment, the 16px draft, and the stacked Settings panel. The approval, question, and plan-review replay scenarios record their portrait card containment in `mobile.expected.md` goldens.
