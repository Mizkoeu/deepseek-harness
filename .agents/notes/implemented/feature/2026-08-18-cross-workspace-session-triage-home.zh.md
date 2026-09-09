# Agent Note: 跨工作区会话分诊 Home 视图

Status: implemented

[English](2026-08-18-cross-workspace-session-triage-home.md) | 中文

## Problem

Web GUI 一次只按一个维度组织工作：侧边栏把会话归入其工作区，主面板恰好显示一个选中的会话。这一组合对于在会话内部干活是正确的，但它没有给跨多个工作区运行大量会话的操作者一个单一的地方来回答真正主宰其一天的三个问题——哪些会话现在需要我、哪些在我离开时完成了、我在构建什么应该回头接着做。手工回答这些问题意味着在侧边栏中逐个展开每个工作区并逐行阅读；成本随会话数增长，而这恰是本 harness 要扩展到的规模。一个在少数几个目录中拥有数十个活动会话的操作者没有分诊表层，因此值得关注的状态（一个阻塞的审批、一个待审的计划、一次刚完成的运行）就埋没在空闲噪声旁边。

回答这些问题所需的信号已经按会话存在，也已经乘载在客户端会话列表 store 上；没有任何东西对它们做聚合或排序。[`SessionSummary`](../../../../packages/client/runtime/src/client/sessions/service.ts) 携带 `pendingInteraction`（`approval | plan-review | question`）、`completed`（在未选中且尚未打开时完成）、`running`、`updatedAt`、`displayTitle`、`cwd`、`parentId`、`origin` 和宿主计算的 `projectionValues`。store 已经跨每个工作区持有每一行——工作区浏览器把该超集过滤到一个工作区来显示。缺的一块是一个读取整个超集、并按操作者的关注度而非按目录对其排序的呈现表层。

## Decision

一个新的 Web 客户端插件 `packages/client/ui-home` 交付一个跨工作区分诊 **Home** 表层。其浏览器半边做两处共享同一开合状态 store 的注册：一个在侧边栏底部 `sidebar.footer.action` 列表插槽中的启动器（渲染在 Settings 上方），以及一个在覆盖整个 frame 的 `shell.overlay` 层中的分诊面板，因此启动器切换 overlay 所渲染的面板。该面板在每次加载时作为着陆表层自动打开。Home 从不取代按会话的对话；选中任何会话都让 Home 保持不变。

Home 是对既有会话列表 store 的纯客户端投影。它在组件内读取框架的 `useSessions` 和 `useWorkspaces` 钩子，把行超集折叠成关注度桶，并按最近活动优先渲染它们，每行显示工作区 basename，因此跨工作区的图景一目了然。不引入 Host RPC、会话事件或对象层状态；分诊是对象层已经发布的位的一个确定性函数。

### 关注度桶

Home 渲染三个不相交、按操作者排序的桶，镜像[完成点笔记](../../implemented/feature/2026-08-06-session-completed-done-dot.md)中所敲定的三个侧边栏 `StateDot` 信号，因此两个表层绝不会对某个会话的状态有分歧：

1. **需要你**——`pendingInteraction` 已置（一个阻塞的审批、计划审阅或问题）。最高优先级；操作者自身的输入是最稀缺的解阻资源。
2. **已完成——审阅或归档**——`completed` 已置（一次运行在会话未选中且未打开时完成）。这些是要签收并清理的会话。
3. **进行中**——`running` 为真且未在上文出现。属于环境感知，而非行动召唤。

不在这些桶中的会话——空闲、停放、已查看——刻意默认不列出。抑制那安静的多数正是要点：Home 是分诊队列，而不是完整列表的第二份副本。行操作打开会话（既有选择路径），而"已完成"桶另外提供内联的 Archive，复用[会话归档笔记](../../implemented/feature/2026-07-31-session-archive-global-set.md)中的注册表全局归档能力，而非第二套隐藏机制。

### 放置与分层

Home 遵守客户端栈的单向知识（[Web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md)）和[插槽系统标准](../../implemented/architecture/2026-07-22-slot-type-chain-implementation.md)。`ui-home` 只做呈现——每个反应式事实都经框架钩子到达，行操作是覆盖 runtime `sessions` 与 `workspaces` 服务的 inject 回调（`open` 经 `sessions.open`，"已完成"行归档经 `workspaces.archiveSession`），共享的开合状态存在一个声明的 store 里，绝不在对象层。启动器与侧边栏底部、在 Settings 旁配对；其琥珀色徽标计数阻塞在操作者上的会话（`pendingInteraction` 已置或 `goal.phase` 为 `blocked`，排除 subagent 与空白会话）。

### 信号设计

