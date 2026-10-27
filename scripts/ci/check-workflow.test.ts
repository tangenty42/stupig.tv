import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('documentation-only CI and deployment', () => {
  const check = parse(readFileSync('.github/workflows/check.yml', 'utf8'))
  const deploy = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
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

  it('uses a fixed verification job label and records the tree in a step', () => {
    expect(check.jobs['verified-tree'].name).toBe('verified-tree')
    expect(check.jobs['verified-tree'].steps[0].name).toBe('verified-tree-$' + '{{ needs.changes.outputs.tree }}')
  })

  it.each([
    { code: 'true', reuse: '', run: true },
    { code: 'true', reuse: 'true', run: false },
    { code: 'true', reuse: 'false', run: true },
    { code: '', reuse: '', run: true },
    { code: 'false', reuse: '', run: false },
  ])('runs every application job only when verification is needed: %#', ({ code, reuse, run }) => {
    for (const name of ['check', 'migrations', 'mqtt', 'browser']) {
      const context = { cancelled: () => false, needs: { changes: { outputs: { code, reuse } } } }
      expect(runInNewContext(check.jobs[name].if, context), name).toBe(run)
    }
  })
})
