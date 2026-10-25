import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  '20261025170000_storage_audit_cleanup.sql': '3ea30a8d20f889e6098c0105c82dec99b015c450be3860101063e9307120e6c7',
  '20261025160000_storage_audit.sql': '452beb5ba23456116f66ceaafe99d6c0dbcca4a77fc68a4b4c3c6f545b0376f5',
  '20261024210000_content_cutover_state.sql': 'e72b758a45935243c34aa45e12cdd435fb02967a507fd5e1e2f7e8b14c52db11',
  '20261024030000_single_migration_ledger.sql': 'ec2d72df984b0a4b2ccbcf0b053ae2dcbe931b0b30e609b3b0c7e52fcd6e729c',
  '20261024020000_migration_runs.sql': '39760ce37e584b05c486bb538380aa8cc9e3ab1d6235127cfaa5b00b8e5a4ab0',
  '20261024010000_content_preload.sql': '8f6e72dea24dbd2986eada454dff035084bd303b82326ab3530d9115057ba2e2',
  '20261023170000_content_redacted_variants.sql': '6ff63ef792c382874aed15b9687f704f40dad3caee431678bf84df95a84cce2b',
  '20261021150000_content_sync_outbox.sql': 'dc36e1fde4b52e1da5b1fee348258c30f56244ce2e7ae3cbc2407f64ddb30473',
  '20261019223000_content_read_revision.sql': '94cac9da84da65866c5b64984ba294fd1c8419161d4f2afb6f4cd38184bd3d27',
  '20261019210000_content_object_retirement.sql': 'a1937290003524c8967b1e85922ad9f0dff7b2601bba1e3b7f8a0b0bba89d003',
  '20261016230000_content_upload_images.sql': 'ca45c121958ff78ae7f3caa3240693865bc77348a43a69bc6f3121925a727c0a',
  '20261016220000_content_image_variants.sql': '1b2c17663099f9c8800b12c11e499cbc4e854a37c0e08f68ea676320eb812b15',
  '20261015190000_content_upload_part_grants.sql': '076b2a9459292747a83c6adf142fb667c7ff218c6d8c3e5cfaa0fd35a98bafdc',
  '20261016010000_content_workspace.sql': '68890706ef1f57899ba1987ea0479ddb6c5f85c11bae7c1a44942dda73c379a7',
  '20261015170000_content_transfer_sessions.sql': '5a9c33d689ada42ee98fa57c06411c07ccc414747b568e095bd8d7e6067af34c',
  '20261015143000_content_storage_retirement.sql': 'd9683adc3aede2b6feeb9a813ca07c97c6177fd635e958234f453bda12e84076',
  '20261015140000_content_secret_storage.sql': 'f0b26f97d847985cb606f672f088d376a492b2904676407e369f301632eea6dd',
  '20261014210000_private_content_attachments.sql': 'd7b17d584c8119993e7397fb334dcd6fe0a806e784dbf40ee6c816a9ba27a128',
  '20261014180000_content_reference_journals.sql': '94d5a4929dd84d7cea4c1d45c94035f78d32d83bd2e2082d5c04dfae3e3cf720',
  '20261013131000_content_task_pause.sql': '0c0fff571c758b4927ef8624ec8dd5d381ce4ff28de3694bb341d59e7c09f092',
  '20261013130000_content_task_retries.sql': '100c26d0c9392981305a0b4df2ae6920e3f4cb0e597ffeaff5dfac47424361bb',
  '20261008000000_init_schema.sql': 'e2b16a74b603fe579ab6b832e1664e61680b9f8e45dd64c3fefe218373214853',
  '20261008140000_content_locks.sql': '3ab1b3e673c11a33ba0f9e81756c33114f76f336ff2160faa50d956bf77429e6',
  '20261008160000_content_tasks.sql': 'e0aa6dbd70ad16ed0a4d0010a5e74a92f585af37a9c364c8e39875716c9a9422',
}

const migrations_dir = resolve(import.meta.dirname, '../../migrations')
// Pin the bundled dependency closure, not just the entry file. Add each TS artifact digest here.
const frozen_scripts: Record<string, string> = {
  '20261024210100_content_references.ts': '46a3187bb96e7ecc1a91130cbed3372d76364fde873060cb92d0205f8c668018',
  '20261024210200_content_workspace.ts': '89b4db2f71b225500ef1bcedbf8ef859819ca41755ef0f2cf46284095f1a8bc1',
}

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