Home 不是对会话列表的重新排序；它按一个首次匹配的优先级阶梯把每个被呈现的会话分类为一个状态，然后把状态分组成区块。阶梯，从高到低：(1) `pendingInteraction` 已置——被你阻塞（审批 / 审阅计划 / 回答）；(2) `goal.phase = blocked`——被你阻塞；(3) 上一轮以 `error`、`max-tokens` 或 `interrupted` 结束且未在运行——已停滞（恢复）；(4) 运行中——工作中，agent 的回合；(5) `goal.phase = complete`、每个 todo 完成、或 `completed` 位——已完成（审阅 / 归档）；(6) 已定稿且末条消息为 assistant 消息、且以上皆非——待定，即由 Tier 1 分类器解决的问询-对-交接的歧义情形；(7) 末条消息是用户或排队的提示——agent 将接下来行动，默认隐藏；(8) 否则空闲——最近。区块：需要你 = 状态 1–3（外加 6 当被分类为问询时），已完成 = 5，进行中 = 4，接着做 = 6-默认与 8。优先级理由：一个活动提示胜过一个持久声明的阻塞项，后者又胜过一个静默停滞。

行携带 agent 自身的任务上下文。第一行是状态点、会话标题和该状态的内联动作动词。第二行，仅在"需要你"和"已完成"行上，是 `goal.objective` 或第一个待办 todo——即"是什么与下一步"——加上 todo 进度 `X/Y`、工作区和时长。"最近"行是单一导航行（标题、工作区、时长）。"需要你"按等待最久优先排序，因此被阻塞最久的工作浮上来；其余每个区块按最新优先排序。

### 确定性分诊阶段（Tier 0）

交付的阶段是确定性的，不带任何模型成本。它乘载每个会话列表行上已缓存的 `goal` 和 `todos` 投影（一个薄的 `dsh-host-apiproxy` 列表载体扩展，携带水位缓存已持有的值，而非新计算）和从 `turn/end` 事件折叠出的 [`lastTurnOutcome`](../../../../packages/session/session-last-turn-outcome/README.md) 投影（`normal | error | max-tokens | interrupted | blocked`），并在其上渲染阶梯、区块、两行上下文和内联动作动词。该插件经三个客户端表层注册（aggregate `references`、`web-app` cordis patch 行、`web-app` 依赖），依照客户端新包检查单。

两项扩展仍推迟，两者都建立在本阶段之上。一个**针对含糊残余（状态 6）的 LLM 分类器**将像[日志支撑的会话标题](../../implemented/feature/2026-07-21-log-backed-session-titles.md)那样折叠一个缓存投影，以末事件 seq 为键，仅当会话推进时重算，覆盖结构化尾部（末条用户消息、末条 assistant 消息、todo 状态、末条工具结果）——绝不覆盖运行中的会话，且只覆盖 Tier 0 无法分类的被呈现会话——从一个中心廉价模型发出 `{ summary, attention: blocking | optional | none, nextAction }`，作为处在"已记录即模型可见"规则之外的客户端读模型。**行动收件箱重构**（单元变成待处理动作，而非会话）以及从时长加 goal phase `complete` 推导的归档建议是另外的推迟方向。

## Relationship to adjacent surfaces

Home 是跨会话的分诊；[任务表层提案](../../proposed/feature/2026-08-04-task-surface.md)是单个会话内部的结构化交互。它们不重叠：Home 从不编辑一个会话的回合，而任务表层从不列出其他会话。Home 还补充——而非取代——会话搜索（[搜索默认不交付](../../implemented/feature/2026-08-02-session-search-not-shipped-default.md)）和按工作区的[会话列表浏览器](../../implemented/feature/2026-07-25-session-list-browsing-and-manual-order.md)：搜索回答"按内容找到某个特定的过往会话"，工作区浏览器回答"浏览一个项目的会话"，而 Home 回答"整个范围内什么现在需要我"。跨会话与跨工作区的恢复机制仍归其既有流程所有；Home 只是把注意力路由到它们。

## Alternatives considered

**在空选择时把 Home 挂载到主面板，而非 overlay 面板。** 推迟，未用于交付形态：非会话的主面板表层是 shell 今天没有的，把该挂载弄错有回归当前拥有空选择的空白新会话流程的风险。启动器加 overlay 的形态在没有 composer 竞争拥有者的情况下交付了分诊；空选择时的主面板挂载仍是后续选项，若采用则必须是一个干净的 shell 分支，且新会话入口仍可从 Home 到达。

**在既有侧边栏工作区浏览器里加一个关注度区块，而非专属表层。** 作为主表层不予采纳：侧边栏窄，会折叠到 56px 的轨条，且在结构上按工作区分组，这些都不适合一个带按行摘要和内联操作的、排序的跨工作区队列。一个紧凑的侧边栏关注度徽标是合理的补充——启动器正携带该计数——但完整分诊需要 frame 宽度。

