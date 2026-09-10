// Session-start upstream freshness check for Mike's local checkout.
//
// This module decides, at the start of a custom session, whether to spend a
// network round trip checking the fixed public upstream, and classifies the
// result without ever mutating history. It NEVER merges, fetches into a
// checked-out ref, force-updates any ref, pushes, mutates a pull request, or
// restarts a server. It reads and fetches objects only.
//
// The last SUCCESSFUL check is tracked separately from where upstream was last
// integrated: integration is derived from git ancestry against the observed
// upstream head, while the check stamp records only that a query succeeded. A
// pending review PR therefore never forces an every-session network check.
//
// State lives per clone in the git common directory (shared across worktrees),
// outside versioned files, so timestamps are not churn-committed. It is written
// atomically and ONLY after a successful query, fetch, and ancestry read; a
// failed query, fetch, or parse leaves the previous stamp untouched.
//
// The command runner and clock are injected so tests drive every path with a
// fake command table, a fake clock, and a temporary git repository — no network.

/** How long a successful check stays fresh before the next query is due. */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Fixed public upstream. A fresh fork's `origin` is usually the fork, not this. */
export const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Owner/name identity the stamp must match to count as a check of THIS upstream. */
export const UPSTREAM_SLUG = 'deepseek-ai/deepseek-harness'

/** Basename of the per-clone state file inside the git common directory. */
export const STATE_BASENAME = 'mike-upstream-check.json'

/**
 * @typedef {object} CheckState
 * @property {string} upstream Upstream slug this stamp describes, e.g. "deepseek-ai/deepseek-harness".
 * @property {string} checkedAtUtc ISO-8601 UTC instant of the last successful check.
 * @property {string} observedDefaultBranch Upstream default branch observed at that check.
 * @property {string} observedSha Full 40-hex upstream head SHA observed at that check.
 */

/**
 * Injected side-effect surface. Every method rejects on failure; the caller
 * treats any rejection as "check did not succeed" and never advances the stamp.
 * @typedef {object} FreshnessEnv
 * @property {(args: string[]) => Promise<{ stdout: string }>} git Run git in the checkout; rejects (non-zero exit) loudly.
 * @property {() => number} now Current epoch milliseconds.
 * @property {(path: string) => Promise<string | null>} readFile Read a UTF-8 file, or null if absent.
 * @property {(path: string, contents: string) => Promise<void>} writeFileAtomic Write a UTF-8 file atomically (temp + rename).
 * @property {(dir: string, name: string) => string} joinPath Join a directory and file name into a path.
 */

/**
 * Parse persisted state, returning null when absent, malformed, or identifying a
 * DIFFERENT upstream. A wrong-upstream stamp is treated as no stamp so another
 * remote's fetch can never masquerade as a check of the fixed upstream.
 * @param {string | null} raw File contents, or null when the file is absent.
 * @returns {CheckState | null}
 */
export function parseState(raw) {
  if (raw === null) return null
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { upstream, checkedAtUtc, observedDefaultBranch, observedSha } = value
  if (upstream !== UPSTREAM_SLUG) return null
  if (typeof checkedAtUtc !== 'string' || Number.isNaN(Date.parse(checkedAtUtc))) return null
  if (typeof observedDefaultBranch !== 'string' || observedDefaultBranch.length === 0) return null
  if (typeof observedSha !== 'string' || !/^[0-9a-f]{40}$/.test(observedSha)) return null
  return { upstream, checkedAtUtc, observedDefaultBranch, observedSha }
}

/**
 * Is a parsed stamp fresh at `nowMs`? A missing stamp is stale. A future
 * timestamp (clock skew or a wrong record) is treated as stale so it can never
 * pin a permanently fresh state; only a stamp in the past and within the window
 * is fresh.
 * @param {CheckState | null} state
 * @param {number} nowMs Current epoch milliseconds.
 * @returns {boolean}
 */
export function isFresh(state, nowMs) {
  if (state === null) return false
  const checkedMs = Date.parse(state.checkedAtUtc)
  if (Number.isNaN(checkedMs)) return false
  const age = nowMs - checkedMs
  if (age < 0) return false
  return age < FRESH_WINDOW_MS
}

/**
 * Normalize a git remote URL to its `owner/name` slug so ssh, https, and
 * `.git`-suffixed forms of the same repository compare equal.
 * @param {string} url Remote fetch URL.
 * @returns {string | null} Lowercased "owner/name", or null when it does not parse.
 */
