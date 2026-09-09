/**
 * Home plugin, browser half. Two registrations share one open-state store:
 * a launcher in the sidebar foot's `sidebar.footer.action` slot (rendered
 * above Settings) and the cross-workspace triage panel in the frame-wide
 * `shell.overlay` layer. Sessions are read through the standard useSessions
 * hook (in-component); row actions are inject callbacks over the runtime
 * sessions and workspace-registry services.
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merges that declare 'shell.overlay' (ui-layout)
// and 'sidebar.footer.action' (ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HomeInjected } from './HomeOverlay.tsx'
import { HomeOverlay } from './HomeOverlay.tsx'
import { HomeLauncher } from './HomeLauncher.tsx'
import { createHomeViewStore } from './stores.ts'

export type { HomeInjected, HomeOverlayProps } from './HomeOverlay.tsx'
export type { HomeLauncherProps } from './HomeLauncher.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'workspaces']

/**
 * Register the launcher and the triage panel once their host slots are on the
 * ledger. Both receive the same store handle, so the launcher toggles the
 * panel the overlay renders.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const store = createHomeViewStore()
  const injected = (): HomeInjected => ({
    open: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
    archive: async (sessionId: SessionId) => { await ctx.workspaces.archiveSession(sessionId) },
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'home',
      store,
    },
    HomeLauncher,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'home',
      store,
      inject: injected,
    },
    HomeOverlay,
  ))
}
