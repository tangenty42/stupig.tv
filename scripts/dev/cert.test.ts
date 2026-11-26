import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { prepare_checkout_https, prepare_dev_certificate } from './cert'

it('preserves existing files, backs up an explicitly rotated certificate and reuses the new chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'stupig-dev-cert-'))
  try {
    writeFileSync(join(directory, 'localhost.pem'), 'previous certificate')
    writeFileSync(join(directory, 'service.log'), 'running')
    expect(() => prepare_dev_certificate(directory)).toThrow('pnpm dev:cert --rotate')
    expect(readFileSync(join(directory, 'localhost.pem'), 'utf8')).toBe('previous certificate')
    const result = prepare_dev_certificate(directory, true)
    expect(result.created).toBe(true)
    expect(readFileSync(join(result.backup!, 'localhost.pem'), 'utf8')).toBe('previous certificate')
    expect(readFileSync(join(directory, 'service.log'), 'utf8')).toBe('running')
    expect(prepare_dev_certificate(directory)).toEqual({ fingerprint: result.fingerprint, created: false })
    expect(readdirSync(directory)).not.toContain('.cert-setup')
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('reuses a complete identity from .dev/https and keeps it across fresh checkouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'stupig-checkouts-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const issued = join(root, 'issued')
  const first = join(root, 'first')
  const second = join(root, 'second')
  const user = join(root, 'user')
  const { fingerprint } = prepare_dev_certificate(issued)
  mkdirSync(first)
  for (const name of ['ca.pem', 'localhost.pem', 'localhost.key'])
    copyFileSync(join(issued, name), join(first, name))
  expect(prepare_checkout_https(first, user, 'start').fingerprint).toBe(fingerprint)
  expect(prepare_checkout_https(second, user, 'start').fingerprint).toBe(fingerprint)
  expect(prepare_dev_certificate(second)).toEqual({ fingerprint, created: false })
})

it('rejects a partial identity instead of mixing it with a new one', () => {
  const root = mkdtempSync(join(tmpdir(), 'stupig-partial-identity-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const issued = join(root, 'issued')
  const workspace = join(root, 'workspace')
  const user = join(root, 'user')
  prepare_dev_certificate(issued)
  mkdirSync(workspace)
  copyFileSync(join(issued, 'localhost.key'), join(workspace, 'localhost.key'))
  expect(() => prepare_checkout_https(workspace, user, 'start'))
    .toThrow('needs all of ca.pem, localhost.pem and localhost.key together; missing ca.pem, localhost.pem')
})

it('creates a machine identity on explicit install and keeps its installed CA across starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'stupig-new-machine-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const user = join(root, 'user')
  expect(() => prepare_checkout_https(workspace, user, 'start')).toThrow('pnpm dev:cert --install')
  const { fingerprint } = prepare_checkout_https(workspace, user, 'install')
  expect(prepare_checkout_https(workspace, user, 'start')).toEqual({ fingerprint, created: false })
  expect(prepare_dev_certificate(workspace)).toEqual({ fingerprint, created: false })
})
