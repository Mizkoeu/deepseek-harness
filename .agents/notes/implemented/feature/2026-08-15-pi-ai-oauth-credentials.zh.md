# Agent Note: pi-ai 提供方登录通过 `dsh auth` 命令运行

Status: implemented

[English](2026-08-15-pi-ai-oauth-credentials.md) | 中文

## Problem

GitHub Copilot 通过 pi-ai 适配器的 `github-copilot` 目录路由提供，其唯一凭据是 OAuth 授权：通过设备流程取得 GitHub 令牌，再换取必须定期刷新的短效 Copilot 令牌。[凭据记录与授权流程决策](../architecture/2026-08-13-credential-records-and-authorization-flows.zh.md)为该授权提供了存放位置，即 `$DSH_HOME/.credentials.yaml` 中键为 `llm-pi-ai/github-copilot` 的 `grant` 记录，并为每个提供登录的 pi-ai 提供方注册一个 `ctx.authorization` 流程。它没有提供任何开始此类流程的界面。唯一调用 `authorization.begin()` 的是 DeepSeek 账号平台，且只针对它自己的键；模型页也不为 pi-ai 提供方提供登录。因此 Copilot 订阅虽有存储和流程，用户却无法运行该流程。

另外，已安装的 pi-ai 目录落后于 Copilot 实际提供的模型。pi-ai 0.87.1 描述了 `claude-opus-5.5` 和 `gpt-6-astra`，但没有描述订阅可以使用的 `claude-sonnet-5.5` 和 `gpt-6.1-sol`。

## Decision

**`dsh auth login|status|logout <provider>` 是用户入口。** 启动器像保留 `plugin` 一样把 `auth` 保留为首个 token，由 [`apps/cli/src/args.ts`](../../../../apps/cli/src/args.ts) 解析其子命令。[`apps/cli/src/auth.ts`](../../../../apps/cli/src/auth.ts) 挂载一个裸 Cordis context，不启动 profile，也不使用 Loader，只包含登录所需的内容：适配器注入的 `dsh-llm`；关闭文件监视的 `dsh-credentials-local`；`dsh-authorization`；以及不含路由的 `dsh-llm-pi-ai`。适配器在挂载时注册其流程，因此该命令驱动的流程、写入的记录与任何其他界面相同。启动环境快照及其代理策略会先行安装，与 profile 启动一致，因此位于 HTTP 代理之后的登录也能到达提供方。

已安装目录条目提供登录的任何提供方 id 都会被接受；没有登录的 id 会被拒绝，并列出有登录的 id。`login` 以流程的首选方式开始流程，提供 OAuth 时即为 OAuth。终端交互会打印通知及需要打开的页面和需要输入的代码，并通过 readline 提问，`secret` 回答不显示。stdin 不是交互式终端时，提问以 `AuthorizationDeclinedError` 拒绝，seam 随之结算为 `cancelled`，而不是等待永远不会到来的输入。提问之外按 Ctrl+C 会中止请求信号；提问中按 Ctrl+C 则表示拒绝回答。`--enterprise-domain` 回答 pi-ai 的 Copilot 登录在设备流程之前提出的文本问题（按消息中的 "enterprise" 识别），且只被 `login github-copilot` 接受；不提供时会询问该问题，空回答即选择 github.com。

`status` 通过不携带值的 `describeRecord` 报告记录类型（`grant`、`api-key` 或不存在），因此该命令不可能打印令牌。`logout` 删除该记录。该命令本身从不处理令牌：pi-ai 在 `Models.login()` 中通过适配器的 `CredentialStore` 写入授权，seam 确认该提交后才报告 `authorized`。`dsh-llm-pi-ai` 导出 `RECORD_SCOPE`，使命令能从所有已注册流程中选出该适配器的流程。

