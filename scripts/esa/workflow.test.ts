import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('production publication workflow', () => {
  it('pins actions and limits the workflow token to repository reads', () => {
    const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
    const steps = workflow.jobs['build-and-deploy'].steps as { uses?: string }[]
    expect(workflow.permissions).toEqual({ contents: 'read' })
    for (const step of steps.filter(step => step.uses))
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[a-f\d]{40}$/)
  })

  it('rejects missing and mismatched SSH host entries before building', () => {
    const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
    const steps = workflow.jobs['build-and-deploy'].steps as { name?: string, run?: string, env?: Record<string, string> }[]
    const preflight = steps.find(step => step.name === 'Check SSH host identity')!
    expect(steps.indexOf(preflight)).toBeLessThan(steps.findIndex(step => step.name === 'Build and push image'))
    expect(preflight.env?.SSH_KNOWN_HOSTS).toBe('$' + '{{ secrets.SSH_KNOWN_HOSTS }}')
    const deploy = steps.find(step => step.name === 'Deploy to server')!
    expect(deploy.run).toContain('StrictHostKeyChecking yes')
    expect(deploy.run).not.toContain('ssh-keyscan')

    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh'
    expect(process.platform !== 'win32' || existsSync(shell)).toBe(true)
    const home = mkdtempSync(join(tmpdir(), 'deploy-host-test-'))
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPW8KdnIvnurwFexUfGZUjfP6vQbORM2iuP9NxnYcljG'
    const run = (known_hosts: string, port = '2222') => spawnSync(shell, ['-c', preflight.run!], {
      env: { ... process.env, HOME: home, SSH_HOST: 'example.test', SSH_PORT: port, SSH_KNOWN_HOSTS: known_hosts },
      encoding: 'utf8',
    })
    try {
      expect(run('').status).not.toBe(0)
      expect(run(`[other.test]:2222 ${key}`).status).not.toBe(0)
      expect(run(`[example.test]:22 ${key}`).status).not.toBe(0)
      expect(run(`[example.test]:2222 ${key}`).status).toBe(0)
      expect(run(`example.test ${key}`, '22').status).toBe(0)
    }
    finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('preflights before deploying the app, publishes after its health gate, and always cleans plaintext', () => {
    const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
    const steps = workflow.jobs['build-and-deploy'].steps as { name?: string, run?: string, if?: string, with?: Record<string, unknown> }[]
    const index = (name: string) => steps.findIndex(step => step.name === name)
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(index('Decrypt production environment')).toBeLessThan(index('Check production ESA target'))
    expect(index('Check production ESA target')).toBeLessThan(index('Deploy to server'))
    expect(index('Prepare server environment')).toBeGreaterThan(index('Check production ESA target'))
    expect(index('Prepare server environment')).toBeLessThan(index('Deploy to server'))
    expect(steps[index('Prepare server environment')]?.run).toBe('pnpm exec tsx scripts/deploy/runtime-env.ts')
    expect(steps[index('Check production ESA target')]?.run).toBe('pnpm esa:deploy:prod --check')
    expect(steps[index('Deploy to server')]?.run).toContain('cat scripts/deploy/remote.sh')
    expect(steps[index('Deploy to server')]?.run).toContain('sh scripts/deploy/stage-env.sh .env.prod.runtime')
    expect(index('Publish production ESA function')).toBeGreaterThan(index('Deploy to server'))
    expect(steps[index('Publish production ESA function')]?.run).toBe('pnpm esa:deploy:prod')
    expect(steps[index('Publish production ESA function')]?.if).toBeUndefined()
    const cleanup = steps[index('Remove plaintext environment')]!
    expect(cleanup.if).toBe('always()')
    expect(cleanup.run).toContain('shred -u .env.prod')
    expect(cleanup.run).toContain('shred -u .env.prod.runtime')
    expect(index('Remove plaintext environment')).toBeGreaterThan(index('Publish production ESA function'))
    expect(steps[index('Upload ESA deployment receipt')]?.with?.path).toBe('.data/esa-deploy/*.json')
  })
})
