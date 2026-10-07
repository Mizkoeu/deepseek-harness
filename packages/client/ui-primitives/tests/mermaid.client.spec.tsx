// @vitest-environment jsdom
// Mermaid is the mocked external boundary (its layout needs a real browser);
// DOMPurify runs for real, so the second sanitization pass is exercised.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
import { MermaidBlock } from '../src/markdown/MermaidBlock.tsx'
import { renderMermaid } from '../src/markdown/mermaid.ts'
import type { MarkdownCodeLabels } from '../src/index.ts'

const runtime = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  getDiagramFromText: vi.fn(),
  failMermaidImport: false,
  failPurifyImport: false,
}))

vi.mock('mermaid', () => ({
  get default() {
    if (runtime.failMermaidImport) {
      runtime.failMermaidImport = false
      throw new Error('mermaid chunk unavailable')
    }
    return {
      initialize: runtime.initialize,
      render: runtime.render,
      mermaidAPI: { getDiagramFromText: runtime.getDiagramFromText },
    }
  },
}))

vi.mock('dompurify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dompurify')>()
  return {
    get default() {
      if (runtime.failPurifyImport) {
        runtime.failPurifyImport = false
        throw new Error('dompurify chunk unavailable')
      }
      return actual.default
    },
  }
})

const labels: MarkdownCodeLabels = {
  copyLabel: 'Copy', copiedLabel: 'Copied',
  toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' },
}

/** The rendered diagram, not the toolbar's decorative icons. */
const DIAGRAM = 'svg:not([aria-hidden])'

const SVG = '<svg id="d" width="100%" style="max-width: 812px;" viewBox="-8 -8 812 400"><g><text dominant-baseline="middle">Node A</text></g></svg>'

function flowchart(vertices: Record<string, { img?: string }> = {}) {
  return { type: 'flowchart-v2', db: { getVertices: () => new Map(Object.entries(vertices)) } }
}

beforeEach(() => {
  runtime.initialize.mockReset()
  runtime.render.mockReset()
  runtime.getDiagramFromText.mockReset()
  runtime.getDiagramFromText.mockResolvedValue(flowchart())
})

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
})

