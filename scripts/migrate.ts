// 数据库迁移执行器：应用 migrations/*.sql 里尚未执行的迁移，容器启动时自动跑。
// 用法：
//   pnpm migrate              应用缺失的迁移
//   pnpm migrate --status     只列出现状（已应用 / 待应用 / 不一致），不改库
//   pnpm migrate --dry-run    同 --status
//   pnpm migrate --baseline   把现存迁移文件全部标记为已应用，不执行 SQL
//                             （给"结构已手工建好"的库用一次，之后正常跑）
//
// 约定：
//   - 文件名以时间戳开头（见 migrations.instructions.md），字典序即执行顺序
//   - 一个文件里的多条语句在同一会话内执行，可用 @变量 / PREPARE，但不要用
//     mysql 客户端的 DELIMITER（服务端不认）；因 MySQL 的 DDL 会隐式提交，
//     "半途失败"无法回滚，所以文件请写成可重复执行（幂等）的形式
//   - 已应用的迁移文件内容不可再改：checksum 不一致会拒绝执行
//   - 存量库自动接管：库里已有业务表但没有任何迁移记录时（迁移系统上线前手工
//     建的库），migrate 会把现存迁移登记为已应用（baseline）而不是重放——重放
//     必然撞已有结构，容器启动会因此陷入重启循环
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load_database_config } from '@config/loader'
import { error_fields, log_error, log_info, log_warn } from '@server/lib/log'
import mysql from 'mysql2/promise'

const lock_name = 'stupig_tv_migrate'

export interface MigrationFile {
  filename: string
  sql: string
  checksum: string
}

export interface InconsistentMigration {
  filename: string
  reason: 'modified' | 'missing'
}

export interface MigrationPlan {
  pending: MigrationFile[]
  /** 已记录但文件被改动（或删掉）——迁移一经应用就不许再动，必须人工处理 */
  inconsistent: InconsistentMigration[]
}

export function read_migrations(dir: string): MigrationFile[] {
  if (! existsSync(dir)) {
    return []
  }
  return readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(resolve(dir, filename), 'utf-8')
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') }
    })
}

export function plan_migrations(files: MigrationFile[], applied: Map<string, string>): MigrationPlan {
  const by_name = new Map(files.map(file => [file.filename, file]))
  const inconsistent: InconsistentMigration[] = []
  for (const [filename, checksum] of applied) {
    const file = by_name.get(filename)
    if (! file) {
      inconsistent.push({ filename, reason: 'missing' })
    }
    else if (file.checksum !== checksum) {
      inconsistent.push({ filename, reason: 'modified' })
    }
  }
  return {
    pending: files.filter(file => ! applied.has(file.filename)),
    inconsistent: inconsistent.sort((left, right) => left.filename.localeCompare(right.filename)),
  }
}

const schema_table_sql = `CREATE TABLE IF NOT EXISTS \`schema_migrations\` (
  \`filename\` varchar(255) COLLATE utf8mb4_bin NOT NULL,
  \`checksum\` char(64) COLLATE utf8mb4_bin NOT NULL,
  \`applied_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`filename\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`

function describe(plan: MigrationPlan) {
  return {
    pending: plan.pending.map(file => file.filename),
    inconsistent: plan.inconsistent,
  }
}

async function read_applied(connection: mysql.Connection): Promise<Map<string, string>> {
  // 不建表：--status/--dry-run 必须真的只读，第一次运行前这张表本就不存在
  const [tables] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    ['schema_migrations'],
  )
  if (! tables.length) {
    return new Map()
  }
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT filename, checksum FROM schema_migrations')
  return new Map(rows.map(row => [String(row.filename), String(row.checksum)]))
}

/** 除 schema_migrations 之外的表数量；非零说明这是一个迁移系统接管前就存在的库 */
async function business_table_count(connection: mysql.Connection): Promise<number> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME != ?',
    ['schema_migrations'],
  )
  return Number(rows[0]?.n ?? 0)
}

export interface MigrationOptions {
  baseline?: boolean
  check_only?: boolean
  dir?: string
}

export async function run_migrations(options: MigrationOptions = {}): Promise<void> {
  const { baseline = false, check_only = false } = options
  if (baseline && check_only) {
    throw new Error('--baseline 不能与 --status/--dry-run 一起使用')
  }

  const config = load_database_config()
  const migration_dir = options.dir ?? resolve(process.cwd(), 'migrations')
  const files = read_migrations(migration_dir)
  log_info('migrations scanned', { dir: migration_dir, total: files.length, baseline, check_only })

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.name,
    timezone: 'Z',
    // 一个 .sql 文件里有多条语句，且依赖同一会话的 @变量 / PREPARE，必须整文件提交
    multipleStatements: true,
  })

  try {
    await connection.query('SET time_zone = "+00:00"')
    // 多副本或人工执行同时跑迁移会互相踩，先抢锁再建表
    const [lock_rows] = await connection.query<mysql.RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS acquired', [lock_name])
    if (lock_rows[0]?.acquired !== 1) {
      throw new Error(`没抢到迁移锁 ${lock_name}，可能有另一次迁移正在跑`)
    }

    try {
      const applied = await read_applied(connection)
      const plan = plan_migrations(files, applied)

      if (plan.inconsistent.length) {
        log_error('migrations inconsistent', { ... describe(plan) })
        throw new Error('已应用的迁移文件被改动或删除了，需要人工确认后再跑')
      }
      if (! plan.pending.length) {
        log_info('migrations up to date', { applied: applied.size })
        return
      }

      // 存量库从未被接管（没有任何已应用记录，但业务表已存在）：真实执行会撞上
      // 已有结构（比如基线迁移的 CREATE TABLE），所以登记而不重放。全新空库
      // （业务表为零）不受影响，正常执行。
      const auto_baseline = applied.size === 0 && await business_table_count(connection) > 0

      if (check_only) {
        log_info('migrations pending', { ... describe(plan), auto_baseline })
        return
      }

      await connection.query(schema_table_sql)

      const mark_applied = async (files: MigrationFile[]) => {
        for (const file of files) {
          await connection.query(
            'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
            [file.filename, file.checksum],
          )
        }
      }

      // 只标记不执行：库里结构已经是这些迁移的终态（手工建过），重放反而危险
      if (baseline) {
        await mark_applied(plan.pending)
        log_info('migrations baselined', { baselined: plan.pending.map(file => file.filename) })
        return
      }

      if (auto_baseline) {
        log_warn('database has tables but no migration records; registering pending migrations as applied instead of replaying them', { baselined: plan.pending.map(file => file.filename) })
        await mark_applied(plan.pending)
        return
      }

      for (const file of plan.pending) {
        log_info('migration applying', { filename: file.filename })
        try {
          await connection.query(file.sql)
        }
        catch (error) {
          // 半应用的语句后面补不上，直接把文件名和原始错误抛出去，别假装继续
          log_error('migration failed', { filename: file.filename, ... error_fields(error) })
          throw new Error(`迁移 ${file.filename} 执行失败，已终止`)
        }
        await connection.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
          [file.filename, file.checksum],
        )
        log_info('migration applied', { filename: file.filename })
      }
      log_info('migrations complete', { applied: plan.pending.length })
    }
    finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lock_name])
    }
  }
  finally {
    await connection.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run_migrations({
    baseline: process.argv.includes('--baseline'),
    check_only: process.argv.includes('--status') || process.argv.includes('--dry-run'),
  })
}
