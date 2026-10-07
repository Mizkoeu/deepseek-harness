# Agent Note: 在沙箱升权与 goal 参数中容忍严格 schema 占位值

Status: implemented

[English](2026-09-09-copilot-responses-strict-optional-tool-fields.md) | 中文

## 问题

GitHub Copilot 的 GPT 模型在 `openai-responses` 路由上会填充每个可选工具字段，因此可升权的调用（`bash`、`pwsh`、`write`、`edit`、`run_code`）以及若干 `update_goal` 调用会在任何工作开始前失败。因果链如下：

1. DSH 工具 schema 只把真正必填的字段列入 `required`；可选控制字段（`sandbox_permissions`、`justification`、`objective`、`max_goal_rounds`）不在其中。这是正确的非严格 schema 形式，`packages/core/tools/src/schema.ts` 中的编译器也按此输出。
2. pi-ai 适配器原样传递 `parameters`，不设置逐工具的 `strict` 标志。pi-ai 的 Responses 适配器只有在模型描述声明 `supportsStrictMode` 时才写入 `strict`，而已安装目录中没有任何 `github-copilot` Responses 模型声明它，因此请求省略了 `strict`。
3. 省略 `strict` 时，OpenAI Responses API 会把工具 schema 规范化为严格模式：每个属性都变为必填。模型随后必须输出每个可选字段，并用看似合理的值填充：枚举取某个成员，例如当前模式或更窄的模式；字符串取 `""` 或一句话；数字取 `6` 之类的合理值。部分严格序列化器会改为输出 `null`。
4. DSH 曾把这些占位值当作真实请求。更窄的 `sandbox_permissions` 以 "not strictly wider" 失败；除 `bash` 外，每个工具都会让带空 `justification` 的同级取值在配对检查中失败；未公开的取值以 "not available in this composition" 失败；`update_goal` 在 `pause`、`resume`、`complete` 或 `blocked` 上遇到非空 `objective` 或非零 `max_goal_rounds` 时以 `GOAL_TOOL_INVALID_UPDATE` 拒绝。这些拒绝文本从不提示模型省略该字段，所以模型会用相同参数重试。

这些 schema 在所有非严格端点（DeepSeek、Chat Completions、Anthropic Messages）上都正确；失败只发生在端点对为非严格用途编写的 schema 强制执行严格模式时。

## 决策

可选控制字段在所有路由上都容忍严格 schema 占位值，而真正的升权保持相同的理由、审批和失败即关闭规则。

- `@deepseek-ai/dsh-sandbox` 导出 [`normalizeEscalationArgs(sandboxPermissions, justification, effectiveMode)`](../../../../packages/sandbox/sandbox/src/escalation.ts)。只有严格宽于调用生效模式（依据 `WIDER_MODES`）的 `sandbox_permissions` 才是升权；此时它返回 `{ requestedMode, justification }`，并要求非空理由（缺失或为 `null` 时为 `invalid escalation: sandbox_permissions requires a justification`，空白时为 `invalid justification: expected a non-empty sentence`）。缺失、`null`、空、相同、更窄或未知的模式，以及未挂载受限后端（`effectiveMode` 为 undefined）时的任何模式，都返回 `undefined`，此时 `justification` 无论取何值都会被忽略。
- `dsh-tool-bash`、`dsh-tool-pwsh`、`dsh-tool-fs`（`write` 与 `edit`，经由 `FsSandboxController.resolvePolicy`）以及 `dsh-tools` 中的 `run_code` 都在审批前调用该归约函数。`undefined` 保留常驻策略；真正的升权经过 `approveEscalation`，且只作用于该次调用。`approveEscalation` 为 `plugin_manager` 等直接调用方保留同级返回与严格更宽检查。
- `dsh-tool-goal` 只在 `edit` 下应用 `objective` 与 `max_goal_rounds`，其中 `""` 与 `0` 视为省略；`pause`、`resume`、`complete` 与 `blocked` 无论取值如何都会忽略这两个字段。在 `blocked` 之外提供非空 `blocked_reason` 仍会被拒绝。这部分取代了[面向模型的 goal 工具决策](../feature/2026-07-19-model-facing-goal-tools.zh.md)中的操作限制。

## 考虑过的替代方案

**升级 pi-ai，直到 Copilot 目录声明 `supportsStrictMode`。** 不作为修复方案。已安装的 `0.87.1` 目录仍未为任何 Copilot Responses 模型声明它，而 Copilot 是代理，可能不遵守显式的 `strict: false`。正确的严格 schema 会把可选字段标为可空且必填，模型会因此发送 `null` 占位值，DSH 仍须把它视为缺失。严格规范化还可能影响 Azure OpenAI Responses、直连 OpenAI，以及未来缺少该能力标志的模型。

