---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载面向 LLM 的 web 搜索，获得可引用的 snippet、可选的综合答案，以及如何在 Web profile 中选用 Tavily。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 [Tavily](https://tavily.com)（为 LLM 智能体打造的检索服务）搜索 web，获得可直接引用的抽取页面摘要。当部署持有 Tavily API 密钥时选择它。Tavily 还可以综合一段简短答案，代价是额外的提供方延迟。没有非空白 snippet 的结果会被丢弃，因此一次调用返回的来源可能少于请求数量。本提供方不属于随包发布的默认集合；部署方需在其 `cordis.yml` 中显式启用。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

### 何时选择

当部署持有 Tavily API 密钥，并希望获得可直接引用的抽取页面摘要（可选附带一段简短的综合答案）时，选择此后端。密钥为空或缺失、或端点基址无法解析时，提供方不可用——每次搜索调用都会以结构化错误失败。

### 最小配置

在 web 服务旁加载本提供方。API 密钥回退到启动环境或被 gitignore 的根 `.env` 中的 `$TAVILY_API_KEY`，因此密钥不会进入 `cordis.yml`；保守的默认值适合一般的编码搜索。

```yaml
# Export TAVILY_API_KEY in the launch environment or a gitignored root .env;
# the provider reads it automatically, so the secret stays out of cordis.yml.
# The conservative defaults (basic / general / includeAnswer false) suit
# general coding search, so no config block is needed to start.
- id: web-search-tavily
  name: '@deepseek-ai/dsh-web-search-tavily'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$TAVILY_API_KEY` | Tavily API 密钥。为空或缺失时提供方不可用。相比字面值，优先使用启动环境或被 gitignore 的根 `.env` |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic`（快速、成本更低）或 `advanced`（更深抓取） |
| `topic` | `general` | 以 Tavily `topic` 发送的搜索类别：`general`、`news` 或 `finance` |
| `includeAnswer` | `false` | 为 true 时请求 Tavily 综合答案（`include_answer`），映射到结果的 `content` |

支持以字面值提供 `apiKey`，但不推荐：请把密钥放在启动环境或被 gitignore 的根 `.env` 中（作为 `TAVILY_API_KEY`），避免被提交。提供方仅把该密钥作为 `Bearer` 凭据发送给已配置的端点，且从不记录日志。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 在 Web profile 中选用 Tavily

随包发布的 Web profile 挂载的是 DeepSeek 搜索，并以 `web.searchProvider: deepseek-official` 固定。要在此 checkout 中把某个 Web 部署切换到 Tavily：

1. 把本地包安装进 `web` profile（在仓库根目录执行）：

   ```sh
   pnpm dsh plugin --profile web add ./packages/web/web-search-tavily
   ```

   该命令会在 `$DSH_HOME/profiles/web/` 中执行 `pnpm add`，因此裸行名 `@deepseek-ai/dsh-web-search-tavily` 在启动时可被解析。已发布的部署应改为添加包名，而非路径。

2. 把密钥放进仓库根目录下被 gitignore 的根 `.env`（切勿提交）：

   ```sh
   TAVILY_API_KEY=your-tavily-key
   ```

3. 编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`，同时**重新指向选择**并**插入提供方行**。patch 会替换目标行的整个 `config` 而不执行合并，因此 `web` 行必须完整重述 `searchProvider`：

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

DeepSeek 搜索可以与 Tavily 一同挂载：显式的 `searchProvider: tavily` 会选中 Tavily，避免服务的 `WEB_PROVIDER_AMBIGUOUS` 错误。可用 `dsh --profile web --dump-config` 验证组合后的树。

### 搜索返回什么

每项 Tavily 结果映射为 `WebSearchSource`：`url`、`title`、以抽取的页面摘要（`content`）作为 `snippet`、`published_date` 作为 `publishedAt`；没有非空白 `content` 的结果缺少可移植的 snippet，会被丢弃。当 `includeAnswer` 请求到非空白答案时，Tavily 的 `answer` 成为结果的 `content`；否则省略 `content`。请求的 `maxResults` 作为 Tavily `max_results` 发送，以优化成本与延迟——最终上限由服务强制执行。空的可选字段会被省略，而非发送为空值。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现，并优先采用 Tavily 嵌套的 `detail.error` 消息；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Tavily `POST /search` API 之上的薄适配器。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），向 `ctx.web` 注册后端，而非默认导出服务：`@deepseek-ai/dsh-web` 拥有 `ctx.web` 键，`@deepseek-ai/dsh-tool-web` 注册面向模型的工具。映射遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源只有在 Tavily 返回抽取的页面 `content` 时才获得 `snippet`；用其他字段捏造会让服务报告一个提供方从未返回的 snippet，因此没有 snippet 的结果被整个丢弃。
- **仅按请求提供答案。** 只有当 `includeAnswer` 请求了综合 `answer` 且 Tavily 返回非空白值时，它才进入 `content`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、错误消息提取、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchRequest`、`TavilySearchResponse`、`TavilyResult`、`TavilyError` |

### 请求与映射流程

`search()` 以 `Bearer` 凭据携带密钥、以 `redirect: 'error'` 把查询、`search_depth`、`topic`、`include_answer` 与可选的 `max_results` POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。扁平的 `results[]` 逐项映射，没有 snippet 的条目被丢弃，可选的 `answer` 成为 `content`，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——web 包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-tavily)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、抽取摘要与发布日期，在设置 `includeAnswer` 时把综合答案作为前置 `content`，或将确切的错误消息 `Tavily search aborted`、`Tavily search request failed: <error>` 和 `Tavily returned an unprocessable response body: <error>` 置于消费方的错误包装层内。提供方私有字段（相关性分数、原始内容）不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有非空白 `content` 的结果会被整个丢弃**——没有可映射的可移植 snippet，因此返回来源可能少于请求数量。
- **只公开 `searchDepth`／`topic`／`includeAnswer`**——Tavily 的其他控制项（域名包含／排除、时间范围、`days`、原始内容、图片）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **综合答案会带来额外的提供方延迟**——`includeAnswer` 要求 Tavily 为每次搜索生成答案；仅需引用时应关闭它。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
