import type mysql from 'mysql2/promise'
import type { create_aliyun_oss } from '../../server/lib/aliyun-oss'

export type MigrationCheckpoint = null | boolean | number | string | MigrationCheckpoint[] | { [key: string]: MigrationCheckpoint }
export type MigrationDatabase = Pick<mysql.Connection, 'query' | 'execute'>
export interface MigrationReport {
  summary: string
  counts?: Record<string, number>
  blocked?: boolean
  issues?: { scope: number, node?: number, code: string }[]
}
export interface MigrationReadContext {
  filename: string
  db: MigrationDatabase
  signal: AbortSignal
  checkpoint: { readonly value: MigrationCheckpoint }
}
export interface MigrationContext extends MigrationReadContext {
  checkpoint: {
    readonly value: MigrationCheckpoint
    save: (value: MigrationCheckpoint) => Promise<void>
  }
  assert_active: () => Promise<void>
  transaction: <T>(work: (db: MigrationDatabase) => Promise<T>) => Promise<T>
  oss: () => Promise<ReturnType<typeof create_aliyun_oss>>
}
export interface ScriptMigration {
  execution: 'automatic' | 'maintenance'
  plan: (context: MigrationReadContext) => Promise<MigrationReport>
  apply: (context: MigrationContext) => Promise<void>
  verify: (context: MigrationReadContext) => Promise<boolean>
}

/** Imports must be side-effect free. Each apply must reconcile repeated external effects. */
export function define_migration(migration: Omit<ScriptMigration, 'execution'> & { execution?: ScriptMigration['execution'] }): ScriptMigration {
  return { ... migration, execution: migration.execution ?? 'maintenance' }
}
