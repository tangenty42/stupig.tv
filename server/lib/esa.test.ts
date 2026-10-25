import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import bypass_deployment, { content_authorization_proof, create_content_auth, create_content_bypass as create_online_bypass } from '../../config/esa/content-auth.mjs'
import { create_esa } from './esa'

vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { esa: null } }) }))
const function_env = vi.hoisted(() => ({ ALIYUN_ESA_AUTH_KEY: undefined as string | undefined, CONTENT_AUTH_URL: 'https://auth.example.test/api/content/authorize' }))
vi.mock('alibaba:workers', () => ({ env: function_env }))
const config = { baseUrl: 'https://esa.example.test', authKey: 'test-key#'.repeat(8), urlTtlSeconds: 300 }
beforeEach(() => vi.useRealTimers())
const create_content_bypass = (key: string, ttl = 300, respond?: (allowed: boolean, status: number) => unknown) => create_online_bypass(key, ttl, respond, async () => 200)

describe('eSA signed Content reads', () => {
  it('fails closed without configuration and rejects unsafe object paths', async () => {
    expect(() => create_esa()).toThrow('ESA 读取鉴权尚未配置')
    const esa = create_esa(config)
    for (const key of ['logo.svg', '/content/att/a', 'content/att/../a', 'content/att//a', 'content/att/a?x=1', 'content/att/a\\b'])
      expect(() => esa.signed_read_url(key, 300)).toThrow('附件对象标识无效')
  })

  it('uses canonical encoded paths, bounded expiry and metadata bound into the signature', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-17T00:00:00Z'))
    const url = new URL(create_esa(config).signed_read_url('content/att/中文 #%.avif', 3600, 'HEAD', '报告 (1).avif', 'inline'))
    expect(url.origin).toBe(config.baseUrl)
    expect(decodeURIComponent(url.pathname)).toBe('/content/att/中文 #%.avif')
    expect([... url.searchParams.keys()]).toEqual(['auth_key', 'response-content-disposition'])
    const [timestamp, rand, uid, hash] = url.searchParams.get('auth_key')!.split('-')
    expect(Number(timestamp)).toBe(Math.floor(Date.now() / 1000))
    const header = url.searchParams.get('response-content-disposition')!
    expect(rand).toBe(createHash('sha256').update(header).digest('hex'))
    expect(hash).toBe(createHash('md5').update([url.pathname, timestamp, rand, uid, config.authKey].join('-')).digest('hex'))
    const shorter = new URL(create_esa(config).signed_read_url('content/att/key', 60))
    expect(Number(shorter.searchParams.get('auth_key')!.split('-')[0]) + config.urlTtlSeconds).toBe(Math.floor(Date.now() / 1000) + 60)
  })

  it('keeps Range/HEAD and streams cached bytes while names and disposition vary per request', async () => {
    const origin = vi.fn<typeof fetch>().mockImplementation(async () => new Response('data', {
      status: 206, headers: { 'Content-Range': 'bytes 0-3/10', 'ETag': 'same-object', 'x-site-cache-status': 'HIT' },
    }))
    const handler = create_content_auth(config.authKey, config.urlTtlSeconds, origin, async () => 200)
    const esa = create_esa(config)
    for (const [name, disposition] of [['first.txt', 'inline'], ['second.txt', 'attachment']] as const) {
      const response = await handler(new Request(esa.signed_read_url('content/att/key', 300, 'GET', name, disposition), {
        headers: { 'Range': 'bytes=0-3', 'If-Range': 'same-object', 'Cookie': 'private-cookie', 'Authorization': 'private-session', 'Origin': 'https://app.test' },
      }))
      expect(response.status).toBe(206)
      expect(await response.text()).toBe('data')
      expect(response.headers.get('Content-Disposition')).toBe(`${disposition}; filename*=UTF-8''${name}`)
      expect(response.headers.get('Content-Range')).toBe('bytes 0-3/10')
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
      const forwarded = origin.mock.calls.at(- 1)![0] as Request
      expect(forwarded.url).toBe('https://esa.example.test/content/att/key')
      expect(forwarded.headers.get('Range')).toBe('bytes=0-3')
      expect(forwarded.headers.get('If-Range')).toBe('same-object')
      for (const header of ['Cookie', 'Authorization', 'Origin'])
        expect(forwarded.headers.has(header)).toBe(false)
    }
    origin.mockImplementationOnce(async () => new Response(null))
    await handler(new Request(esa.signed_read_url('content/att/key', 300, 'HEAD'), { method: 'HEAD' }))
    expect((origin.mock.calls.at(- 1)![0] as Request).method).toBe('HEAD')
  })

  it('rejects tampered metadata, duplicate parameters and expired capabilities before cache access', async () => {
    const origin = vi.fn<typeof fetch>()
    const handler = create_content_auth(config.authKey, 300, origin, async () => 200)
    const base = create_esa(config).signed_read_url('content/att/key', 300, 'GET', 'report.txt')
    const variants = [
      (u: URL) => u.searchParams.set('response-content-disposition', 'inline; filename*=UTF-8\'\'other.txt'),
      (u: URL) => u.searchParams.delete('response-content-disposition'),
      (u: URL) => u.searchParams.append('auth_key', u.searchParams.get('auth_key')!),
      (u: URL) => u.searchParams.append('response-content-disposition', u.searchParams.get('response-content-disposition')!),
      (u: URL) => u.searchParams.set('version', '2'),
      (u: URL) => { u.pathname += 'changed' },
      (u: URL) => { u.search = '' },
    ]
    for (const change of variants) {
      const url = new URL(base)
      change(url)
      const denied = await handler(new Request(url))
      expect(denied.status).toBe(403)
      expect(denied.headers.get('Cache-Control')).toBe('no-store')
    }
    vi.useFakeTimers().setSystemTime(Date.now() + 301_000)
    expect((await handler(new Request(base))).status).toBe(403)
    expect(origin).not.toHaveBeenCalled()
  })

  it('authorizes bypass GET/HEAD without fetching or reading an object body', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Bypass must not fetch'))
    const respond = vi.fn((allowed: boolean, status: number) => ({ allowed, status }))
    const handler = create_content_bypass(config.authKey, 300, respond)
    try {
      for (const method of ['GET', 'HEAD'] as const) {
        const url = create_esa(config).signed_read_url('content/att/key', 300, method, '中文 #%.avif', 'inline')
        expect(await handler(new Request(url, { method, headers: { Range: 'bytes=1-4' } }))).toEqual({ allowed: true, status: 200 })
      }
      expect(fetch).not.toHaveBeenCalled()
    }
    finally {
      fetch.mockRestore()
    }
  })

  it('applies the same signature and metadata guards in bypass mode', async () => {
    const handler = create_content_bypass(config.authKey, 300, (allowed, status) => ({ allowed, status }))
    const base = create_esa(config).signed_read_url('content/att/key', 300, 'GET', 'report.txt')
    const variants = [
      (u: URL) => { u.search = '' },
      (u: URL) => { u.pathname += 'changed' },
      (u: URL) => u.searchParams.set('response-content-disposition', 'attachment; filename*=UTF-8\'\'other.txt'),
      (u: URL) => u.searchParams.delete('response-content-disposition'),
      (u: URL) => u.searchParams.append('response-content-disposition', u.searchParams.get('response-content-disposition')!),
      (u: URL) => u.searchParams.append('auth_key', u.searchParams.get('auth_key')!),
      (u: URL) => u.searchParams.set('version', '2'),
      (u: URL) => { u.search = u.search.replace('auth_key=', '%61uth_key=') },
    ]
    for (const change of variants) {
      const url = new URL(base)
      change(url)
      expect(await handler(new Request(url))).toEqual({ allowed: false, status: 403 })
    }
    expect(await handler(new Request(base, { method: 'POST' }))).toEqual({ allowed: false, status: 405 })
    vi.useFakeTimers().setSystemTime(Date.now() + 301_000)
    expect(await handler(new Request(base))).toEqual({ allowed: false, status: 403 })
    expect(await create_content_bypass('', 300, (allowed, status) => ({ allowed, status }))(new Request(base))).toEqual({ allowed: false, status: 503 })
  })

  it('uses the ESA runtime bypass response and fails closed when it is unavailable', async () => {
    const url = create_esa(config).signed_read_url('content/att/key', 300)
    const runtime = vi.fn(class {
      allowed: boolean
      status: number
      constructor(allowed: boolean, options?: { status: number }) {
        this.allowed = allowed
        this.status = options?.status ?? 200
      }
    })
    try {
      vi.stubGlobal('ResponseBypass', runtime)
      expect(await create_content_bypass(config.authKey)(new Request(url))).toEqual({ allowed: true, status: 200 })
      expect(runtime).toHaveBeenCalledWith(true)
      expect(await create_content_bypass(config.authKey)(new Request('https://esa.example.test/content/att/key'))).toEqual({ allowed: false, status: 403 })
      expect(runtime).toHaveBeenLastCalledWith(false, { status: 403 })
      vi.stubGlobal('ResponseBypass', undefined)
      await expect(create_content_bypass(config.authKey)(new Request(url))).rejects.toThrow()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('logs QA entry and decisions without disclosing signatures or credentials', async () => {
    const alert = vi.fn()
    vi.stubGlobal('console', { ... console, alert })
    const path = 'content/att/qa-esa-bypass/11111111-1111-1111-1111-111111111111/headers.bin'
    const url = create_esa(config).signed_read_url(path, 300, 'GET', 'private-name.bin')
    const handler = create_content_bypass(config.authKey, 300, (allowed, status) => ({ allowed, status }))
    try {
      expect(await handler(new Request(url))).toEqual({ allowed: true, status: 200 })
      expect(await handler(new Request(new URL(path, config.baseUrl)))).toEqual({ allowed: false, status: 403 })
      const events = alert.mock.calls.map(([line]) => JSON.parse(line))
      expect(events.map(event => event.stage)).toEqual(['entered', 'decision', 'returned', 'entered', 'decision', 'returned'])
      expect(events[1]).toEqual({ build: 'content-bypass-debug-v1', stage: 'decision', method: 'GET', path: `/${path}`, allowed: true, status: 200 })
      expect(events[4]).toMatchObject({ allowed: false, status: 403 })
      const output = JSON.stringify(events)
      for (const secret of [config.authKey, new URL(url).searchParams.get('auth_key')!, 'private-name.bin', 'auth_key'])
        expect(output).not.toContain(secret)
      alert.mockClear()
      await handler(new Request(create_esa(config).signed_read_url('content/att/business-file', 300)))
      expect(alert).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves decisions when the ESA log sink throws', async () => {
    vi.stubGlobal('console', { ... console, alert: () => {
      throw new Error('logging unavailable')
    } })
    try {
      const handler = create_content_bypass(config.authKey, 300, (allowed, status) => ({ allowed, status }))
      const url = create_esa(config).signed_read_url('content/att/qa-esa-bypass/11111111-1111-1111-1111-111111111111/probe.bin', 300)
      expect(await handler(new Request(url))).toEqual({ allowed: true, status: 200 })
      expect(await handler(new Request(url.split('?')[0]!))).toEqual({ allowed: false, status: 403 })
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects the retired support token even before its former deadline', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-17T10:00:00Z'))
    const url = new URL('https://stupig-static-dev.oss.tangenty.cn/content/att/qa-esa-bypass/3e15ae36-2723-4f4d-a69e-6bd88c6ca7f8/headers.bin')
    url.searchParams.set('auth_key', 'aliyun_test_20261017')
    const handler = create_content_bypass(config.authKey, 300, (allowed, status) => ({ allowed, status }))
    for (const method of ['GET', 'HEAD']) {
      for (const filename of [null, 'support-a.bin', 'support-b.bin']) {
        const request_url = new URL(url)
        if (filename)
          request_url.searchParams.set('response-content-disposition', `attachment; filename*=UTF-8''${filename}`)
        expect(await handler(new Request(request_url, { method }))).toEqual({ allowed: false, status: 403 })
      }
    }
  })

  it('reads the deployed key from function variables and fails closed when missing', async () => {
    vi.stubGlobal('ResponseBypass', class {
      constructor(public allowed: boolean, public options?: { status: number }) {}
    })
    const request = new Request(create_esa(config).signed_read_url('content/att/key', 300, 'GET', undefined, 'inline', { id: 1, revision: 'a'.repeat(64), role: 'auto', session: 0, generation: 0 }))
    const remote = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      return new Response(null, { status: 204, headers: { 'X-Content-Authorization': content_authorization_proof(config.authKey, body.nonce, body.url, body.method) } })
    })
    try {
      for (const key of [undefined, '', 'REPLACE_WITH_RANDOM_SECRET']) {
        function_env.ALIYUN_ESA_AUTH_KEY = key
        await expect(bypass_deployment.bypass(request)).resolves.toEqual({ allowed: false, options: { status: 503 } })
      }
      function_env.ALIYUN_ESA_AUTH_KEY = config.authKey
      await expect(bypass_deployment.bypass(request)).resolves.toEqual({ allowed: true, options: undefined })
      function_env.ALIYUN_ESA_AUTH_KEY = 'different-key'
      await expect(bypass_deployment.bypass(request)).resolves.toEqual({ allowed: false, options: { status: 403 } })
    }
    finally {
      remote.mockRestore()
      function_env.ALIYUN_ESA_AUTH_KEY = undefined
      vi.unstubAllGlobals()
    }
  })
  it('deploys only a bypass entry and fails closed with an explicit placeholder key', async () => {
    const runtime = vi.fn(class {
      constructor(public allowed: boolean, public options?: { status: number }) {}
    })
    try {
      vi.stubGlobal('ResponseBypass', runtime)
      expect(Object.keys(bypass_deployment)).toEqual(['bypass'])
      // Test the placeholder contract explicitly; the local deployment file may
      // be configured independently. Its async entry is exercised above.
      const result = await create_content_bypass('REPLACE_WITH_RANDOM_SECRET')(new Request(create_esa(config).signed_read_url('content/att/key', 300)))
      expect(result).toEqual({ allowed: false, options: { status: 503 } })
      expect(runtime).toHaveBeenCalledWith(false, { status: 503 })
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
