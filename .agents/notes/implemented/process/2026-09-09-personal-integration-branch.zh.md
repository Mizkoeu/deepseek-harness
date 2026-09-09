# Agent Note: 本地定制的个人集成分支

Status: implemented

[English](2026-09-09-personal-integration-branch.md) | 中文

## Problem

本 checkout 携带一批本地定制，它们绝不能落到上游 `master`，但仍然需要版本控制、可读的按功能拆分历史，以及一个跨会话稳定累积的落脚点。单一的脏工作树会丢失历史并把互不相关的功能混在一起；而直接提交到 `master` 会污染跟踪上游的分支，令日后从 `origin` 同步变得复杂。

## Decision

`oh-mike-dsh` 是一条从 `master` 切出的长期本地集成分支。定制工作在从 `oh-mike-dsh` 创建的 `mike/<topic>` 功能分支上进行，按功能逐一提交（共享文件按 hunk 拆分，使一次提交绝不裹入无关改动），随后以 `git merge --no-ff` 合并回去，让每个功能成为一个独立且可回滚的 merge。`master` 永不改动并继续跟踪 `origin/master`，因此上游同步始终是一次干净的 fast-forward 或 rebase。

功能分支采用扁平的 `mike/<topic>` 前缀，而非 `oh-mike-dsh/<topic>`：Git 以文件形式存储 ref，因此 `refs/heads/oh-mike-dsh` 叶子无法与 `refs/heads/oh-mike-dsh/<topic>` 目录共存。[dsh-mike-branch-workflow 技能](../../../skills/dsh-mike-branch-workflow/SKILL.md) 是操作流程；根 `AGENTS.md` 会在定制工作之前把会话指向它。本地提交不是备份——发布需要明确授权与经核验的目标，且该流程绝不会自行 push 或开上游 PR。

## Alternatives considered

- **直接提交到 `master`。** 已否决：它会使跟踪上游的分支产生分叉，令从 `origin` 拉取或 rebase 易生冲突，并有把私有工作误 push 到上游的风险。
- **把功能分支 rebase 成线性历史**（或合并时 squash）。已否决：`--no-ff` 保留按功能的边界与 merge 点，使个人集成分支可审计、每个功能可独立回滚；线性或 squash 历史会抹去这种分组。
- **个人 fork 加 PR。** 已搁置：在工作仍为本地时这过于笨重；该流程把发布推迟到目标被明确授权之时，届时可在不改变分支模型的前提下加入 fork 或 remote。

## Consequences

- `master` 在本地绝不偏离 `origin/master`；上游更新保持为干净的 fast-forward。
- 每项定制都是 `oh-mike-dsh` 上一个孤立的 `--no-ff` merge，可在不牵动其他功能的情况下回滚或检视。
- 未来会话在更改、提交或集成任何定制之前必须加载 `dsh-mike-branch-workflow`（由根 `AGENTS.md` 规则强制）；技能目录早于该技能的会话直接在 `.agents/skills/` 下阅读它。
- 重整既有脏工作树时，保留一份原始字节的安全归档，直到每个原始路径都被某次提交或明确保留的工作所覆盖。
