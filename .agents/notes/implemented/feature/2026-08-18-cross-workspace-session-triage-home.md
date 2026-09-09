# Agent Note: Cross-workspace session triage Home view

Status: implemented

English | [中文](2026-08-18-cross-workspace-session-triage-home.zh.md)

## Problem

The Web GUI organizes work one dimension at a time: the sidebar groups sessions under their workspace, and the main pane shows exactly one selected session. That composition is correct for doing work inside a session, but it gives an operator running many sessions across many workspaces no single place to answer the three questions that actually govern their day — which sessions need me right now, which finished while I was away, and what was I building that I should pick back up. Finding those answers by hand means expanding each workspace in the sidebar and reading rows one at a time; the cost grows with the session count, which is exactly the population this harness is meant to scale to. An operator with dozens of live sessions across a handful of directories has no triage surface, so attention-worthy state (a blocking approval, a plan awaiting review, a run that just completed) stays buried next to idle noise.

The signals needed to answer those questions already exist per session and already ride the client session-list store; nothing aggregates or ranks them. [`SessionSummary`](../../../../packages/client/runtime/src/client/sessions/service.ts) carries `pendingInteraction` (`approval | plan-review | question`), `completed` (finished while unselected and not yet opened), `running`, `updatedAt`, `displayTitle`, `cwd`, `parentId`, `origin`, and host-computed `projectionValues`. The store already holds every row across every workspace — the workspace browser filters that superset down to one workspace for display. The missing piece is a presentation surface that reads the whole superset and ranks it by operator attention rather than by directory.

## Decision

A new Web client plugin, `packages/client/ui-home`, ships a cross-workspace triage **Home** surface. Its browser half makes two registrations that share one open-state store: a launcher in the sidebar foot's `sidebar.footer.action` list slot (rendered above Settings) and the triage panel in the frame-wide `shell.overlay` layer, so the launcher toggles the panel the overlay renders. The panel auto-opens on each load as a landing surface. Home never replaces the per-session conversation; selecting any session leaves Home unchanged.

Home is a pure client-side projection over the existing session-list store. It reads the framework `useSessions` and `useWorkspaces` hooks in-component, folds the row superset into attention buckets, and renders them newest-activity-first with the workspace basename shown per row so the cross-workspace picture is legible at a glance. No Host RPC, session event, or object-layer state is introduced; the triage is a deterministic function of bits the object layer already publishes.

### Attention buckets

Home renders three disjoint, operator-ordered buckets, mirroring the three sidebar `StateDot` signals settled in [the completion-dot note](../../implemented/feature/2026-08-06-session-completed-done-dot.md) so the two surfaces never disagree about a session's state:

1. **Needs you** — `pendingInteraction` is set (a blocking approval, plan review, or question). Highest priority; an operator's own input is the scarcest unblocking resource.
2. **Done — review or archive** — `completed` is set (a run finished while the session was unselected and unopened). These are the sessions to sign off and clear.
3. **In flight** — `running` is true and not already surfaced above. Ambient awareness, not a call to act.

Sessions in none of these buckets — idle, parked, already-viewed — are deliberately not listed by default. Suppressing that quiet majority is the point: Home is a triage queue, not a second copy of the full list. A row action opens the session (the existing selection path), and the Done bucket additionally offers Archive inline, reusing the registry-global archive capability from [the session-archive note](../../implemented/feature/2026-07-31-session-archive-global-set.md) rather than a second hide mechanism.

### Placement and layering

Home obeys the client stack's one-way knowledge ([web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md)) and the [slot system standard](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.md). `ui-home` is presentation only — every reactive fact arrives through framework hooks, row actions are inject callbacks over the runtime `sessions` and `workspaces` services (`open` via `sessions.open`, Done-row archive via `workspaces.archiveSession`), and the shared open-state lives in a declared store, never in the object layer. The launcher pairs with the sidebar foot beside Settings; its amber badge counts sessions blocking on the operator (`pendingInteraction` set or `goal.phase` of `blocked`, excluding subagent and blank sessions).

### Signal design