**在适配器中把工具 schema 改写为严格形式（可选字段可空且必填）。** 不采纳：适配器无法知道端点会进行规范化，因为 pi-ai 对这些模型报告不支持严格模式。把模型可见的 schema 改为可空还会改变每个已录制的工具 schema 旁路文件。对工具输入做归约无需感知严格模式即可在所有端点上生效。

**只忽略同级升权占位值，继续拒绝更窄的值。** 不采纳：严格填充会选择任意枚举成员，而更窄的模式无法授予权限，拒绝它只会阻断调用。真正放宽权限所需的审批保持不变。

**仅当只属于 edit 的 goal 字段等于已存值时才忽略它。** 不采纳：严格填充可以是任意合理的数字或句子，因此相等性检查仍会拒绝任意填充值。这些字段在 `edit` 之外无法生效，忽略它们不会损失任何能力。

**以 Claude 路由作为变通方案。** 不是修复：它放弃了所有 Copilot GPT 模型。`anthropic-messages` 协议没有严格规范化，这正是该路由可用的原因。

## 后果

- Responses 路由上的 Copilot GPT 调用可以正常运行：不高于生效模式的 `sandbox_permissions` 占位值会按该模式运行且不弹出提示，非 edit goal 操作上的 `objective`/`max_goal_rounds` 占位值会被忽略。
- 这些工具不再报告 `sandbox_permissions is not available …`、`sandbox escalation to … is not strictly wider …` 或 `justification is only valid together with sandbox_permissions`；单独提供的理由会被忽略。没有受限后端时，升权字段会被忽略，这与不公开这些字段的 schema 一致。
- 安全性不变：只有严格更宽的模式才会进入审批，`approveEscalation` 仍是放宽权限的执行点。
- 模型可见的 schema 描述不变。它们仍说明字段何时生效（`Required with sandbox_permissions`、`valid only with action edit`），容忍逻辑位于执行阶段。

## 已知限制

- 在 `read-only` 会话中，填充的 `sandbox_permissions: "workspace-write"` 是有效的放宽目标，因此仍会请求审批；若理由为空，则仍会失败。归约函数无法区分这种填充值与真实请求。
- 在 `edit` 下 `max_goal_rounds` 会生效，因此此处的严格填充可能设置一个虚构的上限。`edit` 需要直接的人类请求。
- 核心参数校验会在 `execute` 之前拒绝 `string` 类型参数上的 JSON `null`，因此 `null` 占位值只有在调用方绕过该校验时才会到达归约函数。要在工具边界接受 `null`，需要可空的模型可见 schema。

## 测试

- `packages/sandbox/sandbox/tests/escalation.spec.ts` 覆盖 `normalizeEscalationArgs`：严格更宽的请求，缺失/`null`/空/相同/更窄/未知模式，单独提供的理由，无受限后端，以及更宽模式缺失或空白理由的情况。
- `dsh-tool-bash`、`dsh-tool-pwsh`、`dsh-tool-fs` 与 `run_code`（`packages/core/tools/tests/ptc.spec.ts`）的测试覆盖带空白和非空理由的同级占位值、更窄占位值、单独提供的理由、无受限后端时的字段，以及仍被拒绝的无理由更宽请求；所有被忽略的情况都不会请求审批。
- `packages/goal/tool-goal/tests/tool-goal.spec.ts` 覆盖 `pause`、`resume`、`blocked` 与 `complete` 上的非空 `objective` 与非零 `max_goal_rounds` 填充，且不改变已存的目标描述或上限。
- 无密钥的 headless `goal-tools` 预期 transcript（`apps/cli/tests/profiles/headless/tests/expected/goal-tools/`）对不存在的 goal 发送带非空 `objective` 与非零 `max_goal_rounds` 的 `pause`，并固定 `GOAL_NOT_FOUND`，表明占位值没有导致拒绝。
- 手工编写的 headless 会话场景 `snapshots/session/bash-narrower-mode-filler/` 在 `danger-full-access` 会话中以 `workspace-write` 占位值和空理由运行 `bash`；命令正常执行。`snapshots/session/bash-same-mode-empty-justification/` 覆盖同级占位值。

## 相关

- OpenAI Responses 严格模式行为：[function-calling 指南](https://developers.openai.com/api/docs/guides/function-calling)。省略 `strict` 时占位值行为的复现：[Vercel AI SDK issue #11869](https://github.com/vercel/ai/issues/11869)。
