import { format_attachment_ref, format_story_ref } from './content-reference'

/** Reference constructs have the same parser, but distinct preview/editor contracts. */
export const content_reference_dialect = {
  attachment_ref: { format: format_attachment_ref, example: 'docs/a.pdf', markdown: '[](att://docs/a.pdf)' },
  folder_ref: { format: format_attachment_ref, example: 'cards', markdown: '[](att://cards)' },
  story_ref: { format: format_story_ref, example: '档案', markdown: '[](content://档案)' },
} as const
