import type { AuthUser } from '@server/types/auth'
import type { ImageAccessRow } from './attachment-access.service'
import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { content_authorization_proof, create_content_authorizer, create_content_bypass } from '../../../config/esa/content-auth.mjs'

const state = vi.hoisted(() => ({
  config: { baseUrl: 'https://esa.test', authKey: 'k'.repeat(64), urlTtlSeconds: 300 },
  rows: new Map<number, ImageAccessRow>(), story: true, session: true, generation: 1, admin: true, permissions: [] as unknown[],
  execute: vi.fn(), begin: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), connect: vi.fn(),
}))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { esa: state.config } }) }))
vi.mock('@server/lib/db', () => ({ db: { execute: state.execute, getConnection: state.connect } }))
const { create_esa } = await import('@server/lib/esa')
const { authorize_edge_read } = await import('./edge-read.service')
const { resolve_attachment_delivery } = await import('./attachment-access.service')
const admin = { id: 7, session_id: 9, token_generation_id: 1, is_admin: true } as AuthUser
const row = () => state.rows.get(11)!
async function signed(role: 'auto' | 'original' = 'auto', viewer: AuthUser | null = null) {
  const object = await resolve_attachment_delivery(row(), role, viewer)
  return create_esa().signed_read_url(object.key, 300, 'GET', object.name, 'inline', object.grant)
}
const request = (url: string) => ({ url, method: 'GET' as const, nonce: randomUUID() })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  state.story = state.session = state.admin = true
  state.generation = 1
  state.permissions = []
  state.rows.clear()
  state.rows.set(11, { id: 11, story_id: 1, read_revision: 1, object_key: 'content/att/file', file_name: 'file.txt', version: 'etag',
    storage_bucket: 'private', storage_provider: 'aliyun', oss_version_id: 'v1', is_private: 0, encryption_key: null })
  state.execute.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes('FROM user_login_session_tokens'))
      return [state.session && state.generation === Number(args[1]) ? [{ id: 7, is_admin: Number(state.admin), permissions: state.permissions }] : []]
    return [state.story && state.rows.has(Number(args[0])) ? [structuredClone(state.rows.get(Number(args[0])))] : []]
  })
  state.connect.mockResolvedValue({ execute: state.execute, beginTransaction: state.begin, commit: state.commit, rollback: state.rollback, release: state.release })
})

