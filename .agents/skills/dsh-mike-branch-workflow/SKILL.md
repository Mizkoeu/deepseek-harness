---
name: dsh-mike-branch-workflow
description: Use before changing, committing, or integrating Mike's DeepSeek Harness customizations. Branch from oh-mike-dsh, keep features separate, and merge completed work back into oh-mike-dsh without changing upstream master.
---

# Mike's DeepSeek Harness Branch Workflow

This skill governs Mike's custom checkout, not upstream contribution policy. `oh-mike-dsh` is the long-lived integration branch. Use `mike/<topic>` for feature branches; Git cannot store `oh-mike-dsh/<topic>` alongside the `oh-mike-dsh` branch. The [decision record](../../notes/implemented/process/2026-09-09-personal-integration-branch.md) explains the trade-offs.

## Before editing

1. Run `pwd`, `git rev-parse --show-toplevel`, `git status --short --branch`, and `git worktree list`. Identify existing work and which worktree owns each branch. Never assume the running server's checkout is safe to switch.
2. Verify `refs/heads/oh-mike-dsh` exists. If missing, inspect configured remotes and ask which verified ref to use; never silently recreate the custom branch from `master` or `origin/master`. Do not assume `origin` is Mike's fork or a remote copy exists.
3. For new work, branch from the current `oh-mike-dsh` tip. If already on that feature's branch, continue there after checking its ancestry and scope. Keep upstream `master` unchanged.
4. If the current worktree is dirty, belongs to another session, or hosts the running GUI, prefer a separate worktree. Do not stash, reset, clean, or switch away another session's work. Preserve existing edits before any authorized history organization.

In a clean, unused worktree:

```sh
git switch -c mike/<topic> oh-mike-dsh
```

For concurrent work, choose an unused path inside the permitted filesystem area:

```sh
git worktree add -b mike/<topic> <unused-worktree-path> oh-mike-dsh
```

Do not reuse an existing branch name or path without inspecting it.

## Commit one feature

- Keep code, tests, documentation, manifests, generated artifacts, and lockfile changes for the same feature together. Split shared files by hunk; do not sweep another feature into a commit with `git add .`.
- Inspect `git diff --cached` and `git diff --cached --check`. Never commit credentials, personal runtime settings, sessions, build output, or dependency directories.
- Select focused tests through [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md). Commit with hooks enabled and inspect hook-generated changes. A failure is not permission to use `--no-verify`, disable hooks, or weaken dependency policy.
- Describe behavior accurately. Uncommitted does not mean unfinished; report demonstrated failures and distinguish missing documentation from broken behavior.

## Integrate completed work

Completion means the requested behavior is present, relevant checks pass, and the feature is committed. If integration advanced, merge its current tip into the feature branch and validate affected behavior again before landing. Unresolved conflicts or failed checks leave the feature unmerged with a concrete report.

Use the clean worktree that owns `oh-mike-dsh`; do not switch another session's checkout. Inspect both tips immediately before merging:

```sh
git switch oh-mike-dsh
git merge --no-ff mike/<topic> -m "Merge mike/<topic> into oh-mike-dsh"
git merge-base --is-ancestor mike/<topic> oh-mike-dsh
git status --short --branch
```

Preserve feature branches and merge commits for traceability. Do not squash, rewrite shared history, delete branches, or merge customizations into upstream `master` without explicit direction. Abort on unexpected ref movement rather than overwrite concurrent integration.

## Publication and handoff

Local commits are not a remote backup. Push only when the user authorizes publication and the destination is verified. Do not create upstream PRs or configure the custom branch to track `origin/master`. For dependent GitHub PRs, the repository's native-stack policy still applies; this local workflow does not replace it.

Report feature branches, commit IDs, integration merge IDs, checks actually run, remaining dirty paths, and whether anything was pushed. Never restart the running Harness server merely to switch or merge branches.

## Session-start upstream freshness