describe('renderMermaid', () => {
  it('renders under strict security with locked configuration and an offscreen staging node', async () => {
    let staged: HTMLElement | undefined
    runtime.render.mockImplementation((_id: string, _code: string, stage: HTMLElement) => {
      staged = stage
      expect(stage.isConnected).toBe(true)
      return Promise.resolve({ svg: SVG })
    })

    const result = await renderMermaid('graph LR; A-->B', 'light')

    expect(result).toEqual({ ok: true, svg: expect.stringContaining('Node A') as unknown, width: 812 })
    expect(runtime.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: 'strict', htmlLabels: false, theme: 'default', startOnLoad: false,
      secure: expect.arrayContaining(['securityLevel', 'htmlLabels', 'theme', 'themeCSS', 'fontFamily']) as unknown,
    }))
    expect(runtime.render).toHaveBeenCalledWith(expect.stringMatching(/^dsh-mermaid-\d+$/), 'graph LR; A-->B', staged)
    expect(staged?.isConnected).toBe(false)
  })

  it('selects the dark Mermaid theme for the dark palette', async () => {
    runtime.render.mockResolvedValue({ svg: SVG })
    await renderMermaid('graph LR; A-->B', 'dark')
    expect(runtime.initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('reports no width when the SVG has no usable viewBox', async () => {
    runtime.render.mockResolvedValue({ svg: '<svg><g></g></svg>' })
    expect(await renderMermaid('graph LR; A', 'light')).toMatchObject({ ok: true, width: undefined })
    runtime.render.mockResolvedValue({ svg: '<svg viewBox="0 0 0 10"><g></g></svg>' })
    expect(await renderMermaid('graph LR; A', 'light')).toMatchObject({ ok: true, width: undefined })
  })

  it('removes active, linked, embedded, and externally loaded content while keeping the diagram', async () => {
    runtime.render.mockResolvedValue({
      svg: [
        '<svg viewBox="0 0 100 50">',
        '<style>@import url(https://evil.example/x.css); .n{fill:url(https://evil.example/p.png)} .m{marker-end:url(#arrow)}</style>',
        '<script>globalThis.pwned = true</script>',
        '<defs><marker id="arrow"><path d="M0,0"></path></marker></defs>',
        '<a href="https://evil.example" transform="translate(5, 5)"><text class="label">Linked</text></a>',
        '<a xlink:href="#arrow"><text>Fragment link</text></a>',
        '<rect onclick="boom()" style="fill: url(https://evil.example/f.png)" width="10" height="10"></rect>',
        '<foreignObject><div>html label</div></foreignObject>',
        '<image href="https://evil.example/i.png"></image>',
        '<use href="https://evil.example/s.svg#x"></use>',
        '<path marker-end="url(#arrow)" d="M0,0L10,10"></path>',
        '</svg>',
      ].join(''),
    })

    const result = await renderMermaid('graph LR; A', 'light')
    const svg = result.ok ? result.svg : ''

    expect(svg).toContain('<style>')
    expect(svg).toContain('url(#arrow)')
    expect(svg).toContain('<a transform="translate(5, 5)"><text class="label">Linked</text></a>')
    expect(svg).toContain('<a><text>Fragment link</text></a>')
    expect(svg).not.toMatch(/evil\.example|<script|onclick|<foreignobject|<image|<use|href|@import/i)
    expect(svg).not.toContain('html label')
  })

  it('rejects flowchart image nodes before layout', async () => {
    runtime.getDiagramFromText.mockResolvedValue(flowchart({ A: {}, B: { img: 'https://example.com/a.png' } }))

    expect(await renderMermaid('flowchart LR; B@{ img: "https://example.com/a.png" }', 'light'))
      .toEqual({ ok: false, error: 'Mermaid image nodes are not supported' })
    expect(runtime.render).not.toHaveBeenCalled()
  })

  it('lays out non-flowchart diagrams without a vertex check', async () => {
    runtime.getDiagramFromText.mockResolvedValue({ type: 'sequence', db: {} })
    runtime.render.mockResolvedValue({ svg: SVG })
    expect(await renderMermaid('sequenceDiagram\nA->>B: hi', 'light')).toMatchObject({ ok: true })
  })

  it('resolves parse, layout, and sanitization failures to error results', async () => {
    runtime.getDiagramFromText.mockRejectedValueOnce(new Error('Parse error on line 1'))
    expect(await renderMermaid('graph BROKEN', 'light')).toEqual({ ok: false, error: 'Parse error on line 1' })

    runtime.render.mockRejectedValueOnce('layout failed')
    expect(await renderMermaid('graph LR; A', 'light')).toEqual({ ok: false, error: 'layout failed' })

    runtime.render.mockResolvedValueOnce({ svg: '<script>x()</script>' })
    expect(await renderMermaid('graph LR; A', 'light')).toEqual({ ok: false, error: 'Mermaid produced no SVG element' })
  })

  it('retries a runtime import that failed', async () => {
    runtime.render.mockResolvedValue({ svg: SVG })
    vi.resetModules()
    const fresh = await import('../src/markdown/mermaid.ts')

    runtime.failMermaidImport = true
    expect(await fresh.renderMermaid('graph LR; A', 'light')).toEqual({ ok: false, error: 'mermaid chunk unavailable' })
    expect(await fresh.renderMermaid('graph LR; A', 'light')).toMatchObject({ ok: true })

    vi.resetModules()
    const again = await import('../src/markdown/mermaid.ts')
    runtime.failPurifyImport = true
    expect(await again.renderMermaid('graph LR; A', 'light')).toEqual({ ok: false, error: 'dompurify chunk unavailable' })
    expect(await again.renderMermaid('graph LR; A', 'light')).toMatchObject({ ok: true })
  })

  it('serializes renders so each initialization applies to its own diagram', async () => {
    const order: string[] = []
    runtime.initialize.mockImplementation((config: { theme: string }) => { order.push(`init:${config.theme}`) })
    runtime.render.mockImplementation(async (_id: string, code: string) => {
      order.push(`render:${code}`)
      await Promise.resolve()
      return { svg: SVG }
    })

    await Promise.all([renderMermaid('one', 'light'), renderMermaid('two', 'dark')])

    expect(order).toEqual(['init:default', 'render:one', 'init:dark', 'render:two'])
  })
})

describe('MermaidBlock', () => {
  it('shows the source while pending, then the diagram in a scrollable card', async () => {
    let resolve: ((value: { svg: string }) => void) | undefined
    runtime.render.mockReturnValue(new Promise((done) => { resolve = done }))
    const { container } = render(<MermaidBlock code="graph LR; A-->B" labels={labels} />)

    const card = container.querySelector('[data-mermaid-diagram]')
    expect(card?.getAttribute('data-mermaid-diagram')).toBe('pending')
    expect(card?.getAttribute('aria-busy')).toBe('true')
    expect(card?.querySelector('pre')?.textContent).toBe('graph LR; A-->B')

    await waitFor(() => { expect(resolve).toBeDefined() })
    await act(async () => { resolve?.({ svg: SVG }) })

    expect(card?.getAttribute('data-mermaid-diagram')).toBe('rendered')
    expect(card?.hasAttribute('aria-busy')).toBe(false)
    expect(card?.querySelector('svg text')?.textContent).toBe('Node A')
    expect(card?.querySelector('pre')).toBeNull()
    expect(card?.querySelector(DIAGRAM)?.parentElement?.getAttribute('style')).toContain('--dsl-mermaid-width: 812px')
    expect(screen.getByText('mermaid')).toBeTruthy()
  })

  it('copies the diagram source', async () => {
    runtime.render.mockResolvedValue({ svg: SVG })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const { container } = render(<MermaidBlock code="graph LR; A-->B" labels={labels} />)
      await waitFor(() => { expect(container.querySelector(DIAGRAM)).not.toBeNull() })
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      expect(writeText).toHaveBeenCalledWith('graph LR; A-->B')
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy() })
    } finally {
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', clipboard)
    }
  })

  it('omits the width hint when the diagram has no viewBox', async () => {
    runtime.render.mockResolvedValue({ svg: '<svg><g></g></svg>' })
    const { container } = render(<MermaidBlock code="graph LR; A" labels={labels} />)
    await waitFor(() => { expect(container.querySelector(DIAGRAM)).not.toBeNull() })
    expect(container.querySelector(DIAGRAM)?.parentElement?.getAttribute('style')).toBeNull()
  })

  it('falls back to the source code block when the diagram cannot render', async () => {
    runtime.getDiagramFromText.mockRejectedValue(new Error('Parse error'))
    const { container } = render(<MermaidBlock code="graph BROKEN" labels={labels} />)

    await waitFor(() => { expect(container.querySelector('[data-mermaid-diagram]')).toBeNull() })
    expect(container.querySelector('.md-code-block pre')?.textContent).toBe('graph BROKEN')
    expect(runtime.render).not.toHaveBeenCalled()
  })

  it('re-renders for a palette change and keeps the current diagram until the replacement arrives', async () => {
    runtime.render.mockResolvedValueOnce({ svg: SVG })
    const { container } = render(<MermaidBlock code="graph LR; A-->B" labels={labels} />)
    await waitFor(() => { expect(container.querySelector(DIAGRAM)).not.toBeNull() })

    let resolve: ((value: { svg: string }) => void) | undefined
    runtime.render.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    act(() => { document.body.setAttribute('data-ds-dark-theme', '') })

    await waitFor(() => { expect(runtime.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })) })
    expect(container.querySelector('svg text')?.textContent).toBe('Node A')
    await waitFor(() => { expect(resolve).toBeDefined() })
    await act(async () => { resolve?.({ svg: SVG.replace('Node A', 'Dark A') }) })
    expect(container.querySelector('svg text')?.textContent).toBe('Dark A')
  })

  it('ignores a render that settles after unmount', async () => {
    let resolve: ((value: { svg: string }) => void) | undefined
    runtime.render.mockReturnValue(new Promise((done) => { resolve = done }))
    const { unmount } = render(<MermaidBlock code="graph LR; A-->B" labels={labels} />)
    await waitFor(() => { expect(resolve).toBeDefined() })
    unmount()
    const errors = vi.spyOn(console, 'error')
    await act(async () => { resolve?.({ svg: SVG }) })
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('Mermaid fences in MarkdownText', () => {
  const source = '```mermaid\ngraph LR; A-->B\n```'

  it('renders a settled fence as a diagram', async () => {
    runtime.render.mockResolvedValue({ svg: SVG })
    const { container } = render(<MarkdownText text={source} />)
    await waitFor(() => { expect(container.querySelector(`[data-mermaid-diagram="rendered"] ${DIAGRAM}`)).not.toBeNull() })
    expect(runtime.render).toHaveBeenCalledWith(expect.any(String), 'graph LR; A-->B', expect.any(HTMLElement))
  })

  it('matches the fence language case-insensitively', async () => {
    runtime.render.mockResolvedValue({ svg: SVG })
    const { container } = render(<MarkdownText text={'```Mermaid\ngraph LR; A-->B\n```'} />)
    await waitFor(() => { expect(container.querySelector('[data-mermaid-diagram="rendered"]')).not.toBeNull() })
  })

  it('keeps a streaming fence as code and never hands partial source to Mermaid', () => {
    const { container } = render(<MarkdownText text={'```mermaid\ngraph LR; A-->'} streaming />)
    expect(container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(container.querySelector('.md-code-block pre')?.textContent).toBe('graph LR; A-->')
    expect(runtime.getDiagramFromText).not.toHaveBeenCalled()
    expect(runtime.render).not.toHaveBeenCalled()
  })
})
