// Unit and integration tests for the session-start upstream freshness check.
//
// The pure policy runs against a fake FreshnessEnv: a scripted command table, an
// injected clock, and in-memory state, so freshness, parsing, source resolution,
// classification, and atomic-write ordering are exercised with no network. A
// second layer builds temporary real git repositories and drives the real helper
// functions against a local named remote to prove the fetch imports the observed
// object only (no branch, remote-tracking ref, HEAD, or worktree change) and that
// classification against the oh-mike-dsh integration ref is correct — still with
// no network, using a local file path or named remote as the upstream.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import {
  classify,
  fetchUpstreamHead,
  findUpstreamRemote,
  formatResult,
  FRESH_WINDOW_MS,
  INTEGRATION_REF,
  isFresh,
  parseState,
  remoteSlug,
  resolveFetchSource,
  runFreshnessCheck,
  STATE_BASENAME,
  UPSTREAM_SLUG,
  UPSTREAM_URL,
} from './freshness.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const NOW = Date.parse('2026-09-10T00:00:00.000Z')

/**
 * Build a fake FreshnessEnv. `commands` maps a joined-argv prefix to a handler
 * returning `{ stdout }` or throwing an Error (optionally carrying `.code`).
 */
function fakeEnv({ commands = {}, files = {}, now = NOW } = {}) {
  const writes = []
  const store = { ...files }
  const env = {
    async git(args) {
      const handler = commands[args.join(' ')] ?? commands[matchPrefix(commands, args)]
      if (!handler) throw new Error(`unexpected git ${args.join(' ')}`)
      return handler(args)
    },
    now: () => now,
    async readFile(path) {
      return path in store ? store[path] : null
    },
    async writeFileAtomic(path, contents) {
      writes.push({ path, contents })
      store[path] = contents
    },
    joinPath: (dir, name) => `${dir}/${name}`,
  }
  return { env, writes, store }
}

/** Find a registered command key that is a prefix of the actual argv. */
function matchPrefix(commands, args) {
  const joined = args.join(' ')
  for (const key of Object.keys(commands)) {
    if (joined.startsWith(`${key} `)) return key
  }
  return joined
}

/**
 * Answer `git merge-base --is-ancestor <a> <b>` from an `${a}->${b}` set: exit 0
 * when the pair is present, else exit 1 (a normal "not an ancestor" answer).
 */
function isAncestorOracle(args, truthyPairs) {
  if (truthyPairs.has(`${args[2]}->${args[3]}`)) return { stdout: '' }
  const err = new Error('not an ancestor')
  err.code = 1
  throw err
}

/** Build a valid stamp string for the fixed upstream. */
function stampJson({ upstream = UPSTREAM_SLUG, checkedAtUtc, sha = SHA_A, branch = 'main' } = {}) {
  return JSON.stringify({ upstream, checkedAtUtc, observedDefaultBranch: branch, observedSha: sha })
}

test('parseState rejects absent, malformed, wrong-upstream, and bad-field stamps', () => {
  assert.equal(parseState(null), null)
  assert.equal(parseState('{ not json'), null)
  assert.equal(parseState(stampJson({ upstream: 'someone/else', checkedAtUtc: '2026-09-01T00:00:00Z' })), null)
  assert.equal(parseState(stampJson({ checkedAtUtc: 'not-a-date' })), null)
  assert.equal(parseState(stampJson({ checkedAtUtc: '2026-09-01T00:00:00Z', sha: 'short' })), null)
  const ok = parseState(stampJson({ checkedAtUtc: '2026-09-01T00:00:00Z' }))
  assert.equal(ok.observedSha, SHA_A)
})

test('isFresh: in-window fresh, stale beyond window, missing stale, future stale', () => {
  const recent = { upstream: UPSTREAM_SLUG, checkedAtUtc: new Date(NOW - 1000).toISOString(), observedDefaultBranch: 'main', observedSha: SHA_A }
  const old = { ...recent, checkedAtUtc: new Date(NOW - FRESH_WINDOW_MS - 1000).toISOString() }
  const future = { ...recent, checkedAtUtc: new Date(NOW + 60_000).toISOString() }
  assert.equal(isFresh(recent, NOW), true)
  assert.equal(isFresh(old, NOW), false)
  assert.equal(isFresh(null, NOW), false)
  assert.equal(isFresh(future, NOW), false, 'a future timestamp must not be treated as fresh')
})

