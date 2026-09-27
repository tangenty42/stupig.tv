import type { StoryMarkdownContext, StoryMarkdownOptions } from './types'
import MarkdownIt from 'markdown-it'
import multimd_table from 'markdown-it-multimd-table'
import { alerts_plugin } from './alerts'
import { carousel_plugin } from './carousel'
import { chips_plugin } from './chips'
import { code_blocks_plugin } from './code-blocks'
import { folder_images_plugin } from './folders'
import { html_wrappers_plugin } from './html-wrappers'
import { images_plugin } from './images'
import { link_cards_plugin } from './link-cards'
import { private_blocks_plugin } from './private'
import { source_anchor_plugin } from './source-anchor'

/**
 * The story markdown renderer: markdown-it plus the preset of core rules and
 * renderer overrides shared by the story page and the editor preview. The
 * getters in `options` are read during `md.render`, so renders stay reactive
 * to the caller's refs.
 */
export function create_story_markdown(options: StoryMarkdownOptions) {
  const md = new MarkdownIt({ html: true, linkify: false })
    // autolabel adds an id derived from the caption text, which comes out
    // empty for CJK captions.
    .use(multimd_table, { rowspan: true, autolabel: false })

  const ctx: StoryMarkdownContext = { options, anchor_render_depth: 0 }
  source_anchor_plugin(md, ctx)
  alerts_plugin(md, ctx)
  carousel_plugin(md, ctx)
  // Must follow carousel_plugin: its core rule is anchored before the carousel
  // rule so expanded images join the carousel run like hand-written ones.
  folder_images_plugin(md, ctx)
  images_plugin(md, ctx)
  chips_plugin(md, ctx)
  link_cards_plugin(md, ctx)
  code_blocks_plugin(md, ctx)
  private_blocks_plugin(md, ctx)
  html_wrappers_plugin(md, ctx)
  return md
}
