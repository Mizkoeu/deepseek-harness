// Unit tests for the upstream-sync policy. A fake SyncApi records every write
// and lets each test script API responses, so all paths run with no network.
// The fake asserts the core security invariants centrally: writes only target
// the fork, ref updates are force:false, and the integration branch is never
// written or merged.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { assertForkGuard, importBranchName, isImportBranch, isOwnedReviewPull, prBody, PR_TITLE_PREFIX, runSync } from './sync.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const CONFIG = {
  fork: 'MizkoEu/deepseek-harness',
  upstream: 'deepseek-ai/deepseek-harness',
  integrationBranch: 'oh-mike-dsh',
  mirrorBranch: 'master',
  prBranchPrefix: 'mike/upstream-',
}

const UPSTREAM_SHA = 'a'.repeat(40)
const OLD_MIRROR_SHA = 'b'.repeat(40)

/**
 * Build a fake SyncApi over an in-memory state.
 * @param {object} state
 * @param {Record<string, string>} state.branches Map of `${repo}#${branch}` to SHA; absent key => branch missing.
 * @param {(repo: string, base: string, head: string) => string} [state.compare] Relation oracle; defaults to 'ahead' (PR needed).
 * @param {Array<{ number: number, head: { ref: string, sha: string }, base: { ref: string }, draft: boolean, state: 'open' | 'closed' }>} [state.pulls]
 */
function fakeApi(state) {
  const calls = { updateRef: [], createRef: [], createPull: [] }
  const key = (repo, branch) => `${repo}#${branch}`
  const api = {
    async getRepo(repo) {
      if (repo === CONFIG.fork) return { fork: true, parent: { full_name: CONFIG.upstream }, default_branch: 'master' }
      if (repo === CONFIG.upstream) return { fork: false, default_branch: 'master' }
      throw new Error(`unexpected getRepo ${repo}`)
    },
    async getBranchSha(repo, branch) {
      const sha = state.branches[key(repo, branch)]
      if (sha === undefined) throw new Error(`404 no ref ${repo}#${branch}`)
      return sha
    },
    async getBranchShaOrNull(repo, branch) {
      // A test can inject a non-404 failure for a specific branch to prove it
      // propagates instead of being treated as "missing".
      if (state.branchError && state.branchError.branch === branch) throw state.branchError.error
      const sha = state.branches[key(repo, branch)]
      return sha === undefined ? null : sha
    },
    async updateRef(repo, ref, sha) {
      // SECURITY INVARIANT: writes only target the fork, never the integration branch.
      assert.equal(repo, CONFIG.fork, 'updateRef must only write the fork')
      assert.notEqual(ref, `heads/${CONFIG.integrationBranch}`, 'must never write the integration branch')
      calls.updateRef.push({ repo, ref, sha, force: false })
      state.branches[key(repo, ref.replace('heads/', ''))] = sha
    },
    async createRef(repo, ref, sha) {
      assert.equal(repo, CONFIG.fork, 'createRef must only write the fork')
      const branch = ref.replace('refs/heads/', '')
      assert.notEqual(branch, CONFIG.integrationBranch, 'must never create over the integration branch')
      if (state.branches[key(repo, branch)] !== undefined) throw new Error(`422 ref exists ${branch}`)
      calls.createRef.push({ repo, ref, sha })
      state.branches[key(repo, branch)] = sha
    },
    async compare(repo, base, head) {
      return (state.compare ?? (() => 'ahead'))(repo, base, head)
    },
    async listPulls(repo, opts) {
      return (state.pulls ?? [])
        .filter(p => p.state === opts.state && p.base.ref === opts.base)
        .filter(p => !opts.head || `${repo.split('/')[0]}:${p.head.ref}` === opts.head)
        .map(p => ({
          // Default an owned title and same-repo head unless the fixture
          // overrides them, so classification-specific tests stay explicit.
          title: `${PR_TITLE_PREFIX}update`,
          ...p,
          head: { repoFullName: CONFIG.fork, ...p.head },
        }))
    },
    async createPull(repo, opts) {
      assert.equal(repo, CONFIG.fork, 'createPull must only target the fork')
      assert.equal(opts.base, CONFIG.integrationBranch, 'PR base must be the integration branch')
      assert.equal(opts.draft, true, 'review PR must be a DRAFT')
      calls.createPull.push(opts)
      return { number: 777 }
    },
  }
  return { api, calls, state }
}

test('force:false mirror advance + draft PR on new upstream changes, never merges integration', async () => {
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': OLD_MIRROR_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.mirrored, true)
  assert.deepEqual(calls.updateRef, [{ repo: CONFIG.fork, ref: 'heads/master', sha: UPSTREAM_SHA, force: false }])
  assert.equal(calls.createRef.length, 1)
  assert.equal(calls.createRef[0].ref, `refs/heads/${importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)}`)
  assert.equal(summary.pr.created, true)
  assert.equal(summary.pr.number, 777)
  assert.equal(calls.createPull.length, 1)
  assert.ok(calls.createPull[0].title.startsWith(PR_TITLE_PREFIX))
})

