/**
 * The escalation vocabulary and choreography shared by every sandbox-enforcing
 * tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
 * strictly-wider ladder, the strict-schema-tolerant argument normalization
 * ({@link normalizeEscalationArgs}), the model-facing
 * denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
 * sequence that resolves a `sandbox_permissions` request through a
 * user-approval channel BEFORE anything executes. One home keeps the two
 * families' approval ordering and verbatim error texts from drifting apart.
 *
 * The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
 * not the approval service type: the tool layer — which owns the agent, the
 * call id, and the tool name — closes over `ctx.approval.request(...)` and
 * hands the closure down, so this package never depends on the approval or
 * agent packages.
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SandboxMode } from './index.ts'

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
 * whenever the mounted capability confines: cutting the enum down to the modes
 * wider than the composition's DEFAULT would strand a session whose effective
 * mode sits below it (a `danger-full-access` default would advertise nothing
 * while a narrower-switched session stays confined with no lever).
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/** One genuine escalation request: a target strictly wider than the call's effective mode plus its reason. */
export interface EscalationArgs {
  /** The requested target mode, strictly wider than the effective mode it was normalized against. */
  requestedMode: SandboxMode
  /** The model's non-empty reason, shown to the user in the approval prompt. */
  justification: string
}

/**
 * Reduce raw `sandbox_permissions`/`justification` tool arguments to a genuine
 * escalation request. A strict-schema endpoint (an OpenAI Responses request
 * that omits `strict` is normalized to all-properties-required) makes the model
 * emit both optional fields on every call, filled with the current or a
 * narrower mode, an empty string, or `null`. Only a `sandbox_permissions`
 * strictly wider than `effectiveMode` (see {@link WIDER_MODES}) requests
 * escalation. Any other value (absent, `null`, empty, same, narrower, or
 * unknown), and any value when no confining backend is mounted
 * (`effectiveMode` undefined), requests nothing, and `justification` is then
 * ignored whatever its value. A genuine request requires a non-empty
 * justification and still passes through {@link approveEscalation}.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument.
 * @param justification - the raw `justification` argument.
 * @param effectiveMode - the call's standing mode, or `undefined` when no confining backend is mounted.
 * @returns the escalation to approve, or `undefined` when the call runs at its standing mode.
 * @throws Error when a strictly wider mode carries no justification or a blank one.
 */
export function normalizeEscalationArgs(
  sandboxPermissions: string | null | undefined,
  justification: string | null | undefined,
  effectiveMode: SandboxMode | undefined,
): EscalationArgs | undefined {
  if (effectiveMode === undefined || sandboxPermissions === null || sandboxPermissions === undefined) return undefined
  const requestedMode = (WIDER_MODES[effectiveMode] ?? []).find(mode => mode === sandboxPermissions)
  if (requestedMode === undefined) return undefined
  if (justification === null || justification === undefined) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification.trim().length === 0) {
    throw new Error('invalid justification: expected a non-empty sentence')
  }
  return { requestedMode, justification }
}

/**
 * The model-facing denial marker — the one vocabulary both enforcing families
 * teach and report, so the model recognizes a policy denial identically
 * whether the kernel refused a bash file effect or the filesystem provider's
 * fence refused a mutation.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields — the nudge lives at the decision point so
 * the sanctioned retry does not depend on the model recalling the tool
 * description.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * The model-facing `sandbox_permissions` parameter description, which carries
 * the escalation rules for every enforcing family.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the parameter description, exactly as the model sees it.
 */
export function sandboxPermissionsDescription(subject: string): string {
  return `The narrowest wider sandbox mode for a one-shot retry of the exact ${subject} the sandbox just denied; the retry asks the user for approval.`
}

/**
 * The closed outcome vocabulary of one escalation ask — structurally identical
 * to the approval seam's `ApprovalOutcome` so an `ApprovalService.request`
 * return is assignable without this package importing it.
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The minimal approval-request shape {@link approveEscalation} needs —
 * structurally the approval seam's `ApprovalService`, generic over the agent
 * type `A` and call-id type `C` so this package resolves escalations through
 * `ctx.approval` without importing the approval or agent packages (the tool
 * layer infers `A`/`C` as its own `Agent`/`ToolCallId`).
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * Ask the human to approve one action, resolving to a closed outcome.
   * @param req - the audit request with optional localized displayReason and presentation lifetime signal.
   * @returns the human's decision as a closed {@link EscalationOutcome}.
   */
  request(req: {
    agent: A
    toolName: string
    callId: C
    reason: string
    displayReason?: { readonly en: string; readonly [locale: string]: string }
    signal?: AbortSignal
  }): Promise<EscalationOutcome>
}

/**
 * The approval ingredients an escalating tool hands {@link approveEscalation}:
 * the approval requester (`ctx.approval`, or `undefined` when none is
 * composed), the calling agent (or `undefined` for an agent-less execution),
 * and the call's identity. The tool layer holds all of these; this package
 * only judges them.
 */
export interface EscalationApproval<A = object, C = string> {
  /** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
  approver: EscalationApprover<A, C> | undefined
  /** The calling agent, or `undefined` for an agent-less execution (fails closed). */
  agent: A | undefined
  /** The tool-call id the approval prompt attaches to. */
  callId: C
  /** The tool name recorded on the approval request. */
  toolName: string
  /** The tool-execution abort signal the approval request rides, when present. */
  signal?: AbortSignal
}

/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS} when advertised). */
  requestedMode: string
  /** The model's one-sentence reason, shown verbatim to the user inside the audit reason. */
  justification: string
  /** The call's effective mode (session override ?? composition default); repeating it needs no approval. */
  effectiveMode: SandboxMode
  /** The family's noun for the escalated action in user-facing texts (`command` for bash, `operation` for fs). */
  subject: string
}

/**
 * Resolve a sandbox permission request before execution. Repeating the call's
 * effective mode returns it without approval. A strictly wider mode requires
 * approval and applies only to this call. Narrower or unsupported targets,
 * missing approval services or agents for widening, and non-grant outcomes
 * throw before execution.
 * @param request - the escalation to judge (see {@link EscalationRequest}).
 * @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
 * @returns the granted mode, consumed by the one call that asked.
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  if (mode === effectiveMode) return effectiveMode
  // Strict widening is an EXECUTION check against the call's effective mode —
  // deliberately not a schema constraint (the enum is the closed target
  // vocabulary; the effective mode is per-call truth).
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`)
  }
  if (approval.approver === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // Self-contained for the audit trail: approval/asked stores this reason,
  // and the target mode is part of the grant's identity.
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    displayReason: {
      en: `Allow this operation with ${mode} permissions: ${justification}`,
      zh: `允许本次操作使用 ${mode} 权限：${justification}`,
    },
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // The schema enum already pinned `mode` to the closed target vocabulary;
    // the check above proved it is strictly wider.
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`)
    case 'cancelled': throw new Error(`approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
