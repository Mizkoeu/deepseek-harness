# Agent Note: 容忍严格 schema 在沙箱升级与 goal 参数中的占位填充

Status: implemented

[English](2026-09-09-copilot-responses-strict-optional-tool-fields.md) | 中文

## 问题

经 `openai-responses` 路由使用 GitHub Copilot 的 GPT 模型时，每一次触发升级的 `bash`/`write`/`edit` 调用，以及若干 `update_goal` 调用，都会在真正开始工作之前被打断。链路如下：

1. DSH 工具 schema 只把确实必填的字段标为 `required`，把可选控制字段（`sandbox_permissions`、`justification`、`max_goal_rounds`）留在 `required` 之外——这是正确的非严格惯用法，也是 `packages/core/tools/src/schema.ts` 中 schema 编译器实际产出的形态。
2. pi-ai 适配器原样透传 `parameters`，不设置任何按工具的 `strict` 标志（`packages/llm/llm-pi-ai/src/context.ts`）。已安装的 pi-ai `0.82.1` 仅当模型目录描述符声明了 `supportsStrictMode` 时才输出 `strict`；而没有任何 `github-copilot` 模型声明它，于是线上载荷完全省略 `strict`。
3. 按 OpenAI Responses 约定，省略 `strict` 会让端点在可行时把 schema 自动归一化为严格模式——所有属性都必填且不可为 null——这与 Chat Completions 在省略 `strict` 时保持非严格恰好相反。在被强制的严格模式下，模型必须输出每个属性，于是它用貌似合理的值填充这些可选字段：enum 取其第一个值（`sandbox_permissions: "workspace-write"`），字符串取 `""` 或一句话，数字取一个貌似合理的非零值。
4. DSH 随后把这些占位值当作真实请求拒绝。`approveEscalation` 会把同级的 `sandbox_permissions` 以「非严格更宽」拒绝——这是纯输入校验，发生在任何审批提示之前——而 `update_goal` 会拒绝非 `edit` action 上的非零 `max_goal_rounds`。模型无法自我恢复，因为拒绝文案从不提示「省略该字段」。

这是一个互操作不兼容，而非回归。DSH 的非严格 schema 惯用法在每一个非严格端点（DeepSeek、Chat Completions、Anthropic）上都是正确的；只有当 Copilot Responses 路由开始服务 GPT 模型时，这一失败才变得可达。它影响该路由上的每一个 Copilot GPT 模型——没有任何 `github-copilot` 描述符声明 `supportsStrictMode`——而不仅是未编目的 `gpt-6-astra` 克隆。

## 决策

加固这些可选控制字段，使其在任何路由上都能容忍严格填充，同时保留每一条升级不变式（配对、严格更宽、审批、失败即拒）。

- `@deepseek-ai/dsh-sandbox` 导出 `normalizeEscalationArgs(sandbox_permissions, justification, effectiveMode)`，取代 `validateEscalationArgs`。`sandbox_permissions` 是驱动方：只有当它命名的模式严格宽于本次调用的有效模式时，升级才成立。`null`／缺省、同级或更窄的取值都不构成升级并返回 `undefined`，因此调用按其有效模式运行；只有真正的拓宽才会校验非空 justification 并进入 `approveEscalation`，后者仍保留自己的严格更宽检查，作为权威的强制执行兜底。
- `tool-bash`、`tool-pwsh` 与 `tool-fs`（write/edit）以该归一化替代旧的配对校验和被删除的「not available in this composition」守卫，因此占位的 `sandbox_permissions` 会让调用照常运行而非报错。
- `tool-goal` 在每一个非 `edit` action（`pause`/`resume`/`complete`/`blocked`）上无论取值一律忽略 `objective` 与 `max_goal_rounds`——它们只在 `edit` 下生效——而不再拒绝非零填充。`blocked_reason` 仍在除 `blocked` 外的任何 action 上被拒绝。这弥合了此前仅处理空／零填充所遗留的非零数字缺口。

## 考虑过的替代方案

**把 `@earendil-works/pi-ai` 升级到原生编目 `supportsStrictMode`（以及 `gpt-6-astra`）的版本。** 作为可能的后续保留，但不作为首选修复：它押注于远端。一个独立复现（Vercel AI SDK issue #11869）显示某 Responses 代理即便显式设置 `strict: false` 也会忽略，而 Copilot 正是一个代理，因此升级也许根本改变不了线上行为。即便升级后 pi-ai 发送正确的严格 schema（可选项写作 `["type","null"]` + required），也会产生显式的 `null` 填充，而 DSH 仍须把它归一化为「缺省」——这正是本次改动新增的 null 处理。故 B 无论如何都需要 A 的一部分；而且严格归一化可命中任何严格端点（Azure OpenAI Responses、直连 OpenAI）以及任何缺少该能力标志的未来模型。

