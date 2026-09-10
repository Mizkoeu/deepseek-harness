// Runtime entry for the upstream-sync workflow. Adapts the actions/github-script
// Octokit client to the injectable SyncApi in sync.mjs and runs one cycle.
//
// This file performs NO logic decisions: it only maps REST calls to the SyncApi
// surface and logs the structured summary. All policy lives in sync.mjs so it is
// unit-testable with a fake API. The workflow passes the authenticated `github`
// Octokit and `core` logger from actions/github-script.

import { runSync } from './sync.mjs'

/** Fixed automation configuration. Repos and branches are constants, not secrets. */
export const CONFIG = {
  fork: 'MizkoEu/deepseek-harness',
  upstream: 'deepseek-ai/deepseek-harness',
  integrationBranch: 'oh-mike-dsh',
  mirrorBranch: 'master',
  prBranchPrefix: 'mike/upstream-',
}

/** Split "owner/name" into Octokit's { owner, repo } arguments. */
function split(repo) {
  const [owner, name] = repo.split('/')
  return { owner, repo: name }
}

/**
 * Build the SyncApi from an Octokit client.
 * @param {import('@octokit/rest').Octokit} github
 * @returns {import('./sync.mjs').SyncApi}
 */
export function octokitApi(github) {
  return {
    async getRepo(repo) {
      const { data } = await github.rest.repos.get(split(repo))
      return { fork: data.fork, parent: data.parent ? { full_name: data.parent.full_name } : undefined, default_branch: data.default_branch }
    },
    async getBranchSha(repo, branch) {
      const { data } = await github.rest.git.getRef({ ...split(repo), ref: `heads/${branch}` })
      return data.object.sha
    },
    async updateRef(repo, ref, sha) {
      await github.rest.git.updateRef({ ...split(repo), ref, sha, force: false })
    },
    async createRef(repo, ref, sha) {
      await github.rest.git.createRef({ ...split(repo), ref, sha })
    },
    async compare(repo, base, head) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...split(repo), basehead: `${base}...${head}` })
      return data.status
    },
    async listPulls(repo, opts) {
      const { data } = await github.rest.pulls.list({ ...split(repo), base: opts.base, state: opts.state, head: opts.head })
      return data.map(pull => ({ number: pull.number, head: { ref: pull.head.ref, sha: pull.head.sha }, base: { ref: pull.base.ref }, draft: pull.draft }))
    },
    async createPull(repo, opts) {
      const { data } = await github.rest.pulls.create({ ...split(repo), title: opts.title, head: opts.head, base: opts.base, body: opts.body, draft: opts.draft })
      return { number: data.number }
    },
  }
}

/**
 * actions/github-script entry. Runs the sync and logs a structured summary.
 * @param {{ github: import('@octokit/rest').Octokit, core: { info: (m: string) => void } }} ctx
 */
export async function main({ github, core }) {
  const summary = await runSync(CONFIG, octokitApi(github))
  core.info(`upstream head: ${summary.upstreamSha}`)
  core.info(`mirror advanced: ${summary.mirrored}`)
  core.info(`review PR: ${summary.pr.reason}${summary.pr.number ? ` (#${summary.pr.number})` : ''}`)
}
