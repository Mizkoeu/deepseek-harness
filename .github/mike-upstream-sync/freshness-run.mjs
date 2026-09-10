// CLI entry for the session-start upstream freshness check. Wires the pure
// policy in freshness.mjs to real git, filesystem, and clock, then prints one
// bounded result line. Exit is always 0 for a read-only check outcome; a genuine
// environment failure (git or fs error) rejects and exits non-zero.
//
// Usage: node .github/mike-upstream-sync/freshness-run.mjs [--now]
//   --now  Force a query regardless of the last successful check's freshness.
//
// This entry performs no merge, push, ref update on a checked-out branch, or PR
// mutation, and reads no GitHub token. Missing `gh` is irrelevant: the check is
// pure git against the public upstream.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runFreshnessCheck } from './freshness.mjs'

/**
 * Run a git command in the current working directory.
 * @param {string[]} args
 * @returns {Promise<{ stdout: string }>} Resolves with stdout on exit 0; rejects with an Error carrying `.code` otherwise.
 */
function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve({ stdout })
      const err = new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)
      err.code = code
      reject(err)
    })
  })
}

/** Read a UTF-8 file, or null when it does not exist. */
async function readFileOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

/** Write a file atomically via a same-directory temp file and rename. */
async function writeFileAtomic(path, contents) {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(tmp, contents, 'utf8')
  await rename(tmp, path)
}

/** @type {import('./freshness.mjs').FreshnessEnv} */
const env = {
  git,
  now: () => Date.now(),
  readFile: readFileOrNull,
  writeFileAtomic,
  joinPath: join,
}

async function main() {
  const force = process.argv.includes('--now')
  const { stdout } = await git(['rev-parse', '--git-common-dir'])
  const commonDir = stdout.trim()
  const result = await runFreshnessCheck(env, commonDir, { force })
  // Both the cached-skip and queried paths carry a bounded message; the cached
  // path recomputed ancestry against the current local HEAD with no network.
  console.log(result.message)
}

main().catch(err => {
  console.error(`upstream freshness check failed: ${err.message}`)
  process.exitCode = 1
})
