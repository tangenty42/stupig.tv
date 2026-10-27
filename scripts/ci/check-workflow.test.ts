import { readFileSync } from 'node:fs'
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

  it('starts deployment only from completed main Check runs', () => {
    expect(deploy.on.workflow_run).toEqual({ workflows: ['Check'], types: ['completed'], branches: ['main'] })
    expect(deploy.jobs['build-and-deploy'].if).toBe('github.event.workflow_run.conclusion == \'success\'')
  })
})
