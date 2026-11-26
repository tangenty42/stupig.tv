import type { H3Event } from 'h3'
import { defineEventHandler } from 'h3'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('@server/services/content.service', () => ({
  list_stories: async () => [{ id: 4, updated_at: '2026-11-18T08:00:00Z' }, { id: 7, updated_at: '2026-11-19T08:00:00Z' }],
}))
vi.mock('@server/services/profile.service', () => ({ list_sitemap_user_ids: async () => [3, 8] }))
vi.stubGlobal('defineSitemapEventHandler', defineEventHandler)
vi.stubGlobal('asSitemapUrl', (url: unknown) => url)
const handler = (await import('./urls.get')).default
afterAll(() => vi.unstubAllGlobals())

it('publishes every story with its last modification and every eligible profile at its own priority', async () => {
  const entries = await handler({} as H3Event)
  expect(entries).toHaveLength(4)
  expect(entries).toEqual(expect.arrayContaining([
    { loc: '/content/4', lastmod: new Date('2026-11-18T08:00:00Z'), changefreq: 'weekly', priority: 0.8 },
    { loc: '/content/7', lastmod: new Date('2026-11-19T08:00:00Z'), changefreq: 'weekly', priority: 0.8 },
    { loc: '/u/3', changefreq: 'weekly', priority: 0.3 },
    { loc: '/u/8', changefreq: 'weekly', priority: 0.3 },
  ]))
})
