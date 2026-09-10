// Daily/manual upstream-mirror maintenance for Mike's public fork.
//
// This module runs only on the fork MizkoEu/deepseek-harness. It force-free
// mirrors the upstream default branch onto the fork's mirror branch and, when
// the integration branch is behind that upstream head, opens exactly one DRAFT
// pull request into the integration branch for HUMAN review. It never merges,
// never force-pushes, never writes upstream or the integration head directly,
// and never touches repository settings, auto-merge, or reviews.
//
// The GitHub API is injected as `api` so tests exercise every path with a fake
// client and no network. `api` is the minimal surface this module needs; each
// method mirrors one REST endpoint. Any API error propagates loudly: this
// module never swallows a failed write into a silent success.

/**
 * @typedef {object} SyncConfig
 * @property {string} fork Owner/name of the fork this automation owns, e.g. "MizkoEu/deepseek-harness".
 * @property {string} upstream Owner/name of the trusted upstream, e.g. "deepseek-ai/deepseek-harness".
 * @property {string} integrationBranch Long-lived integration branch that receives review PRs, e.g. "oh-mike-dsh".
 * @property {string} mirrorBranch Fork branch kept at the exact upstream head, e.g. "master".
 * @property {string} prBranchPrefix Prefix for reserved import branches, e.g. "mike/upstream-".
 */

/**
 * Minimal GitHub client the sync needs. Every method rejects on API failure.
 * @typedef {object} SyncApi
 * @property {(repo: string) => Promise<{ fork: boolean, parent?: { full_name: string }, default_branch: string }>} getRepo
 * @property {(repo: string, branch: string) => Promise<string>} getBranchSha Resolve a branch to its commit SHA; rejects if the branch is absent.
 * @property {(repo: string, ref: string, sha: string) => Promise<void>} updateRef Fast-forward-or-fail ref update (force:false); rejects on divergence.
 * @property {(repo: string, ref: string, sha: string) => Promise<void>} createRef Create a new ref; rejects if it already exists.
 * @property {(repo: string, base: string, head: string) => Promise<'ahead' | 'behind' | 'identical' | 'diverged'>} compare Compare base...head at the commit level.
 * @property {(repo: string, opts: { base: string, state: 'open' | 'closed', head?: string }) => Promise<Array<{ number: number, head: { ref: string, sha: string }, base: { ref: string }, draft: boolean }>>} listPulls
 * @property {(repo: string, opts: { title: string, head: string, base: string, body: string, draft: boolean }) => Promise<{ number: number }>} createPull
 */

/**
 * Deterministic reserved import-branch name for an upstream head. The full SHA
 * makes the ref stable across runs: the same upstream head always maps to the
 * same branch, so a re-run reuses it instead of proliferating branches.
 * @param {string} prefix Branch prefix from config.
 * @param {string} sha Upstream head commit SHA (full 40-char).
 * @returns {string} Branch name without the `refs/heads/` prefix.
 */
export function importBranchName(prefix, sha) {
  return `${prefix}${sha}`
}

/**
 * Does a branch name denote an automation-owned import branch for THIS config?
 * It must be exactly the prefix followed by a full 40-hex-char commit SHA. This
 * deliberately excludes ordinary feature branches that merely share the prefix
 * segment (e.g. `mike/upstream-review-sync`), so the sync never mistakes its own
 * source branch for a bot PR head.
 * @param {string} prefix Branch prefix from config.
 * @param {string} ref Branch name (no `refs/heads/`).
 * @returns {boolean}
 */
export function isImportBranch(prefix, ref) {
  return ref.startsWith(prefix) && /^[0-9a-f]{40}$/.test(ref.slice(prefix.length))
}

/**
 * Normalize an owner/name repository slug for comparison. GitHub owner and
 * repository slugs are case-insensitive, so the fork guard compares lowercased.
 * @param {string} repo
 * @returns {string}
 */
export function normalizeRepo(repo) {
  return repo.toLowerCase()
}

/** Marker prepended to automation-owned PR titles so a later run can recognize its own open PR. */
export const PR_TITLE_PREFIX = '[upstream-sync] '

/**
 * PR body shown to the human reviewer. It states plainly that the sync ran no
 * tests, performed no server update, and that breaking-config and
 * session-format review plus local validation are required before merge. The
 * fork's CI cannot run these PRs green on personal runners, so validation is
 * manual. Kept stable so a snapshot can pin the user-visible text.
 * @param {object} args
 * @param {string} args.upstream Upstream repo full name.
 * @param {string} args.upstreamSha Upstream head SHA.
 * @param {string} args.integrationBranch Integration branch the PR targets.
 * @returns {string} Markdown PR body.
 */
export function prBody({ upstream, upstreamSha, integrationBranch }) {
  return [
    `Automated proposal to update \`${integrationBranch}\` to \`${upstream}\`@\`${upstreamSha}\`.`,
    '',
    '**This is a DRAFT for human review — it does not auto-merge and nothing was deployed.**',
    '',
    'The sync performed NO tests and NO server update. Before merging, a human must:',
    '',
    '- resolve any merge conflicts on THIS PR branch (never on the mirror/master branch);',
    '- review breaking configuration and session-format changes;',
    '- run local validation (the fork cannot run this repository\'s CI on personal runners — see the workflow header and Agent Note).',
    '',
    'Merge only after review. If you close this PR without merging, the sync will NOT reopen it; a newer upstream head can propose the next update.',
  ].join('\n')
}