describe('online ESA authorization before cached bytes', () => {
  it('rechecks every cached GET, HEAD and Range, with no fallback or allow cache', async () => {
    const url = await signed()
    const remote = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body))
      const proof = await authorize_edge_read(input)
      return new Response(null, { status: proof ? 204 : 403, headers: proof ? { 'X-Content-Authorization': proof } : {} })
    })
    const serve = vi.fn((allowed: boolean, status: number) => ({ allowed, status }))
    const gate = create_content_bypass(state.config.authKey, 300, serve, create_content_authorizer(state.config.authKey, 'https://auth.test/api/content/authorize', 1000, remote))
    for (const method of ['GET', 'HEAD'])
      expect(await gate(new Request(url, { method, headers: { Range: 'bytes=1-4', Cookie: 'must-not-forward', Authorization: 'must-not-forward' } }))).toEqual({ allowed: true, status: 200 })
    row().is_private = 1
    row().read_revision = 2
    for (const method of ['GET', 'HEAD'])
      expect(await gate(new Request(url, { method, headers: { Range: 'bytes=1-4' } }))).toEqual({ allowed: false, status: 403 })
    expect(remote).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(remote.mock.calls)).not.toContain('must-not-forward')
    remote.mockRejectedValueOnce(new Error('offline'))
    expect(await gate(new Request(url))).toEqual({ allowed: false, status: 503 })
  })

  it('revokes old grants on privacy changes for all viewers and never revives them on toggle-back', async () => {
    const public_url = await signed()
    const admin_url = await signed('auto', admin)
    expect(await authorize_edge_read(request(admin_url))).toBeTruthy()
    row().is_private = 1
    row().read_revision = 2
    expect(await authorize_edge_read(request(public_url))).toBeNull()
    expect(await authorize_edge_read(request(admin_url))).toBeNull()
    const private_url = await signed('auto', admin)
    expect(await authorize_edge_read(request(private_url))).toBeTruthy()
    row().is_private = 0
    row().read_revision = 3
    for (const url of [public_url, admin_url, private_url])
      expect(await authorize_edge_read(request(url))).toBeNull()
    expect(await authorize_edge_read(request(await signed()))).toBeTruthy()
  })

  it.each(['attachment', 'story', 'replacement'])('denies a cached old object immediately after %s changes', async (change) => {
    const url = await signed()
    if (change === 'attachment')
      state.rows.delete(11)
    else if (change === 'story')
      state.story = false
    else
      row().object_key = 'content/att/new'
    expect(await authorize_edge_read(request(url))).toBeNull()
  })

  it('keeps rename and move compatible with already issued object reads', async () => {
    const url = await signed()
    row().file_name = 'new-directory/renamed.txt'
    expect(await authorize_edge_read(request(url))).toBeTruthy()
  })

  it('rejects an issued original grant when the attachment archive changes or disappears', async () => {
    row().original_key = 'content/att/original'
    const url = await signed('original', admin)
    expect(await authorize_edge_read(request(url))).toBeTruthy()
    row().original_key = 'content/att/replacement'
    expect(await authorize_edge_read(request(url))).toBeNull()
    row().original_key = null
    expect(await authorize_edge_read(request(url))).toBeNull()
  })

  it('keeps a detached copy and its own archive readable after the source changes or disappears', async () => {
    Object.assign(row(), { original_key: 'content/att/copy-original', avif_key: 'content/att/copy.avif', jpeg_key: 'content/att/copy.jpg',
      image_metadata: { original: { name: 'copy.avif' }, source_id: null, archive_source_id: null, archive_source_key: null } })
    state.rows.set(22, { ... row(), id: 22, original_key: 'content/att/source-original' })
    const urls = [await signed(), await signed('original')]
    state.rows.get(22)!.is_private = 1
    state.rows.get(22)!.read_revision = 2
    for (const url of urls)
      expect(await authorize_edge_read(request(url))).toBeTruthy()
    state.rows.delete(22)
    for (const url of urls)
      expect(await authorize_edge_read(request(url))).toBeTruthy()
  })

  it('rechecks live session and permissions, without extending or writing the login session', async () => {
    row().is_private = 1
    const url = await signed('auto', admin)
    state.admin = false
    expect(await authorize_edge_read(request(url))).toBeNull()
    state.permissions = [{ field: 'content_private', level: 'read' }]
    expect(await authorize_edge_read(request(url))).toBeTruthy()
    state.session = false
    expect(await authorize_edge_read(request(url))).toBeNull()
    expect(state.execute.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true)
  })

  it('does not revive old private URLs when a device logs in again using the same session row', async () => {
    row().is_private = 1
    const url = await signed('auto', admin)
    expect(await authorize_edge_read(request(url))).toBeTruthy()
    state.session = false
    expect(await authorize_edge_read(request(url))).toBeNull()
    state.session = true
    state.generation = 2
    expect(await authorize_edge_read(request(url))).toBeNull()
    const new_url = await signed('auto', { ... admin, token_generation_id: 2 })
    expect(await authorize_edge_read(request(new_url))).toBeTruthy()
  })

  it('rejects old protocols, forged metadata, other hosts and noncanonical URLs before DB access', async () => {
    const valid = await signed()
    const urls = [create_esa().signed_read_url('content/att/file', 300)]
    const legacy = new URL(valid)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rand = createHash('sha256').update(JSON.stringify([
      legacy.searchParams.get('response-content-disposition') ?? '', legacy.searchParams.get('access'),
    ])).digest('hex')
    const signature = createHash('md5').update([legacy.pathname, timestamp, rand, '1', state.config.authKey].join('-')).digest('hex')
    legacy.searchParams.set('auth_key', `${timestamp}-${rand}-1-${signature}`)
    urls.push(legacy.href)
    for (const change of [
      (u: URL) => { u.hostname = 'other.test' },
      (u: URL) => u.searchParams.set('access', Buffer.from('{"id":99}').toString('base64url')),
      (u: URL) => u.searchParams.delete('access'),
      (u: URL) => u.searchParams.append('access', u.searchParams.get('access')!),
      (u: URL) => { u.search = u.search.replace('access=', '%61ccess=') },
    ]) {
      const url = new URL(valid)
      change(url)
      urls.push(url.href)
    }
    for (const url of urls)
      expect(await authorize_edge_read(request(url))).toBeNull()
    expect(state.connect).not.toHaveBeenCalled()
  })

  it('binds authorization acknowledgements to a fresh nonce, URL and method', async () => {
    const input = request(await signed())
    const proof = await authorize_edge_read(input)
    expect(proof).toBe(content_authorization_proof(state.config.authKey, input.nonce, input.url, input.method))
    expect(proof).not.toBe(content_authorization_proof(state.config.authKey, randomUUID(), input.url, input.method))
    expect(proof).not.toBe(content_authorization_proof(state.config.authKey, input.nonce, input.url, 'HEAD'))
    const remote = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204, headers: { 'X-Content-Authorization': proof! } }))
    const gate = create_content_authorizer(state.config.authKey, 'https://auth.test/api/content/authorize', 1000, remote)
    expect(await gate(new Request(input.url))).toBe(503)
    remote.mockResolvedValueOnce(new Response(null, { status: 200 }))
    expect(await gate(new Request(input.url))).toBe(503)
  })

  it('fails closed on callback timeout and invalid callback destinations', async () => {
    const url = await signed()
    const remote = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
    }))
    expect(await create_content_authorizer(state.config.authKey, 'https://auth.test/api/content/authorize', 10, remote)(new Request(url))).toBe(503)
    expect(remote).toHaveBeenCalledOnce()
    remote.mockClear()
    for (const endpoint of ['', 'http://auth.test', 'https://esa.test/api', 'https://user:pass@auth.test/api'])
      expect(await create_content_authorizer(state.config.authKey, endpoint, 1000, remote)(new Request(url))).toBe(503)
    expect(remote).not.toHaveBeenCalled()
    expect(await create_content_bypass(state.config.authKey, 300, (allowed, status) => ({ allowed, status }))(new Request(url))).toEqual({ allowed: false, status: 503 })
  })

  it.each(['missing', 'short', 'long', 'nonhex', 'uppercase', 'wrong-key', 'url-signature'])('rejects %s callback proofs without falling back', async (kind) => {
    const url = await signed()
    const remote = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(String(init?.body))
      let proof = content_authorization_proof(state.config.authKey, input.nonce, input.url, input.method)
      if (kind === 'short')
        proof = proof.slice(1)
      else if (kind === 'long')
        proof += '0'
      else if (kind === 'nonhex')
        proof = 'g'.repeat(64)
      else if (kind === 'uppercase')
        proof = proof.toUpperCase()
      else if (kind === 'wrong-key')
        proof = content_authorization_proof('other-key', input.nonce, input.url, input.method)
      else if (kind === 'url-signature')
        proof = new URL(input.url).searchParams.get('auth_key')!.split('-')[4]!
      return new Response(null, { status: 204, headers: kind === 'missing' ? {} : { 'X-Content-Authorization': proof } })
    })
    const gate = create_content_authorizer(state.config.authKey, 'https://auth.test/api/content/authorize', 1000, remote)

    expect(await gate(new Request(url))).toBe(503)
    expect(remote).toHaveBeenCalledOnce()
  })
})
