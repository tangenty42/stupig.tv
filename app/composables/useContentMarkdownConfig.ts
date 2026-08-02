import type { ContentMarkdownConfig } from '@shared/content-markdown'

export function useContentMarkdownConfig() {
  const config = useRuntimeConfig().public

  return {
    title_max_length: config.content_story_title_max_length,
    rating_min: config.content_story_rating_min,
    rating_max: config.content_story_rating_max,
  } satisfies ContentMarkdownConfig
}
