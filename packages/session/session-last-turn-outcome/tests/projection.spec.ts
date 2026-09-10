/**
 * The `lastTurnOutcome` projection unit: a last-wins fold over `turn/end`
 * events, mapping each turn's reason kind to a coarse outcome. Mounting the
 * plugin beside the projection registry serves the value through the composed
 * registry; compositions without the registry are unaffected; unmounting the
 * plugin removes the key (HMR safety). The reason→kind mapping and the
 * reference-stable "unchanged kind" short-circuit run against the exported
 * definition directly, where events are controlled.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as LastTurnOutcomePlugin from '@deepseek-ai/dsh-session-last-turn-outcome'
import { lastTurnOutcomeProjectionDefinition } from '@deepseek-ai/dsh-session-last-turn-outcome/src/projection.ts'
import type { LastTurnOutcome } from '@deepseek-ai/dsh-session-last-turn-outcome/types'

async function harness(withPlugin: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withPlugin) await ctx.plugin(LastTurnOutcomePlugin)
  return { ctx, session: ctx.sessions.create(SessionId('outcome')) }
}

/** Read the composed registry's current value for this session. */
function value(ctx: Context, session: Session): LastTurnOutcome | null | undefined {
  return ctx.sessionProjections.snapshot(session).values.lastTurnOutcome
}

describe('lastTurnOutcome projection unit (registry drive)', () => {
  it('serves null before the first turn ends', async () => {
    const { ctx, session } = await harness(true)
    expect(value(ctx, session)).toBeNull()
  })

  it('folds each turn/end reason kind to its coarse outcome', async () => {
    const cases: readonly [TurnEndReason, LastTurnOutcome['kind']][] = [
      [{ kind: 'completed' }, 'normal'],
      [{ kind: 'aborted', reason: { kind: 'legacy' } }, 'interrupted'],
      [{ kind: 'interrupted' }, 'interrupted'],
      [{ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, 'error'],
      [{ kind: 'max-tokens' }, 'max-tokens'],
      [{ kind: 'blocked' }, 'blocked'],
    ]
    let turn = 0
    for (const [reason, expected] of cases) {
      const { ctx, session } = await harness(true)
      session.append('turn/start', { turn: ++turn })
      session.append('turn/end', { turn, reason })
      expect(value(ctx, session)).toEqual({ kind: expected })
    }
  })

  it('is last-wins: a later clean completion overwrites an earlier error', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } })
    expect(value(ctx, session)).toEqual({ kind: 'error' })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(value(ctx, session)).toEqual({ kind: 'normal' })
  })

  it('notifies the change feed with the causing seq only when the kind changes', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, val, seq) => { changes.push({ key, value: val, seq }) })
    session.append('turn/start', { turn: 1 })
    const errSeq = session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } }).seq
    // A second turn ending the same way carries no kind change, so the fold
    // returns the prior reference and the feed stays silent for it.
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'y', code: 'UNKNOWN' } } })
    session.append('turn/start', { turn: 3 })
    const normalSeq = session.append('turn/end', { turn: 3, reason: { kind: 'completed' } }).seq
    const outcomeChanges = changes.filter(c => c.key === 'lastTurnOutcome')
    expect(outcomeChanges).toEqual([
      { key: 'lastTurnOutcome', value: { kind: 'error' }, seq: errSeq },
      { key: 'lastTurnOutcome', value: { kind: 'normal' }, seq: normalSeq },
    ])
  })

  it('folds a turn already in the log when the plugin mounts late (lazy cell build)', async () => {
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    await ctx.plugin(LastTurnOutcomePlugin)
    expect(value(ctx, session)).toEqual({ kind: 'max-tokens' })
  })

  it('has no lastTurnOutcome key without the plugin, and drops it when the plugin unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('lastTurnOutcome' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(LastTurnOutcomePlugin)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value(ctx, session)).toEqual({ kind: 'normal' })
    await fiber.dispose()
    expect('lastTurnOutcome' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})

/** Build one synthetic committed event for the direct-definition fold. */
function turnEnd(seq: number, reason: Record<string, unknown>): SessionEvent {
  return { type: 'turn/end', seq, time: seq, data: { turn: seq, reason } } as unknown as SessionEvent
}

describe('lastTurnOutcome definition (direct fold)', () => {
  const def = lastTurnOutcomeProjectionDefinition

  it('starts null and ignores non-turn/end events', () => {
    const start = def.init()
    expect(start).toBeNull()
    const other = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as unknown as SessionEvent
    expect(def.apply(start, other)).toBe(start)
  })

  it('maps an unrecognized reason kind to normal', () => {
    // The map has no `finished` entry; the fold defaults to normal rather than
    // failing, since turn/end reason ownership lives in the session surface.
    const folded = def.apply(def.init(), turnEnd(1, { kind: 'finished' }))
    expect(def.view(folded)).toEqual({ kind: 'normal' })
  })

  it('returns the prior state reference when the kind is unchanged', () => {
    const first = def.apply(def.init(), turnEnd(1, { kind: 'error', error: {} }))
    const second = def.apply(first, turnEnd(2, { kind: 'error', error: {} }))
    expect(second).toBe(first)
  })

  it('accepts its own view output through the wire schema and rejects a bad kind', () => {
    expect(def.schema.safeParse({ kind: 'blocked' }).success).toBe(true)
    expect(def.schema.safeParse(null).success).toBe(true)
    expect(def.schema.safeParse({ kind: 'nope' }).success).toBe(false)
  })
})