test('remoteSlug normalizes ssh, https, and .git variants', () => {
  assert.equal(remoteSlug('https://github.com/deepseek-ai/deepseek-harness.git'), UPSTREAM_SLUG)
  assert.equal(remoteSlug('git@github.com:deepseek-ai/deepseek-harness.git'), UPSTREAM_SLUG)
  assert.equal(remoteSlug('https://github.com/deepseek-ai/deepseek-harness'), UPSTREAM_SLUG)
})

test('findUpstreamRemote matches upstream by canonical slug, ignores the fork', () => {
  const verbose = [
    'origin\tgit@github.com:MizkoEu/deepseek-harness.git (fetch)',
    'origin\tgit@github.com:MizkoEu/deepseek-harness.git (push)',
    'ds\thttps://github.com/deepseek-ai/deepseek-harness.git (fetch)',
    'ds\thttps://github.com/deepseek-ai/deepseek-harness.git (push)',
  ].join('\n')
  assert.equal(findUpstreamRemote(verbose), 'ds')
})

test('resolveFetchSource falls back to the fixed URL when no remote matches (fork clone)', async () => {
  const { env } = fakeEnv({
    commands: { 'remote -v': () => ({ stdout: 'origin\tgit@github.com:MizkoEu/deepseek-harness.git (fetch)\n' }) },
  })
  assert.equal(await resolveFetchSource(env), UPSTREAM_URL)
})

// ---------------------------------------------------------------------------
// fetchUpstreamHead: pin the SHA from the symref view, fetch that exact SHA.
// ---------------------------------------------------------------------------

test('fetchUpstreamHead pins the SHA from ls-remote --symref and fetches THAT sha, never a branch', async () => {
  const fetches = []
  const { env } = fakeEnv({
    commands: {
      'ls-remote --symref': () => ({ stdout: `ref: refs/heads/main\tHEAD\n${SHA_B}\tHEAD\n` }),
      'fetch': args => { fetches.push(args.slice(1)); return { stdout: '' } },
      'cat-file -e': () => ({ stdout: '' }),
    },
  })
  const result = await fetchUpstreamHead(env, 'somesource')
  assert.deepEqual(result, { defaultBranch: 'main', sha: SHA_B })
  // The fetch refspec is the exact SHA, not the branch name — so a head that
  // moves after discovery cannot import a different, unobserved commit, and no
  // remote-tracking ref like origin/main can advance.
  assert.deepEqual(fetches, [['--no-tags', 'somesource', SHA_B]])
  assert.ok(!fetches[0].includes('main'), 'must never fetch by branch name')
})

test('fetchUpstreamHead rejects when the pinned object is not present after fetch', async () => {
  const { env } = fakeEnv({
    commands: {
      'ls-remote --symref': () => ({ stdout: `ref: refs/heads/main\tHEAD\n${SHA_B}\tHEAD\n` }),
      'fetch': () => ({ stdout: '' }),
      'cat-file -e': () => { const e = new Error('missing'); e.code = 1; throw e },
    },
  })
  await assert.rejects(fetchUpstreamHead(env, 'somesource'))
})

// ---------------------------------------------------------------------------
// classify: target the integration ref; ordinary fork divergence = updates.
// ---------------------------------------------------------------------------

test('classify targets the oh-mike-dsh integration ref, never HEAD', async () => {
  const seen = []
  const { env } = fakeEnv({
    commands: {
      'merge-base --is-ancestor': args => { seen.push(args); return isAncestorOracle(args, new Set([`${SHA_B}->${INTEGRATION_REF}`])) },
    },
  })
  const status = await classify(env, SHA_B)
  assert.equal(status, 'up-to-date')
  assert.equal(seen[0][3], INTEGRATION_REF, 'ancestry is checked against refs/heads/oh-mike-dsh')
})