**在 Host 上把分诊裁决算成一个新投影或 RPC。** 不予采纳：分类阶梯和排序留在客户端，因此操作者内存中的 `completed` 提醒（[完成点笔记](../../implemented/feature/2026-08-06-session-completed-done-dot.md)）与客户端的活动位在同一处结合，而无需重复的宿主读模型。在列表行上携带已缓存的投影值（`goal`、`todos`、`lastTurnOutcome`）是一个薄的载体扩展，而非宿主计算的分诊——宿主仍只投影它已持有的按会话事实；Home 决定它们的含义。

**把 LLM 摘要折进首发。** 不予采纳，因为分诊的核心价值——对既有位的即时排序——绝不能等待模型延迟或花费 token 来渲染一个列表。摘要是可分离的，且在不为 Home 设门的情况下增强它，因此它属于自己的笔记，带自己的成本与隐私分析。

**自动归档已完成或陈旧会话以保持列表整洁。** 不予采纳。归档是可逆的且从不触碰日志，但静默地把一个会话从视图中移除仍侵蚀操作者对存在什么的心智模型。Home 呈现归档*候选*并让操作者确认；它绝不隐藏操作者未选择清理的会话。

**把 Home 暴露为一个面向模型的工具，使 agent 能组装该仪表盘。** 不予采纳：跨会话分诊是操作者 chrome，而非 agent 能力。它必须是确定性的、始终在场的，并且无论任何会话的模型如何都相同，这是产品 UI 关切，而非工具。

## Verification

两个包都已具备无密钥组合与组件覆盖。`lastTurnOutcome` 投影在 `packages/session/session-last-turn-outcome/tests/` 有逐文件覆盖：一个注册表驱动的单元 spec（原因类别映射、后者胜覆盖、变更馈送仅在类别改变时触发、迟挂载折叠、卸载时移除键）和一个真实 Loader 组合 spec，启动交付的 `session + projection-registry + last-turn-outcome` YAML 并提供粗粒度结果。Home 的浏览器半边在 `packages/client/ui-home/tests/` 有逐文件覆盖：一个 `apply` spec 钉住启动器与 overlay 注册进侧边栏底部与 overlay 插槽、共享开合状态 store、注入的 `open`/`archive` 委派给 runtime 服务、注入到未声明插槽的延迟、以及释放；一个组件 spec 钉住启动器的阻塞计数徽标和 overlay 的首次匹配阶梯（Needs you / In progress / In flight / Pick up / Review or archive）、一个损坏运行的最近-对-陈旧划分、带按行工作区与相对时长的跨工作区分组、两行 goal/todo 上下文、带溢出提示的桶折叠、以及 open/archive/close 行操作。两个包都达到逐文件 100% 门槛，并在干净检出（无已构建 `lib/`）下从源码运行，这由 `session-last-turn-outcome/types` 和 `/client` 的 tsconfig 路径映射使其可解析。Home 的状态与侧边栏 `StateDot` 状态对同一会话绝不分歧，因为两者读取相同的对象层位。Tier 0 不新增任何模型调用，并把分诊分类与排序保持在客户端；其唯一的 Host 依赖是列表行上携带的已缓存 `goal`、`todos` 和 `lastTurnOutcome` 值。

覆盖缺口：本地化的 zh/en chrome、两种主题、纯键盘操作和大列表虚拟化尚未断言，因为交付的面板渲染英文 chrome 和未虚拟化的定量桶；这些断言等待面板获得 locale 接线与虚拟化。

## Consequences

一个跨多个工作区运行大量会话的操作者得到一个按关注度排序的队列，而不必逐行阅读工作区行：启动器徽标一目了然地呈现阻塞计数，自动打开的面板让他们着陆在分诊而非空白 composer。由于 Home 是对象层已发布的位之上的确定性客户端投影，它不新增模型调用、Host RPC 或会话事件，也绝不会与读取相同位的侧边栏点分歧。它接受的成本：已完成桶按浏览器在内存中，重载时重置；含糊的待定状态（6）在推迟的 Tier 1 分类器交付前不做模型分类；且各桶在高会话数下可能变长，因此虚拟化和有界、可扫读的区块承担负载。

## Risks

`completed` 提醒按设计是按浏览器且在内存中的，因此 Home 的"已完成"桶在页面重载时重置——与侧边栏点一致，但重载的操作者会丢失"离开时完成"的集合。这是继承行为，非新增，而推迟的持久摘要是通往可挺过重载的"已完成"信号的路径（若日后想要）。

`pendingInteraction` 只覆盖审批、计划审阅和问题等待。一个被该集合之外的东西阻塞的会话（例如一条长外部命令）显示为进行中，而非需要你。这符合当前信号的含义；扩宽它是对待处理交互源的一次单独变更，而非对 Home 的变更。

在高会话数下，各桶仍可能很长。列表必须虚拟化，且桶应保持有界且可扫读；一个自身变成一堵行墙的桶只是把过载搬了个地方，因此桶内的排序和可选的按工作区折叠需要真实的交互测试。
