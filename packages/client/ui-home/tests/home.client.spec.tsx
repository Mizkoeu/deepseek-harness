// @vitest-environment jsdom
/**
 * Home presentation behavior: the launcher's blocking-count badge and the
 * overlay's first-match bucket ladder, cross-workspace grouping, and row
 * actions. Framework hooks (useSessions/useWorkspaces/useStore) are stubbed as
 * plain selectors over a controlled snapshot — the sanctioned zero-machinery
 * path; the shared store uses its real factory instance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { HomeOverlay } from '../src/client/HomeOverlay.tsx'
import { HomeLauncher } from '../src/client/HomeLauncher.tsx'
import { createHomeViewStore } from '../src/client/stores.ts'

afterEach(cleanup)

describe('Home view store', () => {
  it('opens by default and both actions mutate the open flag', () => {
    const store = createHomeViewStore().create()
    expect(store.getSnapshot().open).toBe(true)
    store.actions.setOpen(false)
    expect(store.getSnapshot().open).toBe(false)
    store.actions.toggle()
    expect(store.getSnapshot().open).toBe(true)
  })
})

const sid = (id: string) => id as SessionId

/** A session summary with sane defaults; overrides tune one classification input. */
function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    id: sid(over.id),
    displayTitle: over.displayTitle ?? over.id,
    blank: false,
    running: false,
    updatedAt: Date.now(),
    ...over,
    id: sid(over.id),
  } as SessionSummary
}

/** Idle timestamp older than the 7-day staleness threshold. */
const STALE_TS = Date.now() - 30 * 24 * 60 * 60 * 1000

/** projectionValues carrying one goal phase (+objective) — shortens the long inline literals. */
const goalPV = (phase: string, objective = 'x') => ({ goal: { goal: { phase, objective } } }) as never
/** projectionValues carrying one last-turn outcome kind. */
const outcomePV = (kind: string) => ({ lastTurnOutcome: { kind } }) as never
/** projectionValues carrying a todo list. */
const todosPV = (todos: { content: string; status: string }[]) => ({ todos }) as never


/** Build the stubbed useSessions/useWorkspaces selector hooks over one snapshot. */
function hooks(list: SessionSummary[], archived: string[] = []) {
  const byId: Record<string, SessionSummary> = {}
  for (const s of list) byId[s.id] = s
  const sessionsSnap = { byId }
  const workspacesSnap = { archivedSessionIds: archived.map(sid) }
  return {
    useSessions: (<T,>(sel: (s: typeof sessionsSnap) => T) => sel(sessionsSnap)) as never,
    useWorkspaces: (<T,>(sel: (w: typeof workspacesSnap) => T) => sel(workspacesSnap)) as never,
  }
}

/** Mount HomeOverlay with the panel forced open and controlled session data. */
function renderOverlay(
  list: SessionSummary[],
  opts: { archived?: string[]; open?: ReturnType<typeof vi.fn>; archive?: ReturnType<typeof vi.fn> } = {},
) {
  const store = createHomeViewStore().create()
  const open = opts.open ?? vi.fn()
  const archive = opts.archive ?? vi.fn(async () => {})
  const view = render(
    <HomeOverlay
      {...hooks(list, opts.archived)}
      useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: true })) as never}
      actions={{ setOpen: vi.fn(), toggle: vi.fn() } as never}
      open={open as never}
      archive={archive as never}
    />,
  )
  return { view, store, open, archive }
}

/** The <section> whose head text starts with the bucket label. */
function bucket(label: string): HTMLElement {
  const head = screen.getByText(label)
  return head.closest('section')!
}

describe('Home launcher badge', () => {
  it('counts only top-level sessions blocking on the operator', () => {
    const list = [
      summary({ id: 'pending', pendingInteraction: 'approval' }),
      summary({ id: 'blocked-goal', projectionValues: { goal: { goal: { phase: 'blocked' } } } as never }),
      summary({ id: 'running', running: true }),
      summary({ id: 'child', pendingInteraction: 'question', parentId: sid('pending') }),
      summary({ id: 'blank-pending', pendingInteraction: 'approval', blank: true }),
    ]
    render(
      <HomeLauncher
        wide
        useSessions={hooks(list).useSessions}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: false })) as never}
        actions={{ setOpen: vi.fn(), toggle: vi.fn() } as never}
      />,
    )
    // Two block: the pending-approval and the blocked-goal; the running,
    // subagent, and blank sessions do not.
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('toggles the shared store on click', () => {
    const store = createHomeViewStore().create()
    const before = store.getSnapshot().open
    render(
      <HomeLauncher
        wide
        useSessions={hooks([]).useSessions}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel(store.getSnapshot())) as never}
        actions={store.actions as never}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(store.getSnapshot().open).toBe(!before)
  })

  it('renders a rail (icon-only) control when collapsed and marks the pressed state when open', () => {
    render(
      <HomeLauncher
        wide={false}
        useSessions={hooks([summary({ id: 'p', pendingInteraction: 'approval' })]).useSessions}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: true })) as never}
        actions={{ setOpen: vi.fn(), toggle: vi.fn() } as never}
      />,
    )
    const button = screen.getByRole('button', { name: 'Home' })
    // Collapsed: no visible "Home" text label; badge still shows the count.
    expect(screen.queryByText('Home')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('1')).toBeTruthy()
  })
})