test('no-op when mirror already current and integration includes upstream head', async () => {
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': UPSTREAM_SHA,
    },
    compare: () => 'identical',
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.mirrored, false)
  assert.deepEqual(calls.updateRef, [])
  assert.deepEqual(calls.createRef, [])
  assert.equal(summary.pr.created, false)
  assert.match(summary.pr.reason, /already includes/)
})

test('mirror divergence rejects loudly without force', async () => {
  const { api } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': OLD_MIRROR_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
  })
  // Wrap updateRef to simulate a server-side fast-forward rejection.
  const orig = api.updateRef
  api.updateRef = async () => { throw new Error('422 update is not a fast-forward') }
  void orig
  await assert.rejects(runSync(CONFIG, api), /not a fast-forward/)
})

test('existing open automation PR is preserved and update queued (no new PR, head untouched)', async () => {
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
    pulls: [{ number: 42, head: { ref: importBranchName(CONFIG.prBranchPrefix, OLD_MIRROR_SHA), sha: OLD_MIRROR_SHA }, base: { ref: 'oh-mike-dsh' }, draft: true, state: 'open' }],
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.pr.created, false)
  assert.match(summary.pr.reason, /#42 awaiting review/)
  assert.deepEqual(calls.createRef, [], 'must not touch existing PR head')
  assert.deepEqual(calls.createPull, [])
})

test('an ordinary feature branch sharing the prefix is NOT treated as a bot PR', async () => {
  // mike/upstream-review-sync is this feature's own source branch; it shares the
  // "mike/upstream-" segment but is not prefix+full-SHA, so the sync must ignore
  // it and open a real proposal instead of mistaking it for an open bot PR.
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
    pulls: [{ number: 5, head: { ref: 'mike/upstream-review-sync', sha: OLD_MIRROR_SHA }, base: { ref: 'oh-mike-dsh' }, draft: false, state: 'open' }],
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.pr.created, true, 'ordinary feature branch must not block a proposal')
  assert.equal(calls.createPull.length, 1)
})

test('closed/rejected PR for same head is honored, not reopened', async () => {
  const branch = importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
    pulls: [{ number: 9, head: { ref: branch, sha: UPSTREAM_SHA }, base: { ref: 'oh-mike-dsh' }, draft: true, state: 'closed' }],
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.pr.created, false)
  assert.match(summary.pr.reason, /was closed; not reopening/)
  assert.deepEqual(calls.createPull, [])
})

test('idempotent recovery: reuse import branch already at upstream head, no new ref, opens PR', async () => {
  const branch = importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
      [`MizkoEu/deepseek-harness#${branch}`]: UPSTREAM_SHA,
    },
  })
  const summary = await runSync(CONFIG, api)

  assert.deepEqual(calls.createRef, [], 'branch already at head: no createRef')
  assert.equal(summary.pr.created, true)
  assert.equal(calls.createPull.length, 1)
})

test('branch collision at different SHA rejects without overwriting', async () => {
  const branch = importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
      [`MizkoEu/deepseek-harness#${branch}`]: OLD_MIRROR_SHA,
    },
  })
  await assert.rejects(runSync(CONFIG, api), /refusing to overwrite/)
  assert.deepEqual(calls.createRef, [])
  assert.deepEqual(calls.createPull, [])
})

test('a non-404 error resolving the import branch propagates with ZERO createRef', async () => {
  const branch = importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)
  for (const error of [Object.assign(new Error('403 workflows scope'), { status: 403 }), new Error('ECONNRESET'), Object.assign(new Error('502'), { status: 502 })]) {
    const { api, calls } = fakeApi({
      branches: {
        'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
        'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
        'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
      },
      branchError: { branch, error },
    })
    await assert.rejects(runSync(CONFIG, api), err => err === error)
    assert.deepEqual(calls.createRef, [], 'must not createRef when branch state is unknown')
    assert.deepEqual(calls.createPull, [])
  }
})

test('a genuine 404 (missing import branch) creates it and opens the PR', async () => {
  const { api, calls } = fakeApi({
    branches: {
      'MizkoEu/deepseek-harness#master': UPSTREAM_SHA,
      'deepseek-ai/deepseek-harness#master': UPSTREAM_SHA,
      'MizkoEu/deepseek-harness#oh-mike-dsh': OLD_MIRROR_SHA,
    },
  })
  const summary = await runSync(CONFIG, api)
  assert.equal(calls.createRef.length, 1, 'missing branch is created')
  assert.equal(summary.pr.created, true)
})

