# Agent Note: assistant Markdown 中的内联 Mermaid 图表

Status: implemented

[English](2026-08-19-web-inline-mermaid-diagrams.md) | 中文

## 问题

assistant Markdown 渲染器已经通过 KaTeX 排版 `$…$`/`$$…$$` TeX，因此公式在聊天中内联渲染（[增量 AST 渲染器](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md)）。图表则没有这样的路径：` ```mermaid ` 围栏渲染为高亮的代码块，因此思维导图、流程图、状态图和时序图——学习者最想放在文字旁的可视化——只能停留为源文本。模型已经能在普通输出中创作 Mermaid 图表；缺的只是渲染。

Mermaid 不是 KaTeX。KaTeX 是同步的（`string → HTML string → DOM`），这正是公式能在 `render.tsx` 的 switch 里作为纯节点渲染的原因。Mermaid 异步渲染，并需要 DOM 来测量和布局（`await mermaid.render(...)`），其打包体积约 1 MB，且此处输入是模型创作的，因此它需要一种不同于纯公式节点的形态，同时遵守渲染器"不让原始模型 HTML 进入 DOM"的规则及其按字节固定的 DOM 一致性约定。

## 决策

` ```mermaid ` 围栏在定稿一遍上渲染为内联图表。`packages/client/ui-primitives/src/markdown/render.tsx` 中的 `renderCode` 在既有 `math` 分支旁增加一个分支：当 `!context.streaming && lang === 'mermaid'` 时，它返回 `<MermaidBlock>`；流式期间则落到纯 `CodeBlock`，因此半写成的图表绝不会到达 mermaid，而定稿的高亮与图表渲染都落在与以往相同的 finalize 交换上。

`MermaidBlock`（`src/markdown/MermaidBlock.tsx`）是一个小型有状态组件——纯公式节点的异步对应物。它显示一个中性的脉动占位符，在 effect 中渲染图表，然后换入 SVG。源变化或卸载会置一个 cancelled 标志，因此迟来的 resolve 绝不会在陈旧或已死组件上设置状态。任何解析或渲染失败都回退为作为 `CodeBlock` 的源码，因此图表源码始终可见且可复制。

`src/markdown/mermaid.ts` 拥有该渲染。mermaid 与 DOMPurify 都在首次使用时通过动态 `import()` 引入——与 `highlight.ts` 中 shiki 惰性语法相同的按需推迟模式——因此整个图表功能（引擎加净化器）都不在主包内；没有图表的会话不增加任何内容。lib 包把两者保持为 `import("mermaid")`/`import("dompurify")` 分块，在 `tsdown` 之后验证。

安全采用纵深防御。Mermaid 以 `securityLevel: 'strict'` 运行（无脚本、无 HTML 标签，因此其自身的 DOMPurify 会净化输出，且渲染出的 SVG 是静态的——调用方绝不绑定点击处理器），而 `mermaid.ts` 在调用方通过 `dangerouslySetInnerHTML` 注入之前，对该 SVG 再运行第二遍 DOMPurify（`USE_PROFILES: { svg: true, svgFilters: true }`，保留图表自身的 `<style>`）——与 `CodeBlock`（shiki）和 `katex.tsx` 所用相同的经许可的生成标记路径。

主题跟随调色板。这个无 cordis 的包读取渲染出的 DOM 而非主题服务：`body[data-ds-dark-theme]`（镜像 `ThemePresenter.DARK_ATTRIBUTE`）或根 `color-scheme: dark` 选择 mermaid 的 `dark` 主题，否则为 `default`。一个单调递增的 render id 使并发图表不会在 mermaid 的瞬态元素 id 上冲突；`deterministicIds: true` 使 SVG 内的 id 保持稳定。

## 曾考虑的替代方案

**通过附件流水线做服务端渲染的光栅图。** 一个工具可以在宿主端把 Mermaid 渲染成 PNG，并经既有 `read_image` → `ImageGallery` 路径内联呈现，无需任何新客户端代码。作为主路径不予采纳：它产出静态光栅而非清晰的矢量 SVG，需要宿主端渲染器依赖，并把一个图表变成持久附件（模型可见的工具结果），而该图表其实只是模型已写文本的呈现。作为对确实需要宿主计算的图/plot 渲染的可行未来补充留存在案。

**像 `math` 那样的纯同步节点。** 不可能：`mermaid.render` 是异步且依赖 DOM 的，因此它无法从 `render.tsx` 的纯 switch 返回一个元素。有状态组件是保持 `render.tsx` 除那一行分派外处处为纯的最小形态。

**把 mermaid 打进主分块。** 不予采纳：对许多会话从不使用的功能，每个会话都要付约 1 MB。惰性 `import()` 把成本限制到首个图表，与 shiki 惰性语法的先例一致。

**只依赖 mermaid 的 strict 模式净化。** 不予采纳，而是加第二遍 DOMPurify：输入是模型创作的，且渲染器的既定规则是没有原始 HTML 到达 DOM，因此图表被要求达到与 shiki/KaTeX 输出相同的双重净化标准。

**在 Mermaid 之外加入 Graphviz/DOT。** 推迟：Mermaid 覆盖思维导图、流程图、状态图、时序图、ER 图和类图——即学习用例——而且 DSH 已经把自己的图渲染为 Mermaid。Graphviz 只在大型密集的任意图上占优，是干净的后续补充。

## 后果

该变更是增量式的，且以现有内容都不使用的 token 为门控，因此全部 46 个 `markdown-dom` 一致性 fixture 都按字节相同地渲染——按字节固定的 DOM 约定无需重新记录即得以保持。两个新的运行时依赖进入 `ui-primitives`（`mermaid`、`dompurify`），两者都已在全仓库范围审核过，都是惰性的，因此都不会增大主包。图表是静态的：无平移/缩放或可点击节点（那种交互属于浏览器标签页 artifact 或未来的沙箱面板，而非此内联表层）。模型以无效语法写出的图表会劣化为其可读源码，而非报错。

## 测试

`packages/client/ui-primitives/tests/mermaid.client.spec.tsx` 把该功能钉在对 `mermaid.ts` 和 `MermaidBlock.tsx` 的逐文件 100% 覆盖率。Mermaid 作为外部的、非确定性依赖被 mock（经许可的 mock 边界）；DOMPurify 真实运行，因此净化这一遍被真正执行——一个测试喂入携带 `<script>` 和 `onclick` 的 SVG，并断言两者都被剥除而 `<svg>` 与 `<style>` 存活。该套件覆盖加载器（strict 模式初始化、从任一 DOM 信号选择深色主题、Error 与非 Error 失败结果）、组件（占位符 → 图表、失败时回退源码、以及卸载后取消的守护）和 `render.tsx` 路由（定稿围栏渲染图表，流式围栏保持纯代码块且从不调用 mermaid）。`markdown-dom-parity` 套件证明零漂移这一主张。

## 相关

- [增量 AST Markdown 渲染器](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md)——本围栏类型在既有 `math` 围栏旁扩展的渲染器及其按字节固定的 DOM 一致性约定。
