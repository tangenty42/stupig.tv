import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { baseline_migration, baseline_sql_checksums } from './baseline'
import { build_migration_scripts } from './build'

/**
 * Applied migrations are frozen, byte for byte.
 *
 * `scripts/migration/local.ts` records a sha256 of each migration file it applies (or
 * baselines) and refuses to run when a recorded file no longer matches — the
 * mismatch means the schema a database actually has may differ from the chain
 * that claims to describe it. Nothing else catches this before production: CI
 * replays the chain on a fresh database, which records the *current* bytes, so
 * an edit to an applied file passes every check and then crash-loops the
 * container at startup. That is exactly how `20261008000000_init_schema.sql`
 * went down on 2026-10-09, from a comment-only edit.
 *
 * So the hashes below are pinned. A diff in this file means someone changed an
 * applied migration: undo the change rather than updating the pin. (The one
 * legitimate reason to touch a recorded row is a line-ending artifact — see
 * `.github/instructions/migrations.instructions.md` — and that does not change
 * the file's content, so it does not change this list.)
 *
 * Adding a migration: add its sha256 in the same commit. The hash is computed
 * over the LF form of the file, which is what `.gitattributes`
 * (`* text=auto eol=lf`) puts in the blob and therefore what the Linux
 * container reads. Line endings are normalised here on purpose: a Windows
 * working tree can hold a *stale* CRLF copy from before `.gitattributes`
 * existed, and that copy's hash is not what any deployment sees.
 */
const frozen_migrations: Record<string, string> = {
  ... baseline_sql_checksums,
  [baseline_migration]: 'ad2f61316091cd2ad720f4052f2aac2c363a4b0d66ccf2b5c7f1bfea7b9d895f',
  '20261112160000_account_permission_levels.sql': 'ac4180b7a24dff1f5e2a5622a4c0bb597c276597a73915346ca485265e3b8df5',
  '20261116000000_drop_legacy_attachment_storage.sql': '80c903e1b5000c438a724a3c8288737ee6489d3ee4890c9acebdd1c7f9bd1d59',
  '20261117220000_redaction_files.sql': '7074bd59868a7c10450a13b35ef0d5618c1d7d0f100715470711c4417dd97068',
  '20261123111552_clear_bcrypt_passwords.sql': 'f1cae6b8bdc7b2e3692120ceda1780f627a83961ae14467ef7f746a44d360aef',
}

const migrations_dir = resolve(import.meta.dirname, '../../migrations')
// Pin the bundled dependency closure, not just the entry file. Add each TS artifact digest here.
const frozen_scripts: Record<string, string> = {}

function canonical_sha256(filename: string) {
  const content = readFileSync(resolve(migrations_dir, filename), 'utf-8').replaceAll('\r\n', '\n')
  return createHash('sha256').update(content).digest('hex')
}

describe('frozen migrations', () => {
  it('脚本及其依赖产物未改动，新增脚本也必须显式冻结', async () => {
    const manifest = await build_migration_scripts(migrations_dir, resolve(import.meta.dirname, '../../.nuxt/frozen-migration-scripts'))
    const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts: { filename: string, checksum: string }[] }).scripts
    expect(Object.fromEntries(scripts.map(item => [item.filename, item.checksum]))).toEqual(frozen_scripts)
  })
  it('已应用的迁移字节未变（改动会让容器启动失败）', () => {
    const changed = Object.entries(frozen_migrations)
      .filter(([filename, checksum]) => canonical_sha256(filename) !== checksum)
      .map(([filename, checksum]) => `${filename}：记录 ${checksum}，实际 ${canonical_sha256(filename)}`)

    expect(changed).toEqual([])
  })

  // 未列入清单的文件等于没被守住，所以新增迁移必须同时补上 hash，而不是只加文件。
  it('migrations/ 里每个迁移都在冻结清单中', () => {
    const files = readdirSync(migrations_dir).filter(name => name.endsWith('.sql')).sort()

    expect(files).toEqual(Object.keys(frozen_migrations).sort())
  })
})
