# Agent Note: Personal integration branch for local customizations

Status: implemented

English | [中文](2026-09-09-personal-integration-branch.zh.md)

## Problem

This checkout carries local customizations that must never land on upstream `master`, yet still need version control, readable per-feature history, and a stable place to accumulate across sessions. A single dirty working tree loses history and mixes unrelated features; committing onto `master` pollutes the upstream-tracking branch and complicates later sync from `origin`.

## Decision

`oh-mike-dsh` is a long-lived local integration branch cut from `master`. Custom work happens on `mike/<topic>` feature branches created from `oh-mike-dsh`, committed one feature at a time (shared files split by hunk so a commit never sweeps in unrelated work), then merged back with `git merge --no-ff` so each feature stays a distinct, revertable merge. `master` is never modified and keeps tracking `origin/master`, so upstream sync remains a clean fast-forward or rebase.

Feature branches use the flat `mike/<topic>` prefix rather than `oh-mike-dsh/<topic>`: Git stores refs as files, so a `refs/heads/oh-mike-dsh` leaf cannot coexist with a `refs/heads/oh-mike-dsh/<topic>` directory. The [dsh-mike-branch-workflow skill](../../../skills/dsh-mike-branch-workflow/SKILL.md) is the operational procedure; the root `AGENTS.md` points sessions to it before customization work. Local commits are not a backup — publication requires explicit authorization and a verified destination, and this workflow never pushes or opens upstream PRs on its own.

## Alternatives considered

- **Commit directly on `master`.** Rejected: it diverges the upstream-tracking branch, makes pulling or rebasing from `origin` conflict-prone, and risks an accidental push of private work upstream.
- **Rebase feature branches into linear history** (or squash on merge). Rejected: `--no-ff` preserves the per-feature boundary and merge points that make a personal integration branch auditable and each feature independently revertable; linear or squashed history erases that grouping.
- **A personal fork with PRs.** Deferred: heavier than needed while work stays local; the workflow defers publication until a destination is explicitly authorized, at which point a fork or remote can be added without changing the branch model. Once published, the [upstream review-sync automation](../feature/2026-09-09-mike-upstream-review-sync.md) realizes this model for upstream maintenance.

## Consequences

- `master` never diverges from `origin/master` locally; upstream updates stay a clean fast-forward.
- Each customization is an isolated `--no-ff` merge on `oh-mike-dsh`, so it can be reverted or inspected without untangling other features.
- Future sessions must load `dsh-mike-branch-workflow` before changing, committing, or integrating a customization (enforced by a root `AGENTS.md` rule); a session whose skill catalog predates the skill reads it directly under `.agents/skills/`.
- Reorganizing an existing dirty tree keeps a safety archive of the original bytes until every original path is accounted for in a commit or explicitly retained.