At the start of a custom session, run the read-only freshness helper before other upstream work: `node .github/mike-upstream-sync/freshness-run.mjs` (add `--now` to force a query). It queries the fixed public upstream `deepseek-ai/deepseek-harness` ONLY when the last successful check is missing, malformed, has a future timestamp, or is at least 7 days old — so a pending review PR never causes an every-session network check. It resolves a configured remote to upstream by canonical URL (or fetches the fixed public URL without adding or renaming a remote), pins the upstream head SHA from `ls-remote --symref` and fetches that exact SHA (no branch refspec, so no remote-tracking ref like `origin/master` advances and the imported commit is the one observed), imports objects with FETCH_HEAD only (no branch or worktree ref touched), and classifies against the `refs/heads/oh-mike-dsh` integration ref — never the checked-out HEAD — as up-to-date, updates-available, or history-diverged, printing one bounded manual-review line. A fork's normal state of local custom commits plus new upstream commits (shared merge base) is updates-available; only a genuine absence of a common ancestor is history-diverged and reports that a migration is needed. It never merges automatically.

The last SUCCESSFUL check is tracked separately from where upstream was last integrated (integration is derived from git ancestry). State lives per clone in the git common directory as `mike-upstream-check.json` — shared across worktrees, outside versioned files, never churn-committed — and records only the upstream observation (identity, UTC time, default branch, head SHA), never a stored conclusion. On a fresh-cache skip the helper rereads the current `oh-mike-dsh` ref and recomputes ancestry offline, so an integration branch that advanced or rewound is reflected without a stale success claim; if the cached object is absent locally it reports only the observation. The stamp advances atomically ONLY after a successful query, fetch, and ancestry read; a failed query, fetch, or parse leaves it unchanged, and a stamp identifying a different upstream does not count as a check. The helper reads no GitHub token and needs no `gh`; it performs no merge, push, PR mutation, or server restart. The manual GitHub workflow (`mike-upstream-sync.yml`) remains operator-initiated `workflow_dispatch` only, with no platform cron. Rationale: [session-start upstream freshness](../../notes/implemented/process/2026-09-10-session-start-upstream-freshness.md).

## Upstream maintenance, review, and deploy are separate

On the published fork `MizkoEu/deepseek-harness`, the `mike upstream review sync` workflow keeps the fork's `master` mirror at the exact upstream head and, when `oh-mike-dsh` is behind that head, opens ONE draft pull request into `oh-mike-dsh` for human review. It checks out the trusted `oh-mike-dsh` branch (which owns its scripts), never the `master` mirror. Automated maintenance stops at proposing: it never merges, force-pushes, deploys, or updates a running server. A human resolves conflicts on the PR branch, reviews breaking configuration and session-format changes, runs local validation, and merges. The fork's `pull_request` CI runs on team-only runners absent from a personal fork, so those checks stay missing or pending — not passes — and these PRs' status is not-run until validated locally. The default `GITHUB_TOKEN` cannot write refs whose diff touches `.github/workflows/**`, so a workflow-file-touching upstream update can make the mirror advance or import-branch creation fail; the sync fails loud rather than declaring the mirror current, and completion then needs a human or a deliberately provisioned `workflows`-scoped credential. The [upstream-review-sync Agent Note](../../notes/implemented/feature/2026-09-09-mike-upstream-review-sync.md) owns the design, its security guarantees, and this auth limitation.

That sync uses reserved `mike/upstream-<full-sha>` import branches, an intentional exception to the `mike/<topic>` feature-branch rule: their source is an upstream import pointing at the upstream head, not hand-authored feature work, so GitHub can open a draft PR even when the merge conflicts. Do not treat an import branch as a feature branch, rebase it, or resolve conflicts on the mirror or `master`; resolve on the PR branch only.

The root `AGENTS.md` directs future sessions here before customization work. A session whose skill catalog predates this file must read it directly; new project sessions discover it under `.agents/skills/`.

This is workflow guidance, not a substitute for inspecting Git state or obtaining permission for publication and destructive operations.

## Recovery

Keep any safety archive used for reorganizing existing edits until every original path is accounted for in commits or explicitly retained work. Do not call local history remotely backed up until the destination ref has been verified after an authorized push.
