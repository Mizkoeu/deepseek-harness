/**
 * Function plugin registering the `lastTurnOutcome` projection unit through
 * the session-projection seam, so its value rides every projection carrier
 * (history tail baseline, `session/projection` frames, and session-list rows)
 * without this plugin owning delivery.
 *
 * @module @deepseek-ai/dsh-session-last-turn-outcome
 */

import type { Context } from '@deepseek-ai/cordis'
import { lastTurnOutcomeProjectionDefinition } from './projection.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'session-last-turn-outcome'
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['sessionProjections']

/**
 * Register the `lastTurnOutcome` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(lastTurnOutcomeProjectionDefinition)
}
