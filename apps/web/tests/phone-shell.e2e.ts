// Web e2e scenario: the shell on a portrait phone. A 390×844 touch page
// checks that navigation never shares the frame with the conversation: the
// closed sidebar leaves the full width to the transcript and puts its reopen
// controls in the leading seat, the open sidebar overlays the conversation
// and closes after a Session is chosen, wide markdown scrolls inside its own
// blocks, the composer draft is large enough that iOS does not zoom into it,
// and Settings stacks its navigation above a full-width options column.
//
// Only a real engine resolves grid tracks, media queries, and pointer
// emulation, so the relations are measured in Chromium. The golden records
// relations and booleans rather than pixel positions, which depend on fonts.
//
// Zero model calls: the transcript is a closed turn assembled through the
// Session API and seeded cold.
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/phone-shell', import.meta.url))
const LAYOUT_EXPECTED = fileURLToPath(new URL('./expected/phone-shell/layout.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PHONE = { width: 390, height: 844 } as const
const SEED_ID = 'phone-shell-web-e2e'
const TAIL_MARKER = 'PHONE_SHELL_DONE'

/** Markdown whose code line, table, link, and token are each wider than a phone column. */
const WIDE_MARKDOWN = [
  'Wide content in a phone transcript.',
  '',
  '```ts',
  'export function phoneShellProbe(argumentNumberOne: string, argumentNumberTwo: number, argumentNumberThree: boolean): string { return argumentNumberOne }',
  '```',
  '',
  '| Column alpha | Column beta | Column gamma | Column delta | Column epsilon | Column zeta |',
  '| --- | --- | --- | --- | --- | --- |',
  '| value one is long | value two is long | value three | value four | value five | value six |',
  '',
  'A long link: https://example.com/a/very/long/path/that/does/not/break/naturally/anywhere/index.html',
  '',
  `Unbroken: ${'a'.repeat(90)}`,
  '',
  TAIL_MARKER,
].join('\n')

/** One closed turn carrying the wide markdown. */
function wideFixture(): string {
  const session = Session.create(SessionId('phone-shell-source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show wide content on a phone.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: WIDE_MARKDOWN }], source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

/** Frame geometry: rendered sidebar and centre widths plus page overflow. */
function shellGeometry(page: Page) {
  return page.locator('[data-sidebar-overlay]').evaluate((frame) => {
    const sidebar = frame.querySelector<HTMLElement>(':scope > [class*="sidebarCol"]')
    const center = frame.querySelector<HTMLElement>(':scope > [class*="centerCol"]')
    if (sidebar === null || center === null) throw new Error('frame columns are missing')
    const centerBox = center.getBoundingClientRect()
    return {
      collapsed: frame.hasAttribute('data-sidebar-collapsed'),
      sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
      centerLeft: Math.round(centerBox.left),
      centerWidth: Math.round(centerBox.width),
      scrim: frame.querySelector('[data-sidebar-scrim]') !== null,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
}

/** Smallest rendered side of a located control, in CSS px. */
async function minSide(control: Locator): Promise<number> {
  const box = await control.boundingBox()
  if (box === null) throw new Error('control has no box')
  return Math.round(Math.min(box.width, box.height))
}

describe('web e2e: portrait phone shell', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, wideFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: PHONE, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'Asia/Shanghai',
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-sidebar-overlay]').waitFor({ timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps every shell surface inside the phone width', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-phone-shell'))
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

    // Closed: no track, a full-width conversation, and the reopen controls in the leading seat.
    const closed = await shellGeometry(page)
    expect(closed).toEqual({
      collapsed: true, sidebarWidth: 0, centerLeft: 0, centerWidth: PHONE.width, scrim: false, pageOverflow: false,
    })
    const seat = page.locator('[data-shell-leading]')
    await seat.waitFor()
    // The hidden column's rail controls leave the accessibility tree, so the
    // page exposes exactly the seat's reopen control.
    const reopen = page.getByRole('button', { name: 'Open sidebar', exact: true })
    expect(await reopen.count()).toBe(1)
    const openSide = await minSide(reopen)
    expect(openSide).toBeGreaterThanOrEqual(36)

    // Open: the sidebar overlays the conversation, whose width does not change.
    await seat.getByRole('button', { name: 'Open sidebar' }).click()
    await expect.poll(() => shellGeometry(page)).toMatchObject({ collapsed: false, sidebarWidth: 280, scrim: true })
    const open = await shellGeometry(page)
    expect(open).toMatchObject({ centerLeft: 0, centerWidth: PHONE.width, pageOverflow: false })
    expect(await seat.count()).toBe(0)

    // Choosing a Session closes the overlay.
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText(TAIL_MARKER, { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(async () => (await shellGeometry(page)).collapsed).toBe(true)
    const navigated = await shellGeometry(page)

    // Wide markdown scrolls or wraps inside the transcript, never the page.
    const transcript = await page.locator('[data-conversation-scroll]').evaluate((scrollport) => {
      const pre = scrollport.querySelector('pre')
      const table = scrollport.querySelector('table')
      const box = scrollport.getBoundingClientRect()
      const inside = (element: Element | null): boolean => {
        if (element === null) return false
        const parent = element.parentElement?.getBoundingClientRect()
        return parent !== undefined && parent.right <= box.right && parent.left >= box.left
      }
      return {
        horizontalOverflow: scrollport.scrollWidth > scrollport.clientWidth,
        codeContained: inside(pre),
        tableContained: inside(table),
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    expect(transcript).toEqual({ horizontalOverflow: false, codeContained: true, tableContained: true, pageOverflow: false })

    // The composer draft avoids iOS focus zoom, and Send stays inside the card.
    const composer = await page.locator('[data-composer-card]').first().evaluate((card) => {
      const input = card.querySelector<HTMLElement>('[data-composer-input]')
      const send = card.querySelector<HTMLElement>('button[aria-label="Send message"]')
      const box = card.getBoundingClientRect()
      const sendBox = send?.getBoundingClientRect()
      return {
        draftFontSize: input === null ? 0 : Number.parseFloat(getComputedStyle(input).fontSize),
        cardInside: box.left >= 0 && box.right <= window.innerWidth,
        sendInside: sendBox !== undefined && sendBox.left >= box.left && sendBox.right <= box.right,
      }
    })
    expect(composer).toEqual({ draftFontSize: 16, cardInside: true, sendInside: true })

    // Settings: the navigation becomes a row above a full-width options column.
    await page.locator('[data-shell-leading]').getByRole('button', { name: 'Open sidebar' }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor()
    const settings = await dialog.evaluate((panel) => {
      const box = panel.getBoundingClientRect()
      const nav = panel.querySelector('nav')
      const cells = [...(nav?.querySelectorAll<HTMLElement>('button') ?? [])].map(cell => cell.getBoundingClientRect())
      // The column beside the navigation: feature actions, close, and options.
      const content = nav?.nextElementSibling?.getBoundingClientRect()
      const buttons = [...panel.querySelectorAll<HTMLElement>('button')]
        .filter(button => !(nav?.contains(button) ?? false))
        .map(button => button.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.top < box.bottom)
      return {
        fillsWidth: Math.round(box.width) === window.innerWidth,
        navInOneRow: cells.length > 1 && cells.every(cell => Math.abs(cell.top - cells[0]!.top) < 1),
        optionsBelowNav: content !== undefined && nav !== null && content.top >= nav.getBoundingClientRect().bottom - 1,
        optionsFullWidth: content !== undefined && Math.round(content.width) === Math.round(box.width),
        controlsInside: buttons.every(rect => rect.left >= box.left && rect.right <= box.right),
      }
    })
    expect(settings).toEqual({
      fillsWidth: true, navInOneRow: true, optionsBelowNav: true, optionsFullWidth: true, controlsInside: true,
    })
    const closeSide = await minSide(dialog.getByRole('button', { name: 'Close', exact: true }))
    expect(closeSide).toBeGreaterThanOrEqual(36)

    await compareOrRefreshGolden(LAYOUT_EXPECTED, [
      '# Portrait phone shell',
      '',
      `- Viewport: ${String(PHONE.width)} x ${String(PHONE.height)}, coarse pointer`,
      '',
      '## Navigation',
      '',
      `- Closed sidebar track: ${String(closed.sidebarWidth)}`,
      `- Conversation width, sidebar closed: ${String(closed.centerWidth)}`,
      `- Reopen control at least 36px: ${String(openSide >= 36)}`,
      `- Open sidebar overlay: ${String(open.sidebarWidth)} over a ${String(open.centerWidth)} conversation, scrim ${String(open.scrim)}`,
      `- Closed after choosing a Session: ${String(navigated.collapsed)}`,
      '',
      '## Transcript and composer',
      '',
      `- Transcript horizontal overflow: ${String(transcript.horizontalOverflow)}`,
      `- Code block and table contained: ${String(transcript.codeContained && transcript.tableContained)}`,
      `- Draft font size: ${String(composer.draftFontSize)}`,
      `- Send inside the composer card: ${String(composer.sendInside)}`,
      '',
      '## Settings',
      '',
      `- Panel fills the width: ${String(settings.fillsWidth)}`,
      `- Navigation in one row above full-width options: ${String(settings.navInOneRow && settings.optionsBelowNav && settings.optionsFullWidth)}`,
      `- Controls inside the panel: ${String(settings.controlsInside)}`,
      `- Close control at least 36px: ${String(closeSide >= 36)}`,
      `- Page overflow anywhere: ${String(closed.pageOverflow || open.pageOverflow || transcript.pageOverflow)}`,
    ].join('\n'), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)

  it.skipIf(MODE === 'record')('keeps the expected inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['layout.expected.md'])
  })
})
