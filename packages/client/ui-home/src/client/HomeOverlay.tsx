/**
 * Cross-workspace triage overlay ("Home"). Reads the whole session-list
 * superset through the standard useSessions hook and classifies each top-level
 * session into one operator state by a first-match ladder, then groups the
 * states into sections:
 *   - Needs you        — a blocking approval/plan/question, a blocked goal, or a recent stalled run (error/max-tokens/interrupted)
 *   - In progress      — idle with recent unfinished work: incomplete todos or an active goal
 *   - In flight        — running now
 *   - Pick up          — recently touched with nothing pending, for navigation
 *   - Review or archive — finished, or idle past the staleness threshold (collapsed)
 * Rows carry the agent's own task context: the goal objective or the next
 * pending todo, plus todo progress. Sessions read their `goal` and `todos`
 * from the projection values already riding every list row. Archived sessions
 * (the registry-global set from the workspaces service) are excluded, so an
 * archived row leaves Home on the state echo. Panel visibility is a store
 * shared with the sidebar launcher.
 *
 * Rendered into the frame-wide, click-through `shell.overlay` layer, so every
 * interactive element opts back into pointer events; the idle backdrop does
 * not block the app underneath.
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { workspaceTitleOf } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconChevronRightOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: these bring the `goal`, `todos`, and `lastTurnOutcome`
// SessionProjectionMap key merges into scope so projectionValues type through.
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { LastTurnOutcomeKind } from '@deepseek-ai/dsh-session-last-turn-outcome/client'
import type { createHomeViewStore } from './stores.ts'
import css from './HomeOverlay.module.css'

/** Row actions the plugin body supplies over the runtime services. */
export interface HomeInjected {
  /** Select and open a session in the main pane. */
  open: (sessionId: SessionId) => void
  /** Archive a session (registry-global archive set; hides it from grouping). */
  archive: (sessionId: SessionId) => Promise<void>
}

/** Composed props: root runtime share, the shared open-state store, and the injected actions. */
export type HomeOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createHomeViewStore>>
  & HomeInjected

/** The section a classified session lands in. */
type Section = 'needs' | 'continue' | 'inflight' | 'done' | 'recent'

/** One classified session: its section plus an optional needs-you reason chip. */
interface ClassifiedRow {
  session: SessionSummary
  section: Section
  reason?: string
}

/** Reason chip per blocking-interaction kind carried on a summary. */
const PENDING_LABEL: Record<NonNullable<SessionSummary['pendingInteraction']>, string> = {
  approval: 'Approval',
  'plan-review': 'Plan review',
  question: 'Question',
}

/** Reason chip per stalled last-turn outcome (only these three count as stalled). */
const STALLED_LABEL: Partial<Record<LastTurnOutcomeKind, string>> = {
  error: 'Error',
  'max-tokens': 'Max tokens',
  interrupted: 'Interrupted',
}

/** Section render config, in display order: label, row density, cap, and collapse. */
const SECTIONS: readonly { key: Section; label: string; twoLine: boolean; cap: number; collapsible?: boolean }[] = [
  { key: 'needs', label: 'Needs you', twoLine: true, cap: Infinity },
  { key: 'continue', label: 'In progress', twoLine: true, cap: 12 },
  { key: 'inflight', label: 'In flight', twoLine: false, cap: 12 },
  { key: 'recent', label: 'Pick up where you left off', twoLine: false, cap: 6 },
  { key: 'done', label: 'Review or archive', twoLine: true, cap: 10, collapsible: true },
]

/** Read a session's goal projection value, when present. */
function goalOf(s: SessionSummary): GoalProjection | null | undefined {
  return s.projectionValues?.goal
}

/** Read a session's todo projection value, when present. */
function todosOf(s: SessionSummary): TodoItem[] | null | undefined {
  return s.projectionValues?.todos
}

/**
 * Idle-staleness threshold for archive suggestions. A session untouched for
 * longer than this becomes an archive candidate even with unfinished work.
 * Starting point; a later setting can make it per-user configurable.
 */
const STALE_DAYS = 7
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000

/** Whether a session has been idle past the staleness threshold. */
function isStale(s: SessionSummary): boolean {
  return s.updatedAt > 0 && Date.now() - s.updatedAt > STALE_MS
}

