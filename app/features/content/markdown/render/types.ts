import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type MarkdownIt from 'markdown-it'
import type { AttachmentBrand } from './attachment-brand'

export interface RenderEnvironment {
  images: string[]
}

export interface FileCardData {
  icon: string
  size: string
  name: string
  privacy?: AttachmentBrand
}

/**
 * Reactive inputs for the story markdown preset. Getters (not snapshots) so
 * reads during `md.render` track the caller's refs and re-render on change.
 */
export interface StoryMarkdownOptions {
  /** Current story id; null = new-story editor (no attachments yet). */
  story_id: () => number | null
  attachments: () => ContentStoryAttachment[]
  /** Workspace directory identities, including directories without files. */
  folders?: () => readonly string[]
  /** Permission to view private folders, which have no readable file URL. */
  can_read_private?: () => boolean
  /** Known stories so `[](content://title)` references render as story cards. */
  stories: () => ContentStorySummary[]
  static_url: (path: string) => string
  /** Maximum decoded LQIP bytes accepted from attachment metadata. */
  lqip_max_bytes: number
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
  /** Number of enclosing carousel bodies while parsing and rendering their content. */
  carousel_render_depth: number
}

export type StoryMarkdownPlugin = (md: MarkdownIt, ctx: StoryMarkdownContext) => void