test('classify: ordinary fork divergence (shared merge base) is updates-available, not migration', async () => {
  const { env } = fakeEnv({
    commands: {
      // observed is NOT an ancestor of oh-mike-dsh (local has custom commits)...
      'merge-base --is-ancestor': args => isAncestorOracle(args, new Set()),
      // ...but they DO share a common base: normal fork state with new upstream.
      'merge-base': () => ({ stdout: 'c'.repeat(40) + '\n' }),
    },
  })
  assert.equal(await classify(env, SHA_B), 'updates-available')
})

test('classify: no common ancestor is history-diverged (migration)', async () => {
  const { env } = fakeEnv({
    commands: {
      'merge-base --is-ancestor': args => isAncestorOracle(args, new Set()),
      'merge-base': () => { const e = new Error('no merge base'); e.code = 1; throw e },
    },
  })
  assert.equal(await classify(env, SHA_B), 'history-diverged')
})

test('classify: a merge-base error other than exit 1 propagates', async () => {
  const { env } = fakeEnv({
    commands: {
      'merge-base --is-ancestor': args => isAncestorOracle(args, new Set()),
      'merge-base': () => { const e = new Error('bad object'); e.code = 128; throw e },
    },
  })
  await assert.rejects(classify(env, SHA_B))
})

// ---------------------------------------------------------------------------
// runFreshnessCheck: query and cache paths.
// ---------------------------------------------------------------------------

/** Command table for a query where the observed head is up-to-date on oh-mike-dsh. */
function upToDateQueryCommands() {
  return {
    'remote -v': () => ({ stdout: '' }),
    'ls-remote --symref': () => ({ stdout: `ref: refs/heads/main\tHEAD\n${SHA_B}\tHEAD\n` }),
    'fetch': () => ({ stdout: '' }),
    'cat-file -e': () => ({ stdout: '' }),
    'merge-base --is-ancestor': args => isAncestorOracle(args, new Set([`${SHA_B}->${INTEGRATION_REF}`])),
  }
}

test('recent successful stamp skips the network and recomputes ancestry offline against oh-mike-dsh', async () => {
  const statePath = `/common/${STATE_BASENAME}`
  const { env, writes } = fakeEnv({
    files: { [statePath]: stampJson({ checkedAtUtc: new Date(NOW - 1000).toISOString(), sha: SHA_B }) },
    commands: {
      'remote -v': () => { throw new Error('network must not be touched') },
      'ls-remote': () => { throw new Error('network must not be touched') },
      'fetch': () => { throw new Error('network must not be touched') },
      'cat-file -e': () => ({ stdout: '' }),
      'merge-base --is-ancestor': args => isAncestorOracle(args, new Set([`${SHA_B}->${INTEGRATION_REF}`])),
    },
  })
  const result = await runFreshnessCheck(env, '/common')
  assert.equal(result.queried, false)
  assert.equal(result.status, 'up-to-date')
  assert.equal(writes.length, 0, 'a skipped check advances no stamp')
})

test('a fresh cache reflects oh-mike-dsh being behind the observed head: updates-available', async () => {
  const statePath = `/common/${STATE_BASENAME}`
  const { env, writes } = fakeEnv({
    files: { [statePath]: stampJson({ checkedAtUtc: new Date(NOW - 1000).toISOString(), sha: SHA_B }) },
    commands: {
      'remote -v': () => { throw new Error('network must not be touched') },
      'cat-file -e': () => ({ stdout: '' }),
      // observed not an ancestor of oh-mike-dsh, but they share a base.
      'merge-base --is-ancestor': args => isAncestorOracle(args, new Set()),
      'merge-base': () => ({ stdout: 'c'.repeat(40) + '\n' }),
    },
  })
  const result = await runFreshnessCheck(env, '/common')
  assert.equal(result.queried, false)
  assert.equal(result.status, 'updates-available')
  assert.equal(writes.length, 0)
})

test('a fresh cache whose observed object is absent locally reports only the observation', async () => {
  const statePath = `/common/${STATE_BASENAME}`
  const { env, writes } = fakeEnv({
    files: { [statePath]: stampJson({ checkedAtUtc: new Date(NOW - 1000).toISOString(), sha: SHA_B }) },
    commands: {
      'remote -v': () => { throw new Error('network must not be touched') },
      'cat-file -e': () => { const e = new Error('missing object'); e.code = 1; throw e },
      'merge-base': () => { throw new Error('must not classify against an absent object') },
    },
  })
  const result = await runFreshnessCheck(env, '/common')
  assert.equal(result.queried, false)
  assert.equal(result.status, null)
  assert.match(result.message, /last observed/)
  assert.equal(writes.length, 0)
})

