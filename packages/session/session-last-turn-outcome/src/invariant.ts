/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-last-turn-outcome`.
 * @module @deepseek-ai/dsh-session-last-turn-outcome/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-last-turn-outcome'

/** Cordis companion plugin name. */
export const name = 'session-last-turn-outcome-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns a single pure last-wins fold over
 * `turn/end`, whose wire payload the projection registry schema-validates at
 * every snapshot and change-feed emission; the `turn/end` event and its
 * `TurnEndReason` are owned and runtime-checked by dsh-agent-loop and the
 * session surface, not here.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
