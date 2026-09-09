// MermaidBlock: the settled render of a ```mermaid fence. Mermaid is async and
// needs the DOM, so unlike KaTeX (synchronous, a pure node in render.tsx) this
// is a small stateful component: it shows a placeholder, renders the diagram
// off the main render pass, then swaps in the sanitized SVG. A parse/render
// failure falls back to the source as a CodeBlock, so the diagram source is
// always visible and copyable. Only reached on the settle pass — while a
// message streams, the fence renders as a plain CodeBlock (render.tsx gates on
// !streaming), so no half-written diagram is ever handed to mermaid.

import { useEffect, useState } from 'react'
import { CodeBlock } from './CodeBlock.tsx'
import { renderMermaid } from './mermaid.ts'
import type { MermaidResult } from './mermaid.ts'
import css from './MermaidBlock.module.css'

export interface MermaidBlockProps {
  /** The fence body: one Mermaid diagram source. */
  code: string
  /** Copy-button idle label forwarded to the source-fallback CodeBlock. */
  copyLabel?: string | undefined
  /** Copy-button confirmation label forwarded to the source-fallback CodeBlock. */
  copiedLabel?: string | undefined
}

type RenderState = { readonly status: 'loading' } | { readonly status: 'done'; readonly result: MermaidResult }

/**
 * Render one Mermaid fence as an inline diagram.
 * @param props - the diagram source and the copy labels its source fallback uses.
 * @returns the diagram SVG, a loading placeholder, or the source code block on failure.
 */
export function MermaidBlock({ code, copyLabel, copiedLabel }: MermaidBlockProps) {
  const [state, setState] = useState<RenderState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void renderMermaid(code).then((result) => {
      if (!cancelled) setState({ status: 'done', result })
    })
    // A source change or unmount abandons the in-flight render so its late
    // resolution never sets state on a stale or dead component.
    return () => { cancelled = true }
  }, [code])

  if (state.status === 'loading') {
    return <div className={css.loading} aria-busy="true" />
  }
  if (!state.result.ok) {
    return (
      <>
        <div className={css.error}>⚠ Diagram could not render: {state.result.error}</div>
        <CodeBlock code={code} lang="mermaid" copyLabel={copyLabel} copiedLabel={copiedLabel} />
      </>
    )
  }
  return (
    <div
      className={css.diagram}
      role="img"
      // Double-sanitized static SVG (mermaid strict mode + the loader's second
      // DOMPurify pass) — the same sanctioned generated-markup innerHTML path
      // CodeBlock (shiki) and katex.tsx use; no raw model HTML reaches here.
      dangerouslySetInnerHTML={{ __html: state.result.svg }}
    />
  )
}
