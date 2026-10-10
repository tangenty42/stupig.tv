import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { check_env, crypt_env, find_gpg } from './gpg-env'

const gpg = find_gpg()
const it_with_gpg = gpg ? it : it.skip

describe('crypt_env', () => {
  let directory: string
  let original_passphrase: string | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'stupig-gpg-env-'))
    original_passphrase = process.env.ENV_PASSPHRASE
    delete process.env.ENV_PASSPHRASE
  })

  afterEach(() => {
    if (original_passphrase === undefined)
      delete process.env.ENV_PASSPHRASE
    else
      process.env.ENV_PASSPHRASE = original_passphrase

    rmSync(directory, { recursive: true, force: true })
  })

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

    expect(() => crypt_env('decrypt', { cwd: directory, passphrase: 'wrong' })).toThrow(/gpg failed/)
    expect(existsSync(join(directory, '.env.prod'))).toBe(false)
  })

  it_with_gpg('reads ENV_PASSPHRASE from .env when the process environment does not provide it', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env'), 'ENV_PASSPHRASE="local-test-passphrase"\n')
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\n')

    crypt_env('encrypt', { cwd: directory })
    rmSync(join(directory, '.env.prod'))
    crypt_env('decrypt', { cwd: directory })

    expect(readFileSync(join(directory, '.env.prod'), 'utf8')).toBe('SECRET=value\n')
  })

  it_with_gpg('prefers the process passphrase over the value in .env', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env'), 'ENV_PASSPHRASE=from-file\n')
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\n')
    process.env.ENV_PASSPHRASE = 'from-process'

    crypt_env('encrypt', { cwd: directory })
    rmSync(join(directory, '.env.prod'))
    crypt_env('decrypt', { cwd: directory })

    expect(readFileSync(join(directory, '.env.prod'), 'utf8')).toBe('SECRET=value\n')
  })

  it_with_gpg('prefers an explicit passphrase over the process environment and .env', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env'), 'ENV_PASSPHRASE=from-file\n')
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\n')
    process.env.ENV_PASSPHRASE = 'from-process'

    crypt_env('encrypt', { cwd: directory, passphrase: 'explicit-value' })
    rmSync(join(directory, '.env.prod'))
    crypt_env('decrypt', { cwd: directory, passphrase: 'explicit-value' })

    expect(readFileSync(join(directory, '.env.prod'), 'utf8')).toBe('SECRET=value\n')
  })

  it_with_gpg('check passes when the committed ciphertext matches the plaintext', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\nOTHER=second\n')
    crypt_env('encrypt', { cwd: directory, passphrase: 'test-passphrase' })

    expect(check_env({ cwd: directory, passphrase: 'test-passphrase' })).toEqual({ ok: true })
  })

  it_with_gpg('check fails when plaintext formatting differs from the encrypted file', { timeout: 60_000 }, () => {
    writeFileSync(join(directory, '.env.prod'), 'SECRET=value\n')
    crypt_env('encrypt', { cwd: directory, passphrase: 'test-passphrase' })

    writeFileSync(join(directory, '.env.prod'), '# added comment\nSECRET=value\n')

    expect(check_env({ cwd: directory, passphrase: 'test-passphrase' })).toEqual({ ok: false })
  })
})
