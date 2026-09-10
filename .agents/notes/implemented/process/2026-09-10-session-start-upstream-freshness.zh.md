# Agent Note: Session-start upstream freshness check

Status: implemented

[English](2026-09-10-session-start-upstream-freshness.md) | 中文

## Problem

Mike 的检出在 `oh-mike-dsh` 集成分支上跟踪固定的公开上游 `deepseek-ai/deepseek-harness`。此前一个每日 GitHub Actions 计划任务让 fork 的镜像保持最新并提出评审 PR，但对个人检出而言，平台 cron 是错误的节奏原语：无论 Mike 是否在工作它都会触发，GitHub 在长期无活动后会禁用计划任务，而且——一旦某个评审 PR 处于开放且待处理状态——一个粗糙的每会话检查会在每个会话都重复一次网络往返却无事可做。Mike 选择的节奏是本地优先：在会话开始时廉价地检查上游新鲜度，最多每周一次，同时让庞大的上游 PR 保持开放且不合并。

## Decision

每日的 `on.schedule` 触发已从 `.github/workflows/mike-upstream-sync.yml` 中移除；该工作流现在仅由操作者发起 `workflow_dispatch`，并保留其 fork 守卫、单队列并发、最小的 `contents`/`pull-requests` 写权限，以及受信任的 `oh-mike-dsh` 检出。例行新鲜度检查迁移到每个克隆的辅助脚本 `.github/mike-upstream-sync/freshness.mjs`，在自定义会话开始时调用（`freshness-run.mjs`，或 `--now` 强制）。

该辅助脚本是一个小型 Node ESM、纯 git 模块，无新增依赖。它仅在最后一次成功检查缺失、格式错误、带有未来时间戳、标识了不同的上游，或已至少 7 天，或传入 `--now` 时，才查询固定的公开上游。查询时，它通过规范 URL（ssh/https/`.git` 形式视为相等）把已配置的 remote 解析到上游，或在没有匹配的 remote 时——常见的新 fork 场景中 `origin` 就是 fork——直接抓取固定的公开 URL，绝不添加或重命名 remote。单次 `ls-remote --symref HEAD` 同时捕获上游默认分支与其确切头部 SHA；随后抓取请求的是该固定 SHA 而非分支名，因此在发现之后移动的头部无法导入另一个未观察到的提交，也不会使任何远程跟踪引用（如 `origin/master`）前进。抓取只导入对象并只写入 `FETCH_HEAD`；不更新任何本地分支、远程跟踪引用或工作树引用，且在信任前先验证固定对象已存在。所有祖先比较都使用该不可变 SHA，针对 `refs/heads/oh-mike-dsh` 集成引用——绝不使用检出的 HEAD，因此位于领先于集成分支的特性分支上的会话不会把它报告为已是最新。它归类为 up-to-date（观察到的 SHA 是 `oh-mike-dsh` 的祖先）、updates-available（二者共享合并基点——本地自定义提交加新上游提交的正常 fork 情形）或 history-diverged（完全没有共同祖先：全新的无关历史或已证实的上游改写，需要人工迁移，绝不自动合并），并打印一行有界、可执行的结果。除干净的"无合并基点"之外的任何 git 错误都会传播并使戳不被推进。

### 检查状态按克隆保存且与集成分离

最后一次成功的检查与上游最后一次被集成的位置分开跟踪：集成由相对观察头部的 git 祖先关系推导，而检查戳仅记录某次查询成功。因此一个待处理的评审 PR 绝不会强制每会话的网络检查。状态按克隆保存在 git 公共目录（跨工作树共享）中，名为 `mike-upstream-check.json`，位于受版本控制的文件之外，因此时间戳绝不被反复提交。它记录上游身份、成功检查的 UTC 时刻，以及观察到的上游默认分支与头部 SHA——仅是上游的观察，绝不是存储的"up-to-date"结论，因为 `oh-mike-dsh` 集成引用可能在缓存仍新鲜时前进或回退。命中新鲜缓存跳过网络时，辅助脚本会重新读取当前 `oh-mike-dsh` 引用并离线重新计算祖先关系；若缓存的上游对象在本地不存在（git 已裁剪，或新工作树从未抓取），则仅报告原始观察，绝不给出过期结论。该文件以原子方式写入（临时文件加重命名），且仅在查询、抓取与祖先读取都成功之后写入；查询、抓取或解析失败会让先前的戳保持不变。标识了不同上游的戳被视为不存在，因此对其他 remote 的抓取绝不能冒充对固定上游的检查，而未来时间戳被视为过期而非永久新鲜。

该辅助脚本不读取任何 GitHub 令牌或 PAT，也不需要 `gh`；缺少 `gh` 绝不会阻塞这个纯 git 检查。它不执行任何合并、推送、PR 变更或服务器重启。手动的 `mike-upstream-sync.yml` 工作流仍是唯一进行镜像与提议的路径，且仅在人工 dispatch 时。

## Alternatives considered

