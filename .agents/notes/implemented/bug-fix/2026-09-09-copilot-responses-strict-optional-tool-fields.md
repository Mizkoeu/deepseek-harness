# Agent Note: Tolerate strict-schema fillers in sandbox escalation and goal arguments

Status: implemented

English | [中文](2026-09-09-copilot-responses-strict-optional-tool-fields.zh.md)

## Problem

GitHub Copilot GPT models on the `openai-responses` route fill every optional tool field, so escalation-capable calls (`bash`, `pwsh`, `write`, `edit`, `run_code`) and several `update_goal` calls fail before any work runs. The chain:

1. DSH tool schemas list only genuinely required fields in `required`; the optional control fields (`sandbox_permissions`, `justification`, `objective`, `max_goal_rounds`) stay out of it. This is the correct non-strict schema form, and the compiler in `packages/core/tools/src/schema.ts` emits it.
2. The pi-ai adapter passes `parameters` through and sets no per-tool `strict` flag. pi-ai's Responses adapter writes `strict` only when the model descriptor declares `supportsStrictMode`, and no `github-copilot` Responses model in the installed catalog declares it, so the request omits `strict`.
3. The OpenAI Responses API normalizes a tool schema toward strict mode when `strict` is omitted: every property becomes required. The model must then emit every optional field and fills it with a plausible value: an enum takes a member such as the current mode or a narrower one, a string takes `""` or a sentence, and a number takes a plausible value such as `6`. Some strict serializers emit `null` instead.
4. DSH treated those fillers as requests. A narrower `sandbox_permissions` failed as "not strictly wider", a same-mode one with an empty `justification` failed the pairing check in every tool except `bash`, an unadvertised one failed as "not available in this composition", and `update_goal` rejected a non-empty `objective` or non-zero `max_goal_rounds` on `pause`, `resume`, `complete`, or `blocked` with `GOAL_TOOL_INVALID_UPDATE`. The rejection texts never tell the model to omit the field, so it retries the same arguments.

The schemas are correct on every non-strict endpoint (DeepSeek, Chat Completions, Anthropic Messages); the failures occur only where an endpoint enforces strict mode on schemas written for non-strict use.

## Decision

The optional control fields tolerate strict-schema fillers on every route, and genuine escalations keep the same justification, approval, and fail-closed rules.

- `@deepseek-ai/dsh-sandbox` exports [`normalizeEscalationArgs(sandboxPermissions, justification, effectiveMode)`](../../../../packages/sandbox/sandbox/src/escalation.ts). Only a `sandbox_permissions` strictly wider than the call's effective mode (per `WIDER_MODES`) is an escalation; it returns `{ requestedMode, justification }` and requires a non-empty justification (`invalid escalation: sandbox_permissions requires a justification` when absent or `null`, `invalid justification: expected a non-empty sentence` when blank). An absent, `null`, empty, same, narrower, or unknown mode, or any mode when no confining backend is mounted (`effectiveMode` undefined), returns `undefined`, and `justification` is ignored whatever its value.
- `dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-tool-fs` (`write` and `edit` through `FsSandboxController.resolvePolicy`), and `run_code` in `dsh-tools` call the normalizer before approval. `undefined` keeps the standing policy; a genuine escalation goes through `approveEscalation` and applies to that one call. `approveEscalation` keeps its same-mode return and strictly-wider check for direct callers such as `plugin_manager`.
- `dsh-tool-goal` applies `objective` and `max_goal_rounds` only under `edit`, where `""` and `0` count as omitted; `pause`, `resume`, `complete`, and `blocked` ignore both whatever their value. A non-empty `blocked_reason` outside `blocked` is still rejected. This partially supersedes the action restriction in the [model-facing goal tools decision](../feature/2026-07-19-model-facing-goal-tools.md).

## Alternatives considered

**Upgrade pi-ai until the Copilot catalog declares `supportsStrictMode`.** Rejected as the fix. The installed `0.87.1` catalog still declares it for no Copilot Responses model, and Copilot is a proxy that may not honor an explicit `strict: false`. A correctly strict schema would mark optional fields nullable and required, so the model would send `null` fillers that DSH must still treat as absent. Strict normalization can also affect Azure OpenAI Responses, direct OpenAI, and future models without the capability flag.

