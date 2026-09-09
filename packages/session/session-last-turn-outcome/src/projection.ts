/**
 * The `lastTurnOutcome` projection unit: a last-wins fold over `turn/end`
 * events, mapping each turn's {@link TurnEndReason} to a coarse outcome the
 * cross-session triage UI reads to flag stalled sessions (error, max-tokens,
 * or interrupted). A running turn has no `turn/end` yet, so the value reflects
 * the previous completed turn until the current one closes.
 *
 * @module @deepseek-ai/dsh-session-last-turn-outcome/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { LastTurnOutcome, LastTurnOutcomeKind } from './types.ts'

/** Map each `turn/end` reason kind to a coarse outcome. */
const KIND_BY_REASON: Record<string, LastTurnOutcomeKind> = {
  completed: 'normal',
  aborted: 'interrupted',
  interrupted: 'interrupted',
  error: 'error',
  'max-tokens': 'max-tokens',
  blocked: 'blocked',
}

/** Wire schema for the `view` output (the projection value the host emits). */
const schema: z.ZodType<LastTurnOutcome | null> = z.union([
  z.object({ kind: z.enum(['normal', 'error', 'max-tokens', 'interrupted', 'blocked']) }),
  z.null(),
])

/** The registrable `lastTurnOutcome` unit. State is the value itself (view is identity). */
export const lastTurnOutcomeProjectionDefinition: ProjectionDefinition<'lastTurnOutcome', LastTurnOutcome | null> = {
  key: 'lastTurnOutcome',
  schema,
  init: () => null,
  apply(state, event) {
    if (event.type !== 'turn/end') return state
    const kind = KIND_BY_REASON[event.data.reason.kind] ?? 'normal'
    if (state !== null && state.kind === kind) return state
    return { kind }
  },
  view: state => state,
  stateVersion: 0,
}