Home is not a re-sort of the session list; it classifies each surfaced session into one state by a first-match precedence ladder, then groups states into sections. The ladder, highest first: (1) `pendingInteraction` set — blocked on you (approve / review plan / answer); (2) `goal.phase = blocked` — blocked on you; (3) the last turn ended `error`, `max-tokens`, or `interrupted` and is not running — stalled (resume); (4) running — working, the agent's move; (5) `goal.phase = complete`, every todo done, or the `completed` bit — done (review / archive); (6) settled with an assistant last message and none of the above — awaiting, the ambiguous ask-versus-handoff case a Tier 1 classifier resolves; (7) the last message is a user or queued prompt — the agent will act next, hidden by default; (8) otherwise idle — recent. Sections: Needs you = states 1–3 (plus 6 when classified as an ask), Done = 5, In flight = 4, Pick up = 6-default and 8. Precedence rationale: a live prompt outranks a durable declared blocker, which outranks a silent stall.

Rows carry the agent's own task context. Line one is the state dot, the session title, and the state's inline action verb. Line two, on Needs-you and Done rows only, is `goal.objective` or the first pending todo — the "what and next" — plus todo progress `X/Y`, the workspace, and the age. Recent rows are a single navigation line (title, workspace, age). Needs you sorts oldest-waiting first so the longest-blocked work surfaces; every other section sorts newest first.

### The deterministic-triage stage (Tier 0)

The shipped stage is deterministic and carries no model cost. It rides the already-cached `goal` and `todos` projections on every session-list row (a thin `dsh-host-apiproxy` list-carrier extension carrying values the watermark cache already holds, not new computation) and the [`lastTurnOutcome`](../../../../packages/session/session-last-turn-outcome/README.md) projection folded from `turn/end` events (`normal | error | max-tokens | interrupted | blocked`), and renders the ladder, sections, two-line context, and inline action verbs over them. The plugin is registered through the three client surfaces (aggregate `references`, `web-app` cordis patch row, `web-app` dependency) per the client new-package checklist.

Two extensions remain deferred, both building on this stage. An **LLM classifier for the ambiguous residual** (state 6) would fold a cached projection like [log-backed session titles](../../implemented/feature/2026-07-21-log-backed-session-titles.md), keyed by the last-event seq and recomputed only when the session advances, over the structured tail (last user message, last assistant message, todo state, last tool outcome) — never over running sessions, and only over surfaced sessions Tier 0 could not classify — emitting `{ summary, attention: blocking | optional | none, nextAction }` from a central cheap model as a client read-model outside the logged-equals-model-visible rule. The **action-inbox reframe** (the unit becomes the pending action, not the session) and archive suggestions derived from age plus goal phase `complete` are the other deferred directions.

## Relationship to adjacent surfaces

Home is triage across sessions; [the Task Surface proposal](../../proposed/feature/2026-08-04-task-surface.md) is structured interaction inside one session. They do not overlap: Home never edits a session's turn, and a Task Surface never lists other sessions. Home also complements, and does not replace, session search ([search not shipped by default](../../implemented/feature/2026-08-02-session-search-not-shipped-default.md)) and the per-workspace [session-list browser](../../implemented/feature/2026-07-25-session-list-browsing-and-manual-order.md): search answers "find a specific past session by content", the workspace browser answers "navigate one project's sessions", and Home answers "what across everything needs me now". Cross-session and cross-workspace resume mechanics stay owned by their existing flows; Home only routes attention to them.

## Alternatives considered

**Mount Home in the main pane on empty selection instead of an overlay panel.** Deferred, not taken for the shipped form: a non-session main-pane surface is one the shell does not have today, and getting that mount wrong risks regressing the blank-new-session flow that currently owns the empty selection. The launcher-plus-overlay form delivers the triage without a competing owner of the composer; the main-pane mount on empty selection remains a later option, and if taken must be a clean shell branch with the new-session affordance still reachable from Home.

**Add an attention section to the existing sidebar workspace browser instead of a dedicated surface.** Rejected as the primary surface: the sidebar is narrow, collapses to a 56px rail, and is structurally grouped by workspace, none of which suits a ranked cross-workspace queue with per-row summaries and inline actions. A compact sidebar attention badge is a reasonable complement — the launcher carries exactly that count — but the full triage needs frame width.

