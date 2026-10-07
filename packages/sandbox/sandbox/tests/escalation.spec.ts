/**
 * Tests for the shared escalation vocabulary and choreography: the strictly-
 * wider ladder, strict-schema-tolerant argument normalization, the model-facing markers, and
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
  sandboxDenialMarker,
  normalizeEscalationArgs,
  sandboxPermissionsDescription,
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
  it('returns a strictly wider mode with its justification', () => {
    expect(normalizeEscalationArgs('workspace-write', 'because the workspace needs it', 'read-only'))
      .toEqual({ requestedMode: 'workspace-write', justification: 'because the workspace needs it' })
    expect(normalizeEscalationArgs('danger-full-access', 'needs the home directory', 'workspace-write'))
      .toEqual({ requestedMode: 'danger-full-access', justification: 'needs the home directory' })
  })

  it.each([
    ['absent fields', undefined, undefined, 'read-only'],
    ['null fields', null, null, 'read-only'],
    ['an empty mode', '', 'filled reason', 'read-only'],
    ['a lone justification', undefined, 'orphan reason', 'read-only'],
    ['a same-mode filler with a blank justification', 'workspace-write', '', 'workspace-write'],
    ['a same-mode filler with a sentence', 'workspace-write', 'filled reason', 'workspace-write'],
    ['a narrower filler', 'workspace-write', '', 'danger-full-access'],
    ['a narrower filler with null justification', 'workspace-write', null, 'danger-full-access'],
    ['an unknown mode', 'bogus-mode', 'reason', 'read-only'],
    ['any mode without a confining backend', 'danger-full-access', 'reason', undefined],
  ] as const)('requests no escalation for %s', (_label, mode, justification, effective) => {
    expect(normalizeEscalationArgs(mode, justification, effective)).toBeUndefined()
  })

  it('rejects a strictly wider mode without a non-empty justification', () => {
    expect(() => normalizeEscalationArgs('workspace-write', undefined, 'read-only')).toThrow('invalid escalation: sandbox_permissions requires a justification')
    expect(() => normalizeEscalationArgs('workspace-write', null, 'read-only')).toThrow('invalid escalation: sandbox_permissions requires a justification')
    expect(() => normalizeEscalationArgs('workspace-write', '', 'read-only')).toThrow('invalid justification: expected a non-empty sentence')
    expect(() => normalizeEscalationArgs('danger-full-access', ' \t\n', 'workspace-write')).toThrow('invalid justification: expected a non-empty sentence')
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('the sandbox_permissions description names the family subject', () => {
    expect(sandboxPermissionsDescription('command')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.')
    expect(sandboxPermissionsDescription('operation')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.')
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
    expect(seen[0]).toMatchObject({
      displayReason: {
        en: 'Allow this operation with workspace-write permissions: the user asked to write in the workspace',
        zh: '允许本次操作使用 workspace-write 权限：the user asked to write in the workspace',
      },
    })
  })

  it.each(ESCALATION_TARGETS)('repeating %s succeeds without asking for approval', async (mode) => {
    const seen: unknown[] = []
    const request = req({ requestedMode: mode, effectiveMode: mode })
    await expect(approveEscalation(request, ingredients({ approver: approver('rejected', r => seen.push(r)) })))
      .resolves.toBe(mode)
    expect(seen).toEqual([])
    await expect(approveEscalation(request, ingredients({ approver: undefined, agent: undefined })))
      .resolves.toBe(mode)
  })

  it('a narrower or unsupported target fails closed without asking', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    await expect(approveEscalation(req({ requestedMode: 'read-only', effectiveMode: 'workspace-write' }), spy))
      .rejects.toThrow(/not strictly wider than this call's current "workspace-write" mode/)
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' as never }), spy))
      .rejects.toThrow(/not strictly wider/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toThrow(/not strictly wider/)
    expect(seen).toEqual([])
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toThrow(/no approval service is composed/)
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toThrow(/no agent to route it through/)
  })

  it('maps each non-grant outcome to its distinct verbatim text (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toThrow('the user rejected escalating this operation to "workspace-write"; it stays denied, so stop and explain instead of working around it')
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toThrow('approval for escalating to "workspace-write" was cancelled')
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toThrow('no approval channel is available')
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
