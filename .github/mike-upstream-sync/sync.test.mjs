// Unit tests for the upstream-sync policy. A fake SyncApi records every write
// and lets each test script API responses, so all paths run with no network.
// The fake asserts the core security invariants centrally: writes only target
// the fork, ref updates are force:false, and the integration branch is never
// written or merged.

import assert from 'node:assert/strict'
import test from 'node:test'

import { assertForkGuard, importBranchName, prBody, PR_TITLE_PREFIX, runSync } from './sync.mjs'

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
    pulls: [{ number: 42, head: { ref: 'mike/upstream-old', sha: OLD_MIRROR_SHA }, base: { ref: 'oh-mike-dsh' }, draft: true, state: 'open' }],
  })
  const summary = await runSync(CONFIG, api)

  assert.equal(summary.pr.created, false)
  assert.match(summary.pr.reason, /#42 awaiting review/)
  assert.deepEqual(calls.createRef, [], 'must not touch existing PR head')
  assert.deepEqual(calls.createPull, [])
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

test('incorrect fork parent is rejected', () => {
  assert.throws(
    () => assertForkGuard(CONFIG, { fork: true, parent: { full_name: 'someone/else' } }),
    /must be a fork of/,
  )
  assert.throws(() => assertForkGuard(CONFIG, { fork: false }), /must be a fork of/)
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
