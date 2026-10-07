/**
 * Settled render of a ```mermaid fence: the shared code-card toolbar (language
 * label and a copy action that writes the diagram source) over the sanitized
 * diagram. The source shows in the card body until the first render settles,
 * a palette change keeps the current diagram until its replacement arrives,
 * and a failed render falls back to the ordinary source `CodeBlock`. Wide
 * diagrams shrink toward the card width down to a floor, then scroll
 * horizontally inside the card instead of widening the transcript.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import clsx from 'clsx'
import { CodeToolbar } from '../CodeToolbar.tsx'
import { useCopyFeedback } from '../use-copy-feedback.ts'
import { CodeBlock } from './CodeBlock.tsx'
import { renderMermaid } from './mermaid.ts'
import type { MermaidResult, MermaidTheme } from './mermaid.ts'
import type { MarkdownCodeLabels } from './render.tsx'
import cardCss from '../CodeCard.module.css'
import css from './MermaidBlock.module.css'

/**
 * Body attribute the theme presenter and boot script set for the dark token
 * palette (`ThemePresenter.DARK_ATTRIBUTE`); this cordis-free package reads
 * the document instead of importing that layer.
 */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Toolbar text for the diagram card; its wrap actions never render because the card passes no wrap handler. */
const DIAGRAM_TOOLBAR_LABELS = { codeLabel: 'mermaid', wrapLabel: '', unwrapLabel: '' }

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
  return () => { observer.disconnect() }
}

function documentTheme(): MermaidTheme {
  return document.body.hasAttribute(DARK_ATTRIBUTE) ? 'dark' : 'light'
}

/** Inputs for one settled Mermaid fence. */
export interface MermaidBlockProps {
  /** Diagram source: the fence body without its trailing newline. */
  code: string
  /** Localized copy labels; `toolbarLabels` also styles the source fallback. */
  labels: MarkdownCodeLabels
}

/**
 * Render one settled Mermaid fence as a diagram card.
 * @param props - Diagram source and localized copy labels.
 * @returns The diagram card, or the source code block when rendering fails.
 */
export function MermaidBlock({ code, labels }: MermaidBlockProps) {
  const theme = useSyncExternalStore(subscribeTheme, documentTheme, documentTheme)
  const [rendered, setRendered] = useState<{ code: string; result: MermaidResult } | undefined>(undefined)
  const { copied, onCopy } = useCopyFeedback(code)

  useEffect(() => {
    let current = true
    void renderMermaid(code, theme).then((result) => {
      if (current) setRendered({ code, result })
    })
    return () => { current = false }
  }, [code, theme])

  const result = rendered?.code === code ? rendered.result : undefined
  if (result?.ok === false) {
    return (
      <CodeBlock
        code={`${code}\n`}
        lang="mermaid"
        copyLabel={labels.copyLabel}
        copiedLabel={labels.copiedLabel}
        toolbarLabels={labels.toolbarLabels}
      />
    )
  }
  return (
    <div className={clsx(cardCss.card, 'md-code-block')} data-mermaid-diagram={result === undefined ? 'pending' : 'rendered'}
      aria-busy={result === undefined || undefined}>
      <CodeToolbar
        lang="mermaid" labels={DIAGRAM_TOOLBAR_LABELS} copyLabel={labels.copyLabel} copiedLabel={labels.copiedLabel}
        copied={copied} wrapped={false} onCopy={onCopy}
      />
      <div className={clsx(cardCss.body, css.body)}>
        {result === undefined
          ? <pre className={css.source}><code>{code}</code></pre>
          : (
            <div
              className={css.diagram}
              style={result.width === undefined ? undefined : { '--dsl-mermaid-width': `${result.width}px` } as CSSProperties}
              // Generated SVG after Mermaid's strict mode and this package's
              // DOMPurify pass (mermaid.ts); no authored markup reaches here.
              dangerouslySetInnerHTML={{ __html: result.svg }}
            />
          )}
      </div>
    </div>
  )
}
