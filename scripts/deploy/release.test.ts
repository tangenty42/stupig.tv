import type { DeploymentPreflight } from '../migration/deployment'
import { describe, expect, it } from 'vitest'
import { decision_environment, release_plan, safe_rollback } from './release'

const hash = 'a'.repeat(64)
const migrations: DeploymentPreflight = {
  version: 1, fingerprint: hash,
  database: { host: 'mysql', port: 3306, name: 'stupig', server_uuid: '11111111-1111-1111-1111-111111111111' },
  catalog: [{ filename: '20261031010000_next.sql', checksum: hash }],
  legacy: [],
  ledger: [],
  pending: [{ filename: '20261031010000_next.sql', checksum: hash, status: 'pending', phase: 'apply', execution: 'automatic' }],
  requires_maintenance: false, sql_recovery_required: [],
}
const identity = {
  commit: 'a'.repeat(40), app: `registry.example/app@sha256:${hash}`, mqtt: `registry.example/app@sha256:${hash}`,
  environment_sha256: hash, compose_sha256: hash, previous_protocol: 'cloud-v1' as const, previous_release_sha256: hash,
}

describe('release approval and rollback', () => {
  it('binds approval to the immutable images, environment, old release and ledger', () => {
    const plan = release_plan(migrations, identity)
    expect(release_plan(structuredClone(migrations), { ... identity }).id).toBe(plan.id)
    for (const key of ['commit', 'app', 'mqtt', 'environment_sha256', 'compose_sha256', 'previous_release_sha256'] as const) {
      const value = key === 'app' || key === 'mqtt' ? identity[key].replace(hash, 'b'.repeat(64)) : identity[key].replaceAll('a', 'b')
      expect(release_plan(migrations, { ... identity, [key]: value }).id).not.toBe(plan.id)
    }
    expect(release_plan({ ... migrations, ledger: [{ filename: 'old.sql', checksum: hash, status: 'completed', phase: 'verify', attempts: 1, finished: true }] }, identity).id).not.toBe(plan.id)
    expect(release_plan(migrations, { ... identity, previous_protocol: 'legacy' }).requires_maintenance).toBe(true)
    expect(release_plan({ ... migrations, requires_maintenance: true }, identity).requires_maintenance).toBe(true)
  })

  it('does not emit executable shell syntax from database identifiers', () => {
    const plan = release_plan(migrations, identity)
    expect(decision_environment(plan)).toContain('DB_NAME=stupig\n')
    expect(() => decision_environment({ ... plan, migrations: { ... migrations, database: { ... migrations.database, name: 'db; env' } } })).toThrow(/safely/)
    expect(() => release_plan(migrations, { ... identity, app: 'registry/app:latest' })).toThrow(/immutable/)
  })

  it('permits rollback only across completed reviewed online steps', () => {
    const row = { filename: migrations.pending[0]!.filename, checksum: hash, status: 'completed', phase: 'apply', attempts: 1, finished: true }
    const after = { ... migrations, ledger: [row], pending: [] }
    expect(safe_rollback(migrations, after)).toBe(true)
    expect(safe_rollback({ ... migrations, pending: [{ ... migrations.pending[0]!, execution: 'maintenance' }] }, after)).toBe(false)
    expect(safe_rollback(migrations, { ... after, ledger: [{ ... row, status: 'failed', finished: false }] })).toBe(false)
    expect(safe_rollback(migrations, { ... after, ledger: [{ ... row, filename: 'unexpected.sql' }] })).toBe(false)
    expect(safe_rollback(after, { ... after, ledger: [] })).toBe(false)
    expect(safe_rollback(after, { ... after, database: { ... after.database, server_uuid: '22222222-2222-2222-2222-222222222222' } })).toBe(false)
  })
})