test('--now forces a query even when fresh, and advances the stamp atomically', async () => {
  const statePath = `/common/${STATE_BASENAME}`
  const { env, writes } = fakeEnv({
    files: { [statePath]: stampJson({ checkedAtUtc: new Date(NOW - 1000).toISOString() }) },
    commands: upToDateQueryCommands(),
  })
  const result = await runFreshnessCheck(env, '/common', { force: true })
  assert.equal(result.queried, true)
  assert.equal(result.status, 'up-to-date')
  assert.equal(writes.length, 1)
  const written = JSON.parse(writes[0].contents)
  assert.equal(written.upstream, UPSTREAM_SLUG)
  assert.equal(written.observedSha, SHA_B)
  assert.equal(written.observedDefaultBranch, 'main')
})

test('missing stamp queries and stores; failed fetch leaves no stamp', async () => {
  const missing = fakeEnv({ commands: upToDateQueryCommands() })
  assert.equal((await runFreshnessCheck(missing.env, '/common')).queried, true)
  assert.equal(missing.writes.length, 1)

  const failing = fakeEnv({
    commands: {
      'remote -v': () => ({ stdout: '' }),
      'ls-remote --symref': () => ({ stdout: `ref: refs/heads/main\tHEAD\n${SHA_B}\tHEAD\n` }),
      'fetch': () => { throw new Error('fetch failed: offline') },
    },
  })
  await assert.rejects(runFreshnessCheck(failing.env, '/common'))
  assert.equal(failing.writes.length, 0, 'a failed fetch must not advance the stamp')
})

test('a future stamp and a wrong-upstream stamp both force a re-query', async () => {
  const statePath = `/common/${STATE_BASENAME}`
  const future = fakeEnv({
    files: { [statePath]: stampJson({ checkedAtUtc: new Date(NOW + 3_600_000).toISOString() }) },
    commands: upToDateQueryCommands(),
  })
  assert.equal((await runFreshnessCheck(future.env, '/common')).queried, true)

  const wrong = fakeEnv({
    files: { [statePath]: stampJson({ upstream: 'someone/else', checkedAtUtc: new Date(NOW - 1000).toISOString() }) },
    commands: upToDateQueryCommands(),
  })
  assert.equal((await runFreshnessCheck(wrong.env, '/common')).queried, true)
})

test('formatResult gives a bounded manual-review line per status', () => {
  assert.match(formatResult('up-to-date', SHA_A), /up-to-date/)
  assert.match(formatResult('updates-available', SHA_A), /review and integrate/)
  assert.match(formatResult('history-diverged', SHA_A), /no common ancestor.*never merge automatically/)
})

// ---------------------------------------------------------------------------
// Real-git integration: drive the actual helper functions, no network.
// ---------------------------------------------------------------------------

/** Run git in `cwd`, returning trimmed stdout; throws on non-zero exit. */
function rgit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content)
  spawnSync('git', ['add', file], { cwd, env: { ...process.env, ...GIT_ENV } })
  spawnSync('git', ['commit', '-m', message], { cwd, env: { ...process.env, ...GIT_ENV } })
  return rgit(cwd, ['rev-parse', 'HEAD'])
}

/** A real env over a git checkout at `cwd`, with in-memory state files. */
function realEnv(cwd, store = {}, now = NOW) {
  const writes = []
  const env = {
    async git(args) {
      const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
      if (res.status !== 0) {
        const err = new Error(`git ${args.join(' ')} -> ${res.status}: ${res.stderr}`)
        err.code = res.status
        throw err
      }
      return { stdout: res.stdout }
    },
    now: () => now,
    async readFile(path) { return path in store ? store[path] : null },
    async writeFileAtomic(path, contents) { writes.push({ path, contents }); store[path] = contents },
    joinPath: (dir, name) => `${dir}/${name}`,
  }
  return { env, writes, store }
}

/** Enable fetching an arbitrary reachable SHA from a local upstream, as GitHub allows. */
function allowShaFetch(repoPath) {
  spawnSync('git', ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: repoPath })
  spawnSync('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: repoPath })
}