登录之后，不含密钥的 `github-copilot` profile 会用存储的授权完成认证，pi-ai 在凭据存储的跨进程写锁下刷新它。模型页在密钥留空时会保存这样的 profile。已配置的 `apiKeyEnv` 优先于授权，[模型指南](../../../../docs/user/guide/providers.zh.md#sign-in-to-github-copilot)提醒用户避免这样配置。

**未编目的 Copilot 模型是 `dsh-llm-pi-ai` 中的一张目录数据表。** [`catalogModels()`](../../../../packages/llm/llm-pi-ai/src/catalog.ts) 把每个 `UNCATALOGED_MODELS` 条目作为已发布兄弟模型的副本加入，只替换 `id` 和 `name`：`claude-sonnet-5.5` 复制自 `claude-sonnet-5`，`gpt-6.1-sol` 复制自 `gpt-6-sol`。在 0.87.1 中，`gpt-6-sol` 的协议（`openai-responses`）、Copilot 请求头和 compat 都与 `gpt-5.6-sol` 相同，并带有 GPT-6 的推理映射，因此是更接近的兄弟模型。同 id 的已发布模型优先，兄弟模型不再发布的条目会被省略，因此为某个模型编目的 pi-ai 升级会让对应条目失效，直到有人将其删除。该路由的 OAuth 模型过滤仍把提供的模型限制在凭据有权使用的 id 上。

## Alternatives considered

**使用现有的 UI 登录。** 已否决，因为 pi-ai 提供方没有这样的登录。`settings.models.sign-in` 是 DeepSeek 账号的引导 slot，[模型指南](../../../../docs/user/guide/providers.zh.md)也曾说明模型页不支持 OAuth 提供方。模型页控件需要授权决策尚未定义的通知与提问线路协议；命令行则不需要。

**启动 `web` 或 `headless` profile 来使用 `ctx.authorization`。** 已否决，因为 profile 启动为运行一个流程会挂载会话、工具、服务器和监视器，需要 profile 目录，还可能与正在运行的 Web 服务器冲突。四插件 context 不挂载登录用不到的任何内容。

**保留 pi-ai 专用凭据文件并直接调用 pi-ai 登录。** 已否决，因为 harness 把 pi-ai 授权存储为共享凭据文档中的 `llm-pi-ai/<provider>` 记录，每个适配器实例都读取并刷新它。第二个文件会把一份凭据拆到两个存储中，直接调用 `Models.login()` 则会绕过 seam 的单次尝试规则和提交确认。

**默认以空回答回应 Copilot 企业域名问题。** 已否决，因为这会把一个提供方的问题硬编码进通用转发逻辑，并对用户隐藏该问题。交互式用户按回车即可使用 github.com。

**在路由配置中声明缺失的模型。** 已否决，因为没有 profile 字段能够表达它们。目录未描述的 id 的 `models` 条目会采用路由的共享协议，而 `github-copilot` 横跨 `anthropic-messages`、`openai-responses` 和 `openai-completions`，因此解析要求路由级 `api`。设置它会把路由上的每个模型都改指向该协议，并丢失逐模型的 Copilot 请求头和 compat，而 `models` 列表还会替换整个目录。`modelOverrides` 只能重塑目录已描述的模型。

**把该表做成经过校验的 `Config` 字段。** 已否决，因为提供方提供哪些模型属于目录数据，与 pi-ai 目录为其他每个模型记录的事实相同，而不是随部署变化的选择；部署仍通过路由的 `models` 列表选择显示哪些模型。配置字段还会暴露一个兄弟模型复制概念，其正确性依赖 pi-ai 内部的模型描述字段。

**升级 pi-ai 直到它为这些模型编目。** 不可行：0.87.1 是当前依赖，仍缺少这两个 id。升级仍是淘汰表中条目的途径。

## Consequences

Copilot 订阅用 `dsh auth login github-copilot` 登录一次，即可在重启之间为不含密钥的 `github-copilot` 路由提供服务；正在运行的 Web 服务器通过凭据存储的文件监视看到新记录。同一命令可以登录每个有登录的 pi-ai 提供方，包括 `openai-codex`。CLI 运行时现在依赖 `dsh-authorization`、`dsh-credentials`、`dsh-credentials-local`、`dsh-llm` 和 `dsh-llm-pi-ai`。`--enterprise-domain` 的匹配依赖 pi-ai Copilot 问题的措辞；措辞变化时，该 flag 不再匹配，问题会改为询问用户。没有交互式终端的登录只有在 flag 回答了所有问题时才能成功，目前这只适用于 GitHub Enterprise Copilot 登录。

pi-ai 升级后必须手动清理未编目表；过时条目无害，因为已发布描述优先。复制出的模型继承兄弟模型的容量和定价元数据，可能与新模型不同。

单元测试针对伪造 host 驱动命令（设备代码转发、企业域名回答、中断、失败原因、状态类型、登出、未知提供方），并在临时 `DSH_HOME` 上挂载真实的四插件 host。参数测试固定命令语法。built-bin 测试检查启动器帮助，并在空 home 上运行 `dsh auth status github-copilot`。目录测试覆盖副本的描述、它们在未配置路由上的存在、已发布描述的优先级以及兄弟模型缺失的情况。真实设备流程已手动验证到打印代码为止；没有自动化测试会登录 GitHub。
