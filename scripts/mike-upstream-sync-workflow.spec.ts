import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('mike upstream review sync workflow', () => {
  it('runs daily and on demand, guarded to the fork, with a single queued run', () => {
    const workflow = loadWorkflow('.github/workflows/mike-upstream-sync.yml')
    if (!isRecord(workflow.on) || !isRecord(workflow.jobs) || !isRecord(workflow.jobs.sync)) {
      throw new TypeError('sync workflow must define on-triggers and the sync job')
    }

    expect(workflow.on.schedule).toEqual([{ cron: '17 5 * * *' }])
    // workflow_dispatch is present with no inputs (null in YAML).
    expect(Object.keys(workflow.on)).toContain('workflow_dispatch')
    expect(workflow.concurrency).toEqual({ group: 'mike-upstream-review-sync', 'cancel-in-progress': false })
    expect(workflow.jobs.sync.if).toBe("github.repository == 'MizkoEu/deepseek-harness'")
    expect(workflow.jobs.sync['runs-on']).toBe('ubuntu-latest')
  })

  it('requests only contents:write and pull-requests:write', () => {
    const workflow = loadWorkflow('.github/workflows/mike-upstream-sync.yml')
    expect(workflow.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' })
  })

  it('checks out only the trusted mirror branch without persisting credentials', () => {
    const workflow = loadWorkflow('.github/workflows/mike-upstream-sync.yml')
    const steps = jobSteps(workflow, 'sync')
    const checkout = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'))
    if (!isRecord(checkout) || !isRecord(checkout.with)) throw new TypeError('checkout step must define with')
    expect(checkout.with).toMatchObject({ ref: 'master', 'persist-credentials': false })
  })

  it('runs the sync through the unit-tested run.mjs entry, executing no fetched upstream code', () => {
    const workflow = loadWorkflow('.github/workflows/mike-upstream-sync.yml')
    const steps = jobSteps(workflow, 'sync')
    const script = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('actions/github-script@'))
    if (!isRecord(script) || !isRecord(script.with) || typeof script.with.script !== 'string') {
      throw new TypeError('sync step must use actions/github-script with an inline script')
    }
    expect(script.with.script).toContain('.github/mike-upstream-sync/run.mjs')
    expect(script.with.script).toContain('main({ github, core })')
    // No install/build/checkout of fetched upstream code with the write token.
    const runSteps = steps.filter(step => typeof step.run === 'string')
    expect(runSteps).toHaveLength(0)
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function jobSteps(workflow: Record<string, unknown>, job: string): Array<Record<string, unknown>> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job]) || !Array.isArray(workflow.jobs[job].steps)) {
    throw new TypeError(`workflow must define the ${job} job steps`)
  }
  return workflow.jobs[job].steps.filter(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
