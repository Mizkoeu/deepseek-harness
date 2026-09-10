# Agent Note：公开 fork 的上游评审同步自动化

Status: implemented

[English](2026-09-09-mike-upstream-review-sync.md) | 中文

## Problem

Mike 的定制内容位于本地 `oh-mike-dsh` 集成分支，该分支从上游 `master` 切出。一旦该检出以 fork `MizkoEu/deepseek-harness` 发布，让集成分支与上游保持同步就需要一个可重复的机制。手动拉取会漂移、会遗忘；而一个直接合并或部署上游代码的粗糙自动化，会彻底否定对这些定制进行评审的初衷。上游变更可能破坏配置或会话格式，因此每次更新都必须先到达人工手中，且不得运行服务器或强制改写历史。

## Decision

`mike upstream review sync` GitHub Actions 工作流（`.github/workflows/mike-upstream-sync.yml`）每天 UTC `17 5 * * *` 运行，并支持 `workflow_dispatch`。它以 `github.repository == 'MizkoEu/deepseek-harness'`（不区分大小写比较，因为 GitHub 的 slug 如此）为守卫，因此绝不会在上游运行；使用单队列并发且不取消进行中的运行；仅请求 `contents: write` 和 `pull-requests: write`。它以 `persist-credentials: false` 检出受信任的自定义集成分支 `oh-mike-dsh`，并通过 `actions/github-script` 运行一个小型 ES 模块入口；它绝不使用写令牌安装、构建或执行获取到的上游代码。检出 `oh-mike-dsh` 而非 `master` 镜像至关重要：镜像持有上游代码，且不携带本自动化的 `.github/mike-upstream-sync/` 脚本，因此检出镜像会导致模块找不到，或在镜像推进后用写令牌执行上游控制的代码。

所有策略都位于经过单元测试的 `.github/mike-upstream-sync/sync.mjs` 中，GitHub 客户端以注入方式提供，因此测试可针对伪 API 运行且不触网。每个周期都会验证该 fork 确实是所指定上游的 fork、且镜像分支与集成分支不同，通过仓库 API 发现上游默认分支，然后以 `force: false` 将 fork 的 `master` 镜像推进到与上游头部完全一致（已一致时为空操作；发生分叉则拒绝——绝不重置或强制）。它绝不写入上游引用、集成分支头部、设置、auto-merge 或评审。

在评审方面，它至多维持一个自动化拥有的、开放的、指向 `oh-mike-dsh` 的草稿 pull request。当集成分支已包含上游头部时，不开 PR。当一个自有 PR 处于开放状态时，该 PR 及其头部保持不动，后续更新排队等待。否则同步会在上游头部创建一个确定性的保留导入分支 `mike/upstream-<full-sha>` 并开一个草稿 PR，以便即使合并存在冲突 GitHub 也能开出 PR；人工在该 PR 分支上解决冲突，绝不在镜像上解决。该分支以幂等方式创建（仅在 SHA 完全一致时复用；已存在但 SHA 不匹配的引用会拒绝且不覆盖），因此"分支已建但建 PR 失败"的运行可恢复。针对某一头部已关闭的 PR 不会被重开；更新的上游头部才会提出下一次更新。绝不发生分支删除或强制推送。PR 正文说明同步未运行任何测试、未更新服务器，且合并前需要人工评审、破坏性配置与会话格式检查以及本地验证。

它使用默认 `GITHUB_TOKEN`，无需 PAT 或密钥配置。保留的 `mike/upstream-<sha>` 导入分支是 `mike/<topic>` 特性分支规则的一个有文档记录的例外，记录于 [dsh-mike-branch-workflow 技能](../../../skills/dsh-mike-branch-workflow/SKILL.md)；本 note 扩展了 [个人集成分支](../process/2026-09-09-personal-integration-branch.md) 决策，后者曾把 fork 加 PR 的模式推迟到发布获授权之后。

## CI cannot validate these PRs automatically

本仓库的 `pull_request` CI 运行在团队专用 runner 上——`dsh-ubuntu-24-04-16core` 和自托管池——这些在个人 fork 上并不存在，因此机器人 PR 不会显示绿色检查。根据当前 GitHub 行为（[triggering a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow)），由 `GITHUB_TOKEN` 开出的 PR 可以触发 `pull_request` 工作流，但此类运行需要人工批准；结合不可用的 runner，应把这些 PR 的检查状态视为"未运行"，直到人工在本地完成验证。新 fork 的 Actions 可能需要启用并被允许创建 PR，这由 parent 在发布后配置；计划任务在负载下可能被延迟，且仓库长期无活动后 GitHub 会禁用计划任务。把庞大的 CI 矩阵重新设计为在个人 runner 上运行超出范围；手动验证与可选的 runner 配置才是有文档记录的路径。

## Alternatives considered