describe('Home overlay classification', () => {
  it('places a blocking approval in Needs you with its reason chip', () => {
    renderOverlay([summary({ id: 's', displayTitle: 'Approve me', pendingInteraction: 'approval' })])
    const needs = bucket('Needs you')
    expect(within(needs).getByText('Approve me')).toBeTruthy()
    expect(within(needs).getByText('Approval')).toBeTruthy()
  })

  it('classifies a recent stalled run as Needs you but an old one as Review or archive', () => {
    const recent = summary({ id: 'recent-err', displayTitle: 'Recent error', updatedAt: Date.now(), projectionValues: outcomePV('error') })
    const old = summary({ id: 'old-err', displayTitle: 'Old error', updatedAt: STALE_TS, projectionValues: outcomePV('error') })
    renderOverlay([recent, old])
    expect(within(bucket('Needs you')).getByText('Recent error')).toBeTruthy()
    // The stale bucket is collapsible; its head still names the session count.
    expect(within(bucket('Review or archive')).getByText('1')).toBeTruthy()
  })

  it('routes running to In flight and finished to Review or archive by first-match precedence', () => {
    const running = summary({ id: 'run', displayTitle: 'Working', running: true, projectionValues: goalPV('active') })
    const done = summary({ id: 'done', displayTitle: 'Finished', completed: true })
    renderOverlay([running, done])
    expect(within(bucket('In flight')).getByText('Working')).toBeTruthy()
    expect(within(bucket('Review or archive')).getByText('1')).toBeTruthy()
  })

  it('shows a two-line context from the goal objective for a Needs-you row', () => {
    renderOverlay([summary({ id: 's', displayTitle: 'Blocked task', projectionValues: goalPV('blocked', 'Ship the thing') })])
    const needs = bucket('Needs you')
    expect(within(needs).getByText('Ship the thing')).toBeTruthy()
    expect(within(needs).getByText('Blocked')).toBeTruthy()
  })

  it('excludes archived, blank, and subagent sessions from every bucket', () => {
    const list = [
      summary({ id: 'archived', pendingInteraction: 'approval', displayTitle: 'Archived' }),
      summary({ id: 'blank', pendingInteraction: 'approval', blank: true, displayTitle: 'Blank' }),
      summary({ id: 'child', pendingInteraction: 'approval', parentId: sid('x'), displayTitle: 'Child' }),
    ]
    renderOverlay(list, { archived: ['archived'] })
    expect(screen.getByText('No sessions yet.')).toBeTruthy()
  })

  it('groups the same-state sessions across different workspaces, each row naming its workspace', () => {
    renderOverlay([
      summary({ id: 'a', displayTitle: 'A', pendingInteraction: 'approval', cwd: '/home/me/alpha' }),
      summary({ id: 'b', displayTitle: 'B', pendingInteraction: 'approval', cwd: '/home/me/beta' }),
    ])
    const needs = bucket('Needs you')
    expect(within(needs).getByText('alpha')).toBeTruthy()
    expect(within(needs).getByText('beta')).toBeTruthy()
  })

  it('puts an active goal or incomplete todos in the In-progress bucket, not Needs you', () => {
    const withGoal = summary({ id: 'g', displayTitle: 'Active goal', projectionValues: goalPV('active', 'keep going') })
    const todoList = [{ content: 'do this', status: 'pending' }, { content: 'done', status: 'completed' }]
    const withTodos = summary({ id: 't', displayTitle: 'Has todos', projectionValues: todosPV(todoList) })
    renderOverlay([withGoal, withTodos])
    const cont = bucket('In progress')
    expect(within(cont).getByText('Active goal')).toBeTruthy()
    expect(within(cont).getByText('keep going')).toBeTruthy()
    // Next-pending-todo context and X/Y progress render on the two-line rows.
    expect(within(cont).getByText('next: do this')).toBeTruthy()
    expect(within(cont).getByText('1/2')).toBeTruthy()
  })

  it('puts an idle session with nothing pending in the Pick-up bucket', () => {
    renderOverlay([summary({ id: 'idle', displayTitle: 'Just idle', updatedAt: Date.now() })])
    expect(within(bucket('Pick up where you left off')).getByText('Just idle')).toBeTruthy()
  })

  it('treats a paused goal as In progress (the second goal-in-progress phase)', () => {
    renderOverlay([summary({ id: 'p', displayTitle: 'Paused work', projectionValues: goalPV('paused', 'later') })])
    expect(within(bucket('In progress')).getByText('Paused work')).toBeTruthy()
  })

  it('renders coarse relative ages and omits age for a zero timestamp', () => {
    const now = Date.now()
    renderOverlay([
      summary({ id: 'm', displayTitle: 'Minutes', pendingInteraction: 'approval', updatedAt: now - 5 * 60 * 1000 }),
      summary({ id: 'h', displayTitle: 'Hours', pendingInteraction: 'approval', updatedAt: now - 3 * 60 * 60 * 1000 }),
      summary({ id: 'd', displayTitle: 'Days', pendingInteraction: 'approval', updatedAt: now - 2 * 24 * 60 * 60 * 1000 }),
      summary({ id: 'z', displayTitle: 'NoTime', pendingInteraction: 'approval', updatedAt: 0 }),
    ])
    const needs = bucket('Needs you')
    expect(within(needs).getByText('5m ago')).toBeTruthy()
    expect(within(needs).getByText('3h ago')).toBeTruthy()
    // The 2-day row is stale (> 7 days? no) — 2 days stays Needs you and shows "2d ago".
    expect(within(needs).getByText('2d ago')).toBeTruthy()
    // The zero-timestamp row shows no age chip but still lists.
    expect(within(needs).getByText('NoTime')).toBeTruthy()
  })

  it('shows "just now" for a very recent update', () => {
    renderOverlay([summary({ id: 'r', displayTitle: 'Fresh', pendingInteraction: 'approval', updatedAt: Date.now() })])
    expect(within(bucket('Needs you')).getByText('just now')).toBeTruthy()
  })
})

