# Agent Note: Tolerate strict-schema fillers in sandbox escalation and goal arguments

Status: implemented

English | [中文](2026-09-09-copilot-responses-strict-optional-tool-fields.zh.md)

## Problem

A GitHub Copilot GPT model over the `openai-responses` route bricks every escalating `bash`/`write`/`edit` call and several `update_goal` calls before any work runs. The chain:

1. DSH tool schemas mark only genuinely-required fields `required` and leave the optional control fields (`sandbox_permissions`, `justification`, `max_goal_rounds`) out of `required` — the correct non-strict idiom, and what the schema compiler in `packages/core/tools/src/schema.ts` emits.
2. The pi-ai adapter passes `parameters` through unchanged and sets no per-tool `strict` flag (`packages/llm/llm-pi-ai/src/context.ts`). Installed pi-ai `0.82.1` emits `strict` only when the model's catalog descriptor declares `supportsStrictMode`; no `github-copilot` model declares it, so the wire payload omits `strict` entirely.
3. Per the OpenAI Responses contract, omitting `strict` makes the endpoint auto-normalize the schema toward strict mode — all properties required and non-nullable — whenever it can, unlike Chat Completions, which stays non-strict when `strict` is omitted. Under forced strict the model must emit every property, so it fills the optional fields with plausible values: an enum takes its first value (`sandbox_permissions: "workspace-write"`), a string takes `""` or a sentence, a number takes a plausible non-zero value.
4. DSH then rejected the filler as a real request. `approveEscalation` rejects a same-mode `sandbox_permissions` as "not strictly wider" — pure input validation, before any approval prompt — and `update_goal` rejected a non-zero `max_goal_rounds` on a non-`edit` action. The model does not self-recover, because the rejection text never says "omit the field."

This is an interop incompatibility, not a regression. DSH's non-strict schema idiom is correct on every non-strict endpoint (DeepSeek, Chat Completions, Anthropic); the failure became reachable only when the Copilot Responses route began serving GPT models. It affects every Copilot GPT model on that route — no `github-copilot` descriptor declares `supportsStrictMode` — not only the uncataloged `gpt-6-astra` clone.

## Decision

Harden the optional control fields to tolerate strict-fill on any route, preserving every escalation invariant (pairing, strictly-wider, approval, fail-closed).

- `@deepseek-ai/dsh-sandbox` exports `normalizeEscalationArgs(sandbox_permissions, justification, effectiveMode)`, replacing `validateEscalationArgs`. `sandbox_permissions` is the driver: an escalation exists only when it names a mode strictly wider than the call's effective mode. `null`/absent, a same-mode, or a narrower value escalate nothing and yield `undefined`, so the call runs at its effective mode; only a genuine widen validates a non-empty justification and reaches `approveEscalation`, which keeps its own strictly-wider check as the authoritative enforcement backstop.
- `tool-bash`, `tool-pwsh`, and `tool-fs` (write/edit) call the normalizer in place of the old pairing validation and the removed "not available in this composition" guard, so a filler `sandbox_permissions` runs the call instead of erroring.
- `tool-goal` ignores `objective` and `max_goal_rounds` on every non-`edit` action (`pause`/`resume`/`complete`/`blocked`) whatever their value — they take effect only through `edit` — rather than rejecting a non-zero fill. `blocked_reason` stays rejected on any action but `blocked`. This closes the non-zero numeric gap the earlier empty/zero-only filler handling left open.

## Alternatives considered

