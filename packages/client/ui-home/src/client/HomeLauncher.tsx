/**
 * Home launcher, registered into the sidebar foot's `sidebar.footer.action`
 * list slot (rendered above Settings). Toggles the shared Home panel. Renders
 * a labelled row when the sidebar is wide and an icon-only rail control when
 * collapsed, mirroring the New Session and Settings controls. An amber badge
 * carries the count of sessions currently blocking on the operator.
 */
import clsx from 'clsx'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChecklistOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: brings the `goal` SessionProjectionMap key merge into scope.
import type {} from '@deepseek-ai/dsh-goal/client'
import type { createHomeViewStore } from './stores.ts'
import css from './HomeLauncher.module.css'

/** Composed props: sidebar foot owner share (wide), session reads, and the shared store. */
export type HomeLauncherProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createHomeViewStore>>

/** Render the sidebar Home launcher (wide row or rail icon). */
export function HomeLauncher({ wide, useSessions, useStore, actions }: HomeLauncherProps) {
  const attention = useSessions(s =>
    Object.values(s.byId).filter((x) => {
      if (x.parentId !== undefined || x.blank) return false
      if (x.pendingInteraction !== undefined) return true
      const goal = x.projectionValues?.goal
      return goal != null && goal.goal.phase === 'blocked'
    }).length,
  )
  const open = useStore(s => s.open)
  return (
    <Tooltip label="Home" delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.button, !wide && css.rail, open && css.active)}
        aria-label="Home"
        aria-pressed={open}
        onClick={() => { actions.toggle() }}
      >
        <IconChecklistOutline14 size={wide ? 14 : 18} />
        {wide && <span className={css.label}>Home</span>}
        {attention > 0 && <span className={css.badge}>{attention}</span>}
      </button>
    </Tooltip>
  )
}
