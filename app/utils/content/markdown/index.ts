import type { StoryMarkdownContext, StoryMarkdownOptions } from './types'
import { create_content_markdown_parser } from '@shared/content-markdown-syntax'
import { alerts_plugin } from './alerts'
import { carousel_plugin } from './carousel'
import { chips_plugin } from './chips'
import { code_blocks_plugin } from './code-blocks'
import { folder_images_plugin } from './folders'
import { html_wrappers_plugin } from './html-wrappers'
import { images_plugin } from './images'
import { link_cards_plugin } from './link-cards'
import { private_blocks_plugin } from './private'
import { sanitize_story_html } from './sanitize'
import { source_anchor_plugin } from './source-anchor'

/**
 * The story markdown renderer: markdown-it plus the preset of core rules and
 * renderer overrides shared by the story page and the editor preview. The
 * getters in `options` are read during `md.render`, so renders stay reactive
 * to the caller's refs.
 */
export function create_story_markdown(options: StoryMarkdownOptions) {
  const md = create_content_markdown_parser()

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
  const render = md.render.bind(md)
  const render_inline = md.renderInline.bind(md)
  md.render = (source, env) => sanitize_story_html(render(source, env))
  md.renderInline = (source, env) => sanitize_story_html(render_inline(source, env))
  return md
}