test('fetchUpstreamHead imports the observed object via a real named remote, changing no ref/HEAD/worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-fetch-'))
  try {
    const upstream = join(dir, 'upstream')
    const local = join(dir, 'local')
    execFileSync('git', ['init', '-q', '-b', 'main', upstream])
    allowShaFetch(upstream)
    commit(upstream, 'f', 'v1\n', 'base')
    // Clone, then advance BOTH the local's origin/main tracking AND upstream so
    // origin/main is stale relative to the true upstream head.
    execFileSync('git', ['clone', '-q', upstream, local])
    allowShaFetch(local)
    const originMainBefore = rgit(local, ['rev-parse', 'refs/remotes/origin/main'])
    const ahead = commit(upstream, 'f', 'v2\n', 'ahead')

    const refsBefore = rgit(local, ['for-each-ref', '--format=%(refname) %(objectname)'])
    const worktreeBefore = readFileSync(join(local, 'f'), 'utf8')
    const headBefore = rgit(local, ['rev-parse', 'HEAD'])

    const { env } = realEnv(local)
    const result = await fetchUpstreamHead(env, 'origin')

    assert.equal(result.defaultBranch, 'main')
    assert.equal(result.sha, ahead, 'the observed SHA is the upstream head captured from ls-remote --symref')
    assert.equal(rgit(local, ['cat-file', '-t', ahead]), 'commit', 'the observed object was imported')
    assert.equal(rgit(local, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore, 'no ref may move')
    assert.equal(rgit(local, ['rev-parse', 'refs/remotes/origin/main']), originMainBefore, 'origin/main must NOT advance')
    assert.equal(readFileSync(join(local, 'f'), 'utf8'), worktreeBefore, 'no worktree file may change')
    assert.equal(rgit(local, ['rev-parse', 'HEAD']), headBefore, 'HEAD must not move')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('query/fetch race: the SHA fetched is the one observed, even if upstream advances after fetch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-race-'))
  try {
    const upstream = join(dir, 'upstream')
    const local = join(dir, 'local')
    execFileSync('git', ['init', '-q', '-b', 'main', upstream])
    allowShaFetch(upstream)
    const base = commit(upstream, 'f', 'v1\n', 'base')
    execFileSync('git', ['clone', '-q', upstream, local])
    allowShaFetch(local)

    // Wrap git so that immediately AFTER the fetch completes, upstream advances
    // to a new head. A branch-refspec implementation would then have imported a
    // moving target or a SHA it never verified; pinning the observed SHA must
    // still return and import exactly `base`.
    const base0 = realEnv(local).env
    let fetched = false
    const env = {
      ...base0,
      async git(args) {
        const out = await base0.git(args)
        if (args[0] === 'fetch' && !fetched) {
          fetched = true
          commit(upstream, 'f', 'v2\n', 'moved-after-fetch')
        }
        return out
      },
    }
    const result = await fetchUpstreamHead(env, 'origin')
    assert.equal(result.sha, base, 'observed and imported SHA is the head seen at discovery, not the moved head')
    assert.equal(rgit(local, ['cat-file', '-t', base]), 'commit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classify against oh-mike-dsh: feature HEAD ahead while oh-mike-dsh is behind reports updates-available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-oh-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'oh-mike-dsh', repo])
    const c1 = commit(repo, 'f', '1\n', 'c1')
    const c2 = commit(repo, 'f', '2\n', 'c2 (observed upstream head)')
    const c3 = commit(repo, 'f', '3\n', 'c3 (feature ahead of observed)')
    // Move off oh-mike-dsh first (git refuses to force the checked-out branch),
    // then leave oh-mike-dsh behind at c1 while HEAD sits on a feature at c3.
    spawnSync('git', ['checkout', '-q', '-b', 'mike/feature', c3], { cwd: repo, env: { ...process.env, ...GIT_ENV } })
    spawnSync('git', ['branch', '-f', 'oh-mike-dsh', c1], { cwd: repo, env: { ...process.env, ...GIT_ENV } })

    const { env } = realEnv(repo)
    assert.equal(rgit(repo, ['rev-parse', 'HEAD']), c3, 'HEAD is on the ahead feature branch')
    assert.equal(rgit(repo, ['rev-parse', 'oh-mike-dsh']), c1, 'oh-mike-dsh is behind at c1')
    assert.equal(await classify(env, c2), 'updates-available', 'oh-mike-dsh at c1 is behind observed c2')

    // Advance oh-mike-dsh to include the observed head -> up-to-date.
    spawnSync('git', ['branch', '-f', 'oh-mike-dsh', c2], { cwd: repo, env: { ...process.env, ...GIT_ENV } })
    assert.equal(await classify(env, c2), 'up-to-date', 'oh-mike-dsh advanced to observed head')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classify: shared-merge-base fork (custom commits + upstream commits) is updates-available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-fork-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'oh-mike-dsh', repo])
    const base = commit(repo, 'shared', 'base\n', 'shared base')
    // oh-mike-dsh has a custom commit on top of the shared base.
    commit(repo, 'custom', 'mine\n', 'custom commit')
    // The observed upstream head is a DIFFERENT commit off the same base.
    spawnSync('git', ['checkout', '-q', '-b', 'up', base], { cwd: repo, env: { ...process.env, ...GIT_ENV } })
    const upHead = commit(repo, 'upfile', 'new\n', 'upstream new commit')
    spawnSync('git', ['checkout', '-q', 'oh-mike-dsh'], { cwd: repo, env: { ...process.env, ...GIT_ENV } })

    const { env } = realEnv(repo)
    assert.equal(await classify(env, upHead), 'updates-available', 'shared base + divergence is normal, not migration')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('classify: unrelated history with no common ancestor is history-diverged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-unrelated-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'oh-mike-dsh', repo])
    commit(repo, 'f', '1\n', 'oh commit')
    const other = join(dir, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    allowShaFetch(other)
    const o1 = commit(other, 'g', 'x\n', 'unrelated root')
    spawnSync('git', ['fetch', '--no-tags', pathToFileURL(other).href, o1], { cwd: repo, env: { ...process.env, ...GIT_ENV } })

    const { env } = realEnv(repo)
    assert.equal(await classify(env, o1), 'history-diverged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runFreshnessCheck end-to-end against a real named remote writes the observed stamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-e2e-'))
  try {
    // Name the upstream directory so its path URL's canonical slug is exactly
    // deepseek-ai/deepseek-harness; the resolver then selects this local remote
    // instead of falling back to the public URL, keeping the test offline.
    const owner = join(dir, 'deepseek-ai')
    const upstream = join(owner, 'deepseek-harness')
    const local = join(dir, 'local')
    execFileSync('git', ['init', '-q', '-b', 'main', upstream])
    allowShaFetch(upstream)
    const u1 = commit(upstream, 'f', '1\n', 'u1')
    execFileSync('git', ['clone', '-q', '-b', 'main', upstream, local])
    // origin's URL slug is deepseek-ai/deepseek-harness, so it is resolved as upstream.
    assert.equal(remoteSlug(rgit(local, ['remote', 'get-url', 'origin'])), UPSTREAM_SLUG)
    spawnSync('git', ['branch', 'oh-mike-dsh', u1], { cwd: local, env: { ...process.env, ...GIT_ENV } })
    allowShaFetch(local)
    const commonDir = rgit(local, ['rev-parse', '--git-common-dir'])
    const statePath = `${commonDir}/${STATE_BASENAME}`

    const { env, writes } = realEnv(local, {})
    const result = await runFreshnessCheck(env, commonDir, { force: true })
    assert.equal(result.queried, true)
    assert.equal(result.observedSha, u1)
    assert.equal(result.status, 'up-to-date')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, statePath)
    const written = JSON.parse(writes[0].contents)
    assert.equal(written.observedSha, u1)
    assert.equal(written.observedDefaultBranch, 'main')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('state is written to the git common directory shared across worktrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-common-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    commit(repo, 'f', '1\n', 'c1')
    const commonDir = rgit(repo, ['rev-parse', '--git-common-dir'])
    assert.ok(commonDir.length > 0)
    const entries = readdirSync(repo)
    assert.ok(!entries.includes(STATE_BASENAME), 'state must not sit in the versioned worktree root')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