**在适配器里把 DSH 工具 schema 改写为兼容严格模式的形态（可选项写作可为 null 且必填）。** 拒绝：DSH 无法得知端点会做归一化，因为 pi-ai 对这些模型报告 strict 为关，适配器将不得不逐模型地推翻 pi-ai 自己的判断。而防守工具输入与端点无关，无需任何严格感知。

**保留更窄的 goal 规则——仅当某个 edit-only 字段等于当前存储值时才剥离它。** 拒绝：在被强制的严格模式下，模型可以用任意貌似合理的数字填充 `max_goal_rounds`，而非当前上限，因此相等判断在任意填充下仍会打断。对非 `edit` action 完全忽略这些 edit-only 字段更简单也更完整，且无所失，因为它们在那些 action 上本就无法生效。

**改用 Claude/Anthropic 路由（临时绕过）。** 这不是修复：它放弃了每一个 Copilot GPT 模型。Anthropic 使用 `anthropic-messages` 协议，没有严格自动归一化——这正是该绕过恰好有效的原因。

## 后果

- Responses 路由上的每一次 Copilot GPT 调用都照常运行：等于或窄于有效模式的占位 `sandbox_permissions` 被剥离，命令按该模式运行；非 `edit` goal action 上的占位 `max_goal_rounds`／`objective` 被忽略。真正的升级仍会校验 justification、请求审批，并与此前完全一致地失败即拒。
- 各工具族不再产出 `sandbox_permissions is not available in this composition`、`sandbox escalation to … is not strictly wider …` 或 `justification is only valid together with sandbox_permissions`；孤立的 justification 现被静默忽略。bash 与 pwsh 的 README 稳定消息列表以及 goal 的 README 删去了这些，并描述了新的容忍行为。
- 安全性不变：`approveEscalation` 仍是严格更宽与审批的唯一强制执行点，直接调用者无法绕过它；归一化只是阻止无操作的占位到达它。

## 推迟

- 在 `read-only` 会话中，被强制的 `sandbox_permissions: "workspace-write"` 是一次真正的拓宽，因此仍会走审批提示（若 justification 被填为空字符串，则仍会报错）。当占位恰好是一个合法的更宽目标时，归一化无法把占位与真实请求区分开；常见的 `workspace-write` 默认已完全修复。
- 在 `edit` 上，`max_goal_rounds` 确实生效，因此对它的严格填充无法与意图区分，可能把上限设成一个虚构值。`edit` 受直接人工把关，且远比普遍的升级打断罕见。
- 目前没有任何带约束的 headless 组合，而真正的沙箱快照会触发平台相关的 landlock/seatbelt 强制——对无密钥固定件不可移植。因此升级路由改由确定性的 `tool-bash`/`tool-pwsh`/`tool-fs` 执行器测试来证明；只有 goal 路径带有 headless 快照。

## 测试

- `packages/sandbox/sandbox/tests/escalation.spec.ts` 覆盖 `normalizeEscalationArgs`：真正的拓宽返回其请求；同级、更窄、`null`、缺省以及缺省有效模式都剥离为 `undefined`；真正的拓宽仍要求非空 justification。
- `tool-bash`/`tool-pwsh`/`tool-fs` 工具测试断言：同级占位会照常执行且无提示，孤立 justification 会照常运行，真正的拓宽仍会校验并审批。
- `tool-goal` 测试断言：非零 `max_goal_rounds` 与非空 `objective` 在 `pause`/`resume`/`complete`/`blocked` 上被忽略，而上限与 objective 保持不变。
- `goal-tools` 无密钥 headless 快照在一次 `pause` 上注入非零占位，并断言结果是 `GOAL_NOT_FOUND`（引用问题），而非 `GOAL_TOOL_INVALID_UPDATE`（占位拒绝）——即端到端穿过组装应用的修复证明。

## 相关

- 让 `gpt-6-astra` 可达的前向兼容垫片是 `packages/llm/llm-pi-ai/src/catalog.ts` 中的 `UNCATALOGED_MODELS`；一次原生编目 Astra 的 pi-ai 升级会让它退役。
- OpenAI Responses 严格模式默认行为：[function-calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。省略 `strict` 后占位行为的独立复现：[Vercel AI SDK issue #11869](https://github.com/vercel/ai/issues/11869)。
