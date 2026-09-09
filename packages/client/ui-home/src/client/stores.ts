/**
 * Shared open-state for Home: the sidebar launcher toggles it, the overlay
 * panel reads it. One handle is passed to both registrations in `apply`, so
 * the two entries share one instance. Not persisted — Home auto-opens on each
 * load as a landing surface.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Whether the Home panel is currently shown. */
type HomeViewState = { open: boolean }

/** Declared mutation set (annotation twin of the actions literal). */
type HomeViewActions = {
  setOpen: (draft: HomeViewState, open: boolean) => void
  toggle: (draft: HomeViewState) => void
}

/**
 * Create the Home view store handle.
 * @returns the store handle shared by the launcher and the panel.
 */
export function createHomeViewStore(): EngineStoreHandle<HomeViewState, HomeViewActions> {
  return defineStore({
    init: (): HomeViewState => ({ open: true }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      toggle: (d) => { d.open = !d.open },
    },
  })
}
