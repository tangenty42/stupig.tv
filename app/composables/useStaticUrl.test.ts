import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStaticUrl } from './useStaticUrl'

afterEach(() => vi.unstubAllGlobals())

describe('bucket public asset addresses', () => {
  it('uses the public bucket base and preserves paths and version queries', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { oss: { buckets: { public: { publicBaseUrl: 'https://assets.test/files/' } } } } }))
    const url = useStaticUrl()
    expect(url('/imgs/icon.svg')).toBe('https://assets.test/files/imgs/icon.svg')
    expect(url('content/att/image.png?version=v1')).toBe('https://assets.test/files/content/att/image.png?version=v1')
    expect(url(null)).toBe('')
    expect(url('')).toBe('')
  })

  it('keeps attachment reads on the authenticated same-origin route', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { oss: { buckets: { public: { publicBaseUrl: 'https://assets.test' } } } } }))
    expect(useStaticUrl()('/api/links/attachments/12?version=v2')).toBe('/api/links/attachments/12?version=v2')
  })
})