describe('Home overlay row actions', () => {
  it('opens a session from its row', () => {
    const open = vi.fn()
    renderOverlay([summary({ id: 's', displayTitle: 'Open me', pendingInteraction: 'approval' })], { open })
    fireEvent.click(screen.getByText('Open me'))
    expect(open).toHaveBeenCalledWith('s')
  })

  it('archives a session from a Done row', () => {
    const archive = vi.fn(async () => {})
    renderOverlay([summary({ id: 's', displayTitle: 'Done one', completed: true })], { archive })
    // Review-or-archive is collapsed by default; expand it to reach the row.
    fireEvent.click(screen.getByText('Review or archive'))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(archive).toHaveBeenCalledWith('s')
  })

  it('expands and re-collapses the Review-or-archive bucket, capping shown rows with an overflow note', () => {
    // 12 finished sessions; the done cap is 10, so expanding shows "+2 more".
    const many = Array.from({ length: 12 }, (_, i) =>
      summary({ id: `done-${i}`, displayTitle: `Done ${i}`, completed: true, updatedAt: Date.now() - i }))
    renderOverlay(many)
    const label = screen.getByText('Review or archive')
    // Collapsed: no rows shown yet.
    expect(screen.queryByText('Done 0')).toBeNull()
    fireEvent.click(label)
    expect(screen.getByText('Done 0')).toBeTruthy()
    expect(screen.getByText('+2 more')).toBeTruthy()
    // Toggle back to collapsed.
    fireEvent.click(label)
    expect(screen.queryByText('Done 0')).toBeNull()
  })

  it('closes the panel from the header close button and the backdrop', () => {
    const setOpen = vi.fn()
    render(
      <HomeOverlay
        {...hooks([summary({ id: 's', pendingInteraction: 'approval' })])}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: true })) as never}
        actions={{ setOpen, toggle: vi.fn() } as never}
        open={vi.fn() as never}
        archive={(vi.fn(async () => {})) as never}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(setOpen).toHaveBeenCalledWith(false)
  })

  it('closes the panel when the idle backdrop is clicked', () => {
    const setOpen = vi.fn()
    const { container } = render(
      <HomeOverlay
        {...hooks([summary({ id: 's', pendingInteraction: 'approval' })])}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: true })) as never}
        actions={{ setOpen, toggle: vi.fn() } as never}
        open={vi.fn() as never}
        archive={(vi.fn(async () => {})) as never}
      />,
    )
    // The backdrop is the panel's sibling div; it precedes the role="dialog".
    const dialog = screen.getByRole('dialog', { name: 'Home' })
    const backdrop = dialog.previousElementSibling as HTMLElement
    fireEvent.click(backdrop)
    expect(setOpen).toHaveBeenCalledWith(false)
    expect(container).toBeTruthy()
  })

  it('renders nothing but the click-through layer while the panel is closed', () => {
    render(
      <HomeOverlay
        {...hooks([summary({ id: 's', pendingInteraction: 'approval' })])}
        useStore={(<T,>(sel: (s: { open: boolean }) => T) => sel({ open: false })) as never}
        actions={{ setOpen: vi.fn(), toggle: vi.fn() } as never}
        open={vi.fn() as never}
        archive={(vi.fn(async () => {})) as never}
      />,
    )
    expect(screen.queryByRole('dialog', { name: 'Home' })).toBeNull()
  })
})
