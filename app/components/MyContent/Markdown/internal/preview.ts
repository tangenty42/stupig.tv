import type { RenderEnvironment, StoryMarkdownOptions } from '~/utils/content/markdown/types'
import { strip_front_matter } from '@shared/content-markdown'
import { redact_private_content_with_source_map } from '@shared/content-private'
import { public_preview_attachments } from '~/utils/content/attachment'
import { create_story_markdown } from '~/utils/content/markdown'

/** Owns reactive Markdown rendering; no DOM or interaction state. */
export function useStoryPreview(markdown: () => string, options: StoryMarkdownOptions & { public_view?: () => boolean }) {
  const body_representation = computed(() => {
    const body = strip_front_matter(markdown())
    return options.public_view?.() ? redact_private_content_with_source_map(body) : { markdown: body }
  })
  const body_markdown = computed(() => body_representation.value.markdown)
  const preview_attachments = computed(() => options.public_view?.() ? public_preview_attachments(options.attachments()) : options.attachments())
  const md = create_story_markdown({ ... options, attachments: () => preview_attachments.value })
  const render_result = computed(() => {
    const environment: RenderEnvironment = { images: [] }
    const html = md.render(body_markdown.value, environment)
    const source_lines = 'source_lines' in body_representation.value ? body_representation.value.source_lines : undefined
    return {
      // Only renderer-owned source annotations change; public pixels and text
      // stay identical to the unprivileged representation used by the server.
      html: source_lines ? html.replace(/ data-line="(\d+)"/g, (_attribute, line: string) => ` data-line="${source_lines[Number(line)] ?? line}"`) : html,
      images: environment.images,
    }
  })

  return { body_markdown, render_result, preview_attachments }
}
