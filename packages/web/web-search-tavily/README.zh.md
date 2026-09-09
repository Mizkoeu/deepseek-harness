# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

由 [Tavily](https://tavily.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Tavily 的 `POST /search` 端点，把扁平 `results[]` 以及可选的综合 `answer` 映射为 seam 规范化的 `WebSearchResult`。Tavily 是为 LLM 智能体打造的检索服务：它返回可直接引用的抽取页面摘要，并可按需综合一段简短答案。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。它不属于随包发布的默认提供方集合；部署方需在其 `cordis.yml` 中显式启用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API 密钥。为空或缺失时提供方不可用。相比字面值，优先使用启动环境或被 gitignore 的根 `.env`。 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic`（快速、成本更低）或 `advanced`（更深抓取）。 |
| `topic` | `general` | 以 Tavily `topic` 发送的搜索类别：`general`、`news` 或 `finance`。 |
| `includeAnswer` | `false` | 为 true 时请求 Tavily 综合答案（`include_answer`），映射到结果的 `content`。 |

```yaml
# Export TAVILY_API_KEY in the launch environment or a gitignored root .env;
# the provider reads it automatically, so the secret stays out of cordis.yml.
# The conservative defaults (basic / general / includeAnswer false) suit
# general coding search, so no config block is needed to start.
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
```

支持以字面值提供 `apiKey`，但不推荐：请把密钥放在启动环境或被 gitignore 的根 `.env` 中（作为 `TAVILY_API_KEY`），避免被提交。该密钥仅作为 `Bearer` 凭据发送给已配置的端点，且从不记录日志。

## 在 Web profile 中选用 Tavily

随包发布的 Web profile 挂载的是 DeepSeek 搜索，并以 `web.searchProvider: deepseek-official` 固定。要在此 checkout 中把某个 Web 部署切换到 Tavily：

1. 把本地包安装进 `web` profile（在仓库根目录执行）：

   ```sh
   pnpm dsh plugin --profile web add ./packages/web/web-search-tavily
   ```

   该命令会在 `$DSH_HOME/profiles/web/` 中执行 `pnpm add`，因此裸行名 `@deepseek-ai/dsh-web-search-tavily` 在启动时可被解析。（已发布的部署应改为添加包名，而非路径。）

2. 把密钥放进仓库根目录下被 gitignore 的根 `.env`（切勿提交）：

   ```sh
   TAVILY_API_KEY=your-tavily-key
   ```

3. 编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，同时**重新指向选择**并**插入提供方行**。patch 会替换目标行的整个 `config`，因此 `web` 行必须完整重述 `searchProvider`——不会执行合并：

   ```yaml
   # Re-point provider selection. This REPLACES the web row's config, so it must
   # restate searchProvider; the base value (deepseek-official) is not merged in.
   - id: web
     config:
       searchProvider: tavily

   # Mount the Tavily provider. TAVILY_API_KEY comes from the root .env / launch
   # environment, so no secret enters this file. The conservative defaults suit
   # general coding search; advanced depth and the news topic each cost more.
   - insert:
       - id: web-search-tavily
         name: '@deepseek-ai/dsh-web-search-tavily'
         config:
           searchDepth: basic
           topic: general
           includeAnswer: false
   ```

在挂载 Tavily 的同时保留 DeepSeek 也没问题：显式的 `searchProvider: tavily` 会选中 Tavily，避免 seam 的 `WEB_PROVIDER_AMBIGUOUS` 错误。可用 `dsh --profile web --dump-config` 验证组合后的树。

## 映射

`content` ← `answer`（仅当 `includeAnswer` 请求到非空答案时存在，否则省略）。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`（抽取的页面摘要——没有非空 `content` 的结果缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `published_date`。请求的 `maxResults` 作为 Tavily `max_results` 发送以优化成本和延迟；最终上限由 seam 强制执行。空的可选字段会被省略，而非发送为空值。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符）以 `WebError` `WEB_PROVIDER_ERROR` 呈现，并优先采用 Tavily 嵌套的 `detail.error` 消息；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、抽取摘要与发布日期，在设置 `includeAnswer` 时把综合答案作为前置 `content`，或将确切的错误消息 `Tavily search aborted`、`Tavily search request failed: <error>` 和 `Tavily returned an unprocessable response body: <error>` 置于消费方的错误包装层内。提供方私有字段（相关性分数、原始内容）不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有非空 `content` 的结果会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `searchDepth`／`topic`／`includeAnswer`**：Tavily 的其他控制项（域名包含／排除、时间范围、`days`、原始内容、图片）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **综合答案会带来额外的提供方延迟**：`includeAnswer` 要求 Tavily 为每次搜索生成答案；仅需引用时应关闭它。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
