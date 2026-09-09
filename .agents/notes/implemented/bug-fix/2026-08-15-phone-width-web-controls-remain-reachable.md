# Agent Note: Phone-width Web controls remain reachable

Status: implemented

English | [中文](2026-08-15-phone-width-web-controls-remain-reachable.zh.md)

## Problem

The Web shell treated every narrow frame as a smaller desktop. Auto-collapse left a 56px sidebar rail in the grid, and opening it restored a 280px grid column; on a 390px phone the conversation therefore received 334px while closed and only 110px while open. The composer toolbar, approval actions, question footer, and plan-review decisions also remained single-row groups. Their optional labels and controls could consume more width than the card, leaving the final Send, Submit, or approval action clipped outside portrait view.

## Decision

AppFrame uses a phone layout below 560px. Navigation occupies no grid track: its closed state is the existing toggle in a 44×52px floating surface, and opening it widens the same mounted sidebar over the conversation at the resolved sidebar width. The conversation retains the full frame width in both states, the sidebar resize handle stays absent, and the ordinary 56px rail plus in-grid resize behavior remain unchanged at wider widths. The sidebar derives its compact presentation from the owner-supplied rendered width, so it follows AppFrame's measured frame rather than independently deciding from the browser window.

The conversation uses 8px composer clearance at the same viewport width and keeps its header clear of the floating toggle. InputBar makes its card a size container; at 460px or less, left controls remain on the first toolbar row while model, context, and the primary action occupy a full second row. The permission trigger keeps its existing icon-only mode, and the model trigger omits the secondary effort caption while the complete selection remains available in its menu.

Approval buttons may wrap and divide the action row. A generic question keeps its pager and feedback on the first footer row and gives Skip and Submit the full second row. Plan-review actions span the footer and may wrap. The cards retain their existing caps and internal scroll regions, so the extra action row consumes footer height rather than moving a decision outside the viewport.

## Alternatives considered

**Shrink the 56px rail everywhere.** Rejected: changing the desktop rail would reclaim only a small amount of phone width, and opening the 280px in-grid sidebar would still reduce a 390px conversation to 110px.

**Hide navigation completely and add a new hamburger button, scrim, focus trap, and auto-close behavior.** Rejected for this correction: the existing sidebar toggle already provides an accessible open and close path. Reusing that mounted control avoids a second navigation state machine while still returning the conversation's grid width.

**Truncate more labels and keep every composer control on one row.** Rejected: permission, model, effort, context, plan, and extension controls vary by composition. Hiding a fixed subset cannot guarantee that the final action remains reachable, while a second row makes the guarantee structural.

## Consequences

Portrait users keep the complete conversation width and can reach Send, approval, question, and plan-review actions without rotating the device. Opening navigation covers the left portion of the conversation until the user closes it; there is deliberately no separate scrim or automatic close policy in this focused change. Dense composer states gain one toolbar row, and decision cards may gain one footer row, trading some vertical space for reachable controls.

The real Web replay scenarios measure a 390×844 viewport. The approval snapshot records a 44×52px collapsed toggle, a 390px conversation, a 366px composer, the primary action on its second row, and no horizontal page overflow. The question snapshot records every button inside its 334px card and the decision actions on a second row; the plan-review scenario verifies the same horizontal containment for all three actions. Unit coverage pins the zero-width phone sidebar track, its 44px owner width, overlay expansion, and absent resize handle.
