# Agent Note: Inline Mermaid diagrams in assistant Markdown

Status: implemented

English | [中文](2026-08-19-web-inline-mermaid-diagrams.zh.md)

## Problem

The assistant-Markdown renderer already typesets `$…$`/`$$…$$` TeX through KaTeX, so equations render inline in chat ([incremental AST renderer](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md)). Diagrams had no such path: a ` ```mermaid ` fence rendered as a highlighted code block, so mind maps, flowcharts, state and sequence diagrams — the visualizations a learner most wants beside prose — stayed as source text. The model can already author a Mermaid diagram in ordinary output; only the rendering was missing.

Mermaid is not KaTeX. KaTeX is synchronous (`string → HTML string → DOM`), which is why math renders as a pure node inside `render.tsx`'s switch. Mermaid renders asynchronously and needs the DOM to measure and lay out (`await mermaid.render(...)`), its bundle is ~1 MB, and its input here is model-authored, so it demands a different shape than the pure math node while honoring the renderer's "no raw model HTML enters the DOM" rule and its byte-pinned DOM-parity contract.

## Decision

A ` ```mermaid ` fence renders as an inline diagram on the settled pass. `renderCode` in `packages/client/ui-primitives/src/markdown/render.tsx` gains one branch beside the existing `math` branch: when `!context.streaming && lang === 'mermaid'`, it returns `<MermaidBlock>`; while streaming it falls through to the plain `CodeBlock`, so a half-written diagram never reaches mermaid and settled highlighting/diagram rendering both land on the same finalize swap as before.

`MermaidBlock` (`src/markdown/MermaidBlock.tsx`) is a small stateful component — the async analogue of the pure math node. It shows a neutral pulsing placeholder, renders the diagram in an effect, then swaps in the SVG. A source change or unmount sets a cancelled flag so a late resolution never sets state on a stale or dead component. Any parse or render failure falls back to the source as a `CodeBlock`, so the diagram source is always visible and copyable.

`src/markdown/mermaid.ts` owns the render. Mermaid and DOMPurify are both imported through dynamic `import()` on first use — the same defer-until-needed pattern as the shiki lazy grammars in `highlight.ts` — so the whole diagram feature (engine plus sanitizer) stays off the main bundle; a session with no diagram adds nothing. The lib bundle keeps both as `import("mermaid")`/`import("dompurify")` chunks, verified after `tsdown`.

Security is defense in depth. Mermaid runs at `securityLevel: 'strict'` (no scripts, no HTML labels, so its own DOMPurify pass sanitizes output and the rendered SVG is static — the caller never binds click handlers), and `mermaid.ts` runs a SECOND DOMPurify pass over the SVG (`USE_PROFILES: { svg: true, svgFilters: true }`, keeping the diagram's own `<style>`) before the caller injects it through `dangerouslySetInnerHTML` — the same sanctioned generated-markup path `CodeBlock` (shiki) and `katex.tsx` use.

Theme follows the palette. This cordis-free package reads the rendered DOM rather than a theme service: `body[data-ds-dark-theme]` (mirroring `ThemePresenter.DARK_ATTRIBUTE`) or root `color-scheme: dark` selects mermaid's `dark` theme, else `default`. A monotonic render id keeps concurrent diagrams from colliding on mermaid's transient element id; `deterministicIds: true` keeps the ids inside the SVG stable.

## Alternatives considered

**Server-rendered raster through the attachment pipeline.** A tool could render Mermaid to PNG host-side and surface it inline through the existing `read_image` → `ImageGallery` path, with zero new client code. Rejected as the primary path: it yields a static raster instead of crisp vector SVG, needs a host-side renderer dependency, and turns a diagram into a durable attachment (a model-visible tool result) when the diagram is really just presentation of text the model already wrote. Kept on record as a viable future complement for plot/图 rendering that genuinely needs host computation.

**A pure synchronous node like `math`.** Impossible: `mermaid.render` is async and DOM-dependent, so it cannot return an element from `render.tsx`'s pure switch. The stateful component is the minimal shape that keeps `render.tsx` pure everywhere except the one-line dispatch.

**Bundling mermaid into the main chunk.** Rejected: ~1 MB on every session for a feature many sessions never use. Lazy `import()` confines the cost to the first diagram, matching the shiki lazy-grammar precedent.

**Rely on mermaid's strict-mode sanitization alone.** Rejected in favor of the second DOMPurify pass: the input is model-authored and the renderer's standing rule is that no raw HTML reaches the DOM, so a diagram is held to the same double-sanitized bar as shiki/KaTeX output.

**Add Graphviz/DOT alongside Mermaid.** Deferred: Mermaid covers mind maps, flowcharts, state, sequence, ER, and class diagrams — the learning cases — and DSH already renders its own graphs as Mermaid. Graphviz only wins on large dense arbitrary graphs and is a clean later addition.

## Consequences

The change is additive and gated on a token no existing content uses, so every one of the 46 `markdown-dom` parity fixtures renders byte-identically — the byte-pinned DOM contract is preserved without a re-record. Two new runtime dependencies enter `ui-primitives` (`mermaid`, `dompurify`), both already vetted repo-wide, both lazy so neither grows the main bundle. Diagrams are static: no pan/zoom or clickable nodes (that interactivity belongs to a browser-tab artifact or a future sandboxed panel, not this inline surface). A diagram the model writes with invalid syntax degrades to its readable source rather than an error.

## Testing

`packages/client/ui-primitives/tests/mermaid.client.spec.tsx` pins the feature at 100% per-file coverage of `mermaid.ts` and `MermaidBlock.tsx`. Mermaid is mocked as the external, nondeterministic dependency (the sanctioned mock boundary); DOMPurify runs for real, so the sanitize pass is genuinely exercised — a test feeds an SVG carrying `<script>` and an `onclick` and asserts both are stripped while `<svg>` and `<style>` survive. The suite covers the loader (strict-mode init, dark-theme selection from either DOM signal, Error and non-Error failure results), the component (placeholder → diagram, source fallback on failure, and the cancelled-after-unmount guard), and the `render.tsx` routing (a settled fence renders a diagram, a streaming fence stays a plain code block and never calls mermaid). The `markdown-dom-parity` suite proves the zero-drift claim.

## Related

- [Incremental AST Markdown renderer](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md) — the renderer and its byte-pinned DOM-parity contract this fence type extends, beside the existing `math` fence.