/**
 * First-match ladder: the one state this session is in. "Needs you" is only
 * a BLOCKING wait (the agent cannot proceed without the operator): a pending
 * interaction or a blocked goal. An archive candidate ("Review or archive")
 * is a non-blocking, non-running session that is either finished (complete
 * goal, all todos done, or the finished-while-away bit) or stale (idle past
 * {@link STALE_DAYS}) — stale wins over "In progress"/"Pick up" so those stay
 * recent. Everything else is unfinished-but-recent ("In progress") or idle
 * with nothing pending ("Pick up").
 */
function classify(s: SessionSummary): ClassifiedRow {
  const pending = s.pendingInteraction
  if (pending !== undefined) return { session: s, section: 'needs', reason: PENDING_LABEL[pending] }
  const goal = goalOf(s)
  if (goal != null && goal.goal.phase === 'blocked') return { session: s, section: 'needs', reason: 'Blocked' }
  if (s.running) return { session: s, section: 'inflight' }
  // A recent broken run (errored / hit max tokens / interrupted) needs you to
  // resume or retry; an old broken run falls through to the stale/archive
  // branch below, since it is effectively abandoned.
  const outcome = s.projectionValues?.lastTurnOutcome
  const stalledLabel = outcome != null ? STALLED_LABEL[outcome.kind] : undefined
  if (stalledLabel !== undefined && !isStale(s)) return { session: s, section: 'needs', reason: stalledLabel }
  const todos = todosOf(s)
  const hasTodos = todos != null && todos.length > 0
  const allTodosDone = hasTodos && todos.every(t => t.status === 'completed')
  const finished = (goal != null && goal.goal.phase === 'complete') || allTodosDone || s.completed === true
  if (finished || isStale(s)) return { session: s, section: 'done' }
  const hasIncompleteTodos = hasTodos && todos.some(t => t.status !== 'completed')
  const goalInProgress = goal != null && (goal.goal.phase === 'active' || goal.goal.phase === 'paused')
  if (hasIncompleteTodos || goalInProgress) return { session: s, section: 'continue' }
  return { session: s, section: 'recent' }
}

/** The state dot for a section (a neutral marker for continue/recent). */
function sectionDot(section: Section): ReactNode {
  switch (section) {
    case 'needs': return <StateDot state="warning" className={css.dot} />
    case 'inflight': return <StateDot state="ongoing" className={css.dot} />
    case 'done': return <StateDot state="done" className={css.dot} />
    case 'continue': return <span className={css.progressDot} />
    case 'recent': return <span className={css.mutedDot} />
  }
}

/** The "what/next" context line: the goal objective, else the next pending todo. */
function contextText(goal: GoalProjection | null | undefined, todos: TodoItem[] | null | undefined): string | undefined {
  if (goal != null && goal.goal.objective.trim() !== '') return goal.goal.objective
  const next = todos?.find(t => t.status !== 'completed')
  return next !== undefined ? `next: ${next.content}` : undefined
}

/** Todo progress `done/total`, when a list exists. */
function todoProgress(todos: TodoItem[] | null | undefined): string | undefined {
  if (todos == null || todos.length === 0) return undefined
  return `${todos.filter(t => t.status === 'completed').length}/${todos.length}`
}