**Compute the triage verdict on the Host as a new projection or RPC.** Rejected: the classification ladder and ranking stay client-side, so the operator's in-memory `completed` reminder ([completion-dot note](../../implemented/feature/2026-08-06-session-completed-done-dot.md)) and the client's live bits combine in one place without a duplicate host read model. Carrying already-cached projection values (`goal`, `todos`, `lastTurnOutcome`) on the list rows is a thin carrier extension, not host-computed triage — the host still only projects per-session facts it already holds; Home decides what they mean.

**Fold the LLM digest into the first release.** Rejected because the core value of triage — instant sorting of existing bits — must not wait on model latency or spend tokens to render a list. The digest is separable and enhances Home without gating it, so it belongs in its own note with its own cost and privacy analysis.

**Auto-archive completed or stale sessions to keep the list clean.** Rejected. Archiving is reversible and never touches the log, but silently removing a session from view still erodes the operator's mental model of what exists. Home surfaces archive *candidates* and lets the operator confirm; it never hides a session the operator did not choose to clear.

**Expose Home as a model-facing tool so an agent can assemble the dashboard.** Rejected: cross-session triage is operator chrome, not an agent capability. It must be deterministic, always present, and identical regardless of any session's model, which is a product-UI concern, not a tool.

## Verification

Keyless composition and component coverage exist for both packages. The `lastTurnOutcome` projection has per-file coverage in `packages/session/session-last-turn-outcome/tests/`: a registry-driven unit spec (reason-kind mapping, last-wins overwrite, the change feed firing only on a kind change, late-mount fold, and key removal on unload) and a real-Loader composition spec that boots the shipped `session + projection-registry + last-turn-outcome` YAML and serves the coarse outcome. Home's browser half has per-file coverage in `packages/client/ui-home/tests/`: an `apply` spec pins launcher and overlay registration into the sidebar-foot and overlay slots, the shared open-state store, the injected `open`/`archive` delegation to the runtime services, deferred injection into undeclared slots, and disposal; a component spec pins the launcher's blocking-count badge and the overlay's first-match ladder (Needs you / In progress / In flight / Pick up / Review or archive), the recent-versus-stale split for a broken run, cross-workspace grouping with per-row workspace and relative age, the two-line goal/todo context, bucket collapse with the overflow note, and open/archive/close row actions. Both packages hit the per-file 100% gate and run from source on a clean checkout (no built `lib/`), which the `session-last-turn-outcome/types` and `/client` tsconfig path mappings make resolvable. Home's states and the sidebar `StateDot` states never disagree for the same session, because both read the same object-layer bits. Tier 0 adds no new model call and keeps triage classification and ranking client-side; its only Host dependency is the already-cached `goal`, `todos`, and `lastTurnOutcome` values carried on list rows.

Coverage gaps: localized zh/en chrome, both themes, keyboard-only operation, and large-list virtualization are not yet asserted, because the shipped panel renders English chrome and un-virtualized capped buckets; those assertions wait on the panel gaining locale wiring and virtualization.

## Consequences

An operator running many sessions across many workspaces gets one attention-ranked queue instead of reading workspace rows one at a time: the launcher's badge surfaces the blocking count at a glance, and the auto-opening panel lands them on triage rather than a blank composer. Because Home is a deterministic client projection over bits the object layer already publishes, it adds no model call, no Host RPC, and no session event, and it can never disagree with the sidebar dots that read the same bits. The costs it accepts: the Done bucket is in-memory per browser and resets on reload; the ambiguous awaiting state (6) is not model-classified until the deferred Tier 1 classifier ships; and buckets can grow long at high session counts, so virtualization and bounded, scannable sections carry the load.

## Risks

The `completed` reminder is per-browser and in-memory by design, so Home's Done bucket resets on a page reload — consistent with the sidebar dot, but an operator who reloads loses the "finished while away" set. This is inherited behavior, not new, and the deferred durable digest is the path to a reload-surviving "done" signal if one is later wanted.

`pendingInteraction` covers only approval, plan-review, and question waits. A session blocked on something outside that set (for example, a long external command) shows as In flight, not Needs you. That matches the current signal's meaning; widening it is a separate change to the pending-interaction source, not to Home.

At high session counts the buckets can still be long. The list must virtualize and the buckets should stay bounded and scannable; a bucket that itself becomes a wall of rows has only moved the overload, so ordering and optional per-workspace collapse inside a bucket need real interaction testing.
