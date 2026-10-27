import { describe, expect, it } from 'vitest'
import { has_verified_pr, verified_jobs } from './reuse-pr-checks.mjs'

const tree = 'a'.repeat(40)
const sha = 'b'.repeat(40)
const head = 'c'.repeat(40)
const names = ['check', 'migrations', 'mqtt', 'browser (1/3)', 'browser (2/3)', 'browser (3/3)', `verified-tree-${tree}`]
const jobs = names.map(name => ({ name, status: 'completed', conclusion: 'success' }))

function api_with(overrides: { pull?: object, run?: object, jobs?: object[] } = {}) {
  return async (path: string) => {
    if (path.includes('/commits/'))
      return [{ merged_at: '2026-01-01', merge_commit_sha: sha, base: { ref: 'main' }, head: { sha: head }, ... overrides.pull }]
    if (path.includes('/workflows/'))
      return { workflow_runs: [{ id: 1, event: 'pull_request', head_sha: head, status: 'completed', conclusion: 'success', ... overrides.run }] }
    return { jobs: overrides.jobs ?? jobs }
  }
}

describe('reusing PR checks on main', () => {
  it('accepts a merged PR whose successful checks verified the exact tree', async () => {
    expect(await has_verified_pr({ api: api_with(), repository: 'owner/repo', sha, tree })).toBe(true)
  })

  it.each(['check', 'migrations', 'mqtt', 'browser (1/3)', 'browser (2/3)', 'browser (3/3)', `verified-tree-${tree}`])('requires a successful %s job', (name) => {
    expect(verified_jobs(jobs.filter(job => job.name !== name), tree)).toBe(false)
    expect(verified_jobs(jobs.map(job => job.name === name ? { ... job, conclusion: 'skipped' } : job), tree)).toBe(false)
  })

  it('rejects a successful run for a different tree', () => {
    expect(verified_jobs(jobs, 'd'.repeat(40))).toBe(false)
  })

  it('accepts a fixed verification job only when its tree step succeeded', () => {
    const fixed_job = { name: 'verified-tree', status: 'completed', conclusion: 'success', steps: [{ name: `verified-tree-${tree}`, status: 'completed', conclusion: 'success' }] }
    const fixed_jobs = [... jobs.slice(0, - 1), fixed_job]
    expect(verified_jobs(fixed_jobs, tree)).toBe(true)
    expect(verified_jobs(fixed_jobs, 'd'.repeat(40))).toBe(false)
    expect(verified_jobs([... jobs.slice(0, - 1), { ... fixed_job, conclusion: 'failure' }], tree)).toBe(false)
    expect(verified_jobs([... jobs.slice(0, - 1), { ... fixed_job, steps: [] }], tree)).toBe(false)
    expect(verified_jobs([... jobs.slice(0, - 1), { ... fixed_job, steps: [{ ... fixed_job.steps[0]!, conclusion: 'skipped' }] }], tree)).toBe(false)
  })

  it('does not reuse checks when the GitHub API fails', async () => {
    const api = async () => {
      throw new Error('network unavailable')
    }
    expect(await has_verified_pr({ api, repository: 'owner/repo', sha, tree })).toBe(false)
  })

  it.each([
    { pull: { merge_commit_sha: 'd'.repeat(40) } },
    { pull: { merged_at: null } },
    { pull: { base: { ref: 'other' } } },
    { run: { head_sha: 'd'.repeat(40) } },
    { run: { event: 'push' } },
    { run: { conclusion: 'failure' } },
    { jobs: jobs.filter(job => job.name !== 'mqtt') },
  ])('does not reuse unrelated or incomplete checks %#', async (overrides) => {
    expect(await has_verified_pr({ api: api_with(overrides), repository: 'owner/repo', sha, tree })).toBe(false)
  })
})