- **使用 merge-upstream API 或合并提交。** 拒绝：它可能在 fork 上创建本地合并，而非上游头部的精确镜像。同步以 `force: false` 将镜像引用快进到精确 SHA，使镜像始终与上游一致，冲突解决只发生在人工拥有的 PR 分支上。
- **对已验证的更新自动合并或部署。** 拒绝：定制分支的全部意义在于人工评审；上游变更可能破坏配置和会话格式，而 fork 的 CI 甚至无法跑绿。自动化止步于提出一个草稿 PR。
- **在分叉时强制更新镜像或保留分支。** 拒绝：强制写入可能摧毁工作并掩盖漂移。分叉与 SHA 不匹配会大声拒绝，且绝不删除或强制推送任何分支。
- **每天重开一个已关闭的提议。** 拒绝：关闭了某提议的人不应就同一头部被反复打扰；只有更新的上游头部才创建下一次提议。
- **重新设计 CI 使 fork PR 在托管 runner 上跑绿。** 拒绝为超出范围且不成比例；该限制已记录，人工本地验证是评审者的路径。

## Auth limitation — updating refs whose diff touches workflow files

`GITHUB_TOKEN` 无法创建或更新 `.github/workflows/**` 下的文件，且没有任何 `permissions` 键能授予它按设计被拒绝的 `workflows` 作用域（[community #35410](https://github.com/orgs/community/discussions/35410)、[为何推送被拒](https://konadu.dev/github-actions-checkout-token-workflow-files-permission-denied)、[community #25222](https://github.com/orgs/community/discussions/25222)）。本同步将 fork 的 `master` 镜像与 `mike/upstream-<sha>` 导入分支推进到上游头部的精确 SHA；每当上游相对 fork 改动了任何 `.github/workflows/**` 文件时，该引用写入都会被服务端拒绝（"refusing to allow a GitHub App to create or update workflow ... without workflows permission"）。因此镜像推进与导入分支创建仅在上游工作流文件未变时成功；触及工作流的上游更新会大声失败并需要人工。`force: false` 与禁止强制的保护保持不变，且并非原因：带无关工作流改动的快进依然被拒。本自动化不携带任何绕过此限制的凭据。备选方案（均不自动执行）：人工手动完成镜像推送，或 parent 有意将带 `workflows` 写权限的 PAT 或 GitHub App 作为工作流密钥提供——绝不在此处从 runner 令牌自动复制。`merge-upstream` API 不是变通办法（它可能向镜像创建分叉合并而非精确镜像，且仍写入工作流文件）。

## Consequences

- fork 的 `master` 始终是上游的精确镜像；集成分支只通过人工评审的草稿 PR 推进。
- 任一时刻至多一个开放的自动化 PR，因此评审不会被淹没；排队的更新在其后等待，其间镜像保持最新。
- 评审者必须本地验证：fork 的团队专用 runner 使机器人 PR 的检查状态不可靠，parent 可能需要在发布后启用 fork Actions 与 PR 创建。
- 镜像与导入分支写入在任何触及工作流文件的上游更新上都会大声失败，直到人工或有意提供的带 `workflows` 作用域的凭据完成它们；默认令牌无法做到。
- 触碰这些分支前必须理解 `mike/<topic>` 规则的保留导入分支例外；技能与本 note 均承载该例外。导入分支仅匹配为前缀加完整 40 位十六进制 SHA，因此像 `mike/upstream-review-sync` 这样的普通特性分支绝不会被误认为机器人 PR 头部。

## Testing

`.github/mike-upstream-sync/sync.test.mjs`（`node:test`，通过 `pnpm run test:mike-upstream-sync` 与 doc-sync 门列表运行）针对一个集中断言安全不变量的伪 API 驱动策略：写入仅指向 fork、引用更新携带 `force: false`、集成分支绝不被写入或合并。它覆盖空操作路径、有新变更时的镜像加草稿 PR、镜像分叉拒绝、开放 PR 的保留与更新排队、一个共享前缀的普通特性分支不被当作机器人 PR、已关闭 PR 的遵守、幂等分支复用、不同 SHA 的分支冲突、错误 fork 与分支相等的拒绝、不区分大小写的 fork 父仓匹配、`isImportBranch` 的前缀加完整 SHA 匹配、API 错误的大声传播，以及固定的 PR 正文。两个结构测试证明检出修复：该套件读取工作流并断言它检出 `oh-mike-dsh` 而绝不检出 `master`，并断言被导入的 `run.mjs` 入口就在此受信任分支上与 `sync.mjs` 相邻存在。`scripts/mike-upstream-sync-workflow.spec.ts` 用既有的 `js-yaml` 依赖解析工作流 YAML，断言计划与 dispatch 触发、不区分大小写的 fork 守卫、最小权限、无凭据的 `oh-mike-dsh` 检出（绝非镜像），以及运行仅执行经过单元测试的入口而无获取代码的构建步骤。
