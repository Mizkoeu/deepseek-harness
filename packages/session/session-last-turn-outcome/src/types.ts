/**
 * Pure types of the last-turn-outcome domain: the ONE home of the
 * `lastTurnOutcome` projection-key declaration, free of host-side value
 * imports (cordis, zod). `./types` serves host consumers and `./client`
 * serves client aggregates, both re-exporting this single source.
 *
 * @module @deepseek-ai/dsh-session-last-turn-outcome/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/**
 * Coarse outcome of a turn, mapped from its {@link TurnEndReason}:
 * `normal` (completed), `error`, `max-tokens`, `interrupted` (aborted or a
 * crash-recovered close), and `blocked`. The stalled-triage consumer treats
 * `error`/`max-tokens`/`interrupted` as needing attention.
 */
export type LastTurnOutcomeKind = 'normal' | 'error' | 'max-tokens' | 'interrupted' | 'blocked'

/** The most recent turn's outcome. */
export interface LastTurnOutcome {
  /** How the session's most recent completed turn ended. */
  kind: LastTurnOutcomeKind
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's most recent `turn/end` reason as a coarse outcome, or
     * `null` before the first turn ends. Last-wins: each `turn/end` replaces
     * the value, so a session that errored and was later resumed to a clean
     * completion reads `normal` again.
     */
    lastTurnOutcome: LastTurnOutcome | null
  }
}
