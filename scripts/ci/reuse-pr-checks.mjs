import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const required_jobs = ['check', 'migrations', 'mqtt', 'browser (1/3)', 'browser (2/3)', 'browser (3/3)', 'browser-css']

// A successful workflow alone is insufficient: skipped jobs also yield success.
export function verified_jobs(jobs, tree) {
  const successful = item => item.status === 'completed' && item.conclusion === 'success'
  if (! required_jobs.every(name => jobs.some(job => job.name === name && successful(job))))
    return false
  return jobs.some(job => successful(job) && (
    job.name === `verified-tree-${tree}`
    || (job.name === 'verified-tree' && Array.isArray(job.steps)
      && job.steps.some(step => step.name === `verified-tree-${tree}` && successful(step)))
  ))
}

async function find_verified_pr({ api, repository, sha, tree }) {
  const prefix = `/repos/${repository}`
  const pulls = await api(`${prefix}/commits/${sha}/pulls?per_page=100`)
  for (const pr of pulls) {
    if (! pr.merged_at || pr.merge_commit_sha !== sha || pr.base?.ref !== 'main' || ! pr.head?.sha)
      continue
    const runs = await api(`${prefix}/actions/workflows/check.yml/runs?event=pull_request&status=completed&head_sha=${encodeURIComponent(pr.head.sha)}&per_page=100`)
    for (const run of runs.workflow_runs) {
      if (run.event !== 'pull_request' || run.head_sha !== pr.head.sha || run.status !== 'completed' || run.conclusion !== 'success')
        continue
      const result = await api(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
      if (verified_jobs(result.jobs, tree))
        return true
    }
  }
  return false
}

export async function has_verified_pr(context) {
  try {
    return await find_verified_pr(context)
  }
  catch {
    return false
  }
}

async function main() {
  let reuse = false
  try {
    const { GITHUB_API_URL, GITHUB_OUTPUT, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN } = process.env
    if (! GITHUB_API_URL || ! GITHUB_OUTPUT || ! GITHUB_REPOSITORY || ! GITHUB_SHA || ! GH_TOKEN)
      throw new Error('Missing GitHub context')
    // A PR cannot attest to its own changes to the verification mechanism.
    execFileSync('git', ['diff', '--quiet', `${GITHUB_SHA}^`, GITHUB_SHA, '--', '.github/workflows/check.yml', 'scripts/ci/reuse-pr-checks.mjs'])
    const tree = execFileSync('git', ['rev-parse', `${GITHUB_SHA}^{tree}`], { encoding: 'utf8' }).trim()
    if (! /^[a-f0-9]{40}$/.test(tree))
      throw new Error('Invalid Git tree')
    const api = async (path) => {
      const response = await fetch(`${GITHUB_API_URL}${path}`, {
        headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(10_000),
      })
      if (! response.ok)
        throw new Error(`GitHub API returned ${response.status}`)
      return response.json()
    }
    reuse = await has_verified_pr({ api, repository: GITHUB_REPOSITORY, sha: GITHUB_SHA, tree })
  }
  catch (error) {
    console.log(`No reusable PR verification: ${error.message}`)
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`)
  console.log(reuse ? 'Reusing browser and MQTT checks for the identical verified tree.' : 'Running browser and MQTT checks on main.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