- **保留每日平台 cron。** 拒绝：它无论是否有活动都会运行，GitHub 在无活动后会禁用它，且在评审 PR 开放而无可集成内容时仍会重新检查上游。会话开始时的检查把成本与实际工作对齐。
- **在每个会话开始都检查上游。** 拒绝：一个开放的待处理 PR 会因此在每个会话触发一次浪费的网络往返。7 天成功检查窗口限定了成本；`--now` 覆盖了强制的罕见需求。
- **从开放的评审 PR 或 git 集成状态推导新鲜度。** 拒绝：集成状态回答的是"上游是否已合并"，而非"我们最近是否看过"。二者混淆会在 PR 待处理期间每会话都重新检查。检查戳是一个独立的事实，单独跟踪。
- **把时间戳存入受版本控制的文件。** 拒绝：按克隆提交时间戳会反复搅动历史并在工作树之间冲突。git 公共目录提供一个跨工作树共享且排除于版本控制之外的、按克隆的单一归宿。
- **假设 `origin` 指向上游。** 拒绝：新 fork 克隆的 `origin` 通常是 fork。辅助脚本按规范 URL 匹配上游，或抓取固定的公开 URL，而不添加或重命名 remote。
- **缓存"up-to-date"结论而非观察。** 拒绝：集成引用可能在缓存仍新鲜时前进或回退，因此存储的结论会在上游未变时就变得过期。缓存仅保存上游观察；跳过路径重新读取 `oh-mike-dsh` 并离线重新计算祖先关系，或在缓存对象缺失时报告原始观察。
- **按名称抓取默认分支，再读取其 SHA。** 拒绝：头部可能在抓取与后续 `ls-remote` 之间移动，返回一个从未被抓取的 SHA，且分支 refspec 可能推进像 `origin/master` 这样的远程跟踪引用。头部 SHA 从最初的 `ls-remote --symref` 固定，抓取以无目标方式请求该确切 SHA，因此观察到的与导入的提交相同，且没有引用移动。
- **相对检出的 HEAD 归类。** 拒绝：会话经常运行在领先于 `oh-mike-dsh` 的 `mike/<topic>` 特性分支上，这会错误地把集成分支报告为已是最新。归类始终针对 `refs/heads/oh-mike-dsh`。
- **把任何非快进关系都当作 history-diverged。** 拒绝：fork 通常有共享合并基点的本地自定义提交与新上游提交——那是普通的 `updates-available`，而非迁移。只有真正缺少共同祖先才是 `history-diverged`；其他每个 git 错误都会传播，而不被误标为分叉。
- **用 `FETCH_HEAD` 做比较。** 拒绝：`FETCH_HEAD` 可变，另一工作树的抓取可能覆盖它。观察到的 SHA 被显式捕获并用于每次祖先检查。

## Consequences

- 上游新鲜度每个克隆最多每周检查一次，与 Mike 实际工作的时机对齐；工作流中不再保留任何平台 cron。远端计划任务仅在父级发布本分支后才真正消失。
- 待处理的上游 PR 不再导致重复的每会话网络检查，因为成功检查戳与集成状态分离。
- 只读检查即使在脏树上也会运行，不做 stash、clean 或编辑用户文件；抓取绝不触碰任何分支引用或工作树文件。
- 该辅助脚本绝不合并、推送、变更 PR 或重启服务器，且不需要任何 GitHub 凭据，因此不引入新的鉴权面。历史分叉被报告以供人工迁移，绝不自动合并。Mike 已明确推迟庞大的上游 PR，因此首次 `--now` 检查可能报告一个大型或分叉的更新；辅助脚本只报告它，绝不集成它或关闭该 PR。
- 这限定了[上游评审同步 Agent Note](../feature/2026-09-09-mike-upstream-review-sync.md) 中的每日节奏说法，该 note 现在将工作流描述为仅由操作者发起。

## Testing

`.github/mike-upstream-sync/freshness.test.mjs`（`node:test`，通过 `pnpm run test:mike-upstream-freshness` 运行并注册在执行的根门列表中）以伪命令表、注入的时钟与临时真实 git 仓库驱动实际的辅助函数——不触网。它覆盖：新鲜度与戳解析；规范 remote slug 匹配与 fork 克隆的固定 URL 回退；`fetchUpstreamHead` 从 `ls-remote --symref` 固定 SHA 并抓取该确切 SHA（绝非分支），以及在抓取后固定对象缺失时拒绝；一次真实命名 remote 抓取在导入观察对象的同时让所有引用、`origin/main`、`HEAD` 与工作树文件保持不变；一次 query/fetch 竞态——上游在抓取后立即前进，观察到的与导入的 SHA 仍是发现时的头部；针对 `refs/heads/oh-mike-dsh` 而非 HEAD 的归类，包括领先于落后 `oh-mike-dsh` 的特性分支报告 updates-available、随后在 `oh-mike-dsh` 前进后报告 up-to-date；共享合并基点的 fork（自定义加上游提交）归类为 updates-available、无关历史归类为 history-diverged，以及非"无合并基点"的 git 错误传播；新鲜缓存跳过时重新读取 `oh-mike-dsh` 离线归类，并在缓存对象缺失时仅报告观察；缺失/`>= 7 天`/`--now` 触发查询；查询或抓取失败让戳保持不变；未来与错误上游的戳重新查询；原子戳写入；一次针对真实命名 remote 的完整 `runFreshnessCheck`；以及跨工作树共享的 git 公共目录放置。`scripts/mike-upstream-sync-workflow.spec.ts` 另外断言工作流不带任何计划任务且仅有 `workflow_dispatch`，同时保留 fork 守卫、权限、受信任检出与经单元测试入口的断言。