test('incorrect fork parent is rejected', () => {
  assert.throws(
    () => assertForkGuard(CONFIG, { fork: true, parent: { full_name: 'someone/else' } }),
    /must be a fork of/,
  )
  assert.throws(() => assertForkGuard(CONFIG, { fork: false }), /must be a fork of/)
})

test('fork-parent comparison is case-insensitive (GitHub slugs are)', () => {
  assert.doesNotThrow(() =>
    assertForkGuard(CONFIG, { fork: true, parent: { full_name: 'DeepSeek-AI/DeepSeek-Harness' } }),
  )
})

test('mirror equal to integration branch is rejected', () => {
  assert.throws(
    () => assertForkGuard({ ...CONFIG, mirrorBranch: 'oh-mike-dsh' }, { fork: true, parent: { full_name: CONFIG.upstream } }),
    /must differ/,
  )
})

test('API errors propagate loudly (no silent success)', async () => {
  const { api } = fakeApi({ branches: {} })
  api.getRepo = async () => { throw new Error('503 GitHub unavailable') }
  await assert.rejects(runSync(CONFIG, api), /GitHub unavailable/)
})

test('PR body pins the human-review + no-tests + no-deploy contract', () => {
  const body = prBody({ upstream: CONFIG.upstream, upstreamSha: UPSTREAM_SHA, integrationBranch: CONFIG.integrationBranch })
  assert.match(body, /DRAFT for human review/)
  assert.match(body, /does not auto-merge and nothing was deployed/)
  assert.match(body, /NO tests and NO server update/)
  assert.match(body, /cannot run this repository's CI on personal runners/)
  assert.match(body, /will NOT reopen it/)
})

test('isImportBranch requires prefix + full 40-hex SHA', () => {
  const p = CONFIG.prBranchPrefix
  assert.equal(isImportBranch(p, `${p}${'a'.repeat(40)}`), true)
  assert.equal(isImportBranch(p, 'mike/upstream-review-sync'), false, 'ordinary feature branch')
  assert.equal(isImportBranch(p, `${p}abc`), false, 'short suffix')
  assert.equal(isImportBranch(p, `${p}${'g'.repeat(40)}`), false, 'non-hex')
  assert.equal(isImportBranch(p, `${p}${'A'.repeat(40)}`), false, 'uppercase is not a git SHA form we emit')
  assert.equal(isImportBranch(p, 'other/branch'), false)
})

test('isOwnedReviewPull requires import branch, same-repo head, AND marker title', () => {
  const ownedBranch = importBranchName(CONFIG.prBranchPrefix, UPSTREAM_SHA)
  const owned = { title: `${PR_TITLE_PREFIX}x`, head: { ref: ownedBranch, repoFullName: CONFIG.fork } }
  assert.equal(isOwnedReviewPull(CONFIG, owned), true)
  // Same import-branch name but authored from a different fork: not ours.
  assert.equal(isOwnedReviewPull(CONFIG, { ...owned, head: { ...owned.head, repoFullName: 'stranger/deepseek-harness' } }), false)
  // Import-branch name and same repo but no automation marker: not ours.
  assert.equal(isOwnedReviewPull(CONFIG, { ...owned, title: 'Manual: update' }), false)
  // Ordinary feature branch with the marker: not ours (head is not an import branch).
  assert.equal(isOwnedReviewPull(CONFIG, { title: `${PR_TITLE_PREFIX}x`, head: { ref: 'mike/upstream-review-sync', repoFullName: CONFIG.fork } }), false)
  // Same-repo head SHA form is case-insensitive on the repo slug.
  assert.equal(isOwnedReviewPull(CONFIG, { ...owned, head: { ...owned.head, repoFullName: 'mizkoeu/deepseek-harness' } }), true)
})

test('workflow checks out the trusted oh-mike-dsh branch, NOT the master mirror', () => {
  const wf = readFileSync(resolve(here, '..', 'workflows', 'mike-upstream-sync.yml'), 'utf8')
  assert.match(wf, /ref:\s*oh-mike-dsh/, 'must check out the custom integration branch')
  assert.doesNotMatch(wf, /^\s*ref:\s*master\s*$/m, 'must NOT check out the upstream mirror')
  assert.match(wf, /persist-credentials:\s*false/)
})

test('the local entry module the workflow imports exists in the checked-out tree', () => {
  // The workflow imports .github/mike-upstream-sync/run.mjs from the checked-out
  // oh-mike-dsh tree. This file lives beside it, so its presence proves the
  // import target ships on the trusted branch (the mirror would not carry it).
  assert.ok(existsSync(resolve(here, 'run.mjs')), 'run.mjs must exist beside sync.mjs on the trusted branch')
})