/** Coarse relative age; empty when the timestamp is absent. */
function relativeTime(updatedAt: number): string {
  if (updatedAt <= 0) return ''
  const minutes = Math.round((Date.now() - updatedAt) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Render the triage panel over the whole session list. */
export function HomeOverlay({ useSessions, useWorkspaces, useStore, actions, open, archive }: HomeOverlayProps) {
  const panelOpen = useStore(s => s.open)
  const list = useSessions(s => s)
  const archivedIds = useWorkspaces(w => w.archivedSessionIds)
  // Which collapsible sections are expanded (default collapsed). The overlay
  // entry stays mounted, so this persists across panel open/close.
  const [expanded, setExpanded] = useState<ReadonlySet<Section>>(() => new Set<Section>())
  const toggleSection = (key: Section) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const sections = useMemo(() => {
    const archived = new Set(archivedIds)
    const classified = Object.values(list.byId)
      .filter(s => s.parentId === undefined && !s.blank && !archived.has(s.id))
      .map(classify)
    // Needs you: oldest-waiting first (the longest-blocked surfaces). Every
    // other section: newest activity first.
    const oldestFirst = (a: ClassifiedRow, b: ClassifiedRow) => a.session.updatedAt - b.session.updatedAt
    const newestFirst = (a: ClassifiedRow, b: ClassifiedRow) => b.session.updatedAt - a.session.updatedAt
    const rows = {} as Record<Section, ClassifiedRow[]>
    for (const { key } of SECTIONS) {
      const inSection = classified.filter(r => r.section === key)
      inSection.sort(key === 'needs' ? oldestFirst : newestFirst)
      rows[key] = inSection
    }
    return { rows, total: classified.length }
  }, [list, archivedIds])

  const openSession = (id: SessionId) => {
    open(id)
    actions.setOpen(false)
  }

  const renderRow = (row: ClassifiedRow, twoLine: boolean) => {
    const s = row.session
    const workspace = s.cwd !== undefined && s.cwd !== '' ? workspaceTitleOf(s.cwd) : undefined
    const age = relativeTime(s.updatedAt)
    const context = twoLine ? contextText(goalOf(s), todosOf(s)) : undefined
    const progress = twoLine ? todoProgress(todosOf(s)) : undefined
    const meta = (
      <>
        {workspace !== undefined && <span className={css.workspace}>{workspace}</span>}
        {age !== '' && <span className={css.time}>{age}</span>}
      </>
    )
    return (
      <div key={s.id} className={css.row}>
        <button type="button" className={css.rowMain} onClick={() => { openSession(s.id) }}>
          {sectionDot(row.section)}
          <div className={css.rowText}>
            <div className={css.line1}>
              <span className={css.title}>{s.displayTitle}</span>
              {row.reason !== undefined && <span className={css.reason}>{row.reason}</span>}
              {!twoLine && <span className={css.metaRight}>{meta}</span>}
            </div>
            {twoLine && (
              <div className={css.line2}>
                {context !== undefined && <span className={css.context}>{context}</span>}
                {progress !== undefined && <span className={css.progress}>{progress}</span>}
                {meta}
              </div>
            )}
          </div>
        </button>
        {row.section === 'done' && (
          <button type="button" className={css.archive} onClick={() => { void archive(s.id) }}>
            Archive
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={css.layer}>
      {panelOpen && (
        <>
          <div className={css.backdrop} onClick={() => { actions.setOpen(false) }} />
          <div className={css.panel} role="dialog" aria-label="Home">
            <header className={css.header}>
              <div className={css.headerText}>
                <h2 className={css.heading}>Home</h2>
                <p className={css.subheading}>What needs you across every workspace</p>
              </div>
              <button type="button" className={css.close} aria-label="Close" onClick={() => { actions.setOpen(false) }}>
                ✕
              </button>
            </header>
            <div className={css.body}>
              {sections.total === 0
                ? <p className={css.empty}>No sessions yet.</p>
                : SECTIONS.map(({ key, label, twoLine, cap, collapsible }) => {
                  const rows = sections.rows[key]
                  if (rows.length === 0) return null
                  const isOpen = !collapsible || expanded.has(key)
                  const shown = isOpen ? rows.slice(0, cap) : []
                  const overflow = rows.length - shown.length
                  return (
                    <section key={key} className={css.bucket}>
                      {collapsible
                        ? (
                          <button type="button" className={css.bucketHeadButton} onClick={() => { toggleSection(key) }} aria-expanded={isOpen}>
                            {isOpen ? <IconChevronDownOutline14 size={12} /> : <IconChevronRightOutline14 size={12} />}
                            <span>{label}</span>
                            <span className={css.count}>{rows.length}</span>
                          </button>
                        )
                        : (
                          <h3 className={css.bucketHead}>
                            <span>{label}</span>
                            <span className={css.count}>{rows.length}</span>
                          </h3>
                        )}
                      {isOpen && <div className={css.rows}>{shown.map(row => renderRow(row, twoLine))}</div>}
                      {isOpen && overflow > 0 && <div className={css.more}>+{overflow} more</div>}
                    </section>
                  )
                })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
