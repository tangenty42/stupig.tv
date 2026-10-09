import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Applied migrations are frozen, byte for byte.
 *
 * `scripts/migrate.ts` records a sha256 of each migration file it applies (or
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
  '20261008000000_init_schema.sql': 'e2b16a74b603fe579ab6b832e1664e61680b9f8e45dd64c3fefe218373214853',
  '20261008140000_content_locks.sql': '3ab1b3e673c11a33ba0f9e81756c33114f76f336ff2160faa50d956bf77429e6',
  '20261008160000_content_tasks.sql': 'e0aa6dbd70ad16ed0a4d0010a5e74a92f585af37a9c364c8e39875716c9a9422',
}

const migrations_dir = resolve(import.meta.dirname, '../migrations')

function canonical_sha256(filename: string) {
  const content = readFileSync(resolve(migrations_dir, filename), 'utf-8').replaceAll('\r\n', '\n')
  return createHash('sha256').update(content).digest('hex')
}

describe('frozen migrations', () => {
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
