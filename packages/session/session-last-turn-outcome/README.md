# @deepseek-ai/dsh-session-last-turn-outcome

English | [中文](README.zh.md)

Function plugin registering the `lastTurnOutcome` projection unit: a last-wins fold over `turn/end` events that maps each turn's `TurnEndReason` to a coarse outcome, served through the session-projection seam (registry snapshot, change feed, and every projection carrier: history tail page, `session/projection` push frames, session list rows). The cross-workspace triage UI reads it to flag stalled sessions; the `./types` and `./client` subpaths re-export the single-source `lastTurnOutcome` key declaration for host and client aggregates without pulling host-side value imports into the client program.

## Fold semantics

- The value is `null` until the first `turn/end`, then the outcome of the most recently ended turn. A composed registry always serves the key, so clients read the value, never key presence.
- Reason kinds map coarsely: `completed` → `normal`; `aborted`/`interrupted` → `interrupted`; `error` → `error`; `max-tokens` → `max-tokens`; `blocked` → `blocked`; any unlisted reason → `normal`. The triage consumer treats `error`/`max-tokens`/`interrupted` as needing attention.
- Last-wins: a session that errored and was later resumed to a clean completion reads `normal` again. A running turn has no `turn/end` yet, so the value reflects the previous completed turn until the current one closes.
- The fold returns the prior state reference when the kind is unchanged, so an unchanged outcome emits no new projection value.

## Composition

```yaml
- id: session-last-turn-outcome
  name: '@deepseek-ai/dsh-session-last-turn-outcome'
```

Injects `sessionProjections` — the plugin's whole purpose; in assemblies without the registry the fiber stays pending and nothing registers.

## Model Experience

None, as the plugin only computes a client-facing read model of already-logged `turn/end` events and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the plugin never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Outcome is whole-session last-wins, not per-turn history** — only the most recent turn's coarse outcome is retained; a consumer needing the sequence of past outcomes reads the log, not this projection.
- **`turn/end` reason ownership lives elsewhere** — the event and its `TurnEndReason` are owned and runtime-checked by dsh-agent-loop and the session surface; unrecognized reason kinds coarsen to `normal` here rather than failing.
- **Mounted where triage consumes it** — assemblies that do not compose this plugin serve no `lastTurnOutcome` key, and their consumers get no stalled-session signal from this source.
