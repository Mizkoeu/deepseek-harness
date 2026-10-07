# Agent Note: assistant Markdown 中的内联 Mermaid 图表

Status: implemented

[English](2026-08-19-web-inline-mermaid-diagrams.md) | 中文

## 问题

Assistant 回复会在 ` ```mermaid ` 围栏中描述流程图、时序图、状态机和思维导图，但聊天界面只显示源码文本。读者多数时候使用约 390px 宽的手机，因此渲染后的图表必须在该宽度下保持可读，且不能撑宽对话记录。图表源码是不受信任的模型输出；Mermaid 约有一兆字节 JavaScript，而多数会话从不需要它；它的渲染是异步的且依赖 DOM，不同于 [Markdown 渲染器](../../../../packages/client/ui-primitives/README.zh.md#rendering-agent-output)已为 TeX 使用的同步 KaTeX 路径。

同一位读者也需要正文中的价格在定稿数学语法下保持原样。在 `micromark-extension-math` 默认的单美元符号规则下，`It costs $5 and $10.` 会把 `5 and ` 解析为行内公式。

## 决策

[render.tsx](../../../../packages/client/ui-primitives/src/markdown/render.tsx) 中的 `renderCode` 会把语言为 `mermaid`（不区分大小写）的定稿围栏交给 [`MermaidBlock`](../../../../packages/client/ui-primitives/src/markdown/MermaidBlock.tsx)。回复流式输出期间，该围栏保留在普通的 `CodeBlock` 分支上，因此不完整的源码永远不会交给 Mermaid；定稿渲染会替换它。

`MermaidBlock` 绘制共享的代码卡片外观：标注为 `mermaid` 的 `CodeToolbar` 位于卡片正文之上，其复制操作写入图表源码。首次渲染完成前，正文显示源码。卡片通过 `MutationObserver` 读取 `body[data-ds-dark-theme]` 上的调色板，该属性由主题呈现器和启动脚本持有。调色板变化时会重新渲染，并在替换结果到达前保留当前图表。渲染失败时，卡片替换为源码 `CodeBlock`，后者保留复制与换行控件。标签经由 `MarkdownLabels.code` 传入，因此不新增任何 locale 键。

[mermaid.ts](../../../../packages/client/ui-primitives/src/markdown/mermaid.ts) 在第一个图表出现时通过动态 `import()` 加载 `mermaid` 11.16.0 与 `dompurify`。导入失败后，下一个图表会重试。由于 Mermaid 配置是全局的，一个队列会串行执行 `initialize` 与 `render`。每次渲染执行以下步骤：

- 以 `securityLevel: 'strict'`、`htmlLabels: false`、`suppressErrorRendering: true`、`fontFamily: 'inherit'` 以及 `default` 或 `dark` 主题初始化 Mermaid。`secure` 列表阻止指令和 front matter 覆盖安全、标签、字体与主题相关的键，包括 `themeCSS` 与 `themeVariables`。
- 解析源码，并在布局前拒绝流程图图片节点。即使在严格安全级别下，Mermaid 的布局仍会加载这些图片。
- 在屏幕外的暂存节点中布局，并在 `finally` 中移除该节点。
- 用私有的 DOMPurify 实例再次净化 SVG，使其钩子永远不会影响 Mermaid 共享的实例。该遍保留 SVG 与 SVG 滤镜配置集，以及图表自身的 `<style>` 和 `dominant-baseline`。它移除 `foreignObject`、`image`、`script` 与 `use`；删除所有链接目标以及其他所有非文档内片段的 `href`，并保留已失效的锚点元素，因为 Mermaid 通过锚点的 `transform` 定位可点击节点；并替换指向文档外部的 CSS `url()` 引用与 `@import` 规则。因此渲染后的图表不会加载任何外部资源，也没有可交互的目标。

净化后的 SVG 保留 Mermaid 的 `width="100%"` 和固有 `max-width`。卡片把 `viewBox` 宽度作为 `--dsl-mermaid-width` 传入，[样式表](../../../../packages/client/ui-primitives/src/markdown/MermaidBlock.module.css)据此设置固有宽度 60% 的下限。窄图表以固有尺寸居中。宽图表缩小到下限后，在卡片正文内横向滚动；正文的 `overflow-x: auto` 来自共享的代码卡片正文。页面永远不会被撑宽。

打包路径保持不变。`ui-primitives` 经由静态链接的 tsdown 预设构建，该预设让每个裸说明符保持外部引用，因此 `import('mermaid')` 与 `import('dompurify')` 会保留在 `lib/index.js` 中。随后 Web 壳的 Vite 构建把它们拆分为 `index` 与 `vendor` chunk 之外的按需 chunk。两个包都是 `ui-primitives` 的开发依赖，与该包的其他浏览器库一致；第三方声明生成器的浏览器输入遍历会把它们披露为随产品分发的运行时包。

数学公式沿用现有的 KaTeX 流水线。[mathCompatibility.ts](../../../../packages/client/ui-primitives/src/markdown/mathCompatibility.ts) 负责单美元符号行内公式，[parse.ts](../../../../packages/client/ui-primitives/src/markdown/parse.ts) 则注册 `math({ singleDollarTextMath: false })`，让 `micromark-extension-math` 继续处理 `$$` 及更长的行内序列。单美元符号构造遵循 Pandoc 的 `tex_math_dollars` 规则：起始 `$` 之后是非空白字符；结束 `$` 之前是非空白字符，之后既不是数字也不是另一个 `$`。它额外增加一条与 TeX 一致的更严格规则：其他任何未转义的 `$` 都会使该候选作为文本结束。因此 `costs $5, and $x$` 会保留后面的公式。反斜杠转义下一个字符，所以 `\$` 是公式中的字面美元符号。

## 考虑过的替代方案

**以 `<img>` data URL 而非内联标记显示 SVG。** 图片模式无需净化器即可隔离 SVG 行为，上游已回退的预览就采用这种方式。但它会失去继承的字体与清晰的文本选择，还需要依据图片的自然尺寸另行计算大小。严格模式加上带钩子的 DOMPurify 遍历会移除所有活动或外部构造，在图表仍是文档一部分的同时，取得同样的无脚本、无外部请求的结果。

**上游的源码／预览切换、灯箱、视口延迟渲染以及 Graphviz/SVG/HTML 预览。** 该设计被回退了两次。它的交互模型、保留结果的归属、屏幕外观察器以及单独的预览声明文件，增加的表面超过这个内联视图的需要。本决策只保留一个静态图表和可复制的源码，不增加额外控件。如果确实需要平移和缩放，应由单独的产物视图提供。

**由 `--dsw-*` token 值驱动 Mermaid 的 base 主题。** 要精确匹配应用调色板，就必须把 CSS 自定义属性解析为 Mermaid 颜色计算可接受的具体颜色。token 可能使用 `color-mix()` 或其他会被拒绝的形式。内置的 `default` 与 `dark` 主题放在代码卡片背景上，在两种调色板下都清晰可读，且没有这种耦合。

**在每个流式分片上渲染。** 不完整的图表大多无效，反复布局还会与流式文本争用资源。定稿提供完整源码。

**通过工具在服务器端渲染为位图。** 宿主侧渲染器会把对模型已写出文本的呈现变成模型可见的附件，增加宿主依赖，并失去矢量文本。

**保留上游的单美元符号公式规则，要求价格写作 `\$`。** 模型输出用裸美元符号书写价格，而默认规则会悄悄把它们改写成斜体公式。Pandoc 的空白规则是被广泛采用的折中；内部 `$` 规则只拒绝 TeX 本身也无法排版的候选。

## 后果

第一个图表需要一次惰性 chunk 请求加上 Mermaid 初始化。没有图表的会话只承担小型的 `MermaidBlock` 与 `mermaid.ts` 模块。布局在浏览器主线程上逐个图表运行，调色板变化会重新渲染所有已挂载的图表。图表是静态的：没有平移、缩放、可点击节点、链接或图片。使用图片节点的流程图会显示其源码。在窄屏上，宽图表在卡片内滚动，而不会缩小到固有宽度的 60% 以下。

单美元符号解析现在会拒绝 `$ x$`、`$x $`、`$x$5`，以及任何包含未转义内部 `$` 的候选。当裸 `$` 同时满足两条定界规则时，混用仍然存在歧义，与 Pandoc 一致。流式语法仍不包含数学公式，因此 TeX 在定稿前保持为字面文本。

## 测试

[mermaid.client.spec.tsx](../../../../packages/client/ui-primitives/tests/mermaid.client.spec.tsx) 只模拟 Mermaid，并真实运行 DOMPurify。它覆盖锁定的配置、主题映射、渲染串行化、暂存节点清理、`viewBox` 宽度，以及对脚本、事件处理器、链接目标、`foreignObject`、图片、`use`、外部 `href` 值、`url()` 与 `@import` 的净化，还覆盖图片节点拒绝、解析与布局失败、导入重试，以及卡片的等待、已渲染、复制、调色板变化、卸载和回退状态。它也检查定稿与流式围栏的路由。[markdown.client.spec.tsx](../../../../packages/client/ui-primitives/tests/markdown.client.spec.tsx) 检查每种定界符、```` ```math ```` 围栏、`aligned` 与矩阵环境的 KaTeX 输出，以及正文价格和 `$$` 行内公式。无需密钥的[浏览器场景](../../../../apps/web/tests/markdown-mermaid-math.e2e.ts)预置一条包含图表和公式的回复，并在构建后的 Web 应用中检查真实的 Mermaid 输出、净化结果、回退、KaTeX 以及手机宽度下的溢出。
