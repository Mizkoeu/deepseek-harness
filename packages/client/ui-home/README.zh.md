# @deepseek-ai/dsh-client-ui-home

[English](README.md) | 中文

Home 插件：一个跨工作区的关注度分诊表层。浏览器半边做两处共享同一开合状态 store 的注册——一个在侧边栏底部 `sidebar.footer.action` 列表插槽中的启动器（渲染在 Settings 上方），以及一个在覆盖整个 frame 的 `shell.overlay` 层中的分诊面板——因此启动器切换 overlay 所渲染的面板。Home 在组件内通过标准 `useSessions` 钩子读取跨每个工作区的每个会话，把行超集折叠成按操作者排序的关注度桶，且从不编辑一个会话的回合。在应用别处选中一个会话不会自动关闭 Home；点击一个 Home 行会打开该会话并关闭面板（该行的 `openSession` 调用 `setOpen(false)`）。约定与原理：[插槽系统标准](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md)与[跨工作区分诊 Home 笔记](../../../.agents/notes/implemented/feature/2026-08-18-cross-workspace-session-triage-home.md)。

Home 是纯客户端投影：它不引入 Host RPC、会话事件或对象层状态。它的桶是对象层已在每个会话行上发布的位的确定性函数——`pendingInteraction`、`completed`、`running`、`updatedAt`，以及已缓存的 `goal` 和 [`lastTurnOutcome`](../../session/session-last-turn-outcome/README.md) 投影值。行操作是覆盖 runtime `sessions` 与 `workspaces` 服务的 inject 回调：打开一行调用 `sessions.open`，一个"已完成"行经 `workspaces.archiveSession` 归档。

启动器在侧边栏宽时渲染带标签的行、折叠时渲染仅图标的轨条控件，镜像 New Session 与 Settings 控件。一个琥珀色徽标携带当前阻塞在操作者上的会话计数——即带有 `pendingInteraction` 或 `goal.phase` 为 `blocked` 的那些，排除 subagent（带 `parentId`）与空白会话。

`/client` 导出仅是插件主体（`apply`/`inject`）加上组合的 prop 与 inject 面类型；`HomeOverlay`、`HomeLauncher` 和视图 store 工厂留在包内、藏在插槽注册之后。所需服务（`inject`）：`slots`、`sessions`、`workspaces`。节点半边是空 apply——该包没有宿主端行为。

## 模型体验

无，因为 Home 在会话列表之上渲染一个浏览器端分诊视图；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **交付形态是一个启动器加一个自动打开的 `shell.overlay` 面板**——设计笔记所述的空选择时主面板呈现形态仍是后续选项；视图 store 在每次加载时打开 Home 且不持久化。
- **桶只是确定性的 Tier 0**——针对含糊的问询-对-交接残余的 LLM 分类器（设计笔记 Tier 1）未交付；Tier 0 无法分类的会话在此不做模型分诊。
- **`completed` 提醒按浏览器且在内存中**——"已完成"桶在页面重载时重置，与侧边栏完成点一致；不存在可挺过重载的"离开时完成"信号。
- **`pendingInteraction` 只覆盖审批、计划审阅和问题等待**——被该集合之外的东西阻塞的会话（例如一条长外部命令）呈现为进行中，而非需要你，符合当前信号的含义。
- **分诊分类与排序留在客户端**——唯一的 Host 依赖是列表行上携带的已缓存 `goal`、`todos` 和 `lastTurnOutcome` 值；Home 不新增任何模型调用。
