# Agent Note: Inline Mermaid diagrams in assistant Markdown

Status: implemented

English | [中文](2026-08-19-web-inline-mermaid-diagrams.zh.md)

## Problem

Assistant replies describe flowcharts, sequences, state machines, and mind maps in ` ```mermaid ` fences, but the chat showed them as source text. The reader most often uses a phone around 390px wide, so a rendered diagram must stay legible there without widening the transcript. Diagram source is untrusted model output, Mermaid is roughly a megabyte of JavaScript that most sessions never need, and its rendering is asynchronous and DOM-dependent, unlike the synchronous KaTeX path the [Markdown renderer](../../../../packages/client/ui-primitives/README.md#rendering-agent-output) already uses for TeX.

The same reader also needs prose prices to survive the settled math grammar. With `micromark-extension-math`'s default single-dollar rule, `It costs $5 and $10.` parsed `5 and ` as inline math.

## Decision

`renderCode` in [render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) routes a settled fence whose language is `mermaid` (case-insensitive) to [`MermaidBlock`](../../../../packages/client/ui-primitives/src/markdown/MermaidBlock.tsx). While a reply streams, the fence stays on the ordinary `CodeBlock` arm, so incomplete source never reaches Mermaid; the settled pass replaces it.

`MermaidBlock` draws the shared code-card chrome: `CodeToolbar` labeled `mermaid` with a copy action that writes the diagram source, over the card body. The source fills the body until the first render settles. The card reads the palette from `body[data-ds-dark-theme]`, the attribute the theme presenter and boot script own, through a `MutationObserver`. A palette change renders again and keeps the current diagram until the replacement arrives. A render failure replaces the card with the source `CodeBlock`, which keeps the copy and wrap controls. Labels arrive through `MarkdownLabels.code`, so no new locale keys exist.

[mermaid.ts](../../../../packages/client/ui-primitives/src/markdown/mermaid.ts) loads `mermaid` 11.16.0 and `dompurify` through dynamic `import()` on the first diagram. A failed import is retried by the next diagram. Because Mermaid configuration is global, one queue serializes `initialize` and `render`. Each render does the following:

- Initializes Mermaid with `securityLevel: 'strict'`, `htmlLabels: false`, `suppressErrorRendering: true`, `fontFamily: 'inherit'`, and the `default` or `dark` theme. The `secure` list stops directives and front matter from overriding the security, label, font, and theme keys, including `themeCSS` and `themeVariables`.
- Parses the source and rejects flowchart image nodes before layout. Mermaid's layout loads those images even under strict security.
- Lays out in an offscreen staging node that is removed in `finally`.
- Re-sanitizes the SVG with a private DOMPurify instance, so its hooks never reach Mermaid's shared instance. The pass keeps the SVG and SVG-filter profiles plus the diagram's own `<style>` and `dominant-baseline`. It removes `foreignObject`, `image`, `script`, and `use`; strips every anchor target and every other `href` that is not an in-document fragment, keeping the inert anchors because Mermaid positions clickable nodes through their `transform`; and replaces CSS `url()` references outside the document and `@import` rules. The rendered diagram therefore loads no external resource and has no interactive target.

The sanitized SVG keeps Mermaid's `width="100%"` and intrinsic `max-width`. The card passes the `viewBox` width as `--dsl-mermaid-width`, and [the stylesheet](../../../../packages/client/ui-primitives/src/markdown/MermaidBlock.module.css) sets a floor at 60% of it. A narrow diagram centers at its intrinsic size. A wide one shrinks to the floor, then scrolls horizontally inside the card body, whose `overflow-x: auto` comes from the shared code-card body. The page never widens.

The bundling path is unchanged. `ui-primitives` builds through the static-linked tsdown preset, which keeps every bare specifier external, so `import('mermaid')` and `import('dompurify')` survive into `lib/index.js`. The Web shell's Vite build then splits them into on-demand chunks outside its `index` and `vendor` chunks. Both packages are `ui-primitives` development dependencies, like the package's other browser libraries, and the browser-input walk in the notices generator discloses them as distributed runtime packages.

Math keeps the existing KaTeX pipeline. [mathCompatibility.ts](../../../../packages/client/ui-primitives/src/markdown/mathCompatibility.ts) owns single-dollar inline math, while [parse.ts](../../../../packages/client/ui-primitives/src/markdown/parse.ts) registers `math({ singleDollarTextMath: false })` so `micromark-extension-math` keeps `$$` and longer inline sequences. The single-dollar construct follows Pandoc's `tex_math_dollars` rule: the opening `$` precedes a non-space character, and the closing `$` follows a non-space character and precedes neither a digit nor another `$`. It adds one stricter rule, matching TeX: any other unescaped `$` ends the candidate as text. `costs $5, and $x$` therefore keeps the later formula. A backslash escapes the next character, so `\$` is a literal dollar inside math.

## Alternatives considered

**Show the SVG as an `<img>` data URL instead of inline markup.** Image mode isolates SVG behavior without a sanitizer, and upstream's reverted preview used it. It also loses the inherited font and crisp text selection, and it needs separate sizing from the image's natural dimensions. Strict mode plus a hooked DOMPurify pass that removes every active or external construct gives the same no-script, no-fetch result while the diagram stays part of the document.

**Upstream's Source/Preview toggle, lightbox, viewport-deferred rendering, and Graphviz/SVG/HTML previews.** That design was reverted twice. Its interaction model, retained-result ownership, offscreen observers, and separate preview notices file added more surface than this inline view needs. This decision keeps one static diagram, copyable source, and no extra controls. Panning and zooming belong to a separate artifact view if they become necessary.

**Mermaid's base theme driven by `--dsw-*` token values.** Matching the application palette exactly requires resolving CSS custom properties to concrete colors that Mermaid's color math accepts. Tokens may use `color-mix()` or other forms that it rejects. The built-in `default` and `dark` themes on the code-card background are legible in both palettes without that coupling.

**Render each streamed chunk.** Partial diagrams are mostly invalid, and repeated layout competes with streaming text. Settlement provides complete source.

**Server-side raster rendering through a tool.** A host-side renderer would turn presentation of text the model already wrote into a model-visible attachment, add a host dependency, and lose vector text.

**Keep upstream's single-dollar math and require `\$` for prices.** Model output writes prices with bare dollars, and the default rule silently rewrote them as italic math. Pandoc's spacing rule is the widely used compromise; the inner-`$` rule only rejects candidates that TeX itself could not typeset.

## Consequences

The first diagram costs one lazy chunk fetch plus Mermaid initialization. Sessions without diagrams pay nothing beyond the small `MermaidBlock` and `mermaid.ts` modules. Layout runs on the browser thread one diagram at a time, and a palette change re-renders every mounted diagram. Diagrams are static: they have no pan, zoom, clickable nodes, links, or images. A flowchart that uses image nodes shows its source instead. On narrow screens a wide diagram scrolls inside its card rather than shrinking below 60% of its intrinsic width.

Single-dollar parsing now rejects `$ x$`, `$x $`, `$x$5`, and any candidate with an unescaped inner `$`. Mixed use remains ambiguous when a bare `$` satisfies both delimiter rules, as in Pandoc. The streaming grammar still has no math, so TeX stays literal until settlement.

## Testing

[mermaid.client.spec.tsx](../../../../packages/client/ui-primitives/tests/mermaid.client.spec.tsx) mocks only Mermaid and runs DOMPurify for real. It covers locked configuration, the theme mapping, render serialization, staging cleanup, `viewBox` width, sanitization of scripts, handlers, anchor targets, `foreignObject`, images, `use`, external `href` values, `url()`, and `@import`, image-node rejection, parse and layout failures, import retry, and the card's pending, rendered, copy, palette-change, unmount, and fallback states. It also checks the settled versus streaming fence routing. [markdown.client.spec.tsx](../../../../packages/client/ui-primitives/tests/markdown.client.spec.tsx) checks KaTeX output for every delimiter, ```` ```math ```` fences, `aligned` and matrix environments, prose prices, and `$$` inline math. The keyless [browser scenario](../../../../apps/web/tests/markdown-mermaid-math.e2e.ts) seeds a reply with diagrams and math and checks real Mermaid output, the sanitization result, fallbacks, KaTeX, and phone-width overflow in the built Web app.
