/** Settled Mermaid diagrams and KaTeX math in an assistant reply, at desktop and phone widths. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/markdown-mermaid-math', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-mermaid-math'
const WIDE = 'flowchart LR\n  A[Collect requirements] --> B[Draft the design] --> C[Review with the team] --> D[Implement the change] --> E[Ship and monitor]'
const SEQUENCE = 'sequenceDiagram\n  participant U as Reader\n  participant R as Renderer\n  U->>R: Mermaid source\n  R-->>U: Diagram'
const INVALID = 'flowchart LR\n  A[unfinished'
const UNTRUSTED = [
  '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body {display:none!important}"}}%%',
  'flowchart LR',
  '  A["<img src=x onerror=alert(1)>"] --> B[Safe]',
  '  click B "javascript:alert(1)"',
].join('\n')
const IMAGE_NODE = 'flowchart LR\n  A@{ img: "https://example.invalid/a.png", label: "Image", pos: "t", h: 60 }'
const PRICES = 'Lunch costs $5 and dinner costs $10.'
const REPLY = [
  '# Diagrams and math',
  ...[WIDE, SEQUENCE, INVALID, UNTRUSTED, IMAGE_NODE].map(code => `\`\`\`mermaid\n${code}\n\`\`\``),
  'Inline $a^2 + b^2 = c^2$ and \\(e^{i\\pi} + 1 = 0\\).',
  '$$\\int_0^1 x\\,dx = \\frac{1}{2}$$',
  '\\[\n\\begin{aligned}\nf(x) &= x^2 \\\\\ng(x) &= 2x\n\\end{aligned}\n\\]',
  '```math\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n```',
  PRICES,
].join('\n\n')

function fixture(): string {
  const session = Session.create(SessionId('markdown-mermaid-math-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Draw the diagrams and typeset the math.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Diagrams and math', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: REPLY }], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

async function openReply(browser: Browser, scaffold: WebScaffold): Promise<{ page: Page; dialogs: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const dialogs: string[] = []
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click({ timeout: 30_000 })
  await page.getByRole('treeitem').nth(1).click()
  await page.getByRole('heading', { name: 'Diagrams and math' }).waitFor()
  await expect.poll(() => page.locator('[data-mermaid-diagram="rendered"]').count(), { timeout: 30_000 }).toBe(3)
  return { page, dialogs }
}

describe('web e2e: Mermaid diagrams and math in a settled reply', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture(), SEED_ID)
    browser = await chromium.launch()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it.skipIf(MODE === 'record')('renders sanitized diagrams, falls back to source, and typesets math', async () => {
    const { page, dialogs } = await openReply(browser, scaffold)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-mermaid-math'))
    const tripwire = watchConsole(page)
    const diagrams = page.locator('[data-mermaid-diagram="rendered"] svg:not([aria-hidden])')

    expect(await diagrams.count()).toBe(3)
    expect(await diagrams.first().locator('text').allTextContents()).toEqual(expect.arrayContaining(['Collect requirements', 'Ship and monitor']))
    expect(await page.locator('[data-mermaid-diagram] :is(foreignObject, image, script, use)').count()).toBe(0)
    expect(await page.locator('[data-mermaid-diagram] [onclick], [data-mermaid-diagram] [href]').count()).toBe(0)
    expect(await page.locator('body').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
    expect(await page.locator('[id^="ddsh-mermaid-"]').count()).toBe(0)
    const untrusted = page.locator('[data-mermaid-diagram="rendered"]').nth(2)
    const source = await untrusted.locator('text', { hasText: '<img src="x">' }).first().boundingBox()
    const target = await untrusted.locator('text', { hasText: 'Safe' }).first().boundingBox()
    expect(target!.x).toBeGreaterThan(source!.x + source!.width)
    const sources = await page.locator('.md-code-block:not([data-mermaid-diagram]) pre').allTextContents()
    expect(sources).toEqual(expect.arrayContaining([INVALID, IMAGE_NODE]))

    expect(await page.locator('.katex').count()).toBe(5)
    expect(await page.locator('.katex-display').count()).toBe(3)
    expect(await page.locator('.katex-error').count()).toBe(0)
    expect(await page.getByText(PRICES, { exact: true }).count()).toBe(1)
    expect(dialogs).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    await page.close()
  })

  it.skipIf(MODE === 'record')('keeps a wide diagram scrolling inside its card at phone width', async () => {
    const { page } = await openReply(browser, scaffold)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-mermaid-math-phone'))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-sidebar-collapsed="true"]').waitFor()
    const wide = page.locator('[data-mermaid-diagram="rendered"]').first()
    await wide.scrollIntoViewIfNeeded()

    const geometry = await wide.evaluate((card) => {
      const body = card.lastElementChild as HTMLElement
      return {
        cardRight: card.getBoundingClientRect().right,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        bodyScrolls: getComputedStyle(body).overflowX === 'auto',
      }
    })
    expect(geometry.cardRight).toBeLessThanOrEqual(390)
    expect(geometry.bodyScrolls).toBe(true)
    expect(geometry.bodyOverflow).toBeGreaterThan(0)
    const pageOverflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.katex-display, [data-mermaid-diagram]')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).length)
    expect(pageOverflow).toBe(0)
    await page.close()
  })

  it.skipIf(MODE === 'record')('re-renders diagrams for the dark palette', async () => {
    const { page } = await openReply(browser, scaffold)
    const first = page.locator('[data-mermaid-diagram="rendered"] svg:not([aria-hidden])').first()
    const lightId = await first.getAttribute('id')
    const lightStyle = await first.locator('style').textContent()
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await expect.poll(() => first.getAttribute('id'), { timeout: 20_000 }).not.toBe(lightId)
    expect(await first.locator('style').textContent()).not.toBe(lightStyle)
    await page.close()
  })
})