export function remoteSlug(url) {
  const trimmed = url.trim().replace(/\.git$/, '')
  const match = trimmed.match(/[/:]([^/:]+)\/([^/]+)$/)
  if (!match) return null
  return `${match[1]}/${match[2]}`.toLowerCase()
}

/**
 * Find a configured remote whose fetch URL points at the fixed upstream, by
 * canonical slug match. Returns the remote name, or null when none matches (a
 * fresh fork clone whose only remote is the fork). This never adds or renames a
 * remote; the caller fetches the fixed URL directly when null.
 * @param {string} remoteVerbose Output of `git remote -v`.
 * @returns {string | null}
 */
export function findUpstreamRemote(remoteVerbose) {
  for (const line of remoteVerbose.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
    if (!match) continue
    if (remoteSlug(match[2]) === UPSTREAM_SLUG) return match[1]
  }
  return null
}

/**
 * Resolve the fetch source: a configured remote pointing at the fixed upstream,
 * or the fixed public URL when none is configured. No remote is added or renamed.
 * @param {FreshnessEnv} env
 * @returns {Promise<string>} A remote name or the fixed upstream URL.
 */
export async function resolveFetchSource(env) {
  const { stdout } = await env.git(['remote', '-v'])
  return findUpstreamRemote(stdout) ?? UPSTREAM_URL
}

/**
 * Fetch the upstream default branch's objects into the object store WITHOUT
 * updating any local branch, and return the observed default branch and its head
 * SHA. Uses `--no-write-fetch-head`-free plain fetch that imports objects and
 * writes only FETCH_HEAD; the observed SHA is captured explicitly here so later
 * ancestry uses that immutable value, never a FETCH_HEAD another worktree may
 * overwrite. Rejects if the query or fetch fails.
 * @param {FreshnessEnv} env
 * @param {string} source Remote name or upstream URL from resolveFetchSource.
 * @returns {Promise<{ defaultBranch: string, sha: string }>}
 */
export async function fetchUpstreamHead(env, source) {
  // Discover the upstream default branch without checking anything out.
  const head = await env.git(['ls-remote', '--symref', source, 'HEAD'])
  const refMatch = head.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)
  if (!refMatch) throw new Error('could not resolve upstream default branch')
  const defaultBranch = refMatch[1]
  // Import objects only. No refspec target, so no local branch is created or
  // moved; only FETCH_HEAD is written. The result SHA is read from ls-remote,
  // not FETCH_HEAD, so it is stable regardless of concurrent worktree fetches.
  await env.git(['fetch', '--no-tags', source, defaultBranch])
  const shaOut = await env.git(['ls-remote', source, `refs/heads/${defaultBranch}`])
  const shaMatch = shaOut.stdout.match(/^([0-9a-f]{40})\s/)
  if (!shaMatch) throw new Error('could not resolve upstream head SHA')
  return { defaultBranch, sha: shaMatch[1] }
}

/**
 * Classify the local HEAD against an explicit observed upstream SHA using git
 * ancestry. `up-to-date` means the observed head is already an ancestor of HEAD
 * (local integration is at or beyond it); `updates-available` means HEAD is an
 * ancestor of the observed head; `history-diverged` means neither is an ancestor
 * of the other, or the objects share no common base — a migration a human must
 * resolve, never an automatic merge.
 * @param {FreshnessEnv} env
 * @param {string} observedSha Explicit upstream head SHA captured at fetch time.
 * @returns {Promise<'up-to-date' | 'updates-available' | 'history-diverged'>}
 */
export async function classify(env, observedSha) {
  if (await isAncestor(env, observedSha, 'HEAD')) return 'up-to-date'
  if (await isAncestor(env, 'HEAD', observedSha)) return 'updates-available'
  return 'history-diverged'
}

/**
 * Is `ancestor` an ancestor of `descendant`? Git exits 0 for yes, 1 for no;
 * any other exit (missing object, no common history reported as error) rejects
 * and is handled by the caller as a diverged/unknown outcome.
 * @param {FreshnessEnv} env
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {Promise<boolean>}
 */
