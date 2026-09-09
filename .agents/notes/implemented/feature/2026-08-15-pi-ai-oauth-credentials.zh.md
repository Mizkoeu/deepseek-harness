# Agent Note: pi-ai 提供方 OAuth 使用结构化本地凭据存储

Status: implemented

[English](2026-08-15-pi-ai-oauth-credentials.md) | 中文

## 问题

多提供方适配器会公开 pi-ai 已安装的提供方 catalog，但认证只能通过 Harness 的 `apiKeyEnv` 字符串或 pi-ai 的环境发现来解析。pi-ai OAuth 凭据包含刷新 token、短期访问 token、过期时间和提供方特有元数据，这些字段必须一起变更。Harness 字符串凭据服务无法保存该记录或串行化刷新，因此 GitHub Copilot 虽出现在模型 catalog 中，Copilot 订阅却没有持久登录路径，粘贴进去的访问 token 也会在无法刷新的情况下过期。

## 决策

`@deepseek-ai/dsh-llm-pi-ai` 拥有一份 pi-ai `CredentialStore` 的文件型实现。JSON 文档位于 `$DSH_HOME/.pi-ai-credentials.json`，会校验持久化输入且不在诊断中引用秘密值，并以 `0600` 权限原子替换；新建 Harness home 时请求 `0700` 权限。每次变更都在共享的跨进程写锁内重新读取完整文档，再替换一条提供方记录，因此并发登录、登出和 OAuth 刷新不会复活旧 token。无锁读取方只会看到完整旧文档或完整替换文档。

每份不可变 `Models` 路由快照都接收同一凭据存储。带 `apiKeyEnv` 的 profile 仍会按请求解析 Harness 凭据，并将其作为 pi-ai 中优先级最高的直接密钥覆盖传入。不带 `apiKeyEnv` 的 profile 则让 pi-ai 解析已存储 OAuth 凭据或提供方原生环境认证。pi-ai 会在 `CredentialStore.modify()` 内检查过期并刷新；刷新失败时保留提供方记录。因此，可配置提供方目录会包含只能通过 OAuth 认证的已安装提供方。

产品启动器通过 `dsh auth login|status|logout github-copilot` 负责用户交互。登录会调用 pi-ai 已安装的 GitHub Copilot OAuth 方法，提供公共 GitHub 或显式企业域，打印提供方设备代码与进度事件，并只在完整提供方流程成功后持久化。状态命令读取不含秘密的元数据且不触发刷新；登出命令原子移除提供方条目。[模型配置指南](../../../../docs/user/guide/providers.md)要求登录后使用无密钥 GitHub Copilot profile，因为设置 `apiKeyEnv` 会有意绕过 OAuth 交换和刷新路径。

仅限所有者的文件系统权限能阻止其他 OS 用户访问，不能阻止以同一用户身份运行的 agent（智能体）工具。适配器与启动器不会把解析后的路径或文档内容透露给模型，但拥有 Harness home 读取权限的工具可以读取该文件。

## 考虑过的替代方案

**把 OAuth 记录作为字符串存入 `.credentials.yaml`。** 不采用，因为凭据服务有意把一条引用映射到一个不透明字符串。把可变提供方 JSON 编码在其中，会把刷新并发与提供方元数据藏进无法表达两者的约定中。

**让用户把 Copilot 访问 token 粘贴进模型 API 密钥字段。** 不采用，因为 GitHub Copilot 交换产出的 token 生命周期很短。静态字段无法保留 GitHub 刷新 token，也无法在后续请求前替换访问 token。

**交付一份替代用的树外 LLM 适配器。** 不采用，因为它只为注入 pi-ai 凭据存储，就必须复制消息转换、回放校验、超时处理、归因和流规范化。现有适配器拥有这些行为，应直接接收该存储。

**改为集成 GitHub Copilot SDK。** 不采用，因为该 SDK 驱动 Copilot agent 进程，而本功能是在 Harness 自有 agent loop（智能体循环）和工具之下认证模型提供方。pi-ai 已拥有所需提供方协议与 token 交换。

**立即添加提供方无关的认证 Service Definition。** 不采用，因为 GitHub Copilot 是当前唯一的产品登录消费方。导出的设置操作与 pi-ai `CredentialStore` 注入已经提供当前扩展点，无需虚构一项没有第二个提供方或 UI 消费方的能力；另一种原生登录体验可以证明完整 Service Definition / Service Provider / Consumer seam 的必要性。

## 后果

GitHub Copilot 订阅可以通过设备流程登录一次，并在重启后继续服务无密钥 Copilot profile；pi-ai 会用已存储 GitHub token 刷新短期访问 token。直接 API 密钥 profile 保留现有优先级和明确失败的引用。CLI 直接依赖适配器的 auth 入口，适配器包也新增了一份必须维护校验、锁、权限与兼容性的持久秘密文档。首次带 tag 发布之前，该磁盘 JSON 不提供兼容性承诺。

聚焦存储测试覆盖仅限所有者的写入、无效持久化输入、跨实例变更、刷新与删除。mock 提供方流程覆盖设备交换与持久化，适配器请求覆盖已存储 OAuth 分派，真实 Loader 组合覆盖支持 OAuth 的 catalog 条目，构建后 CLI 测试覆盖无需启动 profile 的无密钥状态查询。
