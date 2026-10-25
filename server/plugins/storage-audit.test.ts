import { afterEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ register: vi.fn() }))
vi.mock('@server/services/content/background.service', () => ({ register_content_background: boundary.register }))
afterEach(() => vi.unstubAllGlobals())

it('registers the bucket scanner with the existing application runner', async () => {
  vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)
  const plugin = (await import('./storage-audit')).default as unknown as (host: object) => void
  const host = {}
  plugin(host)
  expect(boundary.register).toHaveBeenCalledExactlyOnceWith(host, 'storage_audit')
})
