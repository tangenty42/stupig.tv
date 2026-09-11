import type { BilibiliVideoCard } from '@shared/types/bilibili'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type MarkdownIt from 'markdown-it'

export interface RenderEnvironment {
  images: string[]
  /** Bilibili video hrefs seen while rendering, collected for the metadata fetch. */
  bilibili_hrefs: string[]
}

export interface FileCardData {
  icon: string
  size: string
  /** Set when the link has no label; the card then renders the file name itself. */
  name: string | null
}

export interface StoryCardMeta {
  /** Dead references render a muted placeholder span instead of a link. */
  dead: boolean
}

/**
 * Reactive inputs for the story markdown preset. Getters (not snapshots) so
 * reads during `md.render` track the caller's refs and re-render on change.
 */
export interface StoryMarkdownOptions {
  /** Current story id; null = new-story editor (orphan uploads under content/0/). */
  story_id: () => number | null
  attachments: () => ContentStoryAttachment[]
  /** Known stories so `[](@title)` references render as story cards. */
  stories: () => ContentStorySummary[]
  static_url: (path: string) => string
  /** href -> card metadata; undefined = not fetched yet, null = fetch failed. */
  video_card: (href: string) => BilibiliVideoCard | null | undefined
  /**
   * Whether a folder card can be activated. False leaves it inert: a card whose
   * host has nowhere to open the folder must not look or behave like a button.
   */
  folder_card_openable: () => boolean
}

/** Per-instance state shared between the preset's plugins. */
export interface StoryMarkdownContext {
  options: StoryMarkdownOptions
  /** > 0 while a nested render (html wrapper re-rendering inner markdown) runs. */
  anchor_render_depth: number
}

export type StoryMarkdownPlugin = (md: MarkdownIt, ctx: StoryMarkdownContext) => void
