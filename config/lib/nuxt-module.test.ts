import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ generate_settings: vi.fn() }))
vi.mock('./generate', () => mocks)
vi.mock('nuxt/kit', () => ({ defineNuxtModule: (definition: unknown) => definition }))

function create_nuxt(dev = false) {
  return { options: { dev, watch: [] as string[] }, hook: vi.fn() }
}

const module = (await import('./nuxt-module')).default as unknown as {
  setup: (options: Record<string, never>, nuxt: ReturnType<typeof create_nuxt>) => Promise<void>
}

beforeEach(() => {
  mocks.generate_settings.mockReset()
  mocks.generate_settings.mockResolvedValue(false)
})

describe('app settings Nuxt module', () => {
  it('awaits generation before setup completes', async () => {
    const generation = Promise.withResolvers<boolean>()
    mocks.generate_settings.mockReturnValueOnce(generation.promise)
    const completed = vi.fn()
    const setup = module.setup({}, create_nuxt()).then(completed)
    await Promise.resolve()
    expect(mocks.generate_settings).toHaveBeenCalledOnce()
    expect(completed).not.toHaveBeenCalled()
    generation.resolve(false)
    await setup
    expect(completed).toHaveBeenCalledOnce()
  })

  it('does not watch files in production', async () => {
    const nuxt = create_nuxt()
    await module.setup({}, nuxt)
    expect(nuxt.options.watch).toEqual([])
    expect(nuxt.hook).not.toHaveBeenCalled()
  })

  it('regenerates only for app settings changes in development', async () => {
    const nuxt = create_nuxt(true)
    await module.setup({}, nuxt)
    expect(nuxt.options.watch).toContain('config/app-settings.yaml')
    expect(nuxt.hook).toHaveBeenCalledWith('builder:watch', expect.any(Function))
    const callback = nuxt.hook.mock.calls[0]?.[1] as (event: string, path: string) => Promise<void>
    mocks.generate_settings.mockClear()
    await callback('change', 'config/app-settings.yaml')
    await callback('change', 'C:\\app\\config\\app-settings.yaml')
    await callback('change', '../config/app-settings.yaml')
    expect(mocks.generate_settings).toHaveBeenCalledTimes(3)
    await callback('change', 'config/default.yaml')
    await callback('change', 'other-config/app-settings.yaml')
    expect(mocks.generate_settings).toHaveBeenCalledTimes(3)
  })

  it('propagates generation failures', async () => {
    const error = new Error('Invalid configuration')
    mocks.generate_settings.mockRejectedValueOnce(error)
    await expect(module.setup({}, create_nuxt())).rejects.toBe(error)
  })
})
