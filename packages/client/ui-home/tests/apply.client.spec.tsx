/** Home plugin slot registration, shared-store wiring, and disposal. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-home/client'
import type { HomeInjected } from '@deepseek-ai/dsh-client-ui-home/client'

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const sessions = { open: vi.fn() }
  const workspaces = { archiveSession: vi.fn(async () => {}) }
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  const slots = ctx.get('slots') as SlotRegistry
  if (declare) {
    // The two host slots Home registers into: the sidebar-foot list and the
    // frame-wide overlay layer. A real owner declares them; Home injects.
    slots.register(
      { name: 'root', children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      } } as never,
      () => null,
    )
  }
  return { ctx, slots, sessions, workspaces }
}

describe('ui-home apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces'])
  })

  it('registers the launcher and the overlay panel into their host slots', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.slots.entries('shell.overlay')).toHaveLength(1)
  })

  it('injects open and archive callbacks that delegate to the runtime services', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = (b.slots.entries('shell.overlay')[0]!.inject as () => HomeInjected)()
    expect(Object.keys(injected)).toEqual(['open', 'archive'])
    injected.open('sess-1' as never)
    expect(b.sessions.open).toHaveBeenCalledWith('sess-1')
    await injected.archive('sess-2' as never)
    expect(b.workspaces.archiveSession).toHaveBeenCalledWith('sess-2')
  })

  it('gives both registrations one shared store handle so the launcher toggles the panel', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const launcherStore = b.slots.entries('sidebar.footer.action')[0]!.store
    const overlayStore = b.slots.entries('shell.overlay')[0]!.store
    expect(launcherStore).toBe(overlayStore)
  })

  it('waits for undeclared host slots (injection is deferred, not an error)', async () => {
    // With neither slot declared, apply resolves and installs nothing until an
    // owner declares the slots — no throw, unlike a bare register.
    const b = await bench(false)
    await expect(b.ctx.plugin({ inject: [...inject], apply }).await()).resolves.toBeDefined()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('removes both entries on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('shell.overlay')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