**Rewrite tool schemas into strict form in the adapter (optional fields nullable and required).** Rejected: the adapter cannot know that the endpoint will normalize, because pi-ai reports strict mode as unsupported for these models. Making the model-visible schemas nullable also changes every recorded tool-schema sidecar. Normalizing tool inputs works on every endpoint without strict awareness.

**Ignore only same-mode escalation fillers and keep rejecting narrower ones.** Rejected: strict fills choose any enum member, and a narrower mode cannot grant authority, so rejecting it only blocks calls. Approval for real widening is unchanged.

**Ignore an edit-only goal field only when it equals the stored value.** Rejected: a strict fill can be any plausible number or sentence, so an equality test still rejects arbitrary fills. The fields cannot take effect outside `edit`, so ignoring them loses nothing.

**Use a Claude route as the workaround.** Not a fix: it abandons every Copilot GPT model. The `anthropic-messages` protocol has no strict normalization, which is why that route works.

## Consequences

- Copilot GPT calls on the Responses route run normally: a filler `sandbox_permissions` at or below the effective mode runs at that mode without a prompt, and filler `objective`/`max_goal_rounds` values on non-edit goal actions are ignored.
- The tools no longer report `sandbox_permissions is not available …`, `sandbox escalation to … is not strictly wider …`, or `justification is only valid together with sandbox_permissions`; a lone justification is ignored. Without a confining backend the escalation fields are ignored, which matches the schema that does not advertise them.
- Security is unchanged: only a strictly wider mode reaches approval, and `approveEscalation` remains the enforcement point for widening.
- Model-visible schema descriptions are unchanged. They still say when a field takes effect (`Required with sandbox_permissions`, `valid only with action edit`), and the tolerance is in execution.

## Known limitations

- In a `read-only` session, a filled `sandbox_permissions: "workspace-write"` is a valid widening target, so it still requests approval or, with an empty justification, fails. The normalizer cannot distinguish that fill from a real request.
- Under `edit`, `max_goal_rounds` takes effect, so a strict fill there can set a fabricated cap. `edit` requires a direct human request.
- Core argument validation rejects JSON `null` for a `string`-typed parameter before `execute`, so `null` fillers reach the normalizer only from callers that bypass that validation. Accepting `null` at the tool boundary requires nullable model-visible schemas.

## Testing

- `packages/sandbox/sandbox/tests/escalation.spec.ts` covers `normalizeEscalationArgs`: strictly wider requests, absent/`null`/empty/same/narrower/unknown modes, a lone justification, no confining backend, and missing or blank justifications for a wider mode.
- The `dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-tool-fs`, and `run_code` (`packages/core/tools/tests/ptc.spec.ts`) tests cover same-mode fillers with blank and non-empty justifications, narrower fillers, lone justifications, fields without a confining backend, and the still-rejected wider request without a justification; none of the ignored cases prompts for approval.
- `packages/goal/tool-goal/tests/tool-goal.spec.ts` covers non-empty `objective` and non-zero `max_goal_rounds` fills on `pause`, `resume`, `blocked`, and `complete` without changing the stored objective or cap.
- The keyless headless `goal-tools` expected transcript (`apps/cli/tests/profiles/headless/tests/expected/goal-tools/`) sends a `pause` with a non-empty `objective` and a non-zero `max_goal_rounds` against a missing goal and pins `GOAL_NOT_FOUND`, which shows the fillers did not cause a rejection.
- The authored headless session scenario `snapshots/session/bash-narrower-mode-filler/` runs `bash` in a `danger-full-access` session with a `workspace-write` filler and an empty justification; the command runs. `snapshots/session/bash-same-mode-empty-justification/` covers the same-mode filler.

## Related

- OpenAI Responses strict-mode behavior: the [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling). A reproduction of omitted-`strict` filler behavior: [Vercel AI SDK issue #11869](https://github.com/vercel/ai/issues/11869).
