/**
 * Lazy Mermaid renderer for the assistant-Markdown pipeline. Mermaid (~1 MB)
 * AND its DOMPurify sanitizer are imported only when the first `mermaid` fence
 * renders — the same defer-until-needed pattern as the shiki lazy grammars in
 * `highlight.ts`, so a session that never shows a diagram adds nothing to the
 * main bundle.
 *
 * Security is defense in depth: mermaid runs at `securityLevel: 'strict'`
 * (no script or HTML labels, so its own DOMPurify pass sanitizes the output),
 * and this module runs a SECOND DOMPurify pass over the SVG before it reaches
 * the DOM through the caller's `dangerouslySetInnerHTML` — the same sanctioned
 * generated-markup path `CodeBlock` (shiki) and `katex.tsx` use, held to the
 * renderer's rule that no raw model-authored HTML enters the DOM.
 *
 * The rendered SVG is static: `securityLevel: 'strict'` drops interactivity,
 * so the caller never binds mermaid's click handlers.
 */

/** One diagram render outcome: sanitized SVG markup, or a parse/render error message. */
export type MermaidResult =
  | { readonly ok: true; readonly svg: string }
  | { readonly ok: false; readonly error: string }

/** The imported mermaid default export, resolved once and shared by later renders. */
let modulePromise: Promise<typeof import('mermaid').default> | undefined

/** The imported DOMPurify default export, resolved once and shared by later renders. */
let purifyPromise: Promise<typeof import('dompurify').default> | undefined

/** Monotonic id per render so concurrent diagrams never collide on mermaid's transient element id. */
let renderSeq = 0

/** Import mermaid once; later callers await the same module. */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  modulePromise ??= import('mermaid').then(module => module.default)
  return modulePromise
}

/** Import DOMPurify once; later callers await the same module. */
function loadPurify(): Promise<typeof import('dompurify').default> {
  purifyPromise ??= import('dompurify').then(module => module.default)
  return purifyPromise
}

/**
 * The active light/dark palette, read from the rendered DOM rather than a
 * cordis service (this package is cordis-free). `ThemePresenter` sets
 * `body[data-ds-dark-theme]` for the dark token palette and the boot theme
 * sets root `color-scheme` before React mounts; either signals dark. The
 * attribute name mirrors `ThemePresenter.DARK_ATTRIBUTE` — a DOM contract this
 * lower layer reads but must not import upward.
 * @returns the mermaid theme id matching the current palette.
 */
function activeMermaidTheme(): 'dark' | 'default' {
  return document.body.hasAttribute('data-ds-dark-theme')
    || document.documentElement.style.colorScheme === 'dark'
    ? 'dark'
    : 'default'
}

/**
 * Second-pass sanitize of mermaid's SVG: keep the SVG vocabulary and the
 * diagram's own `<style>` block (its colors), while DOMPurify strips any script
 * element or event-handler attribute that survived mermaid's own strict pass.
 * Labels are native SVG `<text>` (see `htmlLabels: false` below), so this
 * strict SVG-only profile keeps them without allowing HTML into the DOM.
 * @param purify - the imported DOMPurify instance.
 * @param svg - the SVG markup mermaid produced.
 * @returns the sanitized SVG markup.
 */
function sanitizeSvg(purify: typeof import('dompurify').default, svg: string): string {
  return purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
  })
}

/**
 * Render one Mermaid diagram source to sanitized SVG. Any parse or render
 * failure (invalid diagram syntax, edge/size guards) resolves to an `ok:false`
 * result carrying the message, so the caller can fall back to the raw source
 * instead of surfacing an exception.
 * @param code - the diagram source (the fence body).
 * @returns the sanitized SVG on success, or the error message on failure.
 */
export async function renderMermaid(code: string): Promise<MermaidResult> {
  try {
    const [mermaid, purify] = await Promise.all([loadMermaid(), loadPurify()])
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Render node labels as native SVG <text> rather than HTML inside
      // <foreignObject>, so the strict SVG-only sanitize keeps the label text
      // (DOMPurify drops foreignObject's cross-namespace HTML by design).
      htmlLabels: false,
      suppressErrorRendering: true,
      deterministicIds: true,
      maxTextSize: 50_000,
      maxEdges: 2000,
      fontFamily: 'inherit',
      theme: activeMermaidTheme(),
    })
    const { svg } = await mermaid.render(`dsh-mermaid-${renderSeq++}`, code)
    return { ok: true, svg: sanitizeSvg(purify, svg) }
  } catch (error) {
    // Surface the full error (stack) for diagnosis; the returned message drives
    // the caller's visible fallback.
    console.error('[dsh-mermaid] render failed', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