/**
 * Assert the automation is running against its own fork of the exact upstream,
 * and that mirror and integration branches are distinct. Any mismatch throws:
 * the sync must never run on upstream or write the wrong repository.
 * @param {SyncConfig} config
 * @param {{ fork: boolean, parent?: { full_name: string } }} repo Result of getRepo(config.fork).
 */
export function assertForkGuard(config, repo) {
  if (config.mirrorBranch === config.integrationBranch) {
    throw new Error(`mirrorBranch and integrationBranch must differ; both are "${config.mirrorBranch}"`)
  }
  if (!repo.fork || normalizeRepo(repo.parent?.full_name ?? '') !== normalizeRepo(config.upstream)) {
    throw new Error(
      `refusing to run: ${config.fork} must be a fork of ${config.upstream}, got fork=${repo.fork} parent=${repo.parent?.full_name ?? 'none'}`,
    )
  }
}

/**
 * Run one sync cycle. Returns a structured summary of every action taken; the
 * caller logs it. Order: verify fork guard, discover upstream head, mirror it
 * force-free onto the fork, then decide whether a review PR is needed.
 * @param {SyncConfig} config
 * @param {SyncApi} api
 * @returns {Promise<{ upstreamSha: string, mirrored: boolean, pr: { created: boolean, number?: number, reason: string } }>}
 */
export async function runSync(config, api) {
  const forkRepo = await api.getRepo(config.fork)
  assertForkGuard(config, forkRepo)

  const upstreamRepo = await api.getRepo(config.upstream)
  const upstreamDefault = upstreamRepo.default_branch
  const upstreamSha = await api.getBranchSha(config.upstream, upstreamDefault)

  const mirrored = await mirrorUpstream(config, api, upstreamSha)
  const pr = await maintainReviewPull(config, api, upstreamSha)

  return { upstreamSha, mirrored, pr }
}

/**
 * Update the fork's mirror branch to the exact upstream head with force:false.
 * A no-op when already at that SHA. Divergence rejects (updateRef throws): the
 * sync never resets or force-updates the mirror.
 * @returns {Promise<boolean>} true if the ref was advanced, false if already current.
 */
async function mirrorUpstream(config, api, upstreamSha) {
  const current = await api.getBranchSha(config.fork, config.mirrorBranch)
  if (current === upstreamSha) return false
  await api.updateRef(config.fork, `heads/${config.mirrorBranch}`, upstreamSha)
  return true
}

/**
 * Decide and, if needed, create the single review PR. No PR when the
 * integration branch already contains the upstream head. At most one
 * automation-owned open PR into the integration branch exists at a time; while
 * one is open it and its head are left UNTOUCHED and later updates queue. A new
 * proposal uses the deterministic reserved import branch, created idempotently
 * so a prior branch-created-but-PR-failed run recovers without overwriting.
 */
async function maintainReviewPull(config, api, upstreamSha) {
  const relation = await api.compare(config.fork, config.integrationBranch, upstreamSha)
  if (relation === 'identical' || relation === 'behind') {
    return { created: false, reason: 'integration already includes upstream head' }
  }

  const openOwned = (await api.listPulls(config.fork, { base: config.integrationBranch, state: 'open' }))
    .filter(pull => isImportBranch(config.prBranchPrefix, pull.head.ref))
  if (openOwned.length > 0) {
    return { created: false, reason: `open review PR #${openOwned[0].number} awaiting review; update queued` }
  }

  const branch = importBranchName(config.prBranchPrefix, upstreamSha)
  const head = `${config.fork.split('/')[0]}:${branch}`

  // Honor a closed/rejected proposal for this exact head: do not reopen it.
  const closedSame = await api.listPulls(config.fork, { base: config.integrationBranch, state: 'closed', head })
  if (closedSame.length > 0) {
    return { created: false, reason: `review PR for ${upstreamSha} was closed; not reopening` }
  }

  await ensureImportBranch(config, api, branch, upstreamSha)

  const pull = await api.createPull(config.fork, {
    title: `${PR_TITLE_PREFIX}update ${config.integrationBranch} to ${upstreamSha}`,
    head: branch,
    base: config.integrationBranch,
    body: prBody({ upstream: config.upstream, upstreamSha, integrationBranch: config.integrationBranch }),
    draft: true,
  })
  return { created: true, number: pull.number, reason: 'opened draft review PR' }
}

/**
 * Create the reserved import branch at the upstream head, or reuse it when it
 * already points at exactly that SHA (idempotent recovery). A ref that exists
 * at a DIFFERENT SHA rejects without overwriting: the sync never force-pushes.
 */
async function ensureImportBranch(config, api, branch, upstreamSha) {
  let existing
  try {
    existing = await api.getBranchSha(config.fork, branch)
  } catch {
    // Branch absent: create it. getBranchSha rejects only for a missing ref
    // here; a transport failure would resurface on createRef below.
    existing = undefined
  }
  if (existing === upstreamSha) return
  if (existing !== undefined) {
    throw new Error(`import branch ${branch} exists at ${existing}, expected ${upstreamSha}; refusing to overwrite`)
  }
  await api.createRef(config.fork, `refs/heads/${branch}`, upstreamSha)
}
