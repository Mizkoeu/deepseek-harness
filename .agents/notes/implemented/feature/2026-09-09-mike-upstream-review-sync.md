# Agent Note: Upstream review-sync automation for the public fork

Status: implemented

English | [中文](2026-09-09-mike-upstream-review-sync.zh.md)

## Problem

Mike's customizations live on the local `oh-mike-dsh` integration branch, cut from upstream `master`. Once the checkout is published as the fork `MizkoEu/deepseek-harness`, keeping the integration branch current with upstream needs a repeatable mechanism. Manual pulls drift and forget; a naive automation that merges or deploys upstream code would defeat the reason the customizations are reviewed at all. Upstream changes can break configuration or the session format, so every update must reach a human before it lands, and nothing may run a server or force history.

## Decision

The `mike upstream review sync` GitHub Actions workflow (`.github/workflows/mike-upstream-sync.yml`) runs daily at `17 5 * * *` UTC and on `workflow_dispatch`. It is guarded to `github.repository == 'MizkoEu/deepseek-harness'` so it never runs on upstream, uses single-queued concurrency that does not cancel a run in progress, and requests only `contents: write` and `pull-requests: write`. It checks out only the trusted `master` mirror with `persist-credentials: false` and runs one small ES-module entry through `actions/github-script`; it never installs, builds, or executes fetched upstream code with the write token.

All policy lives in the unit-tested `.github/mike-upstream-sync/sync.mjs`, with the GitHub client injected so tests run against a fake API and no network. Each cycle verifies the fork is a fork of the exact upstream and that the mirror and integration branches differ, discovers the upstream default branch through the repository API, then advances the fork's `master` mirror to the exact upstream head with `force: false` (a no-op when current; divergence rejects — never a reset or force). It never writes upstream refs, the integration head, settings, auto-merge, or reviews.

For review, it maintains at most one automation-owned open draft pull request into `oh-mike-dsh` at a time. When the integration branch already contains the upstream head, no PR opens. While an owned PR is open, it and its head are left untouched and later updates queue. Otherwise the sync creates a deterministic reserved import branch `mike/upstream-<full-sha>` at the upstream head and opens a DRAFT PR, so GitHub can open it even when the merge conflicts; the human resolves conflicts on that PR branch, never on the mirror. The branch is created idempotently (reused only at the exact SHA; a mismatched existing ref rejects without overwriting), so a branch-created-but-PR-failed run recovers. A PR closed for one head is not reopened; a newer upstream head proposes the next update. No branch deletion or force push ever occurs. The PR body states that the sync ran no tests and no server update, and that human review, breaking-config and session-format checks, and local validation are required before merge.

This uses the default `GITHUB_TOKEN` with no PAT or secret setup. The reserved `mike/upstream-<sha>` import branch is a documented exception to the `mike/<topic>` feature-branch rule, recorded in the [dsh-mike-branch-workflow skill](../../../skills/dsh-mike-branch-workflow/SKILL.md); this note extends the [personal integration branch](../process/2026-09-09-personal-integration-branch.md) decision, which deferred a fork-with-PRs model until publication was authorized.

## CI cannot validate these PRs automatically

This repository's `pull_request` CI runs on team-only runners — `dsh-ubuntu-24-04-16core` and self-hosted pools — that do not exist on a personal fork, so bot PRs will not show green checks there. Per current GitHub behavior ([triggering a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow)), a PR opened by `GITHUB_TOKEN` can trigger `pull_request` workflows but such runs require manual approval; combined with the unavailable runners, treat check status on these PRs as not-run until a human validates locally. A new fork's Actions may need to be enabled and allowed to create PRs, which the parent configures after publish; scheduled runs can be delayed under load and GitHub disables schedules after prolonged repository inactivity. Redesigning the large CI matrix to run on personal runners is out of scope; manual validation and optional runner setup are the documented path.

## Alternatives considered

- **Use the merge-upstream API or a merge commit.** Rejected: it could create a local merge on the fork instead of an exact mirror of the upstream head. The sync fast-forwards the mirror ref to the exact SHA with `force: false` so the mirror is always identical to upstream, and conflict resolution happens only on the human-owned PR branch.
- **Auto-merge or deploy validated updates.** Rejected: the whole point of the customization branch is human review; upstream changes can break configuration and the session format, and the fork's CI cannot even run green. Automation stops at proposing one draft PR.
- **Force-update the mirror or reserved branch on divergence.** Rejected: force writes can destroy work and hide drift. Divergence and SHA mismatch reject loudly instead, and no branch is ever deleted or force-pushed.
- **Reopen a closed proposal daily.** Rejected: a human who closed a proposal should not be re-nagged for the same head; only a newer upstream head creates the next proposal.
- **Redesign CI to run fork PRs green on hosted runners.** Rejected as out of scope and disproportionate; the limitation is documented and manual local validation is the reviewer's path.

## Consequences

- The fork's `master` stays an exact mirror of upstream; the integration branch only ever advances through a human-reviewed draft PR.
- At most one open automation PR exists at a time, so review is not flooded; queued updates wait behind it and the mirror stays current meanwhile.
- Reviewers must validate locally: the fork's team-only runners make bot-PR CI status unreliable, and the parent may need to enable fork Actions and PR creation after publish.
- The reserved-import-branch exception to the `mike/<topic>` rule must be understood before touching these branches; the skill and this note carry it.

## Testing

`.github/mike-upstream-sync/sync.test.mjs` (`node:test`, run via `pnpm run test:mike-upstream-sync` and the doc-sync gate list) drives the policy against a fake API that centrally asserts the security invariants: writes target only the fork, ref updates carry `force: false`, and the integration branch is never written or merged. It covers the no-op path, new-changes mirror-plus-draft-PR, mirror divergence rejection, open-PR preservation with queued update, closed-PR honoring, idempotent branch reuse, branch collision at a different SHA, incorrect fork or equal-branch rejection, loud API-error propagation, and a pinned PR body. `scripts/mike-upstream-sync-workflow.spec.ts` parses the workflow YAML with the existing `js-yaml` dependency and asserts the schedule and dispatch triggers, fork guard, minimal permissions, mirror-only credential-free checkout, and that the run executes only the unit-tested entry with no fetched-code build step.
