import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('documentation-only CI and deployment', () => {
  const check = parse(readFileSync('.github/workflows/check.yml', 'utf8'))
  const deploy = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
  const maintenance = parse(readFileSync('.github/workflows/maintenance-deploy.yml', 'utf8'))

  it('requires a plan-specific opt-in and serializes maintenance with ordinary deployments', () => {
    expect(Object.keys(maintenance.on)).toEqual(['workflow_dispatch'])
    expect(maintenance.on.workflow_dispatch.inputs.plan_id.required).toBe(true)
    expect(maintenance.on.workflow_dispatch.inputs.confirm_maintenance).toMatchObject({ type: 'boolean', required: true, default: false })
    expect(maintenance.concurrency).toEqual(deploy.concurrency)
    expect(maintenance.jobs.maintenance.if).toBe('github.ref == \'refs/heads/main\'')
    const steps = maintenance.jobs.maintenance.steps
    const checkout = steps.find((step: { with?: { ref?: string } }) => step.with?.ref?.includes('steps.release.outputs.commit'))
    expect(checkout).toBeDefined()
    expect(steps.some((step: { run?: string }) => step.run?.includes('docker build'))).toBe(false)
  })
  const ignored = check.on.push['paths-ignore'] as string[]
  // GitHub's path syntax defines **.md as Markdown at any depth, including root.
  const matches = (file: string, pattern: string) => pattern === '**.md' ? file.endsWith('.md') : pattern === 'docs/**' && file.startsWith('docs/')
  const push_starts_check = (files: string[]) => files.some(file => ! ignored.some(pattern => matches(file, pattern)))

  it('keeps PR checks unfiltered so required checks report a result', () => {
    expect(check.on.pull_request).toBeNull()
    expect(check.on.push.branches).toEqual(['main'])
    expect(ignored).toEqual(['docs/**', '**.md'])
  })

  it('skips main pushes containing only documentation', () => {
    expect(push_starts_check(['README.md', '.github/copilot-instructions.md', '.github/instructions/code-style.instructions.md', 'config/ram/README.md', 'docs/images/example.png'])).toBe(false)
  })

  it('runs main checks when a push includes application or workflow changes', () => {
    expect(push_starts_check(['docs/README.md', 'server/api/index.ts'])).toBe(true)
    expect(push_starts_check(['README.md', '.github/workflows/check.yml'])).toBe(true)
    expect(push_starts_check(['docker-compose.yml'])).toBe(true)
  })

  it('starts deployment only from completed main Check runs pushed to this repository', () => {
    expect(deploy.on.workflow_run).toEqual({ workflows: ['Check'], types: ['completed'], branches: ['main'] })
    // branches: [main] 过滤的是触发 run 的 head 分支名，fork 的默认分支也叫 main；
    // 只有 push 事件且来源为本仓库的成功 Check 才能触发部署。
    expect(deploy.jobs['build-and-deploy'].if).toBe(
      'github.event.workflow_run.conclusion == \'success\''
      + ' && github.event.workflow_run.event == \'push\''
      + ' && github.event.workflow_run.head_repository.full_name == github.repository',
    )
  })

  it.each([
    { event: 'push', owner: 'owner/repo', conclusion: 'success', allow: true },
    { event: 'pull_request', owner: 'fork/repo', conclusion: 'success', allow: false },
    { event: 'pull_request', owner: 'owner/repo', conclusion: 'success', allow: false },
    { event: 'push', owner: 'fork/repo', conclusion: 'success', allow: false },
    { event: 'push', owner: 'owner/repo', conclusion: 'failure', allow: false },
  ])('rejects untrusted workflow events %#', ({ event, owner, conclusion, allow }) => {
    const github = { repository: 'owner/repo', event: { workflow_run: { event, conclusion, head_repository: { full_name: owner } } } }
    expect(runInNewContext(deploy.jobs['build-and-deploy'].if, { github })).toBe(allow)
  })

  const gate = check.jobs.check
  const application_jobs = ['unit', 'mqtt', 'browser', 'browser-css', 'migrations']
  function fails(code = 'true', reuse = '', event = 'pull_request', overrides: Record<string, string> = {}) {
    const needs = Object.fromEntries(gate.needs.map((name: string) => [name, { result: overrides[name] ?? 'success' }]))
    needs.changes = { ... needs.changes, outputs: { code, reuse } }
    return runInNewContext(gate.steps[0].if.replaceAll('needs.*.result', 'results'), {
      needs, github: { event_name: event }, results: Object.values(needs).map(item => item.result),
      contains: (values: string[], value: string) => values.includes(value),
    })
  }

  it('always reports one strict gate and records the tree inside its successful PR path', () => {
    expect(gate.needs).toEqual(['changes', ... application_jobs])
    expect(runInNewContext(gate.if, { always: () => true })).toBe(true)
    expect(check.jobs['browser-status']).toBeUndefined()
    expect(check.jobs['verified-tree']).toBeUndefined()
    expect(gate.steps[0].run).toBe('exit 1')
    const marker = gate.steps[1]
    expect(marker.name).toBe('verified-tree-$' + '{{ needs.changes.outputs.tree }}')
    for (const success of [true, false]) {
      for (const event of ['pull_request', 'push']) {
        for (const code of ['true', 'false']) {
          expect(runInNewContext(marker.if, { success: () => success, github: { event_name: event }, needs: { changes: { outputs: { code } } } }))
            .toBe(success && event === 'pull_request' && code === 'true')
        }
      }
    }
  })

  it('accepts complete verification, classified documentation and verified main reuse', () => {
    expect(fails()).toBe(false)
    const skipped = Object.fromEntries(application_jobs.map(name => [name, 'skipped']))
    expect(fails('false', '', 'pull_request', skipped)).toBe(false)
    expect(fails('true', 'true', 'push', skipped)).toBe(false)
    expect(fails('true', 'true', 'pull_request', skipped)).toBe(true)
  })

  it.each(['failure', 'cancelled', 'skipped'])('rejects a %s classification even when output claims verification can skip', (result) => {
    for (const code of ['true', 'false', ''])
      expect(fails(code, 'true', 'push', { changes: result })).toBe(true)
  })

  it.each(['', 'unknown'])('rejects an invalid classification output: %s', (code) => {
    expect(fails(code)).toBe(true)
  })

  it.each(application_jobs)('blocks failures, cancellations and unintended skips in %s', (name) => {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(fails('true', '', 'pull_request', { [name]: result })).toBe(true)
      if (result !== 'skipped') {
        expect(fails('false', '', 'pull_request', { [name]: result })).toBe(true)
        expect(fails('true', 'true', 'push', { [name]: result })).toBe(true)
      }
    }
  })

  it.each([
    { code: 'true', reuse: '', run: true },
    { code: 'true', reuse: 'true', run: false },
    { code: 'true', reuse: 'false', run: true },
    { code: '', reuse: '', run: true },
    { code: 'false', reuse: '', run: false },
  ])('runs every application job only when verification is needed: %#', ({ code, reuse, run }) => {
    for (const name of ['unit', 'migrations', 'mqtt', 'browser', 'browser-css']) {
      const context = { cancelled: () => false, needs: { changes: { outputs: { code, reuse } } } }
      expect(runInNewContext(check.jobs[name].if, context), name).toBe(run)
    }
  })
})
