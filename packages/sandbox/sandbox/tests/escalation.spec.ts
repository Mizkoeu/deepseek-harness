/**
 * Tests for the shared escalation vocabulary and choreography: the strictly-
 * wider ladder, the argument-pairing validation, the model-facing markers, and
 * {@link approveEscalation}'s ordered fail-closed sequence. Both enforcing tool
 * families (`dsh-tool-bash`, `dsh-tool-fs`) delegate here, so the ordering and
 * verbatim texts are pinned once, next to the vocabulary that owns them.
 */

import { describe, expect, it } from 'vitest'
import {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  normalizeEscalationArgs,
  sandboxDenialMarker,
} from '@deepseek-ai/dsh-sandbox'
import type { EscalationApprover, EscalationOutcome } from '@deepseek-ai/dsh-sandbox'

describe('the strictly-wider ladder', () => {
  it('read-only escalates to either wider mode; workspace-write only to full access', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access'])
    expect(WIDER_MODES['danger-full-access']).toBeUndefined()
  })

  it('the target enum is the closed set every session could escalate TO (read-only is the floor)', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
  })
})

describe('normalizeEscalationArgs', () => {
  it('a genuine widen returns the requested mode and its justification', () => {
    expect(normalizeEscalationArgs('workspace-write', 'because the workspace needs it', 'read-only'))
      .toEqual({ requestedMode: 'workspace-write', justification: 'because the workspace needs it' })
  })

  it('strips a fill that does not strictly widen the effective mode', () => {
    // Same-mode (the strict-schema footgun), narrower, absent, null, and a
    // missing effective mode all escalate nothing, so normalization yields no
    // ask and the call runs at its own mode.
    expect(normalizeEscalationArgs('workspace-write', 'filled reason', 'workspace-write')).toBeUndefined()
    expect(normalizeEscalationArgs('workspace-write', '', 'danger-full-access')).toBeUndefined()
    expect(normalizeEscalationArgs(undefined, undefined, 'read-only')).toBeUndefined()
    expect(normalizeEscalationArgs(null, null, 'read-only')).toBeUndefined()
    expect(normalizeEscalationArgs('workspace-write', 'reason', undefined)).toBeUndefined()
  })

  it('a genuine widen still requires a non-empty justification', () => {
    expect(() => normalizeEscalationArgs('workspace-write', undefined, 'read-only')).toThrow(/requires a justification/)
    expect(() => normalizeEscalationArgs('workspace-write', null, 'read-only')).toThrow(/requires a justification/)
    expect(() => normalizeEscalationArgs('danger-full-access', '   ', 'workspace-write')).toThrow(/non-empty sentence/)
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('the hint marker names the family subject', () => {
    expect(escalationHintMarker('command')).toContain('retry this exact command once with sandbox_permissions')
    expect(escalationHintMarker('operation')).toContain('retry this exact operation once with sandbox_permissions')
  })
})

describe('approveEscalation', () => {
  const req = (over: Partial<Parameters<typeof approveEscalation>[0]> = {}) => ({
    requestedMode: 'workspace-write',
    justification: 'the user asked to write in the workspace',
    effectiveMode: 'read-only' as const,
    subject: 'command',
    ...over,
  })
  /** An approver that records the request and returns a fixed outcome. */
  const approver = (outcome: EscalationOutcome, sink?: (req: unknown) => void): EscalationApprover => ({
    request: async (request) => { sink?.(request); return outcome },
  })
  const ingredients = (over: Partial<Parameters<typeof approveEscalation>[1]> = {}) => ({
    approver: approver('allowed-once'),
    agent: {},
    callId: 'call-1',
    toolName: 'bash',
    ...over,
  })

  it('grants: returns the requested mode, asking through the approver with the audit reason', async () => {
    const seen: { reason?: string }[] = []
    const granted = await approveEscalation(req(), ingredients({ approver: approver('allowed-once', r => seen.push(r as { reason?: string })) }))
    expect(granted).toBe('workspace-write')
    expect(seen[0]?.reason).toBe('escalate sandbox to workspace-write: the user asked to write in the workspace')
  })

  it('a non-widening request fails closed with its own text and never asks', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    await expect(approveEscalation(req({ requestedMode: 'read-only' }), spy))
      .rejects.toThrow(/not strictly wider than this call's current "read-only" mode/)
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' as never }), spy))
      .rejects.toThrow(/not strictly wider/)
    expect(seen).toEqual([])
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toThrow(/no approval service is composed/)
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toThrow(/no agent to route it through/)
  })

  it('maps each non-grant outcome to its distinct verbatim text (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toThrow('the user rejected escalating this operation to "workspace-write"')
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toThrow('approval for escalating to "workspace-write" was cancelled')
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toThrow('no approval channel is available')
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