**Bump `@earendil-works/pi-ai` to a release that catalogs `supportsStrictMode` (and `gpt-6-astra`) natively.** Kept as a possible follow-up, rejected as the primary fix: it bets on the remote. An independent reproduction (Vercel AI SDK issue #11869) shows a Responses proxy ignoring even an explicit `strict: false`, and Copilot is a proxy, so the bump may not change the wire behavior at all. Even a bump that made pi-ai send a correct strict schema (optionals as `["type","null"]` + required) would produce explicit `null` fills that DSH must still normalize to "absent" — the same null-handling this change adds. B therefore needs a piece of A regardless, and strict-normalization can hit any strict endpoint (Azure OpenAI Responses, direct OpenAI) and any future model missing the capability flag.

**Rewrite DSH tool schemas into strict-compatible form in the adapter (optionals as nullable-and-required).** Rejected: DSH cannot know the endpoint will normalize, because pi-ai reports strict as off for these models, so the adapter would have to override pi-ai's own per-model belief. Defending the tool inputs is endpoint-agnostic and needs no strict awareness.

**Keep the narrower goal rule — strip an edit-only field only when it equals the current stored value.** Rejected: under forced strict the model can fill `max_goal_rounds` with any plausible number, not the current cap, so an equality test still bricks on an arbitrary fill. Ignoring the edit-only fields entirely on non-`edit` actions is simpler and complete, and loses nothing, since those fields cannot take effect on those actions.

**Switch to a Claude/Anthropic route (the interim workaround).** Not a fix: it abandons every Copilot GPT model. Anthropic uses the `anthropic-messages` protocol, which has no strict auto-normalization — which is why the workaround happens to work.

## Consequences

- Every Copilot GPT call over the Responses route runs normally: a filler `sandbox_permissions` equal to or narrower than the effective mode is stripped and the command runs at that mode; a filler `max_goal_rounds`/`objective` on a non-`edit` goal action is ignored. A genuine escalation still validates its justification, requests approval, and fails closed exactly as before.
- The tool families no longer surface `sandbox_permissions is not available in this composition`, `sandbox escalation to … is not strictly wider …`, or `justification is only valid together with sandbox_permissions`; a lone justification is now silently ignored. The bash and pwsh README stable-message lists and the goal README drop these and describe the new tolerance.
- Security is intact: `approveEscalation` remains the single enforcement point for strictly-wider widening and approval, so a direct caller cannot bypass it; the normalizer only stops a no-op filler from reaching it.

## Deferred

- In a `read-only` session a forced `sandbox_permissions: "workspace-write"` is a genuine widen, so it still routes to an approval prompt (or, with an empty-string justification fill, still errors). The normalizer cannot separate a filler from a real ask when the filler happens to be a valid wider target; the common `workspace-write` default is fully fixed.
- On `edit`, `max_goal_rounds` legitimately applies, so a strict-fill of it cannot be distinguished from intent and may set the cap to a fabricated value. `edit` is direct-human-gated and far rarer than the pervasive escalation brick.
- No confining headless composition exists, and a real sandbox snapshot would exercise platform-specific landlock/seatbelt enforcement — non-portable for a keyless fixture. The escalation routing is proven by the deterministic `tool-bash`/`tool-pwsh`/`tool-fs` executor tests instead; only the goal path carries a headless snapshot.

## Testing

- `packages/sandbox/sandbox/tests/escalation.spec.ts` covers `normalizeEscalationArgs`: a genuine widen returns its ask; same-mode, narrower, `null`, absent, and an absent effective mode all strip to `undefined`; a genuine widen still requires a non-empty justification.
- `tool-bash`/`tool-pwsh`/`tool-fs` tool tests assert a same-mode filler executes without a prompt, a lone justification runs, and a genuine widen still validates and approves.
- `tool-goal` tests assert a non-zero `max_goal_rounds` and a non-empty `objective` are ignored on `pause`/`resume`/`complete`/`blocked` while the cap and objective stay put.
- The `goal-tools` keyless headless snapshot injects a non-zero filler on a `pause` and asserts the result is `GOAL_NOT_FOUND` (the ref), not `GOAL_TOOL_INVALID_UPDATE` (a filler rejection) — the fix, end-to-end through the assembled app.

## Related

- The forward-compat shim that makes `gpt-6-astra` reachable is `UNCATALOGED_MODELS` in `packages/llm/llm-pi-ai/src/catalog.ts`; a pi-ai bump that catalogs Astra natively retires it.
- OpenAI Responses strict-mode default: the [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling). Independent reproduction of the omitted-`strict` filler behavior: [Vercel AI SDK issue #11869](https://github.com/vercel/ai/issues/11869).
