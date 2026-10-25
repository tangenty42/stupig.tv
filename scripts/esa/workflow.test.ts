import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('production publication workflow', () => {
  it('preflights before deploying the app, publishes after its health gate, and always cleans plaintext', () => {
    const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8'))
    const steps = workflow.jobs['build-and-deploy'].steps as { name?: string, run?: string, if?: string, with?: Record<string, unknown> }[]
    const index = (name: string) => steps.findIndex(step => step.name === name)
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
    expect(index('Decrypt production environment')).toBeLessThan(index('Check production ESA target'))
    expect(index('Check production ESA target')).toBeLessThan(index('Deploy to server'))
    expect(steps[index('Check production ESA target')]?.run).toBe('pnpm esa:deploy:prod --check')
    expect(steps[index('Deploy to server')]?.run).toContain('cat scripts/deploy/remote.sh')
    expect(index('Publish production ESA function')).toBeGreaterThan(index('Deploy to server'))
    expect(steps[index('Publish production ESA function')]?.run).toBe('pnpm esa:deploy:prod')
    expect(steps[index('Publish production ESA function')]?.if).toBeUndefined()
    const cleanup = steps[index('Remove plaintext environment')]!
    expect(cleanup.if).toBe('always()')
    expect(cleanup.run).toContain('shred -u .env.prod')
    expect(index('Remove plaintext environment')).toBeGreaterThan(index('Publish production ESA function'))
    expect(steps[index('Upload ESA deployment receipt')]?.with?.path).toBe('.data/esa-deploy/*.json')
  })
})