async function isAncestor(env, ancestor, descendant) {
  try {
    await env.git(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (err) {
    // Exit 1 means "not an ancestor" — a normal answer, not a failure. Any
    // other exit is a real error and must propagate to the diverged path.
    if (err && typeof err === 'object' && 'code' in err && err.code === 1) return false
    throw err
  }
}

/**
 * Human-readable, bounded result line plus the manual-review instruction for a
 * classification. No line triggers a remote action.
 * @param {'up-to-date' | 'updates-available' | 'history-diverged'} status
 * @param {string} observedSha
 * @returns {string}
 */
export function formatResult(status, observedSha) {
  const short = observedSha.slice(0, 12)
  switch (status) {
    case 'up-to-date':
      return `upstream up-to-date at ${short}; no action needed.`
    case 'updates-available':
      return `upstream updates available at ${short}; review and integrate via the operator-initiated workflow (see dsh-mike-branch-workflow).`
    case 'history-diverged':
      return `upstream history diverged from local at ${short}; migration needed — resolve manually, never merge automatically.`
    default:
      return status
  }
}

/**
 * Is a git object present in the local store? Used before an offline ancestry
 * recompute against a cached SHA, since git may have pruned the object or this
 * worktree may never have fetched it.
 * @param {FreshnessEnv} env
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
async function objectExists(env, sha) {
  try {
    await env.git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * @typedef {object} CachedResult
 * @property {false} queried No network access occurred.
 * @property {CheckState} state The cached upstream observation.
 * @property {'up-to-date' | 'updates-available' | 'history-diverged' | null} status Ancestry against CURRENT local HEAD, or null when the cached object is absent locally.
 * @property {string} message Bounded result line: a fresh classification, or the raw observation when status is null.
 */

/**
 * @typedef {object} QueriedResult
 * @property {true} queried A network query ran.
 * @property {'up-to-date' | 'updates-available' | 'history-diverged'} status Ancestry against the freshly observed head.
 * @property {string} observedSha The observed upstream head SHA.
 * @property {string} message Bounded result line.
 */

/**
 * Build a result from a fresh cache without any network access. The cache holds
 * only the upstream observation, so ancestry is recomputed against the CURRENT
 * local HEAD; when the cached object is not present locally, only the raw
 * observation is reported, never a stale conclusion.
 * @param {FreshnessEnv} env
 * @param {CheckState} state
 * @returns {Promise<CachedResult>}
 */
async function classifyFromCache(env, state) {
  if (!(await objectExists(env, state.observedSha))) {
    const short = state.observedSha.slice(0, 12)
    return {
      queried: false,
      state,
      status: null,
      message: `upstream last observed ${short} at ${state.checkedAtUtc} (cached; object not present locally, run --now to re-check).`,
    }
  }
  const status = await classify(env, state.observedSha)
  return { queried: false, state, status, message: `${formatResult(status, state.observedSha)} (from cached observation ${state.checkedAtUtc}).` }
}

/**
 * Decide and run one session-start freshness check.
 *
 * When a valid, non-future, in-window successful stamp exists and `force` is
 * false, no network access occurs. The cached stamp records only the upstream
 * OBSERVATION (identity, time, default branch, head SHA), never a stored
 * conclusion, because local integration can advance or rewind while the cache
 * stays fresh. The skip path therefore recomputes ancestry against the CURRENT
 * local HEAD offline and returns a fresh classification; if the cached upstream
 * object is not present locally (for example, git pruned it or this is a fresh
 * worktree), it returns the raw observation without a stale conclusion.
 *
 * Otherwise it resolves the upstream source, fetches objects, classifies against
 * the explicit observed SHA, and — only on full success — atomically writes the
 * new stamp. Any failure (query, fetch, parse, ancestry error) leaves the
 * previous stamp unchanged and surfaces as a rejection to the caller.
 *
 * @param {FreshnessEnv} env
 * @param {string} commonDir Git common directory (shared across worktrees).
 * @param {{ force?: boolean }} [opts] `force` (from `--now`) queries regardless of freshness.
 * @returns {Promise<CachedResult | QueriedResult>}
 */
export async function runFreshnessCheck(env, commonDir, opts = {}) {
  const statePath = env.joinPath(commonDir, STATE_BASENAME)
  const state = parseState(await env.readFile(statePath))
  if (!opts.force && isFresh(state, env.now())) {
    return classifyFromCache(env, state)
  }

  const source = await resolveFetchSource(env)
  const { defaultBranch, sha } = await fetchUpstreamHead(env, source)
  const status = await classify(env, sha)

  // Success: advance the stamp atomically. This runs only after the query,
  // fetch, and ancestry read all succeeded above.
  const next = {
    upstream: UPSTREAM_SLUG,
    checkedAtUtc: new Date(env.now()).toISOString(),
    observedDefaultBranch: defaultBranch,
    observedSha: sha,
  }
  await env.writeFileAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`)
  return { queried: true, status, observedSha: sha, message: formatResult(status, sha) }
}
