import { afterEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ register: vi.fn() }))
vi.mock('@server/services/content/background.service', () => ({ register_content_background: boundary.register }))
afterEach(() => vi.unstubAllGlobals())

// Lifecycle/resource behavior is exercised through the actual shared runtime in
// background.service.test.ts; this plugin's contract is its registration identity.
it('registers preload with the shared app runner', async () => {
  vi.stubGlobal('defineNitroPlugin', (value: unknown) => value)
  const host = { hooks: { hook: vi.fn() } }
  const { default: plugin } = await import('./content-preload')
  await plugin(host as unknown as Parameters<typeof plugin>[0])
  expect(boundary.register).toHaveBeenCalledExactlyOnceWith(host, 'preload')
  expect(host.hooks.hook).not.toHaveBeenCalled()
})
