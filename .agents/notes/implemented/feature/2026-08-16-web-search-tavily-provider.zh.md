# Agent Note: Tavily 支持的 web 搜索提供方

Status: implemented

[English](2026-08-16-web-search-tavily-provider.md) | 中文

## Problem

web 能力 seam（`ctx.web`）已经承载 Exa、Perplexity 和 DeepSeek 原生搜索提供方，但尚无对 [Tavily](https://tavily.com) 的一等集成——Tavily 是一个为 LLM 智能体打造的检索 API。Tavily 在对 seam 而言关键的方面不同于现有提供方：它是一个专用检索服务，返回预先抽取、可直接引用的页面摘要，并可在同一次请求中*可选地*综合一段简短答案。Exa 返回高亮但不返回答案；Perplexity 本质上是答案生成器，其引用只是副产品，且结果数量无法在协议层受限。想要面向智能体调优的检索并按需获得答案的部署方，此前没有受支持的后端。

## Decision

`@deepseek-ai/dsh-web-search-tavily` 向 `ctx.web` 注册 `TavilySearchProvider`（id 为 `tavily`），在结构上仿照 `web-search-exa`：一个函数／命名空间插件（`inject: ['web']`），无默认导出，其 `apply` 在构造前把环境变量和常量默认值解析为完全解析的提供方选项。它不属于随包发布的默认提供方集合；部署方通过其 `cordis.yml` 显式启用。

该提供方调用 Tavily 当前的 `POST https://api.tavily.com/search`，使用 `Authorization: Bearer <key>`——此认证格式已对照实时端点确认：无效密钥时端点返回 `{"detail":{"error":"Unauthorized: missing or invalid API key."}}`，而非臆测请求体中的 `api_key` 字段。配置只公开有证据支持、且能干净映射到 seam 的 Tavily 控制项：`apiKey`（回退到 `$TAVILY_API_KEY`）、`baseURL`（默认 `https://api.tavily.com`）、`searchDepth`（`basic`|`advanced`，默认 `basic`）、`topic`（`general`|`news`|`finance`，默认 `general`）以及 `includeAnswer`（默认 `false`）。请求的 `maxResults` 作为 Tavily `max_results` 发送；最终上限仍由 seam 强制执行。

Tavily 是*专用检索*服务，因此其答案是可选的：`includeAnswer` 默认关闭，仅当设置时提供方才把 Tavily 综合的 `answer` 映射到 seam 可选的 `content`。这与 Perplexity 恰好相反——后者的答案是主产品且始终存在。每项结果把 `url/title/content/published_date` 映射为规范化源，以 `content`（抽取摘要）作为 `snippet`；没有非空 `content` 的结果会被丢弃，因为 seam 没有其他字段可派生可移植的 snippet，臆造一个会造成失真。空的可选字段会被省略，而非发送为空值。

带凭据的请求使用 `redirect: 'error'`，符合 web 包规则——任何带凭据的提供方请求都不跟随重定向：`Bearer` 密钥仅发送给已配置的端点，绝不转发到 `Location` 源。密钥从不记录日志。提供方、网络、响应体畸形和 HTTP 失败统一规范化为 `WebError` `WEB_PROVIDER_ERROR`（优先采用 Tavily 嵌套的 `detail.error` 消息），中止以 `WEB_ABORTED` 呈现，与同类提供方一致。`available()` 仅本地检查：校验非空密钥与可解析的基址，不发起任何网络调用。

## Alternatives considered

**把密钥作为请求体 `api_key` 字段发送。** 拒绝：实时端点接受并采用 `Authorization: Bearer`，而把密钥放入 JSON 体会使其进入被记录的请求负载，并偏离每个同类提供方基于请求头的认证。任务要求遵循真实的认证证据，而非臆测。

**始终请求综合答案。** 拒绝：Tavily 的定位是检索，答案会带来额外的提供方延迟，仅需引用的搜索不应为生成付费。`includeAnswer` 默认关闭；Perplexity 始终开启答案是恰当的，因为生成*就是* Perplexity 的产品。

**立即公开 Tavily 的完整控制面（域名包含／排除、时间范围、`days`、原始内容、图片）。** 拒绝：这些控制项在当前 `WebSearchRequest`／配置 seam 上没有提供方无关的归属，而臆造工具层无法驱动的按提供方配置会违背 seam 的提供方无关设计。它们等待 Service Definition 字段，已记为已知限制，与 Exa、Perplexity 延后其额外控制项的做法一致。

**复用 `content` 作为始终存在的 snippet 来源而不加丢弃规则。** 拒绝：Tavily 结果可能带空 `content`；发出空 snippet 或臆造的 snippet 会使 seam 失真。丢弃无摘要条目与 Exa 的高亮丢弃规则一致。

## Consequences

部署方可注册 `web-search-tavily` 以获得面向智能体调优的检索，并可选地把综合答案作为前置 `content`，其错误／取消／重定向姿态与其他提供方一致。该包已在 `tsconfig.host.json` 与 `python/sdk-runtime/package.json` 中与 Exa、Perplexity 并列注册，并列入 `packages/web` README 映射表（英文与中文）。未改动任何随包发布的默认提供方或 base/web 包。在 seam 增长出提供方无关字段之前，Tavily 的高级控制项仍不可用。

验证：聚焦单元测试（`tests/tavily.spec.ts`）覆盖结果／响应映射（answer→`content`、摘要丢弃、空字段省略）、可用性、请求体构造、`max_results` 透传、中止传播、`detail`／`detail.error`／状态行错误路径、`redirect: 'error'` 的启用以及证明不发起第二次请求的重定向拒绝回归测试、上下文内的注册／释放，还有默认导出会使其坍缩的 `unwrapExports` 命名空间形状路径。REAL-composition 守卫 `tests/loader-composition.spec.ts` 通过真实 Loader + Include 路径，从仅供测试的 `cordis.yml` 引导 `dsh-web` + `web-search-tavily`，并将 Tavily 固定为 `searchProvider`，随后针对本地 `node:http` 模拟 Tavily 端点（`tests/mock-tavily-server.ts`）以真实网络往返运行 `ctx.web.search`——断言 seam 归一化后的结果，且所配置的 `Bearer` 密钥与请求体只到达该回环端点、绝不泄露真实凭据——再通过 `include.refresh()` 移除该提供方行，证明注册 effect 会解绑，使后续搜索以 `WEB_PROVIDER_CONFIGURED_MISSING` 选择失败。真实 API e2e 在缺少 `$TAVILY_API_KEY` 时自跳过，且恰好只花费一次付费搜索：它设置 `includeAnswer: true`，使单次请求同时断言映射出的 sources 与综合 `content`。包级 `tsc -b` 类型检查通过。
