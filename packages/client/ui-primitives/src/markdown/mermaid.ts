/**
 * Lazy Mermaid rendering for settled Markdown fences. Mermaid and DOMPurify
 * load through dynamic `import()` on the first diagram, so neither enters the
 * initial client bundle. Diagram source is untrusted model output: Mermaid
 * runs at `securityLevel: 'strict'` with HTML labels off, flowchart image
 * nodes are rejected before layout (layout would fetch them even in strict
 * mode), and a private DOMPurify instance re-sanitizes the SVG before the
 * caller inserts it. The second pass keeps the SVG vocabulary and the
 * diagram's own `<style>`, removes `foreignObject`, images, scripts, and
 * `use` elements, strips every anchor target and every other `href` that is
 * not an in-document fragment, and replaces CSS `url()` references that
 * leave the document and `@import` rules, so a rendered diagram loads no
 * external resource and has no interactive target.
 *
 * Mermaid configuration is global, so every render runs through one queue
 * that initializes the requested theme and renders before the next request
 * starts. Diagram directives cannot override the security, label, font, or
 * theme keys this module sets.
 */

import type { Mermaid } from 'mermaid'
import type { DOMPurify } from 'dompurify'

/** Document palette a diagram renders against. */
export type MermaidTheme = 'light' | 'dark'

/** One diagram render outcome. */
export type MermaidResult =
  | {
    readonly ok: true
    /** Sanitized SVG markup whose root is an `<svg>` element. */
    readonly svg: string
    /** Intrinsic diagram width in CSS pixels from the SVG `viewBox`, when present. */
    readonly width: number | undefined
  }
  | { readonly ok: false; readonly error: string }

/** Mermaid theme ids for each document palette. */
const MERMAID_THEMES: Readonly<Record<MermaidTheme, 'default' | 'dark'>> = {
  light: 'default',
  dark: 'dark',
}

/**
 * Configuration keys diagram directives and front matter cannot override.
 * Mermaid's own defaults are restated because `secure` replaces, not extends,
 * its list.
 */
const SECURE_KEYS = [
  'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
  'htmlLabels', 'fontFamily', 'theme', 'themeVariables', 'themeCSS', 'darkMode',
]

/**
 * SVG elements removed even when the SVG profile would keep them. Anchors
 * stay, without targets, because Mermaid positions clickable nodes through
 * the anchor's `transform`.
 */
const FORBIDDEN_TAGS = ['foreignObject', 'image', 'script', 'use']

/** CSS that would load a resource from outside the document. */
const EXTERNAL_CSS_IMPORT = /@import\b[^;]*;?/gi
const EXTERNAL_CSS_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi

let runtime: Promise<Mermaid> | undefined
let sanitizer: Promise<DOMPurify> | undefined
let queue: Promise<unknown> = Promise.resolve()
let nextDiagramId = 0

/** Import Mermaid once; a failed import is retried by the next render. */
function loadMermaid(): Promise<Mermaid> {
  runtime ??= import('mermaid').then(module => module.default).catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

/** Create the private DOMPurify instance once; a failed import is retried by the next render. */
function loadSanitizer(): Promise<DOMPurify> {
  sanitizer ??= import('dompurify').then(module => createSanitizer(module.default)).catch((error: unknown) => {
    sanitizer = undefined
    throw error
  })
  return sanitizer
}

/** Remove CSS references to resources outside the document. */
function stripExternalCss(css: string): string {
  return css.replace(EXTERNAL_CSS_IMPORT, '').replace(EXTERNAL_CSS_URL, 'none')
}

/**
 * Build a DOMPurify instance whose hooks do not reach Mermaid's own shared
 * instance.
 * @param factory - DOMPurify's default export, callable as an instance factory.
 * @returns The configured private instance.
 */
function createSanitizer(factory: DOMPurify): DOMPurify {
  const purify = factory(window)
  purify.addHook('uponSanitizeElement', (node, event) => {
    if (event.tagName === 'style' && node.textContent !== null) node.textContent = stripExternalCss(node.textContent)
  })
  purify.addHook('afterSanitizeAttributes', (element) => {
    const anchor = element.localName === 'a'
    for (const name of ['href', 'xlink:href']) {
      const value = element.getAttribute(name)
      if (value !== null && (anchor || !value.startsWith('#'))) element.removeAttribute(name)
    }
    const style = element.getAttribute('style')
    if (style !== null) element.setAttribute('style', stripExternalCss(style))
  })
  return purify
}

/**
 * Reject flowchart image nodes, which Mermaid's layout loads from the network
 * even under strict security.
 * @param mermaid - The loaded runtime, initialized for this render.
 * @param code - Diagram source.
 * @throws {Error} When the source fails to parse or declares an image node.
 */
async function rejectImageNodes(mermaid: Mermaid, code: string): Promise<void> {
  // The supported parse API reports validity, not the parsed nodes.
  // oxlint-disable-next-line typescript/no-deprecated
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(code)
  if (!diagram.type.startsWith('flowchart')) return
  const db = diagram.db as { getVertices(): Map<string, { img?: string }> }
  for (const vertex of db.getVertices().values()) {
    if (vertex.img !== undefined) throw new Error('Mermaid image nodes are not supported')
  }
}

/**
 * Sanitize Mermaid's SVG and read its intrinsic width.
 * @param purify - The private sanitizer.
 * @param svg - SVG markup from `mermaid.render`.
 * @returns The sanitized markup and its `viewBox` width.
 * @throws {Error} When sanitization leaves no root `<svg>` element.
 */
function sanitizeSvg(purify: DOMPurify, svg: string): { svg: string; width: number | undefined } {
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['dominant-baseline'],
    FORBID_TAGS: FORBIDDEN_TAGS,
    RETURN_DOM_FRAGMENT: true,
  })
  const root = fragment.firstElementChild
  if (root?.localName !== 'svg') throw new Error('Mermaid produced no SVG element')
  const width = Number(root.getAttribute('viewBox')?.trim().split(/[\s,]+/)[2])
  return { svg: root.outerHTML, width: Number.isFinite(width) && width > 0 ? width : undefined }
}

async function renderOne(code: string, theme: MermaidTheme): Promise<MermaidResult> {
  const [mermaid, purify] = await Promise.all([loadMermaid(), loadSanitizer()])
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    fontFamily: 'inherit',
    theme: MERMAID_THEMES[theme],
    secure: SECURE_KEYS,
  })
  await rejectImageNodes(mermaid, code)
  // Layout measures text, so the staging node must be laid out but unseen.
  const stage = document.createElement('div')
  stage.setAttribute('aria-hidden', 'true')
  Object.assign(stage.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden' })
  document.body.append(stage)
  try {
    const { svg } = await mermaid.render(`dsh-mermaid-${nextDiagramId++}`, code, stage)
    return { ok: true, ...sanitizeSvg(purify, svg) }
  } finally {
    stage.remove()
  }
}

/**
 * Render one Mermaid diagram to sanitized SVG. Renders run one at a time in
 * request order; an import, parse, image-node, layout, or sanitization
 * failure resolves to an error result rather than rejecting.
 * @param code - Complete diagram source (the settled fence body).
 * @param theme - Document palette the diagram colors follow.
 * @returns The sanitized SVG and its intrinsic width, or the failure message.
 */
export function renderMermaid(code: string, theme: MermaidTheme): Promise<MermaidResult> {
  const task = queue.then(() => renderOne(code, theme)).catch((error: unknown): MermaidResult => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
  queue = task
  return task
}
