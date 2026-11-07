import { list_stories } from '@server/services/content.service'
import { list_sitemap_user_ids } from '@server/services/profile.service'

export default defineSitemapEventHandler(async () => {
  const [stories, user_ids] = await Promise.all([list_stories(), list_sitemap_user_ids()])

  return [
    ... stories.map(story => asSitemapUrl({
      loc: `/content/${story.id}`,
      lastmod: new Date(story.updated_at),
      changefreq: 'weekly',
      priority: 0.8,
    })),
    ... user_ids.map(id => asSitemapUrl({
      loc: `/u/${id}`,
      changefreq: 'weekly',
      priority: 0.3,
    })),
  ]
})
