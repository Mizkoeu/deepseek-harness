// @vitest-environment jsdom
// Inline Mermaid rendering: the lazy loader, the MermaidBlock states, and the
// render.tsx fence routing. Mermaid is the one external, nondeterministic
// module mocked here (the sanctioned mock boundary); DOMPurify runs for real,
// so the second sanitize pass is genuinely exercised.
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initialize, renderFn } = vi.hoisted(() => ({ initialize: vi.fn(), renderFn: vi.fn() }))
vi.mock('mermaid', () => ({ default: { initialize, render: renderFn } }))

import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { MermaidBlock } from '../src/markdown/MermaidBlock.tsx'
import { renderMermaid } from '../src/markdown/mermaid.ts'

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
  document.documentElement.style.removeProperty('color-scheme')
})
beforeEach(() => {
  initialize.mockReset()
  renderFn.mockReset()
})

describe('renderMermaid', () => {
  it('renders sanitized svg under strict security', async () => {
    renderFn.mockResolvedValue({ svg: '<svg><g></g></svg>' })
    const result = await renderMermaid('graph TD; A-->B')
    expect(result).toEqual({ ok: true, svg: expect.stringContaining('<svg') })
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, theme: 'default' }))
    expect(renderFn).toHaveBeenCalledWith(expect.stringMatching(/^dsh-mermaid-/), 'graph TD; A-->B')
  })

  it('strips scripts and event handlers while keeping the svg vocabulary, style, and text labels', async () => {
    renderFn.mockResolvedValue({
      svg: '<svg><style>.n{fill:red}</style><script>globalThis.x=1</script>'
        + '<text class="nodeLabel">Node Text</text>'
        + '<rect onclick="boom()"></rect></svg>',
    })
    const result = await renderMermaid('x')
    expect(result.ok).toBe(true)
    const svg = result.ok ? result.svg : ''
    expect(svg).toContain('<svg')
    expect(svg).toContain('<style')
    // Labels render as native SVG <text> (htmlLabels: false), kept by the svg profile.
    expect(svg).toContain('Node Text')
    expect(svg).not.toContain('<script')
    expect(svg.toLowerCase()).not.toContain('onclick')
  })

  it('selects the dark theme from the palette attribute', async () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    renderFn.mockResolvedValue({ svg: '<svg/>' })
    await renderMermaid('x')
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('selects the dark theme from the root color-scheme', async () => {
    document.documentElement.style.colorScheme = 'dark'
    renderFn.mockResolvedValue({ svg: '<svg/>' })
    await renderMermaid('x')
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('returns an error result for a render failure', async () => {
    renderFn.mockRejectedValue(new Error('parse fail'))
    expect(await renderMermaid('bad')).toEqual({ ok: false, error: 'parse fail' })
  })

  it('stringifies a non-Error rejection', async () => {
    renderFn.mockRejectedValue('boom')
    expect(await renderMermaid('bad')).toEqual({ ok: false, error: 'boom' })
  })
})

describe('MermaidBlock', () => {
  it('shows a placeholder, then the rendered diagram', async () => {
    renderFn.mockResolvedValue({ svg: '<svg><g></g></svg>' })
    const { container } = render(<MermaidBlock code="graph TD; A-->B" />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    await waitFor(() => expect(container.querySelector('[role="img"] svg')).not.toBeNull())
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it('falls back to the source code block on failure', async () => {
    renderFn.mockRejectedValue(new Error('nope'))
    const { container } = render(<MermaidBlock code="graph BROKEN SYNTAX" copyLabel="Copy" copiedLabel="Copied" />)
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull())
    expect(container.textContent).toContain('graph BROKEN SYNTAX')
  })

  it('abandons a render that resolves after unmount', async () => {
    let resolveRender: (() => void) | undefined
    renderFn.mockReturnValue(new Promise<{ svg: string }>((resolve) => {
      resolveRender = () => resolve({ svg: '<svg/>' })
    }))
    const { container, unmount } = render(<MermaidBlock code="graph TD; A-->B" />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    unmount()
    resolveRender?.()
    // Flush the loader's awaits and the component's late .then: the cancelled
    // guard must skip the setState on the unmounted component without throwing.
    await new Promise(resolve => setTimeout(resolve))
  })
})

describe('mermaid fence routing in MarkdownText', () => {
  const source = '```mermaid\ngraph TD; A-->B\n```'

  it('renders a settled fence as a diagram, not its source', async () => {
    renderFn.mockResolvedValue({ svg: '<svg><g></g></svg>' })
    const { container } = render(<MarkdownText text={source} />)
    await waitFor(() => expect(container.querySelector('[role="img"] svg')).not.toBeNull())
    expect(container.textContent).not.toContain('graph TD')
  })

  it('renders a streaming fence as a plain code block', () => {
    const { container } = render(<MarkdownText text={source} streaming />)
    expect(container.querySelector('[role="img"]')).toBeNull()
    expect(container.textContent).toContain('graph TD; A-->B')
    expect(renderFn).not.toHaveBeenCalled()
  })
})
