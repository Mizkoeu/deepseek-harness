# @deepseek-ai/dsh-client-ui-home

English | [中文](README.zh.md)

Home plugin: a cross-workspace attention-triage surface. The browser half makes two registrations that share one open-state store — a launcher in the sidebar foot's `sidebar.footer.action` list slot (rendered above Settings) and the triage panel in the frame-wide `shell.overlay` layer — so the launcher toggles the panel the overlay renders. Home reads every session across every workspace through the standard `useSessions` hook in-component, folds the row superset into operator-ordered attention buckets, and never edits a session's turn. Selecting a session elsewhere in the app does not auto-close Home; clicking a Home row opens that session and closes the panel (the row's `openSession` calls `setOpen(false)`). Contract and rationale: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) and the [cross-workspace triage Home note](../../../.agents/notes/implemented/feature/2026-08-18-cross-workspace-session-triage-home.md).

Home is a pure client-side projection: it introduces no Host RPC, session event, or object-layer state. Its buckets are a deterministic function of bits the object layer already publishes on each session row — `pendingInteraction`, `completed`, `running`, `updatedAt`, and the cached `goal` and [`lastTurnOutcome`](../../session/session-last-turn-outcome/README.md) projection values. Row actions are inject callbacks over the runtime `sessions` and `workspaces` services: opening a row calls `sessions.open`, and a Done row archives through `workspaces.archiveSession`.

The launcher renders a labelled row when the sidebar is wide and an icon-only rail control when collapsed, mirroring the New Session and Settings controls. An amber badge carries the count of sessions currently blocking on the operator — those with a `pendingInteraction` or a `goal.phase` of `blocked`, excluding subagent (`parentId`-bearing) and blank sessions.

The `/client` exports are the plugin body (`apply`/`inject`) plus the composed prop and injected-face types only; `HomeOverlay`, `HomeLauncher`, and the view store factory stay package-internal behind the slot registrations. Required services (`inject`): `slots`, `sessions`, `workspaces`. The node half is an empty apply — this package has no host-side behavior.

## Model Experience

None, as Home renders a browser-side triage view over the session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The shipped form is a launcher plus an auto-opening `shell.overlay` panel** — the main-pane-on-empty-selection form described in the design note remains a later option; the view store opens Home on each load and is not persisted.
- **Buckets are deterministic Tier 0 only** — the LLM classifier for the ambiguous ask-versus-handoff residual (design-note Tier 1) is not shipped; sessions that Tier 0 cannot classify are not model-triaged here.
- **The `completed` reminder is per-browser and in-memory** — the Done bucket resets on a page reload, consistent with the sidebar completion dot; there is no reload-surviving "finished while away" signal.
- **`pendingInteraction` covers only approval, plan-review, and question waits** — a session blocked on something outside that set (for example a long external command) surfaces as In flight, not Needs you, matching the current signal's meaning.
- **Triage classification and ranking stay client-side** — the only Host dependency is the already-cached `goal`, `todos`, and `lastTurnOutcome` values carried on list rows; Home adds no new model call.
