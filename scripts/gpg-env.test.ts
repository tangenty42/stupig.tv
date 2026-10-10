import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crypt_env, find_gpg } from './gpg-env'

const gpg = find_gpg()
const it_with_gpg = gpg ? it : it.skip

describe('crypt_env', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'stupig-gpg-env-'))
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it_with_gpg('encrypt then decrypt round-trips without leaking plaintext', { timeout: 60_000 }, () => {
    const original = 'SECRET=value\nCOMMENT=中文注释\n'
    writeFileSync(join(directory, '.env.prod'), original)

    crypt_env('encrypt', { cwd: directory, passphrase: 'test-passphrase' })
    const encrypted_path = join(directory, '.env.prod.gpg')
    expect(existsSync(encrypted_path)).toBe(true)
    expect(readFileSync(encrypted_path)).not.toContain('SECRET=value')

    rmSync(join(directory, '.env.prod'))
    crypt_env('decrypt', { cwd: directory, passphrase: 'test-passphrase' })
    expect(readFileSync(join(directory, '.env.prod'), 'utf8')).toBe(original)
  })

  it_with_gpg('decrypt with a wrong passphrase fails instead of writing garbage', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\n')
    crypt_env('encrypt', { cwd: directory, passphrase: 'right' })
    rmSync(join(directory, '.env.prod'))

    expect(() => crypt_env('decrypt', { cwd: directory, passphrase: 'wrong' })).toThrow(/gpg decrypt failed/)
    expect(existsSync(join(directory, '.env.prod'))).toBe(false)
  })
})
