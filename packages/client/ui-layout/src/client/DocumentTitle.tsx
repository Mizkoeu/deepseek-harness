/** Browser title selection follows the active main panel without subscribing the frame. */
import { useEffect } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Session list state as the standard `useSessions` hook exposes it. */
type SessionListSnapshot = Parameters<Parameters<PropsRuntime<'root'>['useSessions']>[0]>[0]

/**
 * Select the Session the main view retains.
 * @param state - Session list state.
 * @returns the retained Session id, or undefined without one.
 */
export function mainViewSessionId(state: SessionListSnapshot): SessionListSnapshot['ids'][number] | undefined {
  return Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

/** Props for the browser title projection. */
export type DocumentTitleProps = Pick<PropsRuntime<'root'>, 'useSessions' | 'usePanelInfo'> & {
  /** Build-configured or localized product title. */
  productTitle: string
}

/**
 * Project the selected durable session title into the browser title and
 * restore the build-selected product title when unmounted.
 * @param props - Selected session title projection.
 * @returns No rendered content.
 */
export function DocumentTitle({ useSessions, usePanelInfo, productTitle }: DocumentTitleProps): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = mainViewSessionId(state)
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}
