import { afterEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ register: vi.fn() }))
vi.mock('@server/services/content/background.service', () => ({ register_content_background: boundary.register }))

afterEach(() => vi.unstubAllGlobals())

it('registers receipt compaction with the shared app runner', async () => {
  vi.stubGlobal('defineNitroPlugin', (value: unknown) => value)
  const host = { hooks: { hook: vi.fn() } }
  const { default: plugin } = await import('./content-receipts')
  await plugin(host as unknown as Parameters<typeof plugin>[0])
  expect(boundary.register).toHaveBeenCalledExactlyOnceWith(host, 'receipts')
  expect(host.hooks.hook).not.toHaveBeenCalled()
})
